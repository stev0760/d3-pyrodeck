import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ProcessManager,
  type LaunchConfig,
  type ProcessStatus,
  type StopReason,
} from "../launcher/ProcessManager.js";
import { resolveLogDir, buildLogFilename, prepareLogFile } from "../launcher/logPaths.js";
import {
  parseDedicatedCfg,
  extractTelnetConfig,
} from "../launcher/ConfigGenerator.js";
import { TelnetConnection } from "../connection/TelnetConnection.js";
import { probeCapabilitiesDetailed } from "../session/probeCapabilities.js";
import { parseNetgameinfo } from "../parser/parsers/netgameinfo.js";
import { sessionManager, serializeCaps } from "./server.js";
import { wsBroadcast, wireSessionToClients } from "./command.js";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { ServerProfileManager } from "../config/ServerProfile.js";
import type { PlaylistEntry } from "../launcher/PlaylistManager.js";
import {
  playlistManager,
  playlistStatusPayload,
  rotationHealth,
} from "../launcher/playlistInstance.js";
import { findIncompatibleEntries } from "../gamefiles/playlistCompat.js";
import { buildPostStartCommands } from "../launcher/postStartSettings.js";
import { consoleHostFor, sanitizeStoredLaunchOptions, type LaunchOptions } from "../launcher/launchOptions.js";
import { buildTeamSettingLines, sanitizeStoredTeamSettings } from "../launcher/teamSettings.js";
import { ProfileAutomation } from "../launcher/profileAutomation.js";
import type { ServerConnection } from "../connection/ServerConnection.js";
import { missionHost } from "./mission-host.js";
import { serverEvents } from "../events/ServerEvents.js";
import { ServerLineMonitor } from "../launcher/ServerLineMonitor.js";
import { Supervisor } from "../launcher/Supervisor.js";
import { validateSupervisorSettings } from "../launcher/supervisorSettings.js";
import {
  clearRunRecord,
  decideAdopt,
  readLinuxIdentity,
  readProcessFacts,
  readRunRecord,
  writeRunRecord,
  type RunRecord,
} from "../launcher/runRecord.js";

export { playlistManager };

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

export const processManager = new ProcessManager();

// Joins, leaves, chat and level starts onto the event bus, read from the
// launched process's stdout (from the console for a re-attached one).
const lineMonitor = new ServerLineMonitor();
lineMonitor.onConsoleQuit = () => processManager.noteConsoleQuit();
serverEvents.onEvent("server.started", ({ profileId }) => lineMonitor.reset(profileId));
serverEvents.onEvent("server.adopted", ({ profileId }) => lineMonitor.reset(profileId));

// One line per event in Pyrodeck's own log: the history D3Server3 kept in
// its event log.
serverEvents.onEvent("server.started", (e) => console.log(`[Server] started (${e.reason}), pid ${e.pid}`));
serverEvents.onEvent("server.stopped", (e) =>
  console.log(`[Server] stopped (${e.reason}${e.via ? `, ${e.via}` : ""}), pid ${e.pid}`),
);
serverEvents.onEvent("server.crashed", (e) =>
  console.log(`[Server] crashed, pid ${e.pid} (${e.signal ? `signal ${e.signal}` : `exit code ${e.code}`})`),
);
serverEvents.onEvent("server.hung", (e) =>
  console.log(`[Server] hung, pid ${e.pid}: console silent ${Math.round(e.silentForMs / 1000)} s`),
);
serverEvents.onEvent("server.adopted", (e) => console.log(`[Server] re-attached, pid ${e.pid} (started ${e.startedAt})`));
serverEvents.onEvent("level.started", (e) => console.log(`[Server] level ${e.level ?? "?"} started`));
serverEvents.onEvent("player.joined", (e) => console.log(`[Server] ${e.name} joined`));
serverEvents.onEvent("player.left", (e) => console.log(`[Server] ${e.name} left`));

// The running server's PID and launch, on disk, so the next Pyrodeck can
// re-attach to it (reattachToRunningServer). Writes and removals are queued
// so a quick exit cannot leave a stale record behind.
let runRecordQueue: Promise<void> = Promise.resolve();
function queueRunRecord(task: () => Promise<void>): void {
  runRecordQueue = runRecordQueue.then(task).catch((err) => {
    console.warn(`[Pyrodeck] Could not update ${CONFIG_DIR}/running-server.json: ${err instanceof Error ? err.message : err}`);
  });
}
serverEvents.onEvent("server.started", ({ pid, args }) => {
  queueRunRecord(async () => {
    const config = processManager.getLaunchConfig();
    const status = processManager.getStatus();
    if (!config || status.pid !== pid) return;
    const linux = process.platform === "linux" ? await readLinuxIdentity(pid) : null;
    const record: RunRecord = {
      version: 1,
      pid,
      profileId: config.profileId ?? null,
      executablePath: config.executablePath,
      gamePath: config.gamePath,
      configFile: config.configFile,
      args,
      logPath: config.logPath ?? null,
      telnetPort: config.telnetPort,
      launchOptions: config.launchOptions ?? null,
      startedAt: (status.startedAt ?? new Date()).toISOString(),
      ...(linux ? { linux: { startTicks: linux.startTicks, bootId: linux.bootId } } : {}),
    };
    if (processManager.getStatus().pid !== pid) return; // already gone
    await writeRunRecord(CONFIG_DIR, record);
  });
});

/** Periodic commands and respawn scaling for the launched profile (server.started → console ready → exit). */
export const profileAutomation = new ProfileAutomation({
  loadProfile: (id) => new ServerProfileManager(CONFIG_DIR, "").read(id).catch(() => null),
});
profileAutomation.listen(serverEvents);
processManager.on("exit", () => profileAutomation.serverDown());

// Restore playlist activation state from disk on startup
playlistManager.restoreState().catch(() => {});

// Wire playlist events to WebSocket broadcasts
playlistManager.on("timerUpdate", (gameEndAt: number | null) => {
  wsBroadcast("playlist_timer", { gameEndAt });
});

// A new level is loading (level rotation, $warp, $endlevel) — tell clients so
// they drop their stale countdown, re-anchor locally, and show which level is
// now loaded. Clients do NOT re-query $netgameinfo (it leaks the engine text
// buffer and crashes dedicated servers); they derive the countdown locally.
playlistManager.on("levelChanged", (level: string | null) => {
  wsBroadcast("level_changed", { level });
});

// The server re-queried $netgameinfo (activation/rotation only) — push the
// fresh static config to all clients so their panels stay current without
// any client-side polling.
playlistManager.on("serverInfoRaw", (raw: string) => {
  const info = parseNetgameinfo(raw);
  if (info) wsBroadcast("serverinfo", info as unknown as Record<string, unknown>);
});

/**
 * Build a single-line vote prompt sized for D3's 2-line chat window.
 * Example: "Vote next mission (type 1-3): 1=Abend2  2=Stadium  3=BBQ"
 */
function buildVotePromptLine(options: PlaylistEntry[]): string {
  const parts = options.map((o, i) => `${i + 1}=${o.label}`).join("  ");
  return `say Vote next mission (type 1-${options.length}): ${parts}`;
}

playlistManager.on("voteAnnounce", (options: PlaylistEntry[], timeoutMs: number) => {
  wsBroadcast("playlist_vote_announce", {
    options: options.map((o, i) => ({ index: i + 1, id: o.id, label: o.label, missionName: o.missionName })),
    timeoutMs,
    deadline: Date.now() + timeoutMs,
  });

  if (options.length > 0 && playlistManager.sendCommandFn) {
    playlistManager.sendCommandFn(buildVotePromptLine(options)).catch(() => {});
  }
});

// Periodic reminder — D3 chat clips to the last ~2 lines, so we re-send the
// prompt every 10s while the vote is open so late joiners and busy players
// still see it.
playlistManager.on("voteReminder", (options: PlaylistEntry[]) => {
  if (options.length > 0 && playlistManager.sendCommandFn) {
    playlistManager.sendCommandFn(buildVotePromptLine(options)).catch(() => {});
  }
});

// Acknowledge votes in chat so players know their vote registered.
playlistManager.on(
  "voteReceived",
  (payload: { playerName: string; option: PlaylistEntry; changed: boolean; voterCount: number }) => {
    if (!playlistManager.sendCommandFn) return;
    const verb = payload.changed ? "changed vote to" : "voted for";
    playlistManager.sendCommandFn(
      `say [Vote ${payload.voterCount}] ${payload.playerName} ${verb}: ${payload.option.label}`,
    ).catch(() => {});
  },
);

playlistManager.on("voteResult", (winner: PlaylistEntry, counts: number[]) => {
  wsBroadcast("playlist_vote_result", {
    winner: { id: winner.id, label: winner.label, missionName: winner.missionName },
    counts,
  });

  // Announce winner in-game
  if (playlistManager.sendCommandFn) {
    playlistManager.sendCommandFn(`say Vote closed — next mission: ${winner.label}`)
      .catch(() => {});
  }
});

/**
 * Send the launched profile's post-start settings (PLAN Phase 3 Step 7) over
 * the new console session. Best-effort: a failure is reported, never fatal.
 */
async function applyPostStartSettings(connection: ServerConnection): Promise<void> {
  const profileId = processManager.getStatus().activeProfileId;
  if (!profileId) return;
  let commands: string[];
  try {
    const profile = await new ServerProfileManager(CONFIG_DIR, "").read(profileId);
    commands = buildPostStartCommands(profile.postStart);
  } catch {
    return; // profile deleted since launch
  }
  for (const cmd of commands) {
    try {
      await connection.send(cmd);
      console.log(`[Pyrodeck] Post-start: ${cmd}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      wsBroadcast("error", { message: `Post-start setting "${cmd}" failed: ${message}` });
      return;
    }
  }
}

/**
 * Register a one-shot telnetReady handler so auto-connect fires after (re)start.
 * Called from POST /start, the playlist rotate handler and the supervisor.
 *
 * `healthToken` is set for a playlist restart: the result is then reported to
 * the rotation health check (healthy once `$servercaps` gets an answer, or a
 * failure) instead of completing the rotation directly.
 */
function registerAutoConnect(telnetPassword: string, healthToken?: number): void {
  // Remove any stale once-handler from a launch that crashed before telnet was ready
  processManager.removeAllListeners("telnetReady");

  processManager.once("telnetReady", (port: number, host?: string) => {
    const consoleHost = consoleHostName(host);
    console.log(`[Pyrodeck] D3 telnet ready on ${consoleHost}:${port}, auto-connecting...`);
    void connectConsole(consoleHost, port, telnetPassword, { healthToken }).catch(() => {});
  });
}

interface ConsoleConnectOptions {
  /** Playlist restart health token (see registerAutoConnect). */
  healthToken?: number;
  /**
   * Log in again to a server that has been up for a while (the console link
   * dropped, or Pyrodeck re-attached to it): no post-start settings, no toast
   * on failure. Throws on failure so the caller can retry.
   */
  again?: boolean;
  /**
   * Anchor an active playlist's timer even when logging in again (after a
   * re-attach). Each anchor costs a `$netgameinfo`, which leaks engine
   * memory, so a plain reconnect keeps the timer it has.
   */
  anchorPlaylist?: boolean;
}

/**
 * The name to log in to the launched console with: a server started with
 * -useip listens on that address only (ProcessManager.consoleHost).
 */
function consoleHostName(host: string | undefined): string {
  return host && host !== "127.0.0.1" ? host : "localhost";
}

/** Log in to the launched server's remote console and make it the active session. */
async function connectConsole(
  host: string,
  port: number,
  telnetPassword: string,
  opts: ConsoleConnectOptions = {},
): Promise<void> {
  const { healthToken, again = false, anchorPlaylist = !again } = opts;
  try {
    // Disconnect any stale session
    const existing = sessionManager.getActive();
    if (existing) {
      sessionManager.remove(existing.id);
    }

    const connection = new TelnetConnection();
    const session = sessionManager.create(
      connection,
      host,
      port,
      telnetPassword,
    );

    sessionManager.updateState(session.id, "connecting");
    await connection.connect(host, port, telnetPassword);

    // Probe capabilities
    sessionManager.updateState(session.id, "probing");
    const { caps: capabilities, answered } = await probeCapabilitiesDetailed(connection, (late) => {
      if (healthToken !== undefined) rotationHealth.healthy(healthToken);
      if (sessionManager.getActive()?.id !== session.id) return;
      sessionManager.updateCapabilities(session.id, late);
      wsBroadcast("capabilities", serializeCaps(late));
    });

    sessionManager.updateCapabilities(session.id, capabilities);
    sessionManager.updateState(session.id, "ready");
    wireSessionToClients();

    // Wire up graceful quit
    processManager.sendQuitFn = async () => {
      try { await connection.send("quit"); } catch { /* connection may be dead */ }
    };

    // Wire playlist manager's command sender
    playlistManager.sendCommandFn = async (cmd: string) => connection.send(cmd);

    if (healthToken === undefined) {
      // User-started launch: nothing to verify. (Also unsticks a playlist
      // left "restarting" by a rotation the operator took over by hand.)
      playlistManager.markRotationComplete();
    } else if (answered) {
      // Playlist restart: the console answered $servercaps, the server is up.
      // A silent first probe waits for the background re-probe (above) or
      // the health check's deadline.
      rotationHealth.healthy(healthToken);
    }

    // Per-profile DMFC settings dedicated.cfg can't hold. The console runs
    // one command at a time, so these never interleave with other replies.
    if (!again) void applyPostStartSettings(connection);

    // The profile's start lines (once per run), then its periodic lines every
    // N minutes. A new login hands the timers the new connection.
    const launchedProfileId = processManager.getStatus().activeProfileId;
    if (launchedProfileId) void profileAutomation.consoleReady(launchedProfileId, connection);

    watchConsole(connection, host, port, telnetPassword);

    // Anchor playlist timer if a playlist is active
    if (playlistManager.isActive() && anchorPlaylist) {
      playlistManager.anchorTimer().catch(() => {});
    }

    // Broadcast to WS clients
    wsBroadcast("connection_state", { state: "ready" });
    wsBroadcast("capabilities", serializeCaps(capabilities));

    // Broadcast current playlist status
    if (playlistManager.getStatus().activePlaylistId) {
      wsBroadcast("playlist_status", playlistStatusPayload());
    }

    console.log(`[Pyrodeck] Launch Mode: auto-connected to D3 server (session ${session.id})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Pyrodeck] Launch Mode: telnet auto-connect failed: ${message}`);
    if (again) throw err;
    wsBroadcast("error", { message: `Auto-connect failed: ${message}` });
    if (healthToken === undefined) {
      playlistManager.markRotationComplete();
    } else {
      rotationHealth.failure(`remote console login failed (${message})`, healthToken);
    }
  }
}

// ---------------------------------------------------------------------------
// Playlist restart health (PLAN Phase 3 Step 6, best-effort rotation):
// every rotation restart must come healthy within the deadline; one automatic
// retry, then the playlist pauses with a visible reason instead of rotating on
// behind a dead server.
// ---------------------------------------------------------------------------

interface RotationLaunch {
  label: string;
  telnetPassword: string;
  launch: LaunchConfig;
}

/** The launch the current rotation is trying to bring up (kept for the retry). */
let currentRotationLaunch: RotationLaunch | null = null;

function broadcastPlaylistStatus(): void {
  wsBroadcast("playlist_status", playlistStatusPayload());
}

/** Spawn the rotation's server and start the health deadline. Throws if the spawn fails. */
async function launchForRotation(rl: RotationLaunch, token: number): Promise<void> {
  registerAutoConnect(rl.telnetPassword, token);
  await processManager.start(rl.launch, "playlist");
  rotationHealth.arm();
}

/** Give up on a rotation restart: pause the playlist and say why, loudly. */
function pauseAfterFailedRotation(reason: string, label = currentRotationLaunch?.label): void {
  currentRotationLaunch = null;
  const what = label ? `the restart into "${label}"` : "the server restart";
  console.error(`[Playlist] Paused: ${what} failed: ${reason}`);
  if (playlistManager.isActive()) {
    playlistManager.pause(`${what[0].toUpperCase()}${what.slice(1)} failed: ${reason}.`);
  }
  wsBroadcast("error", {
    message: `Playlist paused: ${what} failed (${reason}). Check the server, launch it if needed, then resume the playlist.`,
  });
  broadcastPlaylistStatus();
}

/**
 * The operator started or stopped the server by hand while a playlist restart
 * was still being checked: stop checking (a deadline must not relaunch a
 * server the operator just stopped) and let the playlist carry on.
 */
function takeOverFromRotation(): void {
  if (!rotationHealth.isPending()) return;
  rotationHealth.cancel();
  currentRotationLaunch = null;
  playlistManager.markRotationComplete();
  broadcastPlaylistStatus();
}

rotationHealth.on("healthy", (attempt: number) => {
  const label = currentRotationLaunch?.label;
  currentRotationLaunch = null;
  console.log(`[Playlist] Restart${label ? ` into "${label}"` : ""} healthy${attempt > 0 ? " after a retry" : ""}`);
  playlistManager.markRotationComplete();
  broadcastPlaylistStatus();
});

rotationHealth.on("retry", async (_attempt: number, reason: string) => {
  const rl = currentRotationLaunch;
  if (!rl) {
    rotationHealth.failure("nothing to relaunch");
    return;
  }
  const token = rotationHealth.token();
  console.warn(`[Playlist] Restart into "${rl.label}" not healthy (${reason}); retrying once`);
  wsBroadcast("error", {
    message: `Playlist restart into "${rl.label}" is not healthy (${reason}). Retrying once…`,
  });
  broadcastPlaylistStatus();

  try {
    // Tear down whatever the failed attempt left behind.
    const existing = sessionManager.getActive();
    if (existing) sessionManager.remove(existing.id);
    processManager.sendQuitFn = null;
    playlistManager.sendCommandFn = null;
    if (processManager.isRunning()) await processManager.stop("playlist");

    // The operator may have taken over (Stop/Launch) while we were stopping.
    if (rotationHealth.token() !== token || !rotationHealth.isPending()) return;
    await launchForRotation(rl, token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rotationHealth.failure(`restart failed (${message})`, token);
  }
});

rotationHealth.on("failed", (reason: string) => {
  pauseAfterFailedRotation(reason);
});

// Pause/resume (and the health snapshot) reach every client.
playlistManager.on("statusChanged", () => {
  broadcastPlaylistStatus();
});

// Rotate: stop server, swap mission CVar, restart
playlistManager.on("rotate", async (entry: PlaylistEntry) => {
  const config = pyrodeckConfig.get();
  const globalGamePath = config.gamePath;

  console.log(`[Playlist] Rotate triggered for entry: ${entry.label} (${entry.missionName})`);

  // Resolve the active profile via profiles.json (profile records live in
  // CONFIG_DIR; we only need a valid gamePath for the ServerProfileManager's
  // file ops AFTER we pick the profile, so pass an empty string initially).
  // Done BEFORE stopping the server so a compat failure can skip the rotation
  // and leave the current mission running.
  const metadataManager = new ServerProfileManager(CONFIG_DIR, "");
  let serverStopped = false;
  try {
    const profiles = await metadataManager.list();
    if (profiles.length === 0) {
      console.warn("[Playlist] No profiles found; cannot rotate");
      playlistManager.markRotationComplete();
      return;
    }

    // Pick the most recently launched profile (this is the one that was
    // running when the rotation fired).
    const sorted = profiles
      .filter((p) => p.lastLaunchedAt)
      .sort((a, b) => (b.lastLaunchedAt ?? "").localeCompare(a.lastLaunchedAt ?? ""));
    const activeProfile = sorted[0] ?? profiles[0];

    // Profile overrides take precedence over global config — profiles with a
    // custom gamePath / executablePath (e.g. a PiccuEngine install) rely on
    // these to resolve correctly across a mission rotation.
    const gamePath = activeProfile.gamePath ?? globalGamePath;
    const executablePathRaw = activeProfile.executablePath ?? config.executablePath;

    if (!gamePath || !executablePathRaw) {
      wsBroadcast("error", {
        message:
          "Playlist rotation failed: game path or executable not configured for the active profile",
      });
      playlistManager.markRotationComplete();
      return;
    }

    // Guard: the profile's Scriptname may have changed since activation. If
    // this entry's mission doesn't support it, skip the rotation instead of
    // restarting into a server that can't start the game. The next
    // "Ending level." rotates to the following entry.
    const { scriptName, incompatible } = await findIncompatibleEntries(
      gamePath,
      activeProfile.configFile,
      [entry],
    );
    if (incompatible.length > 0) {
      const reason = incompatible[0].reason;
      console.warn(
        `[Playlist] Skipping rotation to ${entry.missionName}: ${reason} (Scriptname=${scriptName})`,
      );
      wsBroadcast("error", {
        message: `Playlist skipped "${entry.label}" (${entry.missionName}): ${reason} for ${scriptName}. Current mission keeps running.`,
      });
      playlistManager.markRotationComplete();
      return;
    }

    // Announce rotation if server is running
    if (playlistManager.sendCommandFn && processManager.isRunning()) {
      try {
        await playlistManager.sendCommandFn(`say Changing mission to: ${entry.label}`);
        await new Promise((r) => setTimeout(r, 1000));
      } catch { /* ignore */ }
    }

    // Close our telnet session cleanly before killing D3 — this sends a FIN
    // from our side so the TCP 4-tuple closes through FIN_WAIT rather than
    // lingering in TIME_WAIT with D3's local port as the sockname, which can
    // interfere with the next D3 binding the same port.
    //
    // Rotation deliberately SKIPS the graceful `quit` path (unlike /stop):
    // `quit` makes D3 close the connection from its side, parking the 4-tuple
    // in TIME_WAIT on D3's port and forcing waitForPortFree() to delay the
    // relaunch by up to a minute between missions.
    const existingSession = sessionManager.getActive();
    if (existingSession) {
      sessionManager.remove(existingSession.id);
    }
    processManager.sendQuitFn = null;
    playlistManager.sendCommandFn = null;

    const launchStatus = processManager.getStatus();
    if (launchStatus.state === "running" || launchStatus.state === "starting") {
      await processManager.stop("playlist");
    }
    // From here on the server is down: a failure pauses the playlist instead
    // of leaving it "restarting" behind a dead server.
    serverStopped = true;

    // Re-bind the profile manager to the effective gamePath for file ops.
    const profileManager = new ServerProfileManager(CONFIG_DIR, gamePath);

    await profileManager.ensureConfigReference(
      activeProfile.configFile,
      "MissionName",
      entry.missionName,
    );

    if (entry.startingLevel !== undefined) {
      await profileManager.ensureConfigReference(
        activeProfile.configFile,
        "SetLevel",
        String(entry.startingLevel),
      );
    }

    // Restart the server with the updated config
    const cfgPath = path.join(gamePath, activeProfile.configFile);
    const cfgContent = await fs.readFile(cfgPath, "utf-8");
    const telnetCfg = extractTelnetConfig(parseDedicatedCfg(cfgContent));
    if (!telnetCfg.enabled || !telnetCfg.password) {
      pauseAfterFailedRotation(
        `${activeProfile.configFile} has no remote console (AllowRemoteConsole=1 and ConsolePassword are required), so Pyrodeck cannot restart and watch the server`,
        entry.label,
      );
      return;
    }

    let executablePath = executablePathRaw;
    if (!path.isAbsolute(executablePath)) {
      executablePath = path.join(gamePath, executablePath);
    }
    // Auto-name the rotation's log in the configured dir (default: next to
    // the executable) and create it, as POST /start does. A rotation still
    // restarts the server when the log can't be written (players matter
    // more than the log), but says so; ProcessManager then marks the
    // launch's log as failed in the status the Launch panel shows.
    const logDir = resolveLogDir(config.logDir, executablePath);
    const logPath = path.join(logDir, buildLogFilename(activeProfile.name));
    const logError = await prepareLogFile(logPath);
    if (logError) {
      wsBroadcast("error", { message: `Playlist rotation: ${logError} The server restarts without a log.` });
    }

    await profileManager.markLaunched(activeProfile.id);
    currentRotationLaunch = {
      label: entry.label,
      telnetPassword: telnetCfg.password,
      launch: {
        executablePath,
        gamePath,
        configFile: activeProfile.configFile,
        logPath,
        telnetPort: telnetCfg.port,
        telnetPassword: telnetCfg.password,
        profileId: activeProfile.id,
        launchOptions: sanitizeStoredLaunchOptions(activeProfile.launchOptions),
        autoexecBlock: buildTeamSettingLines(sanitizeStoredTeamSettings(activeProfile.teamSettings)),
      },
    };
    rotationHealth.begin();
    const token = rotationHealth.token();
    broadcastPlaylistStatus();
    try {
      await launchForRotation(currentRotationLaunch, token);
      wsBroadcast("playlist_rotate", {
        entry: { id: entry.id, label: entry.label, missionName: entry.missionName },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Playlist] Restart failed: ${message}`);
      rotationHealth.failure(`restart failed (${message})`, token);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Playlist] Rotation error: ${message}`);
    if (serverStopped) {
      pauseAfterFailedRotation(`rotation error (${message})`, entry.label);
    } else {
      wsBroadcast("error", { message: `Playlist rotation error: ${message}` });
      playlistManager.markRotationComplete();
    }
  }
});

// ---------------------------------------------------------------------------
// Supervisor (D3Server3 parity): relaunch after a crash, kill and relaunch a
// hung server, restart an empty one after an uptime limit. Settings are global
// (pyrodeck.json); see launcher/Supervisor.ts for the rules.
// ---------------------------------------------------------------------------

/** Result of startServer/stopServer: the new status, or an HTTP code and message. */
export type LaunchResult = { ok: true; status: ProcessStatus } | { ok: false; code: number; error: string };

/**
 * Stop the launched server on request and drop its console session: the path
 * behind POST /api/launcher/stop, also taken by the supervisor and the weekly
 * schedule.
 *
 * `quit` over the console is sent only for a manual stop. Otherwise the
 * session is closed first and the process is signalled, as a playlist
 * rotation does: closing from our side keeps the console port out of
 * TIME_WAIT, so a relaunch need not wait for the port (waitForPortFree).
 */
export async function stopServer(reason: StopReason, options: { kill?: boolean } = {}): Promise<LaunchResult> {
  if (!processManager.isRunning()) {
    return { ok: false, code: 409, error: "Server is not running" };
  }
  takeOverFromRotation();
  playlistManager.sendCommandFn = null;
  if (reason !== "manual") dropConsoleSession();
  // A manual stop keeps the session wired so ProcessManager can try a
  // graceful `quit` first (via sendQuitFn) before escalating to SIGTERM. If
  // D3's exit leaves the telnet 4-tuple in TIME_WAIT, waitForPortFree()
  // absorbs that on the next launch.
  await processManager.stop(reason, options);
  dropConsoleSession();
  wsBroadcast("connection_state", { state: "disconnected" });
  return { ok: true, status: processManager.getStatus() };
}

function dropConsoleSession(): void {
  processManager.sendQuitFn = null;
  const session = sessionManager.getActive();
  if (session) sessionManager.remove(session.id);
}

/** Start the last launch again, into a new log file next to the last one. */
async function relaunchLast(): Promise<void> {
  const last = processManager.getLaunchConfig();
  if (!last) throw new Error("there is no launch to repeat");
  if (processManager.isRunning()) return;

  let logPath = last.logPath;
  if (logPath) {
    let label = path.basename(last.configFile, path.extname(last.configFile));
    if (last.profileId) {
      try {
        label = (await new ServerProfileManager(CONFIG_DIR, "").read(last.profileId)).name;
      } catch {
        // profile deleted since launch: keep the config name
      }
    }
    const fresh = path.join(path.dirname(logPath), buildLogFilename(label));
    const logError = await prepareLogFile(fresh);
    if (logError) {
      wsBroadcast("error", { message: `Relaunch: ${logError} The server restarts without a log.` });
      logPath = undefined;
    } else {
      logPath = fresh;
    }
  }

  dropConsoleSession();
  registerAutoConnect(last.telnetPassword);
  await processManager.start({ ...last, logPath }, "relaunch");
}

export const supervisor = new Supervisor({
  relaunch: relaunchLast,
  stop: async (reason, options) => {
    await stopServer(reason, options);
  },
  command: async (cmd) => {
    const session = sessionManager.getActive();
    if (!session || session.state !== "ready" || !session.connection.isConnected()) {
      throw new Error("no console");
    }
    return session.connection.send(cmd);
  },
  isRunning: () => processManager.isRunning(),
  rotationPending: () => rotationHealth.isPending(),
  notify: (message, level) => {
    if (level === "error") {
      console.warn(`[Supervisor] ${message}`);
      wsBroadcast("error", { message });
    } else {
      console.log(`[Supervisor] ${message}`);
    }
  },
});

/**
 * Feed a logged-in console to the supervisor, and log in again if the link
 * drops while the server runs. A re-attached server has no stdout, so its
 * console also feeds the line monitor and the playlist's level detection.
 */
function watchConsole(connection: ServerConnection, host: string, port: number, telnetPassword: string): void {
  connection.onData((text) => {
    supervisor.consoleActivity();
    if (processManager.getStatus().adopted) {
      lineMonitor.push(text);
      playlistManager.onStdoutChunk(text);
    }
  });
  connection.onDisconnect(() => scheduleConsoleReconnect(host, port, telnetPassword));
  stopConsoleReconnect();
  supervisor.consoleReady();
}

// D3Server3 logs in again 5 s after its console link drops.
const CONSOLE_RECONNECT_MS = 5_000;
let consoleReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleConsoleReconnect(host: string, port: number, telnetPassword: string): void {
  if (consoleReconnectTimer || processManager.getStatus().state !== "running") return;
  consoleReconnectTimer = setTimeout(async () => {
    consoleReconnectTimer = null;
    if (processManager.getStatus().state !== "running") return;
    try {
      await connectConsole(host, port, telnetPassword, { again: true });
    } catch {
      scheduleConsoleReconnect(host, port, telnetPassword);
    }
  }, CONSOLE_RECONNECT_MS);
}

function stopConsoleReconnect(): void {
  if (consoleReconnectTimer) clearTimeout(consoleReconnectTimer);
  consoleReconnectTimer = null;
}

// Wire process events to WebSocket broadcasts
processManager.on("stateChange", (state: string) => {
  // Trailing output (e.g. the stderr lines explaining a crash) must reach
  // clients before the state change that it caused.
  flushProcessOutput();
  wsBroadcast("process_state", { state });
  // The loaded level is gone once the process is down; forget it so a stale
  // name isn't reported on the next connect. A restart re-populates it from
  // the next "Opening level" line.
  if (state === "stopped" || state === "crashed") {
    playlistManager.clearCurrentLevel();
  }
  // Read before the health check reacts below: once it gives up it is idle,
  // and the supervisor must still know the crash was the rotation's.
  const rotationOwned = rotationHealth.isPending();
  // A playlist restart that dies before it answers fails its health check now,
  // not at the deadline. Only while armed ("waiting"): the old process being
  // stopped for a retry is not this attempt's crash.
  if (state === "crashed" && rotationHealth.snapshot().state === "waiting") {
    const { exitCode, exitSignal } = processManager.getStatus();
    rotationHealth.failure(
      `server exited during startup (${exitSignal ? `signal ${exitSignal}` : `exit code ${exitCode}`})`,
      rotationHealth.token(),
    );
  }
  if (state === "stopped" || state === "crashed") {
    stopConsoleReconnect();
    queueRunRecord(() => clearRunRecord(CONFIG_DIR));
    const { exitCode, exitSignal, stopReason } = processManager.getStatus();
    supervisor.processDown({
      crashed: state === "crashed",
      stopReason,
      rotationOwned,
      code: exitCode,
      signal: exitSignal,
    });
  }
});

// Debug D3 builds can emit hundreds of stdout lines/sec (bot AI logging).
// Forwarding every pipe chunk as its own WS message floods browsers — the
// per-message overhead (JSON parse + xterm write) is what makes the UI laggy,
// not the byte volume. Coalesce and flush on a short tick. Buffering as a list
// of per-stream runs (not one buffer per stream) keeps stdout/stderr in true
// arrival order, so a stderr crash message still renders where it happened.
const OUTPUT_FLUSH_MS = 100;
let pendingOutput: { stream: "stdout" | "stderr"; data: string }[] = [];
let outputFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushProcessOutput(): void {
  if (outputFlushTimer) {
    clearTimeout(outputFlushTimer);
    outputFlushTimer = null;
  }
  const runs = pendingOutput;
  pendingOutput = [];
  for (const run of runs) {
    wsBroadcast("process_output", run);
  }
}

function queueProcessOutput(stream: "stdout" | "stderr", data: string): void {
  const last = pendingOutput[pendingOutput.length - 1];
  if (last && last.stream === stream) {
    last.data += data;
  } else {
    pendingOutput.push({ stream, data });
  }
  outputFlushTimer ??= setTimeout(flushProcessOutput, OUTPUT_FLUSH_MS);
}

processManager.on("stdout", (data: string) => {
  queueProcessOutput("stdout", data);
  // Feed to playlist manager unbatched — level-end detection stays immediate
  playlistManager.onStdoutChunk(data);
  lineMonitor.push(data);
});

processManager.on("stderr", (data: string) => {
  queueProcessOutput("stderr", data);
});

// Logging failed to materialize (bad/unwritable dir, stream error). Surface it
// as an error toast so a soak that's writing nowhere is caught in seconds, not
// discovered hours later.
processManager.on("logWarning", (message: string) => {
  wsBroadcast("error", { message });
});

/**
 * Re-attach to the server the previous Pyrodeck run launched, if it is still
 * running (D3Server3 does the same with its saved process IDs). What works
 * afterwards: status, console, Stop, the supervisor, playlist level
 * detection (from the console). What does not: the server's stdout is gone
 * with the old Pyrodeck, so the Output tab and the log file get nothing more,
 * and its exit code is not known.
 */
async function reattachToRunningServer(): Promise<void> {
  const record = await readRunRecord(CONFIG_DIR);
  if (!record) return;
  const forget = async (why: string) => {
    console.log(`[Pyrodeck] Not re-attaching to server PID ${record.pid}: ${why}`);
    await clearRunRecord(CONFIG_DIR);
  };

  const decision = decideAdopt(record, await readProcessFacts(record.pid), process.platform);
  if (!decision.adopt) return forget(decision.reason);

  let password: string | null;
  try {
    const cfg = await fs.readFile(path.join(record.gamePath, record.configFile), "utf-8");
    password = extractTelnetConfig(parseDedicatedCfg(cfg)).password ?? null;
  } catch {
    password = null;
  }
  if (!password) {
    // Leave the record: the server runs, Pyrodeck just cannot log in to it.
    console.warn(`[Pyrodeck] Server PID ${record.pid} is still running, but ${record.configFile} has no console password; not re-attaching.`);
    return;
  }

  // A server started with -useip has its console on that address only.
  const launchOptions = sanitizeStoredLaunchOptions(record.launchOptions);
  const host = consoleHostName(consoleHostFor(launchOptions) ?? undefined);

  if (process.platform !== "linux") {
    // Only "a process with this PID is alive" is known here; prove it is the
    // server by logging in to its console first.
    const probe = new TelnetConnection();
    try {
      await probe.connect(host, record.telnetPort, password);
    } catch (err) {
      return forget(`no server answers on console port ${record.telnetPort} (${err instanceof Error ? err.message : err})`);
    } finally {
      await probe.disconnect();
    }
  }

  const linux = record.linux;
  const isAlive = async (): Promise<boolean> => {
    const facts = await readProcessFacts(record.pid);
    return facts.alive && (!linux || facts.linux?.startTicks === linux.startTicks);
  };
  const config: LaunchConfig = {
    executablePath: record.executablePath,
    gamePath: record.gamePath,
    configFile: record.configFile,
    logPath: record.logPath ?? undefined,
    telnetPort: record.telnetPort,
    telnetPassword: password,
    profileId: record.profileId ?? undefined,
    launchOptions,
  };

  processManager.removeAllListeners("telnetReady");
  processManager.once("telnetReady", (port: number) => {
    connectConsole(host, port, password, { again: true, anchorPlaylist: true }).catch((err) => {
      wsBroadcast("error", {
        message: `Re-attached to the running server, but its console login failed (${err instanceof Error ? err.message : err}). Retrying every 5 s.`,
      });
      scheduleConsoleReconnect(host, port, password);
    });
  });
  processManager.adopt({ pid: record.pid, startedAt: new Date(record.startedAt), config, args: record.args, isAlive });
  console.log(`[Pyrodeck] Re-attached to the server Pyrodeck launched before it restarted (PID ${record.pid})`);
}

/**
 * Start a server from a profile, or from the global dedicated.cfg without
 * one: the path behind POST /api/launcher/start, also taken by the weekly
 * schedule.
 */
export async function startServer(opts: { profileId?: string; reason: "manual" | "schedule" }): Promise<LaunchResult> {
  if (processManager.isRunning()) {
    return { ok: false, code: 409, error: "Server is already running" };
  }
  takeOverFromRotation();

  const config = pyrodeckConfig.get();

  // Resolve config file and effective paths from profile (if specified)
  let configFile = "dedicated.cfg";
  // Label used to auto-name the log file for this launch; profile name when
  // launching a profile, otherwise the config filename.
  let logLabel = path.basename(configFile, path.extname(configFile));
  // Start with global config; profile may override these
  let gamePath = config.gamePath;
  let executablePath = config.executablePath;
  let launchOptions: LaunchOptions | null = null;
  // Only a profile launch owns the block in the Startup Commands file.
  let autoexecBlock: string[] | undefined;

  if (opts.profileId) {
    // Use a base manager (gamePath unused for reading profiles.json from CONFIG_DIR)
    const profileManager = new ServerProfileManager(CONFIG_DIR, gamePath ?? "");
    try {
      const profile = await profileManager.read(opts.profileId);
      configFile = profile.configFile;
      logLabel = profile.name;
      // Per-profile path overrides take precedence over global config
      if (profile.gamePath) gamePath = profile.gamePath;
      if (profile.executablePath) executablePath = profile.executablePath;
      launchOptions = sanitizeStoredLaunchOptions(profile.launchOptions);
      autoexecBlock = buildTeamSettingLines(sanitizeStoredTeamSettings(profile.teamSettings));
      await profileManager.markLaunched(opts.profileId);
    } catch {
      return { ok: false, code: 404, error: `Profile not found: ${opts.profileId}` };
    }
  }

  if (!gamePath || !executablePath) {
    return {
      ok: false,
      code: 400,
      error: "Game path and executable not configured (set in Pyrodeck Settings or add overrides to the profile)",
    };
  }

  const cfgPath = path.join(gamePath, configFile);

  // Parse the config file for the telnet port/password. Both are always set
  // from the parsed config below before use (every other path returns), so
  // they're declared without a dead initializer.
  let telnetPort: number;
  let telnetPassword: string;

  try {
    const cfgContent = await fs.readFile(cfgPath, "utf-8");
    const entries = parseDedicatedCfg(cfgContent);
    const telnetCfg = extractTelnetConfig(entries);

    if (!telnetCfg.enabled) {
      return {
        ok: false,
        code: 400,
        error:
          "AllowRemoteConsole is not enabled in " +
          configFile +
          ". Pyrodeck requires remote console access.",
      };
    }

    telnetPort = telnetCfg.port;
    telnetPassword = telnetCfg.password ?? "";
  } catch {
    return {
      ok: false,
      code: 400,
      error: `Cannot read config file: ${cfgPath}`,
    };
  }

  if (!telnetPassword) {
    return {
      ok: false,
      code: 400,
      error:
        "ConsolePassword not set in " +
        configFile +
        ". Pyrodeck needs a password to connect.",
    };
  }

  // Disconnect any existing session
  const existing = sessionManager.getActive();
  if (existing) {
    sessionManager.remove(existing.id);
  }

  // Resolve executable path (if relative, join with gamePath)
  // executablePath is already set from profile override or global config above
  if (!path.isAbsolute(executablePath)) {
    executablePath = path.join(gamePath, executablePath);
  }

  // Log file: auto-named per launch in the configured log directory (default:
  // next to the executable). Create the directory and the file itself BEFORE
  // launch so a missing or unwritable target fails loudly instead of silently
  // logging into the void for hours.
  const logDir = resolveLogDir(config.logDir, executablePath);
  const logPath = path.join(logDir, buildLogFilename(logLabel));
  const logError = await prepareLogFile(logPath);
  if (logError) {
    return {
      ok: false,
      code: 400,
      error: `${logError} Set a valid Log Directory in the Logs panel.`,
    };
  }

  // If a playlist is active and hasn't been synced to a server yet, override
  // the profile's MissionName/SetLevel with the playlist's current entry
  // BEFORE launch — otherwise the first level would be whatever the config
  // has, and the playlist wouldn't kick in until the first "Ending level."
  const initialEntry = playlistManager.consumeInitialSync();
  if (initialEntry) {
    const profileManager = new ServerProfileManager(CONFIG_DIR, gamePath);
    try {
      await profileManager.ensureConfigReference(
        configFile,
        "MissionName",
        initialEntry.missionName,
      );
      if (initialEntry.startingLevel !== undefined) {
        await profileManager.ensureConfigReference(
          configFile,
          "SetLevel",
          String(initialEntry.startingLevel),
        );
      }
      console.log(
        `[Playlist] Pre-launch: wrote MissionName=${initialEntry.missionName} to ${configFile}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: 500,
        error: `Failed to apply playlist mission to config: ${message}`,
      };
    }
  }

  // Register auto-connect handler BEFORE calling start() so it's ready when telnet fires
  registerAutoConnect(telnetPassword);

  // Start the D3 process
  try {
    await processManager.start(
      {
        executablePath,
        gamePath,
        configFile,
        logPath,
        telnetPort,
        telnetPassword,
        profileId: opts.profileId,
        launchOptions,
        autoexecBlock,
      },
      opts.reason,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 500, error: message };
  }

  return { ok: true, status: processManager.getStatus() };
}

export async function launcherRoutes(app: FastifyInstance): Promise<void> {
  // pyrodeck.json is loaded by now (it was not when this module was evaluated).
  supervisor.applySettings(pyrodeckConfig.get().supervisor);
  app.addHook("onClose", async () => supervisor.dispose());
  try {
    await reattachToRunningServer();
  } catch (err) {
    console.warn(`[Pyrodeck] Re-attach failed: ${err instanceof Error ? err.message : err}`);
  }

  app.post("/api/launcher/start", async (request, reply) => {
    const body = (request.body ?? {}) as { profileId?: string };
    const result = await startServer({ profileId: body.profileId, reason: "manual" });
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    return {
      status: result.status,
      message: "Server starting",
    };
  });

  app.post("/api/launcher/stop", async (_request, reply) => {
    const result = await stopServer("manual");
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    return { ok: true, status: result.status };
  });

  app.get("/api/launcher/status", async () => {
    return {
      ...processManager.getStatus(),
      missionHost: missionHost.getStatus(),
      supervisor: supervisor.snapshot(),
    };
  });

  /** GET /api/launcher/supervisor: the saved settings and the live state. */
  app.get("/api/launcher/supervisor", async () => supervisor.snapshot());

  /**
   * PUT /api/launcher/supervisor  { relaunchOnCrash, hangCheck, hangProbeAfterSec,
   *   hangRestartAfterSec, emptyRestart, emptyRestartAfterHours, emptyRestartGraceSec }
   * Fields left out keep their saved value. Applies at once.
   */
  app.put("/api/launcher/supervisor", async (request, reply) => {
    const check = validateSupervisorSettings(request.body, pyrodeckConfig.get().supervisor);
    if (check.errors.length > 0) {
      return reply.status(400).send({ error: check.errors.join(" "), errors: check.errors });
    }
    await pyrodeckConfig.save({ supervisor: check.settings });
    supervisor.applySettings(check.settings);
    return supervisor.snapshot();
  });

  /** POST /api/launcher/supervisor/cancel-relaunch: leave a crashed server down. */
  app.post("/api/launcher/supervisor/cancel-relaunch", async (_request, reply) => {
    if (!supervisor.cancelRelaunch()) {
      return reply.status(409).send({ error: "No relaunch is pending" });
    }
    return supervisor.snapshot();
  });

  app.get("/api/launcher/detect", async (_request, reply) => {
    const config = pyrodeckConfig.get();
    if (!config.gamePath) {
      return reply.status(400).send({ error: "Game path not configured" });
    }

    const gamePath = config.gamePath;
    const hogFiles: string[] = [];
    const missionFiles: string[] = [];

    try {
      const entries = await fs.readdir(gamePath);
      for (const entry of entries) {
        const lower = entry.toLowerCase();
        if (lower.endsWith(".hog")) hogFiles.push(entry);
        if (lower.endsWith(".mn3")) missionFiles.push(entry);
      }
    } catch {
      return reply.status(500).send({ error: "Cannot read game directory" });
    }

    return { hogFiles, missionFiles };
  });
}
