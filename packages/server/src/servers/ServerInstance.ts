import type { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ProcessManager,
  type LaunchConfig,
  type ProcessStatus,
  type StartReason,
  type StopReason,
} from "../launcher/ProcessManager.js";
import { resolveLogDir, buildLogFilename, prepareLogFile } from "../launcher/logPaths.js";
import { parseDedicatedCfg, extractTelnetConfig } from "../launcher/ConfigGenerator.js";
import { TelnetConnection } from "../connection/TelnetConnection.js";
import type { ServerConnection } from "../connection/ServerConnection.js";
import { probeCapabilitiesDetailed } from "../session/probeCapabilities.js";
import type { ServerSession, SessionManager } from "../session/SessionManager.js";
import { parseNetgameinfo } from "../parser/parsers/netgameinfo.js";
import { serializeCaps } from "../parser/parsers/servercaps.js";
import type { PyrodeckConfig } from "../config/PyrodeckConfig.js";
import { ServerProfileManager, type ServerProfile } from "../config/ServerProfile.js";
import type { ConsoleLink } from "../players/consoleLink.js";
import type { PlaylistEntry, PlaylistManager } from "../launcher/PlaylistManager.js";
import { RotationHealthMonitor } from "../launcher/RotationHealthMonitor.js";
import { findIncompatibleEntries } from "../gamefiles/playlistCompat.js";
import { buildPostStartCommands } from "../launcher/postStartSettings.js";
import {
  consoleHostFor,
  consoleWarnings,
  localConsoleUseipNote,
  sanitizeStoredLaunchOptions,
  type LaunchOptions,
} from "../launcher/launchOptions.js";
import { buildTeamSettingLines, sanitizeStoredTeamSettings } from "../launcher/teamSettings.js";
import { ProfileAutomation } from "../launcher/profileAutomation.js";
import { NO_PROFILE_ID, serverEvents, type ServerEvents } from "../events/ServerEvents.js";
import { ConsoleQuitWatch } from "../launcher/consoleQuit.js";
import { chatName, sayToAll } from "../players/playerActions.js";
import { Supervisor, type ProcessDown, type SupervisorOptions } from "../launcher/Supervisor.js";
import { Autostart, type AutostartOptions } from "../launcher/Autostart.js";
import { chooseAutostartProfile, type AutostartChoice } from "../launcher/autostartSettings.js";
import {
  RUN_RECORD_FILE,
  clearRunRecord,
  decideAdopt,
  readLinuxIdentity,
  readProcessFacts,
  readRunRecord,
  writeRunRecord,
  type LinuxIdentity,
  type ProcessFacts,
  type RunRecord,
} from "../launcher/runRecord.js";

/**
 * What a server instance uses of its game process: ProcessManager, or a
 * stand-in in tests. The events are ProcessManager's.
 */
export type GameProcess = Pick<
  ProcessManager,
  | "sendQuitFn"
  | "start"
  | "stop"
  | "adopt"
  | "getStatus"
  | "getLaunchConfig"
  | "getActiveLogPath"
  | "isRunning"
  | "consoleHost"
  | "noteConsoleQuit"
> &
  Pick<EventEmitter, "on" | "once" | "removeAllListeners">;

/** The Pyrodeck settings a server reads (pyrodeck.json). */
export type InstanceSettings = Pick<PyrodeckConfig, "gamePath" | "executablePath" | "logDir" | "autostart">;

/** Send a message to every browser (routes/command.ts wsBroadcast). */
export type Broadcast = (type: string, payload: Record<string, unknown>) => void;

/** What re-attaching learns about a process (launcher/runRecord.ts); stand-ins in tests. */
export interface ProcessHost {
  platform: NodeJS.Platform;
  readProcessFacts(pid: number): Promise<ProcessFacts>;
  readLinuxIdentity(pid: number): Promise<LinuxIdentity | null>;
}

export interface InstanceTiming {
  /** Log in again this long after the console link drops. */
  consoleReconnectMs: number;
  /** Process output is sent to the browsers in batches this often. */
  outputFlushMs: number;
  /** Pause between the "Changing mission" chat line and the stop of a rotation. */
  rotationAnnounceMs: number;
}

export const DEFAULT_TIMING: InstanceTiming = {
  // D3Server3 logs in again 5 s after its console link drops.
  consoleReconnectMs: 5_000,
  outputFlushMs: 100,
  rotationAnnounceMs: 1_000,
};

/** A launch the guard let through: the launch to spawn, with the ports and files held until release(). */
export type LaunchPass = { ok: true; launch: LaunchConfig; release: () => void } | { ok: false; error: string };

/**
 * Checks every launch against the other servers Pyrodeck runs
 * (servers/ServerRegistry.ts): refuses one that would share a port or a file
 * with a running server, and adds Pyrodeck's per-server defaults (its own
 * -tempdir, a free -gamespyport) where the profile sets none.
 */
export interface LaunchGuard {
  reserve(serverId: string, launch: LaunchConfig): Promise<LaunchPass>;
}

/** A launch the guard refused; its message says why. */
export class LaunchRefusedError extends Error {}

/** The launch whose ports and files a server holds, for the other servers' launch checks. */
export interface HeldLaunch {
  launch: LaunchConfig;
  pid: number | null;
  /** Why it is held: "running", "restarting", or a server from before Pyrodeck's restart not re-attached. */
  why: string;
}

export interface ServerInstanceOptions {
  id: string;
  /**
   * The profile this server runs, or null for the server launched without
   * one (the global dedicated.cfg). Unset: it launches whichever profile
   * start() names, as the single server of a Pyrodeck that ran one did.
   */
  profileId?: string | null;
  /** Where profiles.json, running-server.json and the playlist state are kept. */
  configDir: string;
  settings: () => InstanceSettings;
  /** The console session store, shared with the other servers and Connect mode. */
  sessions: SessionManager;
  /** The playlist this server rotates through. */
  playlist: PlaylistManager;
  broadcast: Broadcast;
  /** Stream a ready session's console output to the browsers. */
  wireSessionToClients: (session: ServerSession) => void;
  /** None: every launch goes ahead as asked (one server). */
  launchGuard?: LaunchGuard;
  /** The run record's file. Default: `<configDir>/running-server.json`. */
  runRecordPath?: string;
  /** Called after the run record was written (with it) or removed (null). */
  onRunRecord?: (record: RunRecord | null) => void;
  /**
   * Which profile autostart launches, or null for none. Default: the one
   * PYRODECK_AUTOSTART_PROFILE names, else the profile ticked "Start when
   * Pyrodeck starts".
   */
  autostartChoice?: () => Promise<AutostartChoice | null>;
  /** PYRODECK_AUTOSTART_PROFILE, read once at startup. */
  autostartEnv?: string | null;
  /** Default: the process-wide bus. */
  events?: ServerEvents;
  /** Default: a ProcessManager on `events`. */
  process?: GameProcess;
  /** Default: a new monitor with the standard deadline. */
  rotationHealth?: RotationHealthMonitor;
  /** A new console transport. Default: TelnetConnection. */
  createConnection?: () => ServerConnection;
  /** Default: this machine (process.platform, /proc). */
  host?: Partial<ProcessHost>;
  supervisor?: Omit<SupervisorOptions, "events">;
  autostart?: Omit<AutostartOptions, "events">;
  timing?: Partial<InstanceTiming>;
}

/** Result of start()/stop(): the new status, or an HTTP code and message. */
export type LaunchResult = { ok: true; status: ProcessStatus } | { ok: false; code: number; error: string };

export type StartRequest = {
  profileId?: string;
  reason: "manual" | "schedule" | "autostart";
};

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

interface RotationLaunch {
  label: string;
  telnetPassword: string;
  launch: LaunchConfig;
}

/** What a playlist rotation restarts (ServerInstance.rotationTarget). */
interface RotationTarget {
  /** Null for the server launched without a profile. */
  profile: ServerProfile | null;
  /** The log file's label. */
  name: string;
  configFile: string;
  gamePath: string | null | undefined;
  executablePath: string | null | undefined;
  launchOptions: LaunchOptions | null;
  autoexecBlock?: string[];
  startupFile?: string;
}

/**
 * Build a single-line vote prompt sized for D3's 2-line chat window.
 * Example: "Vote next mission (type 1-3): 1=Abend2  2=Stadium  3=BBQ"
 */
// Labels and voters' names are the operator's and the players' text: every
// line goes through sayToAll (no `%`, printable ASCII, no colon, which the
// engine would read as a chat destination).
function buildVotePromptLine(options: PlaylistEntry[]): string {
  const parts = options.map((o, i) => `${i + 1}=${o.label}`).join("  ");
  return sayToAll(`Vote next mission (type 1-${options.length}) - ${parts}`);
}

/** Remove a log file Pyrodeck created for a launch that went to another file, if nothing was written to it. */
async function removeIfEmpty(file: string): Promise<void> {
  try {
    if ((await fs.stat(file)).size === 0) await fs.rm(file, { force: true });
  } catch {
    // gone already
  }
}

/**
 * The address to log in to the launched console at (ProcessManager.consoleHost):
 * 127.0.0.1, which an AllowRemoteConsole=0 console accepts and nothing else,
 * or the -useip address of an AllowRemoteConsole=1 console.
 */
function consoleHostName(host: string | undefined): string {
  return host || "127.0.0.1";
}

/**
 * Say in Pyrodeck's log what the launched profile's console exposes
 * (launchOptions.ts consoleWarnings): an AllowRemoteConsole=1 console is open
 * to the network, and the -useip case older engines cannot log in to.
 */
function logConsoleWarnings(configFile: string, launch: Pick<LaunchConfig, "launchOptions" | "allowRemoteConsole" | "telnetPort">): void {
  for (const w of consoleWarnings(launch.launchOptions, launch.allowRemoteConsole ?? true, launch.telnetPort)) {
    console.warn(`[Pyrodeck] ${configFile}: ${w}`);
  }
}

/**
 * One game server Pyrodeck runs: its process, the console session Pyrodeck
 * logs in to, and everything that watches or restarts it (the supervisor,
 * autostart and its crash-loop guard, the playlist rotation and its restart
 * health check, the profile's console automation, the run record that lets
 * the next Pyrodeck re-attach, the output sent to the browsers).
 *
 * The console session lives in the SessionManager shared with the other
 * servers and Connect mode; this server only ever uses, replaces or closes the
 * session it opened (the session's owner is this server's id). With the
 * registry's scoped bus as `events`, its watchers hear only this server's
 * events.
 *
 * Order of effects when the process changes state (onStateChange): the
 * buffered output is sent first, then the new state; the loaded level is
 * forgotten; a crash fails a playlist restart that is being health-checked;
 * then the reconnect timer stops, the run record is removed, and the down
 * process is reported to autostart's guard before the supervisor, so a
 * tripped guard is in place before a relaunch would be scheduled.
 */
export class ServerInstance {
  readonly id: string;
  readonly process: GameProcess;
  readonly events: ServerEvents;
  readonly playlist: PlaylistManager;
  readonly rotationHealth: RotationHealthMonitor;
  /** Periodic commands and respawn scaling for the launched profile (server.started → console ready → exit). */
  readonly profileAutomation: ProfileAutomation;
  /**
   * D3Server3 parity: relaunch after a crash, kill and relaunch a hung
   * server, restart an empty one after an uptime limit. Settings are global
   * (pyrodeck.json); see launcher/Supervisor.ts for the rules.
   */
  readonly supervisor: Supervisor;
  /**
   * Launch a profile when Pyrodeck starts (PYRODECK_AUTOSTART_PROFILE, or the
   * profile ticked "Start when Pyrodeck starts"), after re-attach, with a
   * crash-loop guard over the supervisor's relaunches (launcher/Autostart.ts).
   */
  readonly autostart: Autostart;
  /** The profile PYRODECK_AUTOSTART_PROFILE names; read once, like the other PYRODECK_* settings. */
  readonly autostartEnv: string | null;
  /** The profile this server runs (null: none, the global dedicated.cfg); undefined: any. */
  readonly profileId: string | null | undefined;

  private readonly configDir: string;
  private readonly settings: () => InstanceSettings;
  private readonly sessions: SessionManager;
  private readonly broadcast: Broadcast;
  private readonly wireSessionToClients: (session: ServerSession) => void;
  private readonly createConnection: () => ServerConnection;
  private readonly host: ProcessHost;
  private readonly timing: InstanceTiming;
  private readonly launchGuard: LaunchGuard | null;
  private readonly runRecordDir: string;
  private readonly runRecordName: string;
  private readonly onRunRecord: (record: RunRecord | null) => void;
  /** The console session this server opened, by id. */
  private sessionId: string | null = null;
  /** A playlist rotation is between stopping the server and spawning the next mission's. */
  private rotating = false;
  /** A server from before Pyrodeck's restart that still runs but could not be re-attached to. */
  private unattached: RunRecord | null = null;

  /**
   * A `quit` typed at a remote console, read from the launched process's
   * stdout (from the console for a re-attached one): its exit is then a stop
   * on request, not a crash. Joins, leaves, chat and level starts reach the
   * bus from the console event hub (events/consoleEventHub.ts).
   */
  private readonly quitWatch: ConsoleQuitWatch;
  /**
   * The running server's PID and launch, on disk, so the next Pyrodeck can
   * re-attach to it (reattachToRunningServer). Writes and removals are queued
   * so a quick exit cannot leave a stale record behind.
   */
  private runRecordQueue: Promise<void> = Promise.resolve();
  /** Playlist activation state restored from disk; autostart waits for it, so its launch sees the playlist as the Launch button would. */
  private readonly playlistRestored: Promise<void>;
  /** The launch the current rotation is trying to bring up (kept for the retry). */
  private currentRotationLaunch: RotationLaunch | null = null;
  /**
   * Set by re-attach when a server from before Pyrodeck's restart still runs
   * but could not be re-attached to: autostart must not launch a second one
   * onto its ports.
   */
  private reattachBlock: string | null = null;
  private consoleReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingOutput: { stream: "stdout" | "stderr"; data: string }[] = [];
  private outputFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ServerInstanceOptions) {
    this.id = options.id;
    this.profileId = options.profileId;
    this.configDir = options.configDir;
    this.settings = options.settings;
    this.sessions = options.sessions;
    this.playlist = options.playlist;
    this.broadcast = options.broadcast;
    this.wireSessionToClients = options.wireSessionToClients;
    this.launchGuard = options.launchGuard ?? null;
    const runRecordPath = options.runRecordPath ?? path.join(options.configDir, RUN_RECORD_FILE);
    this.runRecordDir = path.dirname(runRecordPath);
    this.runRecordName = path.basename(runRecordPath);
    this.onRunRecord = options.onRunRecord ?? (() => {});
    this.autostartEnv = options.autostartEnv ?? null;
    this.events = options.events ?? serverEvents;
    this.process = options.process ?? new ProcessManager({ events: this.events });
    this.rotationHealth = options.rotationHealth ?? new RotationHealthMonitor();
    this.createConnection = options.createConnection ?? (() => new TelnetConnection());
    this.host = {
      platform: process.platform,
      readProcessFacts,
      readLinuxIdentity,
      ...options.host,
    };
    this.timing = { ...DEFAULT_TIMING, ...options.timing };

    // The listeners below are added in a fixed order: on each emitter, a
    // listener added earlier runs first.
    this.quitWatch = new ConsoleQuitWatch(() => this.process.noteConsoleQuit());
    this.events.onEvent("server.started", () => this.quitWatch.reset());
    this.events.onEvent("server.adopted", () => this.quitWatch.reset());

    this.events.onEvent("server.started", ({ pid, args }) => this.recordRun(pid, args));

    this.profileAutomation = new ProfileAutomation({
      loadProfile: (id) => this.profileList().read(id).catch(() => null),
    });
    this.profileAutomation.listen(this.events);
    this.process.on("exit", () => this.profileAutomation.serverDown());

    this.playlistRestored = this.playlist.restoreState().catch(() => {});

    this.playlist.on("timerUpdate", (gameEndAt: number | null) => {
      this.broadcast("playlist_timer", { gameEndAt });
    });

    // A new level is loading (level rotation, $warp, $endlevel) — tell clients so
    // they drop their stale countdown, re-anchor locally, and show which level is
    // now loaded. Clients do NOT re-query $netgameinfo (it leaks the engine text
    // buffer and crashes dedicated servers); they derive the countdown locally.
    this.playlist.on("levelChanged", (level: string | null) => {
      this.broadcast("level_changed", { level });
    });

    // The server re-queried $netgameinfo (activation/rotation only) — push the
    // fresh static config to all clients so their panels stay current without
    // any client-side polling.
    this.playlist.on("serverInfoRaw", (raw: string) => {
      const info = parseNetgameinfo(raw);
      if (info) this.broadcast("serverinfo", info as unknown as Record<string, unknown>);
    });

    this.playlist.on("voteAnnounce", (options: PlaylistEntry[], timeoutMs: number) => {
      this.broadcast("playlist_vote_announce", {
        options: options.map((o, i) => ({ index: i + 1, id: o.id, label: o.label, missionName: o.missionName })),
        timeoutMs,
        deadline: Date.now() + timeoutMs,
      });

      if (options.length > 0 && this.playlist.sendCommandFn) {
        this.playlist.sendCommandFn(buildVotePromptLine(options)).catch(() => {});
      }
    });

    // Periodic reminder — D3 chat clips to the last ~2 lines, so we re-send the
    // prompt every 10s while the vote is open so late joiners and busy players
    // still see it.
    this.playlist.on("voteReminder", (options: PlaylistEntry[]) => {
      if (options.length > 0 && this.playlist.sendCommandFn) {
        this.playlist.sendCommandFn(buildVotePromptLine(options)).catch(() => {});
      }
    });

    // Acknowledge votes in chat so players know their vote registered.
    this.playlist.on(
      "voteReceived",
      (payload: { playerName: string; option: PlaylistEntry; changed: boolean; voterCount: number }) => {
        if (!this.playlist.sendCommandFn) return;
        const verb = payload.changed ? "changed vote to" : "voted for";
        this.playlist.sendCommandFn(
          sayToAll(`[Vote ${payload.voterCount}] ${chatName(payload.playerName)} ${verb} ${payload.option.label}`),
        ).catch(() => {});
      },
    );

    this.playlist.on("voteResult", (winner: PlaylistEntry, counts: number[]) => {
      this.broadcast("playlist_vote_result", {
        winner: { id: winner.id, label: winner.label, missionName: winner.missionName },
        counts,
      });

      // Announce winner in-game
      if (this.playlist.sendCommandFn) {
        this.playlist.sendCommandFn(sayToAll(`Vote closed. Next mission is ${winner.label}`))
          .catch(() => {});
      }
    });

    // Playlist restart health (PLAN Phase 3 Step 6, best-effort rotation):
    // every rotation restart must come healthy within the deadline; one
    // automatic retry, then the playlist pauses with a visible reason instead
    // of rotating on behind a dead server.
    this.rotationHealth.on("healthy", (attempt: number) => this.onRotationHealthy(attempt));
    this.rotationHealth.on("retry", (attempt: number, reason: string) => this.onRotationRetry(attempt, reason));
    this.rotationHealth.on("failed", (reason: string) => {
      this.pauseAfterFailedRotation(reason);
    });

    // Pause/resume (and the health snapshot) reach every client.
    this.playlist.on("statusChanged", () => {
      this.broadcastPlaylistStatus();
    });

    // Rotate: stop server, swap mission CVar, restart
    this.playlist.on("rotate", (entry: PlaylistEntry) => this.rotate(entry));

    this.supervisor = new Supervisor(
      {
        relaunch: async () => {
          try {
            await this.relaunchLast();
          } catch (err) {
            // Autostart's crash-loop guard counts a relaunch that could not start.
            this.autostart.relaunchFailed(err instanceof Error ? err.message : String(err));
            throw err;
          }
        },
        stop: async (reason, options) => {
          await this.stop(reason, options);
        },
        command: async (cmd) => {
          const session = this.consoleSession();
          if (!session || session.state !== "ready" || !session.connection.isConnected()) {
            throw new Error("no console");
          }
          return session.connection.send(cmd);
        },
        isRunning: () => this.process.isRunning(),
        rotationPending: () => this.rotationHealth.isPending(),
        notify: (message, level) => {
          if (level === "error") {
            console.warn(`[Supervisor] ${message}`);
            this.broadcast("error", { message });
          } else {
            console.log(`[Supervisor] ${message}`);
          }
        },
      },
      { ...options.supervisor, events: this.events },
    );

    // A playlist holds the players before a restart only when one may be on (PlaylistManager.startHold).
    this.playlist.humansFn = () => this.supervisor.humansOnline();

    const autostartChoice =
      options.autostartChoice ??
      (async () => chooseAutostartProfile(this.autostartEnv, this.settings().autostart.profileId, await this.profileList().list()));
    this.autostart = new Autostart(
      {
        choose: autostartChoice,
        blockedBy: () => {
          if (this.process.isRunning()) {
            const { pid, adopted } = this.process.getStatus();
            return adopted
              ? `the server Pyrodeck launched before it restarted is still running (PID ${pid}) and was re-attached`
              : `a server is already running (PID ${pid})`;
          }
          return this.reattachBlock;
        },
        launch: async (profileId) => {
          await this.playlistRestored;
          const result = await this.start({ profileId, reason: "autostart" });
          return result.ok ? { ok: true } : { ok: false, error: result.error };
        },
        supervisorRelaunches: (down) => down.stopReason === "hang" || this.supervisor.getSettings().relaunchOnCrash,
        relaunchPending: () => this.supervisor.snapshot().pendingRelaunch !== null,
        stopRelaunching: (reason) => this.supervisor.giveUp(reason),
        notify: (message) => this.broadcast("error", { message }),
        log: { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) },
      },
      { ...options.autostart, events: this.events },
    );

    // Process events to the browsers, the playlist and the watchers.
    this.process.on("stateChange", (state: string) => this.onStateChange(state));

    this.process.on("stdout", (data: string) => {
      this.queueProcessOutput("stdout", data);
      // Feed to playlist manager unbatched — level-end detection stays immediate
      this.playlist.onStdoutChunk(data);
      this.quitWatch.push(data);
    });

    this.process.on("stderr", (data: string) => {
      this.queueProcessOutput("stderr", data);
    });

    // Logging failed to materialize (bad/unwritable dir, stream error). Surface it
    // as an error toast so a soak that's writing nowhere is caught in seconds, not
    // discovered hours later.
    this.process.on("logWarning", (message: string) => {
      this.broadcast("error", { message });
    });
  }

  // ---------------------------------------------------------------------------
  // Start and stop
  // ---------------------------------------------------------------------------

  /**
   * Start a server from a profile, or from the global dedicated.cfg without
   * one: the path behind POST /api/launcher/start, also taken by the weekly
   * schedule and by autostart.
   */
  async start(opts: StartRequest): Promise<LaunchResult> {
    if (this.process.isRunning()) {
      return { ok: false, code: 409, error: "Server is already running" };
    }
    const requested = opts.profileId ?? this.profileId ?? undefined;
    if (this.profileId !== undefined && (requested ?? null) !== this.profileId) {
      return {
        ok: false,
        code: 400,
        error: this.profileId
          ? `This server runs profile ${this.profileId}, not ${requested ?? "the global dedicated.cfg"}`
          : "This server runs the global dedicated.cfg, not a profile",
      };
    }
    this.takeOverFromRotation();

    const config = this.settings();

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
    let startupFile: string | undefined;

    if (requested) {
      // Use a base manager (gamePath unused for reading profiles.json from the config directory)
      const profileManager = new ServerProfileManager(this.configDir, gamePath ?? "");
      try {
        const profile = await profileManager.read(requested);
        configFile = profile.configFile;
        logLabel = profile.name;
        // Per-profile path overrides take precedence over global config
        if (profile.gamePath) gamePath = profile.gamePath;
        if (profile.executablePath) executablePath = profile.executablePath;
        launchOptions = sanitizeStoredLaunchOptions(profile.launchOptions);
        autoexecBlock = buildTeamSettingLines(sanitizeStoredTeamSettings(profile.teamSettings));
        startupFile = profile.startupFile;
        await profileManager.markLaunched(requested);
      } catch {
        return { ok: false, code: 404, error: `Profile not found: ${requested}` };
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

    // Parse the config file for the console port, password and
    // AllowRemoteConsole. They are always set from the parsed config below
    // before use (every other path returns), so they're declared without a dead
    // initializer. Either AllowRemoteConsole works for a server launched here:
    // with 0 Pyrodeck logs in on 127.0.0.1.
    let telnetPort: number;
    let telnetPassword: string;
    let allowRemoteConsole: boolean;

    try {
      const cfgContent = await fs.readFile(cfgPath, "utf-8");
      const entries = parseDedicatedCfg(cfgContent);
      const telnetCfg = extractTelnetConfig(entries);

      telnetPort = telnetCfg.port;
      telnetPassword = telnetCfg.password ?? "";
      allowRemoteConsole = telnetCfg.allowRemote;
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

    // Disconnect the session this server had open
    this.removeConsoleSession();

    // Resolve executable path (if relative, join with gamePath)
    // executablePath is already set from profile override or global config above
    if (!path.isAbsolute(executablePath)) {
      executablePath = path.join(gamePath, executablePath);
    }

    // Log file: auto-named per launch in the configured log directory (default:
    // next to the executable).
    const logDir = resolveLogDir(config.logDir, executablePath);
    const planned: LaunchConfig = {
      executablePath,
      gamePath,
      configFile,
      logPath: path.join(logDir, buildLogFilename(logLabel)),
      telnetPort,
      telnetPassword,
      allowRemoteConsole,
      profileId: requested,
      launchOptions,
      autoexecBlock,
      ...(startupFile ? { startupFile } : {}),
    };

    // A launch that would share a port or a file with another running server
    // is refused here, before anything is written.
    const pass = await this.passLaunchGuard(planned);
    if (!pass.ok) return { ok: false, code: 409, error: pass.error };
    const launch = pass.launch;
    try {
      // Create the log's directory and the file itself BEFORE launch so a
      // missing or unwritable target fails loudly instead of silently logging
      // into the void for hours.
      const logError = await prepareLogFile(launch.logPath!);
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
      const initialEntry = this.playlist.consumeInitialSync();
      if (initialEntry) {
        const profileManager = new ServerProfileManager(this.configDir, gamePath);
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

      logConsoleWarnings(configFile, { launchOptions, allowRemoteConsole, telnetPort });

      // Register auto-connect handler BEFORE calling start() so it's ready when telnet fires
      this.registerAutoConnect(telnetPassword);

      // Start the D3 process
      try {
        await this.process.start(launch, opts.reason);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, code: 500, error: message };
      }
    } finally {
      pass.release();
    }

    return { ok: true, status: this.process.getStatus() };
  }

  /**
   * Stop the launched server on request and drop its console session: the path
   * behind POST /api/launcher/stop, also taken by the supervisor and the weekly
   * schedule.
   *
   * A manual stop sends `quit` over the console (with a half-close, so the
   * server tells its clients it has gone and the port is left free), as a
   * playlist rotation does. Otherwise the session is closed first and the
   * process is signalled: closing from our side keeps the console port out of
   * TIME_WAIT, so a relaunch need not wait for the port (waitForPortFree).
   */
  async stop(reason: StopReason, options: { kill?: boolean } = {}): Promise<LaunchResult> {
    if (!this.process.isRunning()) {
      return { ok: false, code: 409, error: "Server is not running" };
    }
    this.takeOverFromRotation();
    this.playlist.sendCommandFn = null;
    if (reason !== "manual") this.dropConsoleSession();
    // A manual stop keeps the session wired so ProcessManager can try a
    // graceful `quit` first (via sendQuitFn) before escalating to SIGTERM.
    await this.process.stop(reason, options);
    this.dropConsoleSession();
    this.broadcast("connection_state", { state: "disconnected" });
    return { ok: true, status: this.process.getStatus() };
  }

  /**
   * Re-attach to the server the previous Pyrodeck run launched, if it still
   * runs. Call once at startup, before runAutostart(). Never throws: when it
   * is not known whether a server still runs, autostart is blocked.
   */
  async reattach(others: RunRecord[] = []): Promise<void> {
    try {
      this.reattachBlock = await this.reattachToRunningServer(others);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Pyrodeck] Re-attach failed: ${message}`);
      // Whether a server still runs is not known: do not launch another onto its ports.
      this.reattachBlock = `re-attaching to a server from before Pyrodeck's restart failed (${message})`;
    }
  }

  /** Run autostart (once), after reattach(). */
  runAutostart(): Promise<void> {
    return this.autostart.run();
  }

  /** A playlist restart is being health-checked. */
  rotationPending(): boolean {
    return this.rotationHealth.isPending();
  }

  /**
   * The `profileId` this server's events carry: its profile, NO_PROFILE_ID
   * for the server without one, or (a server not bound to a profile) the
   * profile of the current launch.
   */
  eventScopeId(): string {
    if (this.profileId !== undefined) return this.profileId ?? NO_PROFILE_ID;
    return this.process.getStatus().activeProfileId ?? NO_PROFILE_ID;
  }

  /** The console session this server opened, while it is open. */
  consoleSession(): ServerSession | undefined {
    if (this.sessionId === null) return undefined;
    const session = this.sessions.get(this.sessionId);
    return session && session.state !== "disconnected" ? session : undefined;
  }

  /** This server's console once logged in, for the player, ban and rule services; else null. */
  consoleLink(): ConsoleLink | null {
    const session = this.consoleSession();
    if (!session || session.state !== "ready") return null;
    return {
      profileId: session.profileId ?? this.eventScopeId(),
      capabilities: session.capabilities,
      send: (command) => session.connection.send(command),
    };
  }

  /**
   * The launch whose ports and files this server holds: while its process
   * runs or stops, while a playlist rotation restarts it, and for a server
   * from before Pyrodeck's restart that still runs but was not re-attached.
   */
  heldLaunch(): HeldLaunch | null {
    const status = this.process.getStatus();
    const config = this.process.getLaunchConfig();
    if (config && (status.state === "starting" || status.state === "running" || status.state === "stopping")) {
      return { launch: config, pid: status.pid, why: "running" };
    }
    if (config && (this.rotating || this.rotationHealth.isPending())) {
      return { launch: config, pid: null, why: "restarting for its playlist" };
    }
    const record = this.unattached;
    if (record) {
      return {
        launch: {
          executablePath: record.executablePath,
          gamePath: record.gamePath,
          configFile: record.configFile,
          logPath: record.logPath ?? undefined,
          telnetPort: record.telnetPort,
          telnetPassword: "",
          allowRemoteConsole: record.allowRemoteConsole ?? true,
          profileId: record.profileId ?? undefined,
          launchOptions: sanitizeStoredLaunchOptions(record.launchOptions),
          defaultOptions: sanitizeStoredLaunchOptions(record.defaultOptions),
          ...(record.startupFile ? { startupFile: record.startupFile } : {}),
        },
        pid: record.pid,
        why: "still running from before Pyrodeck restarted, not re-attached",
      };
    }
    return null;
  }

  /** Playlist status as sent to clients: the manager's state plus the restart health check. */
  playlistStatusPayload(): Record<string, unknown> {
    return { ...this.playlist.getStatus(), rotationCheck: this.rotationHealth.snapshot() };
  }

  /** Stop the supervisor's and autostart's timers (Pyrodeck shutting down, tests). */
  dispose(): void {
    this.supervisor.dispose();
    this.autostart.dispose();
  }

  // ---------------------------------------------------------------------------
  // Run record
  // ---------------------------------------------------------------------------

  private queueRunRecord(task: () => Promise<void>): void {
    this.runRecordQueue = this.runRecordQueue.then(task).catch((err) => {
      console.warn(
        `[Pyrodeck] Could not update ${path.join(this.runRecordDir, this.runRecordName)}: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  private writeOwnRunRecord(record: RunRecord): Promise<void> {
    return writeRunRecord(this.runRecordDir, record, this.runRecordName).then(() => this.onRunRecord(record));
  }

  private clearOwnRunRecord(): Promise<void> {
    return clearRunRecord(this.runRecordDir, this.runRecordName).then(() => this.onRunRecord(null));
  }

  private recordRun(pid: number, args: string[]): void {
    // A new process of this server: an older one Pyrodeck could not re-attach to holds nothing any more.
    this.unattached = null;
    this.queueRunRecord(async () => {
      const config = this.process.getLaunchConfig();
      const status = this.process.getStatus();
      if (!config || status.pid !== pid) return;
      const linux = this.host.platform === "linux" ? await this.host.readLinuxIdentity(pid) : null;
      const record: RunRecord = {
        version: 1,
        ...(this.profileId !== undefined ? { serverId: this.id } : {}),
        pid,
        profileId: config.profileId ?? null,
        executablePath: config.executablePath,
        gamePath: config.gamePath,
        configFile: config.configFile,
        args,
        logPath: config.logPath ?? null,
        telnetPort: config.telnetPort,
        launchOptions: config.launchOptions ?? null,
        ...(config.defaultOptions ? { defaultOptions: config.defaultOptions } : {}),
        ...(config.startupFile ? { startupFile: config.startupFile } : {}),
        allowRemoteConsole: config.allowRemoteConsole ?? true,
        startedAt: (status.startedAt ?? new Date()).toISOString(),
        ...(linux ? { linux: { startTicks: linux.startTicks, bootId: linux.bootId } } : {}),
      };
      if (this.process.getStatus().pid !== pid) return; // already gone
      await this.writeOwnRunRecord(record);
    });
  }

  // ---------------------------------------------------------------------------
  // Console session
  // ---------------------------------------------------------------------------

  /** Profile metadata (profiles.json); the game path is not needed to read it. */
  private profileList(): ServerProfileManager {
    return new ServerProfileManager(this.configDir, "");
  }

  /**
   * Send the launched profile's post-start settings (PLAN Phase 3 Step 7) over
   * the new console session. Best-effort: a failure is reported, never fatal.
   */
  private async applyPostStartSettings(connection: ServerConnection): Promise<void> {
    const profileId = this.process.getStatus().activeProfileId;
    if (!profileId) return;
    let commands: string[];
    try {
      const profile = await this.profileList().read(profileId);
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
        this.broadcast("error", { message: `Post-start setting "${cmd}" failed: ${message}` });
        return;
      }
    }
  }

  /**
   * Register a one-shot telnetReady handler so auto-connect fires after (re)start.
   * Called from start(), the playlist rotate handler and the supervisor.
   *
   * `healthToken` is set for a playlist restart: the result is then reported to
   * the rotation health check (healthy once `$servercaps` gets an answer, or a
   * failure) instead of completing the rotation directly.
   */
  private registerAutoConnect(telnetPassword: string, healthToken?: number): void {
    // Remove any stale once-handler from a launch that crashed before telnet was ready
    this.process.removeAllListeners("telnetReady");

    this.process.once("telnetReady", (port: number, host?: string) => {
      const consoleHost = consoleHostName(host);
      console.log(`[Pyrodeck] D3 telnet ready on ${consoleHost}:${port}, auto-connecting...`);
      void this.connectConsole(consoleHost, port, telnetPassword, { healthToken }).catch(() => {});
    });
  }

  /** Log in to the launched server's remote console and make it the active session. */
  private async connectConsole(
    host: string,
    port: number,
    telnetPassword: string,
    opts: ConsoleConnectOptions = {},
  ): Promise<void> {
    const { healthToken, again = false, anchorPlaylist = !again } = opts;
    try {
      // Disconnect this server's stale session
      this.removeConsoleSession();

      const connection = this.createConnection();
      const session = this.sessions.create(connection, host, port, telnetPassword, {
        owner: this.id,
        profileId: this.eventScopeId(),
      });
      this.sessionId = session.id;

      this.sessions.updateState(session.id, "connecting");
      await connection.connect(host, port, telnetPassword);

      // Probe capabilities
      this.sessions.updateState(session.id, "probing");
      const { caps: capabilities, answered } = await probeCapabilitiesDetailed(connection, (late) => {
        if (healthToken !== undefined) this.rotationHealth.healthy(healthToken);
        if (this.consoleSession()?.id !== session.id) return;
        this.sessions.updateCapabilities(session.id, late);
        this.broadcast("capabilities", serializeCaps(late));
      });

      this.sessions.updateCapabilities(session.id, capabilities);
      this.sessions.updateState(session.id, "ready");
      this.wireSessionToClients(session);

      // Wire up graceful quit: `quit` with a half-close (TelnetConnection.quit), so the server tells its clients it
      // has gone and the console port is left free for the next launch.
      this.process.sendQuitFn = async () => {
        try { await connection.quit(); } catch { /* connection may be dead */ }
      };

      // Wire playlist manager's command sender
      this.playlist.sendCommandFn = async (cmd: string) => connection.send(cmd);

      if (healthToken === undefined) {
        // User-started launch: nothing to verify. (Also unsticks a playlist
        // left "restarting" by a rotation the operator took over by hand.)
        this.playlist.markRotationComplete();
      } else if (answered) {
        // Playlist restart: the console answered $servercaps, the server is up.
        // A silent first probe waits for the background re-probe (above) or
        // the health check's deadline.
        this.rotationHealth.healthy(healthToken);
      }

      // Per-profile DMFC settings dedicated.cfg can't hold. The console runs
      // one command at a time, so these never interleave with other replies.
      if (!again) void this.applyPostStartSettings(connection);

      // The profile's start lines (once per run), then its periodic lines every
      // N minutes. A new login hands the timers the new connection.
      const launchedProfileId = this.process.getStatus().activeProfileId;
      if (launchedProfileId) void this.profileAutomation.consoleReady(launchedProfileId, connection);

      this.watchConsole(connection, host, port, telnetPassword);

      // Anchor playlist timer if a playlist is active
      if (this.playlist.isActive() && anchorPlaylist) {
        this.playlist.anchorTimer().catch(() => {});
      }

      // Broadcast to WS clients
      this.broadcast("connection_state", { state: "ready" });
      this.broadcast("capabilities", serializeCaps(capabilities));

      // Broadcast current playlist status
      if (this.playlist.getStatus().activePlaylistId) {
        this.broadcast("playlist_status", this.playlistStatusPayload());
      }

      console.log(`[Pyrodeck] Launch Mode: auto-connected to D3 server (session ${session.id})`);
    } catch (err) {
      const launch = this.process.getLaunchConfig();
      const note = launch ? localConsoleUseipNote(launch.launchOptions, launch.allowRemoteConsole ?? true) : null;
      const message = `${err instanceof Error ? err.message : String(err)}${note ? ` ${note}` : ""}`;
      console.error(`[Pyrodeck] Launch Mode: telnet auto-connect failed: ${message}`);
      if (again) throw err;
      this.broadcast("error", { message: `Auto-connect failed: ${message}` });
      if (healthToken === undefined) {
        this.playlist.markRotationComplete();
      } else {
        this.rotationHealth.failure(`remote console login failed (${message})`, healthToken);
      }
    }
  }

  /**
   * Feed a logged-in console to the supervisor, and log in again if the link
   * drops while the server runs. A re-attached server has no stdout, so its
   * console also feeds the quit watch and the playlist's level detection.
   */
  private watchConsole(connection: ServerConnection, host: string, port: number, telnetPassword: string): void {
    connection.onData((text) => {
      this.supervisor.consoleActivity();
      if (this.process.getStatus().adopted) {
        this.quitWatch.push(text);
        this.playlist.onStdoutChunk(text);
      }
    });
    connection.onDisconnect(() => this.scheduleConsoleReconnect(host, port, telnetPassword));
    this.stopConsoleReconnect();
    this.supervisor.consoleReady();
  }

  private scheduleConsoleReconnect(host: string, port: number, telnetPassword: string): void {
    if (this.consoleReconnectTimer || this.process.getStatus().state !== "running") return;
    this.consoleReconnectTimer = setTimeout(async () => {
      this.consoleReconnectTimer = null;
      if (this.process.getStatus().state !== "running") return;
      try {
        await this.connectConsole(host, port, telnetPassword, { again: true });
      } catch {
        this.scheduleConsoleReconnect(host, port, telnetPassword);
      }
    }, this.timing.consoleReconnectMs);
  }

  private stopConsoleReconnect(): void {
    if (this.consoleReconnectTimer) clearTimeout(this.consoleReconnectTimer);
    this.consoleReconnectTimer = null;
  }

  private dropConsoleSession(): void {
    this.process.sendQuitFn = null;
    this.removeConsoleSession();
  }

  /** Close the console session this server opened, if one is open. Never another server's or Connect mode's. */
  private removeConsoleSession(): void {
    const session = this.consoleSession();
    if (session) this.sessions.remove(session.id);
    this.sessionId = null;
  }

  /** Ask the launch guard (if any) to let `launch` through. */
  private async passLaunchGuard(launch: LaunchConfig): Promise<LaunchPass> {
    if (!this.launchGuard) return { ok: true, launch, release: () => {} };
    return this.launchGuard.reserve(this.id, launch);
  }

  /**
   * Spawn a launch Pyrodeck makes on its own (a rotation, a relaunch) once
   * the launch guard lets it through. A log the guard renamed (another server
   * writes one of that name) is created first; when it cannot be, the server
   * starts without a log, as for any log that cannot be written.
   */
  private async spawnGuarded(launch: LaunchConfig, reason: StartReason): Promise<void> {
    const pass = await this.passLaunchGuard(launch);
    if (!pass.ok) throw new LaunchRefusedError(pass.error);
    try {
      let next = pass.launch;
      if (next.logPath && next.logPath !== launch.logPath) {
        const logError = await prepareLogFile(next.logPath);
        if (logError) {
          this.broadcast("error", { message: `${logError} The server restarts without a log.` });
          next = { ...next, logPath: undefined };
        }
        if (launch.logPath) await removeIfEmpty(launch.logPath);
      }
      await this.process.start(next, reason);
    } finally {
      pass.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Playlist rotation and its restart health check
  // ---------------------------------------------------------------------------

  private broadcastPlaylistStatus(): void {
    this.broadcast("playlist_status", this.playlistStatusPayload());
  }

  /** Spawn the rotation's server and start the health deadline. Throws if the spawn fails. */
  private async launchForRotation(rl: RotationLaunch, token: number): Promise<void> {
    this.registerAutoConnect(rl.telnetPassword, token);
    await this.spawnGuarded(rl.launch, "playlist");
    this.rotationHealth.arm();
  }

  /** Give up on a rotation restart: pause the playlist and say why, loudly. */
  private pauseAfterFailedRotation(reason: string, label = this.currentRotationLaunch?.label): void {
    this.currentRotationLaunch = null;
    const what = label ? `the restart into "${label}"` : "the server restart";
    console.error(`[Playlist] Paused: ${what} failed: ${reason}`);
    if (this.playlist.isActive()) {
      this.playlist.pause(`${what[0].toUpperCase()}${what.slice(1)} failed: ${reason}.`);
    }
    this.broadcast("error", {
      message: `Playlist paused: ${what} failed (${reason}). Check the server, launch it if needed, then resume the playlist.`,
    });
    this.broadcastPlaylistStatus();
  }

  /**
   * The operator started or stopped the server by hand while a playlist restart
   * was still being checked: stop checking (a deadline must not relaunch a
   * server the operator just stopped) and let the playlist carry on.
   */
  private takeOverFromRotation(): void {
    this.playlist.cancelHold();
    if (!this.rotationHealth.isPending()) return;
    this.rotationHealth.cancel();
    this.currentRotationLaunch = null;
    this.playlist.markRotationComplete();
    this.broadcastPlaylistStatus();
  }

  private onRotationHealthy(attempt: number): void {
    const label = this.currentRotationLaunch?.label;
    this.currentRotationLaunch = null;
    console.log(`[Playlist] Restart${label ? ` into "${label}"` : ""} healthy${attempt > 0 ? " after a retry" : ""}`);
    this.playlist.markRotationComplete();
    this.broadcastPlaylistStatus();
  }

  private async onRotationRetry(_attempt: number, reason: string): Promise<void> {
    const rl = this.currentRotationLaunch;
    if (!rl) {
      this.rotationHealth.failure("nothing to relaunch");
      return;
    }
    const token = this.rotationHealth.token();
    console.warn(`[Playlist] Restart into "${rl.label}" not healthy (${reason}); retrying once`);
    this.broadcast("error", {
      message: `Playlist restart into "${rl.label}" is not healthy (${reason}). Retrying once…`,
    });
    this.broadcastPlaylistStatus();

    try {
      // Tear down whatever the failed attempt left behind.
      this.removeConsoleSession();
      this.process.sendQuitFn = null;
      this.playlist.sendCommandFn = null;
      if (this.process.isRunning()) await this.process.stop("playlist");

      // The operator may have taken over (Stop/Launch) while we were stopping.
      if (this.rotationHealth.token() !== token || !this.rotationHealth.isPending()) return;
      await this.launchForRotation(rl, token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.rotationHealth.failure(`restart failed (${message})`, token);
    }
  }

  /**
   * What a rotation restarts: this server's profile; for the server without
   * one, its last launch; for a server not bound to a profile, the profile of
   * its current launch, else the most recently launched profile.
   */
  private async rotationTarget(): Promise<RotationTarget | { skip: string }> {
    const config = this.settings();
    if (this.profileId === null) {
      const last = this.process.getLaunchConfig();
      const configFile = last?.configFile ?? "dedicated.cfg";
      return {
        profile: null,
        name: path.basename(configFile, path.extname(configFile)),
        configFile,
        gamePath: last?.gamePath ?? config.gamePath,
        executablePath: last?.executablePath ?? config.executablePath,
        launchOptions: last?.launchOptions ?? null,
      };
    }
    const profiles = await this.profileList().list();
    const wanted = this.profileId ?? this.process.getLaunchConfig()?.profileId;
    let profile: ServerProfile | undefined;
    if (wanted) {
      profile = profiles.find((p) => p.id === wanted);
      if (!profile) return { skip: `Profile ${wanted} no longer exists; cannot rotate` };
    } else {
      if (profiles.length === 0) return { skip: "No profiles found; cannot rotate" };
      profile =
        profiles
          .filter((p) => p.lastLaunchedAt)
          .sort((a, b) => (b.lastLaunchedAt ?? "").localeCompare(a.lastLaunchedAt ?? ""))[0] ?? profiles[0];
    }
    // Profile overrides take precedence over global config — profiles with a
    // custom gamePath / executablePath (e.g. a PiccuEngine install) rely on
    // these to resolve correctly across a mission rotation.
    return {
      profile,
      name: profile.name,
      configFile: profile.configFile,
      gamePath: profile.gamePath ?? config.gamePath,
      executablePath: profile.executablePath ?? config.executablePath,
      launchOptions: sanitizeStoredLaunchOptions(profile.launchOptions),
      autoexecBlock: buildTeamSettingLines(sanitizeStoredTeamSettings(profile.teamSettings)),
      ...(profile.startupFile ? { startupFile: profile.startupFile } : {}),
    };
  }

  private async rotate(entry: PlaylistEntry): Promise<void> {
    const config = this.settings();

    console.log(`[Playlist] Rotate triggered for entry: ${entry.label} (${entry.missionName})`);

    // Resolve what to restart BEFORE stopping the server, so a compat failure
    // can skip the rotation and leave the current mission running.
    let serverStopped = false;
    this.rotating = true;
    try {
      const target = await this.rotationTarget();
      if ("skip" in target) {
        console.warn(`[Playlist] ${target.skip}`);
        this.playlist.rotationSkipped();
        return;
      }
      const activeProfile = target;
      const gamePath = target.gamePath;
      const executablePathRaw = target.executablePath;

      if (!gamePath || !executablePathRaw) {
        this.broadcast("error", {
          message:
            "Playlist rotation failed: game path or executable not configured for the active profile",
        });
        this.playlist.rotationSkipped();
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
        this.broadcast("error", {
          message: `Playlist skipped "${entry.label}" (${entry.missionName}): ${reason} for ${scriptName}. Current mission keeps running.`,
        });
        this.playlist.rotationSkipped();
        return;
      }

      // Announce rotation if server is running
      if (this.playlist.sendCommandFn && this.process.isRunning()) {
        try {
          await this.playlist.sendCommandFn(sayToAll(`Changing mission to ${entry.label}`));
          await new Promise((r) => setTimeout(r, this.timing.rotationAnnounceMs));
        } catch { /* ignore */ }
      }

      // Stop through the console's `quit` (ProcessManager.stop runs sendQuitFn, then signals if the server stays up).
      // A `quit` makes the server tell every client it has gone, so a player still on drops to the menu at once
      // instead of hanging until the client times out. TelnetConnection.quit sends it with a half-close: our FIN goes
      // first, so the TIME_WAIT is on our side and the relaunch binds the console port at once, on any server
      // version. The session is dropped only after the server has closed it: a full close while the console still
      // echoes the line would end a server that does not ignore SIGPIPE before the quit runs.
      this.playlist.sendCommandFn = null;

      const launchStatus = this.process.getStatus();
      if (launchStatus.state === "running" || launchStatus.state === "starting") {
        await this.process.stop("playlist");
      }
      this.removeConsoleSession();
      this.process.sendQuitFn = null;
      // From here on the server is down: a failure pauses the playlist instead
      // of leaving it "restarting" behind a dead server.
      serverStopped = true;

      // Re-bind the profile manager to the effective gamePath for file ops.
      const profileManager = new ServerProfileManager(this.configDir, gamePath);

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
      if (!telnetCfg.password) {
        this.pauseAfterFailedRotation(
          `${activeProfile.configFile} has no ConsolePassword, so Pyrodeck cannot log in to the console to restart and watch the server`,
          entry.label,
        );
        return;
      }

      let executablePath = executablePathRaw;
      if (!path.isAbsolute(executablePath)) {
        executablePath = path.join(gamePath, executablePath);
      }
      // Auto-name the rotation's log in the configured dir (default: next to
      // the executable) and create it, as start() does. A rotation still
      // restarts the server when the log can't be written (players matter
      // more than the log), but says so; ProcessManager then marks the
      // launch's log as failed in the status the Launch panel shows.
      const logDir = resolveLogDir(config.logDir, executablePath);
      const logPath = path.join(logDir, buildLogFilename(activeProfile.name));
      const logError = await prepareLogFile(logPath);
      if (logError) {
        this.broadcast("error", { message: `Playlist rotation: ${logError} The server restarts without a log.` });
      }

      if (activeProfile.profile) await profileManager.markLaunched(activeProfile.profile.id);
      this.currentRotationLaunch = {
        label: entry.label,
        telnetPassword: telnetCfg.password,
        launch: {
          executablePath,
          gamePath,
          configFile: activeProfile.configFile,
          logPath,
          telnetPort: telnetCfg.port,
          telnetPassword: telnetCfg.password,
          allowRemoteConsole: telnetCfg.allowRemote,
          profileId: activeProfile.profile?.id,
          launchOptions: activeProfile.launchOptions,
          autoexecBlock: activeProfile.autoexecBlock,
          ...(activeProfile.startupFile ? { startupFile: activeProfile.startupFile } : {}),
        },
      };
      logConsoleWarnings(activeProfile.configFile, this.currentRotationLaunch.launch);
      this.rotationHealth.begin();
      const token = this.rotationHealth.token();
      this.broadcastPlaylistStatus();
      try {
        await this.launchForRotation(this.currentRotationLaunch, token);
        this.broadcast("playlist_rotate", {
          entry: { id: entry.id, label: entry.label, missionName: entry.missionName },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Playlist] Restart failed: ${message}`);
        this.rotationHealth.failure(`restart failed (${message})`, token);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Playlist] Rotation error: ${message}`);
      if (serverStopped) {
        this.pauseAfterFailedRotation(`rotation error (${message})`, entry.label);
      } else {
        this.broadcast("error", { message: `Playlist rotation error: ${message}` });
        this.playlist.rotationSkipped();
      }
    } finally {
      this.rotating = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Supervisor relaunch
  // ---------------------------------------------------------------------------

  /** Start the last launch again, into a new log file next to the last one. */
  private async relaunchLast(): Promise<void> {
    const last = this.process.getLaunchConfig();
    if (!last) throw new Error("there is no launch to repeat");
    if (this.process.isRunning()) return;

    let logPath = last.logPath;
    if (logPath) {
      let label = path.basename(last.configFile, path.extname(last.configFile));
      if (last.profileId) {
        try {
          label = (await this.profileList().read(last.profileId)).name;
        } catch {
          // profile deleted since launch: keep the config name
        }
      }
      const fresh = path.join(path.dirname(logPath), buildLogFilename(label));
      const logError = await prepareLogFile(fresh);
      if (logError) {
        this.broadcast("error", { message: `Relaunch: ${logError} The server restarts without a log.` });
        logPath = undefined;
      } else {
        logPath = fresh;
      }
    }

    this.dropConsoleSession();
    this.registerAutoConnect(last.telnetPassword);
    await this.spawnGuarded({ ...last, logPath }, "relaunch");
  }

  // ---------------------------------------------------------------------------
  // Process events
  // ---------------------------------------------------------------------------

  private onStateChange(state: string): void {
    // Trailing output (e.g. the stderr lines explaining a crash) must reach
    // clients before the state change that it caused.
    this.flushProcessOutput();
    this.broadcast("process_state", { state });
    // The loaded level is gone once the process is down; forget it so a stale
    // name isn't reported on the next connect. A restart re-populates it from
    // the next "Opening level" line.
    if (state === "stopped" || state === "crashed") {
      this.playlist.clearCurrentLevel();
    }
    // Read before the health check reacts below: once it gives up it is idle,
    // and the supervisor must still know the crash was the rotation's.
    const rotationOwned = this.rotationHealth.isPending();
    // A playlist restart that dies before it answers fails its health check now,
    // not at the deadline. Only while armed ("waiting"): the old process being
    // stopped for a retry is not this attempt's crash.
    if (state === "crashed" && this.rotationHealth.snapshot().state === "waiting") {
      const { exitCode, exitSignal } = this.process.getStatus();
      this.rotationHealth.failure(
        `server exited during startup (${exitSignal ? `signal ${exitSignal}` : `exit code ${exitCode}`})`,
        this.rotationHealth.token(),
      );
    }
    if (state === "stopped" || state === "crashed") {
      this.stopConsoleReconnect();
      this.queueRunRecord(() => this.clearOwnRunRecord());
      const { exitCode, exitSignal, stopReason } = this.process.getStatus();
      const down: ProcessDown = {
        crashed: state === "crashed",
        stopReason,
        rotationOwned,
        code: exitCode,
        signal: exitSignal,
      };
      // The guard first: when it trips it stops the supervisor's relaunch.
      this.autostart.processDown(down);
      this.supervisor.processDown(down);
    }
  }

  // Debug D3 builds can emit hundreds of stdout lines/sec (bot AI logging).
  // Forwarding every pipe chunk as its own WS message floods browsers — the
  // per-message overhead (JSON parse + xterm write) is what makes the UI laggy,
  // not the byte volume. Coalesce and flush on a short tick. Buffering as a list
  // of per-stream runs (not one buffer per stream) keeps stdout/stderr in true
  // arrival order, so a stderr crash message still renders where it happened.
  private flushProcessOutput(): void {
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }
    const runs = this.pendingOutput;
    this.pendingOutput = [];
    for (const run of runs) {
      this.broadcast("process_output", run);
    }
  }

  private queueProcessOutput(stream: "stdout" | "stderr", data: string): void {
    const last = this.pendingOutput[this.pendingOutput.length - 1];
    if (last && last.stream === stream) {
      last.data += data;
    } else {
      this.pendingOutput.push({ stream, data });
    }
    this.outputFlushTimer ??= setTimeout(() => this.flushProcessOutput(), this.timing.outputFlushMs);
  }

  // ---------------------------------------------------------------------------
  // Re-attach
  // ---------------------------------------------------------------------------

  /**
   * Re-attach to the server the previous Pyrodeck run launched, if it is still
   * running (D3Server3 does the same with its saved process IDs). What works
   * afterwards: status, console, Stop, the supervisor, playlist level
   * detection (from the console). What does not: the server's stdout is gone
   * with the old Pyrodeck, so the Output tab and the log file get nothing more,
   * and its exit code is not known.
   *
   * Returns why no new server may be launched although none was re-attached
   * (one still runs that Pyrodeck cannot log in to), or null.
   *
   * `others`: records from elsewhere that may describe this server (an older
   * Pyrodeck's running-server.json). The newest live one is taken, and kept
   * as this server's own record from then on.
   */
  private async reattachToRunningServer(others: RunRecord[]): Promise<string | null> {
    const own = await readRunRecord(this.runRecordDir, this.runRecordName);
    const seen = new Set<number>();
    const candidates = [own, ...others]
      .filter((r): r is RunRecord => r !== null && !seen.has(r.pid) && (seen.add(r.pid), true))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    for (const record of candidates) {
      const outcome = await this.reattachTo(record);
      if (outcome === "forgotten") continue;
      if (record !== own) {
        await this.writeOwnRunRecord(this.profileId !== undefined ? { ...record, serverId: this.id } : record);
      }
      if (outcome === "adopted") return null;
      this.unattached = record;
      return outcome.blocked;
    }
    if (own) await this.clearOwnRunRecord();
    return null;
  }

  /** Re-attach to the process in one record: adopted, forgotten (it is not that server any more), or why it blocks. */
  private async reattachTo(record: RunRecord): Promise<"adopted" | "forgotten" | { blocked: string }> {
    const forget = async (why: string): Promise<"forgotten"> => {
      console.log(`[Pyrodeck] Not re-attaching to server PID ${record.pid}: ${why}`);
      return "forgotten";
    };

    const decision = decideAdopt(record, await this.host.readProcessFacts(record.pid), this.host.platform);
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
      return {
        blocked: `the server Pyrodeck launched before it restarted is still running (PID ${record.pid}), but ${record.configFile} has no console password, so Pyrodeck could not re-attach to it`,
      };
    }

    // 127.0.0.1, or the -useip address of a console that takes remote connections.
    const launchOptions = sanitizeStoredLaunchOptions(record.launchOptions);
    const allowRemoteConsole = record.allowRemoteConsole ?? true;
    const host = consoleHostName(consoleHostFor(launchOptions, allowRemoteConsole) ?? undefined);

    if (this.host.platform !== "linux") {
      // Only "a process with this PID is alive" is known here; prove it is the
      // server by logging in to its console first.
      const probe = this.createConnection();
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
      const facts = await this.host.readProcessFacts(record.pid);
      return facts.alive && (!linux || facts.linux?.startTicks === linux.startTicks);
    };
    const defaultOptions = sanitizeStoredLaunchOptions(record.defaultOptions);
    const config: LaunchConfig = {
      executablePath: record.executablePath,
      gamePath: record.gamePath,
      configFile: record.configFile,
      logPath: record.logPath ?? undefined,
      telnetPort: record.telnetPort,
      telnetPassword: password,
      allowRemoteConsole,
      profileId: record.profileId ?? undefined,
      launchOptions,
      ...(defaultOptions ? { defaultOptions } : {}),
      ...(record.startupFile ? { startupFile: record.startupFile } : {}),
    };

    this.process.removeAllListeners("telnetReady");
    this.process.once("telnetReady", (port: number) => {
      this.connectConsole(host, port, password, { again: true, anchorPlaylist: true }).catch((err) => {
        this.broadcast("error", {
          message: `Re-attached to the running server, but its console login failed (${err instanceof Error ? err.message : err}). Retrying every 5 s.`,
        });
        this.scheduleConsoleReconnect(host, port, password);
      });
    });
    this.process.adopt({ pid: record.pid, startedAt: new Date(record.startedAt), config, args: record.args, isAlive });
    console.log(`[Pyrodeck] Re-attached to the server Pyrodeck launched before it restarted (PID ${record.pid})`);
    return "adopted";
  }
}
