import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { ProcessManager } from "../launcher/ProcessManager.js";
import {
  parseDedicatedCfg,
  extractTelnetConfig,
} from "../launcher/ConfigGenerator.js";
import { TelnetConnection } from "../connection/TelnetConnection.js";
import {
  parseServercaps,
  VANILLA_CAPS,
  type ServerCapabilities,
} from "../parser/parsers/servercaps.js";
import { sessionManager, serializeCaps } from "./server.js";
import { wsBroadcast, wireSessionToClients } from "./command.js";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { ServerProfileManager } from "../config/ServerProfile.js";
import type { PlaylistEntry } from "../launcher/PlaylistManager.js";
import { playlistManager } from "../launcher/playlistInstance.js";

export { playlistManager };

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

export const processManager = new ProcessManager();

// Restore playlist activation state from disk on startup
playlistManager.restoreState().catch(() => {});

// Wire playlist events to WebSocket broadcasts
playlistManager.on("timerUpdate", (gameEndAt: number | null) => {
  wsBroadcast("playlist_timer", { gameEndAt });
});

// A new level is loading (level rotation, $warp, $endlevel) — tell clients so
// they can drop their stale countdown, re-query $netgameinfo, and show which
// level is now loaded.
playlistManager.on("levelChanged", (level: string | null) => {
  wsBroadcast("level_changed", { level });
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
 * Register a one-shot telnetReady handler so auto-connect fires after (re)start.
 * Called from POST /start and from the playlist rotate handler.
 */
function registerAutoConnect(telnetPassword: string): void {
  // Remove any stale once-handler from a launch that crashed before telnet was ready
  processManager.removeAllListeners("telnetReady");

  processManager.once("telnetReady", async (port: number) => {
    console.log(`[Pyrodeck] D3 telnet ready on port ${port}, auto-connecting...`);

    try {
      // Disconnect any stale session
      const existing = sessionManager.getActive();
      if (existing) {
        sessionManager.remove(existing.id);
      }

      const connection = new TelnetConnection();
      const session = sessionManager.create(
        connection,
        "localhost",
        port,
        telnetPassword,
      );

      sessionManager.updateState(session.id, "connecting");
      await connection.connect("localhost", port, telnetPassword);

      // Probe capabilities
      sessionManager.updateState(session.id, "probing");
      let capabilities: ServerCapabilities;
      try {
        const capsResponse = await connection.send("$servercaps");
        const parsed = parseServercaps(capsResponse);
        capabilities = parsed ?? { ...VANILLA_CAPS, features: new Set() };
      } catch {
        capabilities = { ...VANILLA_CAPS, features: new Set() };
      }

      sessionManager.updateCapabilities(session.id, capabilities);
      sessionManager.updateState(session.id, "ready");
      wireSessionToClients();

      // Wire up graceful quit
      processManager.sendQuitFn = async () => {
        try { await connection.send("quit"); } catch { /* connection may be dead */ }
      };

      // Wire playlist manager's command sender
      playlistManager.sendCommandFn = async (cmd: string) => connection.send(cmd);

      // Transition out of "restarting" if this connect is the post-rotation
      // resume; ensure subsequent "Ending level." events fire rotations again.
      playlistManager.markRotationComplete();

      // Anchor playlist timer if a playlist is active
      if (playlistManager.isActive()) {
        playlistManager.anchorTimer().catch(() => {});
      }

      // Broadcast to WS clients
      wsBroadcast("connection_state", { state: "ready" });
      wsBroadcast("capabilities", serializeCaps(capabilities));

      // Broadcast current playlist status
      const playlistStatus = playlistManager.getStatus();
      if (playlistStatus.activePlaylistId) {
        wsBroadcast("playlist_status", playlistStatus as unknown as Record<string, unknown>);
      }

      console.log(`[Pyrodeck] Launch Mode: auto-connected to D3 server (session ${session.id})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Pyrodeck] Launch Mode: telnet auto-connect failed: ${message}`);
      wsBroadcast("error", { message: `Auto-connect failed: ${message}` });
      // If this auto-connect was the post-rotation resume, unstick the playlist
      // manager so future "Ending level." events can rotate again.
      playlistManager.markRotationComplete();
    }
  });
}

// Rotate: stop server, swap mission CVar, restart
playlistManager.on("rotate", async (entry: PlaylistEntry) => {
  const config = pyrodeckConfig.get();
  const globalGamePath = config.gamePath;

  console.log(`[Playlist] Rotate triggered for entry: ${entry.label} (${entry.missionName})`);

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
    await processManager.stop();
  }

  // Resolve the active profile via profiles.json (profile records live in
  // CONFIG_DIR; we only need a valid gamePath for the ServerProfileManager's
  // file ops AFTER we pick the profile, so pass an empty string initially).
  const metadataManager = new ServerProfileManager(CONFIG_DIR, "");
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
    try {
      const cfgContent = await fs.readFile(cfgPath, "utf-8");
      const entries = parseDedicatedCfg(cfgContent);
      const telnetCfg = extractTelnetConfig(entries);

      if (telnetCfg.enabled && telnetCfg.password) {
        let executablePath = executablePathRaw;
        if (!path.isAbsolute(executablePath)) {
          executablePath = path.join(gamePath, executablePath);
        }
        const logPath = activeProfile.logPath ?? path.join(CONFIG_DIR, "server.log");

        // Register auto-connect handler BEFORE calling start()
        registerAutoConnect(telnetCfg.password);

        await profileManager.markLaunched(activeProfile.id);
        await processManager.start({
          executablePath,
          gamePath,
          configFile: activeProfile.configFile,
          logPath,
          telnetPort: telnetCfg.port,
          telnetPassword: telnetCfg.password,
        });

        wsBroadcast("playlist_rotate", {
          entry: { id: entry.id, label: entry.label, missionName: entry.missionName },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Playlist] Restart failed: ${message}`);
      wsBroadcast("error", { message: `Playlist restart failed: ${message}` });
      playlistManager.markRotationComplete();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Playlist] Rotation error: ${message}`);
    wsBroadcast("error", { message: `Playlist rotation error: ${message}` });
    playlistManager.markRotationComplete();
  }
});

// Wire process events to WebSocket broadcasts
processManager.on("stateChange", (state: string) => {
  wsBroadcast("process_state", { state });
  // The loaded level is gone once the process is down; forget it so a stale
  // name isn't reported on the next connect. A restart re-populates it from
  // the next "Opening level" line.
  if (state === "stopped" || state === "crashed") {
    playlistManager.clearCurrentLevel();
  }
});

processManager.on("stdout", (data: string) => {
  wsBroadcast("process_output", { stream: "stdout", data });
  // Feed to playlist manager for level-end detection and vote parsing
  playlistManager.onStdoutChunk(data);
});

processManager.on("stderr", (data: string) => {
  wsBroadcast("process_output", { stream: "stderr", data });
});

export async function launcherRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/launcher/start", async (request, reply) => {
    if (processManager.isRunning()) {
      return reply.status(409).send({ error: "Server is already running" });
    }

    const body = request.body as {
      profileId?: string;
      telnetPort?: number;
    };

    const config = pyrodeckConfig.get();

    // Resolve config file and effective paths from profile (if specified)
    let configFile = "dedicated.cfg";
    let profileLogPath: string | undefined;
    // Start with global config; profile may override these
    let gamePath = config.gamePath;
    let executablePath = config.executablePath;

    if (body.profileId) {
      // Use a base manager (gamePath unused for reading profiles.json from CONFIG_DIR)
      const profileManager = new ServerProfileManager(CONFIG_DIR, gamePath ?? "");
      try {
        const profile = await profileManager.read(body.profileId);
        configFile = profile.configFile;
        profileLogPath = profile.logPath;
        // Per-profile path overrides take precedence over global config
        if (profile.gamePath) gamePath = profile.gamePath;
        if (profile.executablePath) executablePath = profile.executablePath;
        await profileManager.markLaunched(body.profileId);
      } catch {
        return reply.status(404).send({ error: `Profile not found: ${body.profileId}` });
      }
    }

    if (!gamePath || !executablePath) {
      return reply.status(400).send({
        error: "Game path and executable not configured (set in Pyrodeck Settings or add overrides to the profile)",
      });
    }

    const cfgPath = path.join(gamePath, configFile);

    // Parse the config file to get telnet password
    let telnetPort = body.telnetPort ?? config.defaultTelnetPort;
    let telnetPassword = "";

    try {
      const cfgContent = await fs.readFile(cfgPath, "utf-8");
      const entries = parseDedicatedCfg(cfgContent);
      const telnetCfg = extractTelnetConfig(entries);

      if (!telnetCfg.enabled) {
        return reply.status(400).send({
          error:
            "AllowRemoteConsole is not enabled in " +
            configFile +
            ". Pyrodeck requires remote console access.",
        });
      }

      telnetPort = telnetCfg.port;
      telnetPassword = telnetCfg.password ?? "";
    } catch {
      return reply.status(400).send({
        error: `Cannot read config file: ${cfgPath}`,
      });
    }

    if (!telnetPassword) {
      return reply.status(400).send({
        error:
          "ConsolePassword not set in " +
          configFile +
          ". Pyrodeck needs a password to connect.",
      });
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

    // Log file: use profile-specific path if set, otherwise default to config dir
    const logPath = profileLogPath ?? path.join(CONFIG_DIR, "server.log");

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
        return reply.status(500).send({
          error: `Failed to apply playlist mission to config: ${message}`,
        });
      }
    }

    // Register auto-connect handler BEFORE calling start() so it's ready when telnet fires
    registerAutoConnect(telnetPassword);

    // Start the D3 process
    try {
      await processManager.start({
        executablePath,
        gamePath,
        configFile,
        logPath,
        telnetPort,
        telnetPassword,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }

    return {
      status: processManager.getStatus(),
      message: "Server starting",
    };
  });

  app.post("/api/launcher/stop", async (_request, reply) => {
    if (!processManager.isRunning()) {
      return reply.status(409).send({ error: "Server is not running" });
    }

    playlistManager.sendCommandFn = null;

    // Stop while the telnet session is still wired so ProcessManager can try
    // a graceful `quit` first (via sendQuitFn) before escalating to SIGTERM.
    // If D3's exit leaves the telnet 4-tuple in TIME_WAIT, waitForPortFree()
    // absorbs that on the next launch.
    await processManager.stop();

    // Clean up session after the process is down
    processManager.sendQuitFn = null;
    const session = sessionManager.getActive();
    if (session) {
      sessionManager.remove(session.id);
    }

    wsBroadcast("connection_state", { state: "disconnected" });

    return { ok: true, status: processManager.getStatus() };
  });

  app.get("/api/launcher/status", async () => {
    return processManager.getStatus();
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
