import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServerInstance, type InstanceSettings } from "./ServerInstance.js";
import { NO_PROFILE_ID, ServerEvents } from "../events/ServerEvents.js";
import { SessionManager } from "../session/SessionManager.js";
import { PlaylistManager } from "../launcher/PlaylistManager.js";
import type { ServerConnection } from "../connection/ServerConnection.js";
import type { AdoptTarget, LaunchConfig, ProcessState, ProcessStatus, StartReason, StopReason } from "../launcher/ProcessManager.js";
import { DEFAULT_SUPERVISOR_SETTINGS } from "../launcher/supervisorSettings.js";
import { RUN_RECORD_FILE, type ProcessFacts, type RunRecord } from "../launcher/runRecord.js";
import { sayToAll } from "../players/playerActions.js";

// A queued state write may still land while the temp directory is being removed (ENOTEMPTY): retry.
const RM_TEMP = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 } as const;

/**
 * A server instance on a stand-in game: the process follows ProcessManager's
 * order of state changes and events, the console TelnetConnection's
 * callbacks. Every process call, console command, browser message and server
 * event lands on one timeline, so the tests check what happened and in which
 * order. Timers are fake; files are real, in a temp directory.
 */

const PROFILE_ID = "p-ctf";
const PROFILE_NAME = "Public CTF";
const CONSOLE_PORT = 2600;
const PASSWORD = "secret";
const BOOT_ID = "boot-1";
const CFG = [
  "GameName=Test",
  "MissionName=alpha.mn3",
  "Scriptname=anarchy.d3m",
  `ConsolePassword=${PASSWORD}`,
  `RemoteConsolePort=${CONSOLE_PORT}`,
  "AllowRemoteConsole=0",
  "",
].join("\n");
const SERVERCAPS = "SERVERCAPS version=1 fork=Matcen fork_version=0.10.17 features=bots,roster\n";

const realSetImmediate = setImmediate;

/** Wait (in real time, without moving the fake clock) until `cond` holds: file I/O completes meanwhile. */
async function settle(cond: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((r) => realSetImmediate(r));
  }
}

/** The part of `expected` found in `timeline` in that order (the whole of it when the order holds). */
function inOrder(timeline: string[], expected: string[]): string[] {
  const found: string[] = [];
  let from = 0;
  for (const entry of expected) {
    const at = timeline.indexOf(entry, from);
    if (at < 0) break;
    found.push(entry);
    from = at + 1;
  }
  return found;
}

class FakeGame {
  readonly process: FakeProcess;
  readonly consoles: FakeConsole[] = [];
  readonly logins: { host: string; port: number; password: string }[] = [];
  /** Every command sent to any console, in order. */
  readonly sent: string[] = [];
  /** Humans `$players` lists. */
  humans: string[] = [];
  /** The main loop is stuck: commands get no answer, `quit` does nothing. */
  hung = false;

  constructor(
    readonly timeline: string[],
    bus: ServerEvents,
  ) {
    this.process = new FakeProcess(this, bus);
  }

  connect(): FakeConsole {
    const c = new FakeConsole(this);
    this.consoles.push(c);
    return c;
  }

  /** The console of the latest login. */
  get console(): FakeConsole {
    return this.consoles[this.consoles.length - 1];
  }

  reply(command: string): string {
    if (this.hung) return "";
    if (command === "$servercaps") return SERVERCAPS;
    if (command === "$players") {
      return ["PNum Name", "00: -Server-", ...this.humans.map((n, i) => `${String(i + 1).padStart(2, "0")}: ${n}`), ""].join("\n");
    }
    return "";
  }
}

/** The game process, as ProcessManager reports it. */
class FakeProcess extends EventEmitter {
  sendQuitFn: (() => Promise<void>) | null = null;
  readonly launches: LaunchConfig[] = [];
  private status: ProcessStatus = {
    state: "stopped",
    pid: null,
    exitCode: null,
    exitSignal: null,
    startedAt: null,
    stoppedAt: null,
    activeProfileId: null,
    log: { path: null, state: "none", message: null },
    stopReason: null,
    adopted: false,
  };
  private config: LaunchConfig | null = null;
  private telnetReady = false;
  private stopReason: StopReason = "manual";
  private consoleQuitAt = 0;
  private nextPid = 5001;

  constructor(
    private readonly game: FakeGame,
    private readonly bus: ServerEvents,
  ) {
    super();
  }

  getStatus(): ProcessStatus {
    return { ...this.status, log: { ...this.status.log } };
  }

  getLaunchConfig(): LaunchConfig | null {
    return this.config ? { ...this.config } : null;
  }

  getActiveLogPath(): string | null {
    return this.status.pid !== null && !this.status.adopted ? (this.config?.logPath ?? null) : null;
  }

  isRunning(): boolean {
    return this.status.state === "running" || this.status.state === "starting";
  }

  consoleHost(): string {
    return "127.0.0.1";
  }

  noteConsoleQuit(): void {
    this.consoleQuitAt = Date.now();
  }

  /** As ProcessManager.start: checks on disk come first, so the state changes after the call returns to its caller. */
  async start(config: LaunchConfig, reason: StartReason = "manual"): Promise<void> {
    if (this.isRunning()) throw new Error("Server is already running");
    this.game.timeline.push(`proc start ${reason}`);
    await Promise.resolve();
    this.launches.push(config);
    this.config = config;
    this.telnetReady = false;
    this.stopReason = "manual";
    this.consoleQuitAt = 0;
    this.setState("starting");
    await Promise.resolve();
    const pid = this.nextPid++;
    this.status = {
      ...this.status,
      pid,
      adopted: false,
      startedAt: new Date(),
      exitCode: null,
      exitSignal: null,
      stoppedAt: null,
      activeProfileId: config.profileId ?? null,
      stopReason: null,
      log: { path: config.logPath ?? null, state: config.logPath ? "pending" : "none", message: null },
    };
    this.bus.emitEvent("server.started", {
      profileId: config.profileId ?? NO_PROFILE_ID,
      pid,
      args: ["-dedicated", `./${config.configFile}`],
      reason,
    });
  }

  /** The console port answers (ProcessManager.onTelnetReady). */
  consoleUp(): void {
    this.telnetReady = true;
    this.setState("running");
    this.emit("telnetReady", this.config!.telnetPort, this.consoleHost());
  }

  async stop(reason: StopReason = "manual", options: { kill?: boolean } = {}): Promise<void> {
    if (this.status.pid === null || this.status.state === "stopped" || this.status.state === "stopping") return;
    this.game.timeline.push(`proc stop ${reason}${options.kill ? " kill" : ""}`);
    this.stopReason = reason;
    this.setState("stopping");
    if (!options.kill && this.sendQuitFn && this.telnetReady) {
      await this.sendQuitFn();
      if (this.status.pid === null) return;
    }
    const signal = options.kill ? "SIGKILL" : "SIGTERM";
    this.game.timeline.push(`proc ${signal}`);
    this.exit(null, signal);
  }

  adopt(target: AdoptTarget): void {
    if (this.isRunning()) throw new Error("Server is already running");
    this.game.timeline.push(`proc adopt ${target.pid}`);
    this.config = target.config;
    this.telnetReady = true;
    this.stopReason = "manual";
    this.consoleQuitAt = 0;
    this.status = {
      state: "running",
      pid: target.pid,
      exitCode: null,
      exitSignal: null,
      startedAt: target.startedAt,
      stoppedAt: null,
      activeProfileId: target.config.profileId ?? null,
      log: { path: null, state: "none", message: null },
      stopReason: null,
      adopted: true,
    };
    this.setState("running");
    this.bus.emitEvent("server.adopted", {
      profileId: target.config.profileId ?? NO_PROFILE_ID,
      pid: target.pid,
      startedAt: target.startedAt.toISOString(),
    });
    setTimeout(() => this.emit("telnetReady", target.config.telnetPort, this.consoleHost()), 0);
  }

  /** Output on stdout (a launched process only). */
  print(text: string): void {
    this.emit("stdout", text);
  }

  /** The process ended: after a stop, after a `quit` typed at its console, or on its own (ProcessManager.onProcessExit). */
  exit(code: number | null, signal: string | null): void {
    const pid = this.status.pid;
    if (pid === null) return;
    const profileId = this.status.activeProfileId ?? NO_PROFILE_ID;
    this.status = { ...this.status, pid: null, exitCode: code, exitSignal: signal, stoppedAt: new Date() };
    const reason = this.stopReason;
    if (this.status.state === "stopping") {
      this.status.stopReason = reason;
      this.setState("stopped");
      if (reason !== "hang") this.bus.emitEvent("server.stopped", { profileId, pid, reason });
    } else if (this.consoleQuitAt > 0 && Date.now() - this.consoleQuitAt < 30_000) {
      this.status.stopReason = "console";
      this.setState("stopped");
      this.bus.emitEvent("server.stopped", { profileId, pid, reason: "manual", via: "console" });
    } else {
      this.setState("crashed");
      this.bus.emitEvent("server.crashed", { profileId, pid, code, signal });
    }
    this.emit("exit", code, signal);
  }

  private setState(state: ProcessState): void {
    this.status.state = state;
    this.emit("stateChange", state);
  }
}

/** One login to the game's remote console, with TelnetConnection's callbacks. */
class FakeConsole implements ServerConnection {
  private connected = false;
  private dataCallbacks: ((data: string) => void)[] = [];
  private disconnectCallbacks: ((reason: string) => void)[] = [];

  constructor(private readonly game: FakeGame) {}

  async connect(host: string, port: number, password: string): Promise<void> {
    this.game.logins.push({ host, port, password });
    this.game.timeline.push("login");
    this.connected = true;
  }

  async send(command: string): Promise<string> {
    if (!this.connected) throw new Error("Not connected");
    this.game.sent.push(command);
    this.game.timeline.push(`console ${command}`);
    const reply = this.game.reply(command);
    // A reply is console output like any other: every onData listener sees it.
    if (reply) for (const cb of this.dataCallbacks) cb(reply);
    return reply;
  }

  onData(callback: (data: string) => void): void {
    this.dataCallbacks.push(callback);
  }

  onDisconnect(callback: (reason: string) => void): void {
    this.disconnectCallbacks.push(callback);
  }

  /** Closed from our side: no disconnect callback runs. */
  async disconnect(): Promise<void> {
    this.connected = false;
    this.dataCallbacks = [];
    this.disconnectCallbacks = [];
  }

  async quit(): Promise<void> {
    if (!this.connected) return;
    this.game.sent.push("quit");
    this.game.timeline.push("console quit");
    if (this.game.hung) return; // nothing runs it; the caller signals the process
    this.closedByServer();
    this.game.process.exit(0, null);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** The server prints a line nobody asked for. */
  print(text: string): void {
    for (const cb of this.dataCallbacks) cb(text);
  }

  /** The server closed the connection. */
  closedByServer(reason = "Connection closed"): void {
    if (!this.connected) return;
    this.connected = false;
    for (const cb of [...this.disconnectCallbacks]) cb(reason);
  }
}

interface SetUpOptions {
  autostartProfileId?: string;
  autostart?: { maxFailures?: number };
  processFacts?: (pid: number) => ProcessFacts;
  /** A restarted Pyrodeck: the config and game directories of this earlier harness, as it left them. */
  after?: Harness;
}

interface Harness {
  root: string;
  configDir: string;
  gamePath: string;
  timeline: string[];
  game: FakeGame;
  sessions: SessionManager;
  playlist: PlaylistManager;
  broadcasts: { type: string; payload: Record<string, unknown> }[];
  logs: string[];
  wired: () => number;
  server: ServerInstance;
}

const harnesses: Harness[] = [];

async function setUp(opts: SetUpOptions = {}): Promise<Harness> {
  const root = opts.after?.root ?? (await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-instance-")));
  const configDir = path.join(root, "config");
  const gamePath = path.join(root, "game");
  if (!opts.after) {
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(path.join(gamePath, "missions"), { recursive: true });
    await fs.writeFile(path.join(gamePath, "ctf.cfg"), CFG);
    for (const mission of ["alpha.mn3", "beta.mn3", "gamma.mn3"]) {
      await fs.writeFile(path.join(gamePath, "missions", mission), "");
    }
    await fs.writeFile(
      path.join(configDir, "profiles.json"),
      JSON.stringify([{ id: PROFILE_ID, name: PROFILE_NAME, configFile: "ctf.cfg", createdAt: "2026-11-01T00:00:00.000Z" }]),
    );
  }

  const timeline: string[] = [];
  const bus = new ServerEvents();
  for (const name of ["server.started", "server.stopped", "server.crashed", "server.hung", "server.adopted"] as const) {
    bus.on(name, (p: { reason?: string }) => timeline.push(`bus ${name}${p.reason ? ` ${p.reason}` : ""}`));
  }
  const game = new FakeGame(timeline, bus);
  const sessions = new SessionManager();
  const playlist = new PlaylistManager(configDir);
  const broadcasts: Harness["broadcasts"] = [];
  let wired = 0;
  const settings: InstanceSettings = {
    gamePath,
    executablePath: path.join(gamePath, "Descent3"),
    logDir: path.join(root, "logs"),
    autostart: { profileId: opts.autostartProfileId ?? null },
  };
  const noProcess: ProcessFacts = { alive: false, cmdline: null, linux: null, bootTimeMs: 0 };
  const server = new ServerInstance({
    id: "test",
    configDir,
    settings: () => settings,
    sessions,
    playlist,
    broadcast: (type, payload) => {
      broadcasts.push({ type, payload });
      timeline.push(`ws ${type}${typeof payload.state === "string" ? ` ${payload.state}` : ""}`);
    },
    wireSessionToClients: () => {
      wired++;
    },
    events: bus,
    process: game.process,
    createConnection: () => game.connect(),
    host: {
      platform: "linux",
      readProcessFacts: async (pid) => opts.processFacts?.(pid) ?? noProcess,
      readLinuxIdentity: async (pid) => ({ startTicks: `ticks-${pid}`, state: "S", bootId: BOOT_ID }),
    },
    autostart: opts.autostart,
  });
  server.supervisor.applySettings(DEFAULT_SUPERVISOR_SETTINGS);

  const logs: string[] = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }

  const h: Harness = {
    root,
    configDir,
    gamePath,
    timeline,
    game,
    sessions,
    playlist,
    broadcasts,
    logs,
    wired: () => wired,
    server,
  };
  harnesses.push(h);
  return h;
}

const readyCount = (h: Harness) =>
  h.broadcasts.filter((b) => b.type === "connection_state" && b.payload.state === "ready").length;

/** Wait until Pyrodeck has completed its `n`th console login (the "ready" it sends the browsers last). */
async function loggedIn(h: Harness, n: number): Promise<void> {
  await settle(() => readyCount(h) >= n, `console login ${n}`);
  expect(h.sessions.getActive()?.state).toBe("ready");
}

/** Launch the profile by hand and wait until Pyrodeck is logged in to its console. */
async function launchAndLogIn(h: Harness): Promise<void> {
  const result = await h.server.start({ profileId: PROFILE_ID, reason: "manual" });
  expect(result).toMatchObject({ ok: true });
  h.game.process.consoleUp();
  await loggedIn(h, readyCount(h) + 1);
}

async function missionName(h: Harness): Promise<string | undefined> {
  const cfg = await fs.readFile(path.join(h.gamePath, "ctf.cfg"), "utf-8");
  return /^MissionName=(.*)$/m.exec(cfg)?.[1];
}

async function activatePlaylist(h: Harness, holdSeconds: number, labels = ["Alpha", "Beta"]): Promise<void> {
  const playlist = await h.playlist.create(
    "Rotation",
    "sequential",
    labels.map((label) => ({ label, missionName: `${label.toLowerCase()}.mn3` })),
  );
  await h.playlist.update(playlist.id, { holdSeconds });
  await h.playlist.activate(playlist.id);
}

function missionOver(h: Harness): void {
  h.game.process.print("Ending level.\n");
  h.game.process.print("Mission over.  Looping back to first level...\n");
}

const runRecordPath = (h: Harness) => path.join(h.configDir, RUN_RECORD_FILE);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    h.server.dispose();
    vi.clearAllTimers();
    await fs.rm(h.root, RM_TEMP);
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ServerInstance: launch", () => {
  it("launches the profile, logs in to its console, starts watching it and records the run", async () => {
    const h = await setUp();
    const result = await h.server.start({ profileId: PROFILE_ID, reason: "manual" });

    expect(result).toMatchObject({ ok: true, status: { state: "starting", activeProfileId: PROFILE_ID } });
    expect(h.game.process.launches).toEqual([
      expect.objectContaining({
        executablePath: path.join(h.gamePath, "Descent3"),
        gamePath: h.gamePath,
        configFile: "ctf.cfg",
        telnetPort: CONSOLE_PORT,
        telnetPassword: PASSWORD,
        allowRemoteConsole: false,
        profileId: PROFILE_ID,
        logPath: expect.stringMatching(/public-ctf-.*\.log$/),
      }),
    ]);
    expect(existsSync(h.game.process.launches[0].logPath!)).toBe(true);

    h.game.process.consoleUp();
    await loggedIn(h, 1);

    expect(h.game.logins).toEqual([{ host: "127.0.0.1", port: CONSOLE_PORT, password: PASSWORD }]);
    const expected = [
      "proc start manual",
      "ws process_state starting",
      "bus server.started manual",
      "ws process_state running",
      "login",
      "console $servercaps",
      "console $players",
      "ws connection_state ready",
      "ws capabilities",
    ];
    expect(inOrder(h.timeline, expected)).toEqual(expected);
    expect(h.broadcasts.filter((b) => b.type === "capabilities").at(-1)?.payload).toMatchObject({
      fork: "Matcen",
      forkVersion: "0.10.17",
    });
    expect(h.wired()).toBe(1);
    expect(h.server.process.sendQuitFn).not.toBeNull();
    expect(h.server.supervisor.snapshot()).toMatchObject({ hang: { state: "listening" }, humans: 0 });

    await settle(() => existsSync(runRecordPath(h)), "the run record");
    const record = JSON.parse(await fs.readFile(runRecordPath(h), "utf-8")) as RunRecord;
    expect(record).toMatchObject({
      version: 1,
      pid: h.game.process.getStatus().pid,
      profileId: PROFILE_ID,
      configFile: "ctf.cfg",
      telnetPort: CONSOLE_PORT,
      allowRemoteConsole: false,
      args: ["-dedicated", "./ctf.cfg"],
    });
  });

  it("refuses a second launch and a stop of a server that is down, without touching the process", async () => {
    const h = await setUp();
    expect(await h.server.stop("manual")).toEqual({ ok: false, code: 409, error: "Server is not running" });
    await launchAndLogIn(h);
    expect(await h.server.start({ profileId: PROFILE_ID, reason: "manual" })).toEqual({
      ok: false,
      code: 409,
      error: "Server is already running",
    });
    expect(h.timeline.filter((e) => e.startsWith("proc "))).toEqual(["proc start manual"]);
  });

  it("stops by hand through the console's quit, then drops the session and leaves the server down", async () => {
    const h = await setUp();
    await launchAndLogIn(h);
    await settle(() => existsSync(runRecordPath(h)), "the run record");

    const result = await h.server.stop("manual");

    expect(result).toMatchObject({ ok: true, status: { state: "stopped", stopReason: "manual" } });
    const expected = [
      "proc stop manual",
      "ws process_state stopping",
      "console quit",
      "ws process_state stopped",
      "bus server.stopped manual",
      "ws connection_state disconnected",
    ];
    expect(inOrder(h.timeline, expected)).toEqual(expected);
    expect(h.sessions.getActive()).toBeUndefined();
    expect(h.server.process.sendQuitFn).toBeNull();
    await settle(() => !existsSync(runRecordPath(h)), "the run record's removal");

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.game.process.launches).toHaveLength(1);
    expect(h.server.supervisor.snapshot().pendingRelaunch).toBeNull();
  });

  it("a scheduled stop closes the console session first and signals the process, without a quit", async () => {
    const h = await setUp();
    await launchAndLogIn(h);

    const result = await h.server.stop("schedule");

    expect(result).toMatchObject({ ok: true, status: { state: "stopped", stopReason: "schedule" } });
    const expected = [
      "proc stop schedule",
      "proc SIGTERM",
      "ws process_state stopped",
      "bus server.stopped schedule",
      "ws connection_state disconnected",
    ];
    expect(inOrder(h.timeline, expected)).toEqual(expected);
    expect(h.timeline).not.toContain("console quit");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.game.process.launches).toHaveLength(1);
  });

  it("logs in again 5 s after the console link drops while the server runs", async () => {
    const h = await setUp();
    await launchAndLogIn(h);

    h.game.console.closedByServer();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(h.game.logins).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await loggedIn(h, 2);

    expect(h.game.logins).toHaveLength(2);
    expect(h.sessions.getActive()?.connection).toBe(h.game.consoles[1]);
  });
});

describe("ServerInstance: playlist rotation", () => {
  it("rotates at the mission's end: announce, quit through the console, next mission, relaunch, healthy", async () => {
    const h = await setUp();
    await activatePlaylist(h, 0);
    await launchAndLogIn(h);
    expect(await missionName(h)).toBe("alpha.mn3");
    const mark = h.timeline.length;

    missionOver(h);
    await settle(() => h.game.sent.includes(sayToAll("Changing mission to Beta")), "the rotation's announcement");
    expect(h.game.process.launches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(() => h.broadcasts.some((b) => b.type === "playlist_rotate"), "the relaunch");

    expect(await missionName(h)).toBe("beta.mn3");
    expect(h.game.process.launches[1]).toMatchObject({ configFile: "ctf.cfg", profileId: PROFILE_ID, telnetPassword: PASSWORD });
    expect(h.server.playlistStatusPayload()).toMatchObject({ status: "restarting", rotationCheck: { state: "waiting", attempt: 0 } });

    h.game.process.consoleUp();
    await loggedIn(h, 2);
    await settle(() => h.server.playlist.getStatus().status === "active", "the healthy restart");

    const expected = [
      `console ${sayToAll("Changing mission to Beta")}`,
      "proc stop playlist",
      "ws process_state stopping",
      "console quit",
      "ws process_state stopped",
      "bus server.stopped playlist",
      "ws playlist_status",
      "proc start playlist",
      "ws process_state starting",
      "bus server.started playlist",
      "ws playlist_rotate",
      "ws process_state running",
      "login",
      "console $servercaps",
      "ws playlist_status",
      "ws connection_state ready",
    ];
    const timeline = h.timeline.slice(mark);
    expect(inOrder(timeline, expected)).toEqual(expected);
    expect(h.server.playlistStatusPayload()).toMatchObject({ status: "active", currentIndex: 1, rotationCheck: { state: "idle" } });
    expect(h.logs).toContain('[Playlist] Restart into "Beta" healthy');
    // The supervisor leaves a rotation's stop alone.
    expect(h.timeline.filter((e) => e.startsWith("proc start"))).toEqual(["proc start manual", "proc start playlist"]);
  });

  it("holds a human before the restart: $wait on once the level is up, countdown from the join, then rotates held", async () => {
    const h = await setUp();
    h.game.humans = ["Pilot"];
    await activatePlaylist(h, 10);
    await launchAndLogIn(h);
    await settle(() => h.server.supervisor.humansOnline() === 1, "the roster");

    missionOver(h);
    expect(h.server.playlist.getStatus().status).toBe("holding");
    expect(h.broadcasts.at(-1)).toMatchObject({ type: "playlist_status", payload: { status: "holding" } });

    h.game.process.print("Loading... Opening level 'alpha.d3l'\n");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.game.sent).toContain("$wait on");
    expect(h.game.sent).not.toContain(sayToAll("Mission over. The server restarts in 10 seconds for Beta."));

    h.game.process.print("*Pilot has joined the Anarchy\n");
    expect(h.game.sent).toContain(sayToAll("Mission over. The server restarts in 10 seconds for Beta."));
    await vi.advanceTimersByTimeAsync(10_000);
    await settle(() => h.game.sent.includes(sayToAll("Changing mission to Beta")), "the rotation");
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(() => h.game.process.launches.length === 2, "the relaunch");

    const expected = [
      "console $wait on",
      `console ${sayToAll("Mission over. The server restarts in 10 seconds for Beta.")}`,
      `console ${sayToAll("Restarting into Beta in 5 seconds.")}`,
      `console ${sayToAll("Changing mission to Beta")}`,
      "proc stop playlist",
      "console quit",
      "proc start playlist",
    ];
    expect(inOrder(h.timeline, expected)).toEqual(expected);
    // The server quits held: nothing lets the players go first.
    expect(h.game.sent).not.toContain("$wait off");
  });

  it("a stop by hand during the hold lets the players go and leaves the server down with the playlist active", async () => {
    const h = await setUp();
    h.game.humans = ["Pilot"];
    await activatePlaylist(h, 10);
    await launchAndLogIn(h);
    await settle(() => h.server.supervisor.humansOnline() === 1, "the roster");
    missionOver(h);
    h.game.process.print("Opening level 'alpha.d3l'\n");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.game.sent).toContain("$wait on");

    const result = await h.server.stop("manual");

    expect(result.ok).toBe(true);
    const expected = ["console $wait off", "proc stop manual", "console quit", "bus server.stopped manual", "ws connection_state disconnected"];
    expect(inOrder(h.timeline, expected)).toEqual(expected);
    expect(h.server.playlist.getStatus()).toMatchObject({ status: "active", holdEntry: null });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.game.process.launches).toHaveLength(1);
  });

  it("a stop by hand while the restart is being checked ends the check: no retry, no relaunch", async () => {
    const h = await setUp();
    await activatePlaylist(h, 0);
    await launchAndLogIn(h);
    missionOver(h);
    await settle(() => h.game.sent.includes(sayToAll("Changing mission to Beta")), "the rotation");
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(() => h.broadcasts.some((b) => b.type === "playlist_rotate"), "the relaunch");
    expect(h.server.rotationPending()).toBe(true);

    const result = await h.server.stop("manual");

    expect(result.ok).toBe(true);
    expect(h.server.rotationPending()).toBe(false);
    expect(h.server.playlistStatusPayload()).toMatchObject({ status: "active", rotationCheck: { state: "idle" } });
    // The restart's console never logged in, so there is no quit to send: the process is signalled.
    const expected = ["proc start playlist", "ws playlist_status", "proc stop manual", "proc SIGTERM", "bus server.stopped manual"];
    expect(inOrder(h.timeline, expected)).toEqual(expected);
    expect(h.timeline.filter((e) => e === "console quit")).toHaveLength(1); // the rotation's own
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.game.process.launches).toHaveLength(2);
    expect(h.server.supervisor.snapshot().pendingRelaunch).toBeNull();
  });

  it("a rotation restart that dies is retried by the rotation, not the supervisor; dying again pauses the playlist", async () => {
    const h = await setUp();
    await activatePlaylist(h, 0);
    await launchAndLogIn(h);
    missionOver(h);
    await settle(() => h.game.sent.includes(sayToAll("Changing mission to Beta")), "the rotation");
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(() => h.broadcasts.some((b) => b.type === "playlist_rotate"), "the relaunch");

    h.game.process.exit(1, null);
    await settle(() => h.server.rotationHealth.snapshot().state === "waiting" && h.game.process.launches.length === 3, "the rotation's retry");
    expect(h.broadcasts.some((b) => String(b.payload.message).includes("is not healthy (server exited during startup (exit code 1)). Retrying once"))).toBe(true);
    expect(h.server.supervisor.snapshot()).toMatchObject({ pendingRelaunch: null, lastCrash: { code: 1 } });

    h.game.process.exit(1, null);

    expect(h.server.playlist.getStatus()).toMatchObject({
      status: "paused",
      pausedReason: 'The restart into "Beta" failed: server exited during startup (exit code 1).',
    });
    expect(h.logs).toContain('[Playlist] Paused: the restart into "Beta" failed: server exited during startup (exit code 1)');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.timeline.filter((e) => e.startsWith("proc start"))).toEqual([
      "proc start manual",
      "proc start playlist",
      "proc start playlist",
    ]);
  });
});

describe("ServerInstance: supervisor", () => {
  it("sends the crash's output before the crash, then relaunches the same launch after 5 s and logs in", async () => {
    const h = await setUp();
    await launchAndLogIn(h);
    const first = h.game.process.launches[0];

    h.game.process.emit("stderr", "Segmentation fault\n");
    h.game.process.exit(null, "SIGSEGV");

    const expected = ["ws process_output", "ws process_state crashed", "ws error", "bus server.crashed"];
    expect(inOrder(h.timeline, expected)).toEqual(expected);
    expect(h.broadcasts.find((b) => b.type === "process_output")?.payload).toEqual({
      stream: "stderr",
      data: "Segmentation fault\n",
    });
    expect(h.broadcasts.find((b) => b.type === "error")?.payload.message).toBe("The server crashed; relaunching in 5 s.");
    expect(h.server.supervisor.snapshot().pendingRelaunch).toMatchObject({ cause: "crash" });

    await vi.advanceTimersByTimeAsync(5_000);
    await settle(() => h.game.process.launches.length === 2, "the relaunch");
    const { logPath: firstLog, ...firstRest } = first;
    const { logPath: secondLog, ...secondRest } = h.game.process.launches[1];
    expect(secondRest).toEqual(firstRest);
    expect(path.dirname(secondLog!)).toBe(path.dirname(firstLog!));
    expect(h.timeline).toContain("bus server.started relaunch");

    h.game.process.consoleUp();
    await loggedIn(h, 2);
    expect(h.server.supervisor.snapshot()).toMatchObject({ relaunchCount: 1, hang: { state: "listening" } });
  });

  it("a stop while the relaunch is pending finds nothing running; cancelling the relaunch leaves the server down", async () => {
    const h = await setUp();
    await launchAndLogIn(h);
    h.game.process.exit(null, "SIGSEGV");

    expect(await h.server.stop("manual")).toEqual({ ok: false, code: 409, error: "Server is not running" });
    expect(h.server.supervisor.cancelRelaunch()).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.game.process.launches).toHaveLength(1);
  });

  it("a stop by hand of the relaunched server before its console is up leaves it down", async () => {
    const h = await setUp();
    await launchAndLogIn(h);
    h.game.process.exit(null, "SIGSEGV");
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(() => h.game.process.launches.length === 2, "the relaunch");

    const result = await h.server.stop("manual");

    expect(result).toMatchObject({ ok: true, status: { state: "stopped", stopReason: "manual" } });
    const expected = ["proc start relaunch", "proc stop manual", "proc SIGTERM", "bus server.stopped manual"];
    expect(inOrder(h.timeline, expected)).toEqual(expected);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.game.process.launches).toHaveLength(2);
  });

  it("probes a silent console, kills the server when the probe goes unanswered, then relaunches it", async () => {
    const h = await setUp();
    await launchAndLogIn(h);
    const probesAtLogin = h.game.sent.filter((c) => c === "$players").length;
    h.game.hung = true;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.game.sent.filter((c) => c === "$players").length).toBe(probesAtLogin + 1);
    expect(h.timeline).not.toContain("bus server.hung");

    await vi.advanceTimersByTimeAsync(61_000);
    await settle(() => h.timeline.includes("proc SIGKILL"), "the kill");

    const expected = [
      "bus server.hung",
      "ws error",
      "proc stop hang kill",
      "ws process_state stopping",
      "proc SIGKILL",
      "ws process_state stopped",
      "ws connection_state disconnected",
    ];
    expect(inOrder(h.timeline, expected)).toEqual(expected);
    // A hang kill reports server.hung only; the session went before the kill, so no quit was tried.
    expect(h.timeline.filter((e) => e.startsWith("bus server.stopped") || e === "console quit")).toEqual([]);
    expect(h.server.supervisor.snapshot().pendingRelaunch).toMatchObject({ cause: "hang" });

    h.game.hung = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(() => h.game.process.launches.length === 2, "the relaunch");
    expect(h.timeline).toContain("bus server.started relaunch");
  });

  it("a stop by hand of a server whose console went silent signals it and leaves it down", async () => {
    const h = await setUp();
    await launchAndLogIn(h);
    h.game.hung = true;
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await h.server.stop("manual");

    expect(result).toMatchObject({ ok: true, status: { state: "stopped", stopReason: "manual" } });
    const expected = ["proc stop manual", "console quit", "proc SIGTERM", "bus server.stopped manual"];
    expect(inOrder(h.timeline, expected)).toEqual(expected);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.timeline).not.toContain("bus server.hung");
    expect(h.game.process.launches).toHaveLength(1);
  });
});

describe("ServerInstance: a playlist across a Pyrodeck restart", () => {
  const statePath = (h: Harness) => path.join(h.configDir, "playlist-state.json");

  /**
   * Wait (real time, at most 2 s) until the saved playlist state has the position the playlist has now, and the
   * run record names the running process. The test goes on either way: a position that is never saved fails it later.
   */
  async function saved(h: Harness, pending: string | null): Promise<void> {
    const deadline = performance.now() + 2_000;
    const want = h.playlist.getStatus().currentIndex;
    while (performance.now() < deadline) {
      try {
        const state = JSON.parse(await fs.readFile(statePath(h), "utf-8"));
        const record = JSON.parse(await fs.readFile(runRecordPath(h), "utf-8")) as RunRecord;
        const running = h.game.process.getStatus().pid;
        if (state.currentIndex === want && (state.pending?.kind ?? null) === pending && record.pid === running) return;
      } catch {
        // not written yet
      }
      await new Promise<void>((r) => realSetImmediate(r));
    }
  }

  /** Pyrodeck stops (its timers go with it); the game server keeps running. */
  function pyrodeckStops(h: Harness): void {
    h.server.dispose();
    vi.clearAllTimers();
  }

  /** The next Pyrodeck: re-attaches to the process `pid` the last one left running and logs in to its console. */
  async function restartedOnto(h: Harness, pid: number): Promise<Harness> {
    const next = await setUp({
      after: h,
      processFacts: (p) => ({
        alive: p === pid,
        cmdline: [path.join(h.gamePath, "Descent3"), "-dedicated", "./ctf.cfg"],
        linux: { startTicks: `ticks-${p}`, state: "S", bootId: BOOT_ID },
        bootTimeMs: 0,
      }),
    });
    await next.server.reattach();
    expect(next.timeline).toContain(`proc adopt ${pid}`);
    await vi.advanceTimersByTimeAsync(0);
    await loggedIn(next, 1);
    return next;
  }

  /** The re-attached server's mission ends (on its console: there is no stdout), and the rotation relaunches it. */
  async function missionOverOnConsole(h: Harness, label: string): Promise<void> {
    h.game.console.print("Ending level.Mission over.  Looping back to first level...\n");
    await settle(() => h.game.sent.includes(sayToAll(`Changing mission to ${label}`)), `the rotation into ${label}`);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(() => h.game.process.launches.length === 1, "the relaunch");
  }

  it("re-attached mid-playlist, the next mission end rotates to the entry after the one the server runs", async () => {
    const h = await setUp();
    await activatePlaylist(h, 0, ["Alpha", "Beta", "Gamma"]);
    await launchAndLogIn(h);
    missionOver(h);
    await settle(() => h.game.sent.includes(sayToAll("Changing mission to Beta")), "the rotation into Beta");
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(() => h.game.process.launches.length === 2, "the relaunch");
    h.game.process.consoleUp();
    await loggedIn(h, 2);
    await settle(() => h.playlist.getStatus().status === "active", "the healthy restart");
    await saved(h, null);
    pyrodeckStops(h);

    const after = await restartedOnto(h, 5002);
    expect(after.server.playlistStatusPayload()).toMatchObject({ status: "active", currentEntry: { label: "Beta" } });
    expect(after.game.sent).toContain("$netgameinfo"); // the playlist's timer is anchored again
    await missionOverOnConsole(after, "Gamma");

    expect(await missionName(after)).toBe("gamma.mn3");
    expect(after.game.sent).not.toContain(sayToAll("Changing mission to Beta"));
  });

  it("restarted during the hold, it restarts the held server into the held entry once logged in", async () => {
    const h = await setUp();
    h.game.humans = ["Pilot"];
    await activatePlaylist(h, 10, ["Alpha", "Beta", "Gamma"]);
    await launchAndLogIn(h);
    await settle(() => h.server.supervisor.humansOnline() === 1, "the roster");
    missionOver(h);
    h.game.process.print("Opening level 'alpha.d3l'\n");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.game.sent).toContain("$wait on");
    await saved(h, "hold");
    pyrodeckStops(h);

    const after = await restartedOnto(h, 5001);
    await settle(() => after.game.sent.includes(sayToAll("Changing mission to Beta")), "the rotation into Beta");
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(() => after.game.process.launches.length === 1, "the relaunch");

    expect(await missionName(after)).toBe("beta.mn3");
    const expected = [
      "proc adopt 5001",
      "login",
      `console ${sayToAll("Changing mission to Beta")}`,
      "proc stop playlist",
      "console quit",
      "proc start playlist",
    ];
    expect(inOrder(after.timeline, expected)).toEqual(expected);
    // No second hold, no timer for the level the restart throws away; the server quits held.
    expect(after.game.sent.filter((c) => c.startsWith("$wait") || c === "$netgameinfo")).toEqual([]);
    expect(after.server.playlistStatusPayload()).toMatchObject({ status: "restarting", currentEntry: { label: "Beta" } });
  });

  it("restarted while a rotation's relaunch was being checked, it leaves the new server alone and goes past its entry", async () => {
    const h = await setUp();
    await activatePlaylist(h, 0, ["Alpha", "Beta", "Gamma"]);
    await launchAndLogIn(h);
    missionOver(h);
    await settle(() => h.game.sent.includes(sayToAll("Changing mission to Beta")), "the rotation into Beta");
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(() => h.broadcasts.some((b) => b.type === "playlist_rotate"), "the relaunch");
    expect(h.server.rotationPending()).toBe(true);
    await saved(h, "restart");
    pyrodeckStops(h);

    const after = await restartedOnto(h, 5002);
    expect(after.server.playlistStatusPayload()).toMatchObject({ status: "active", currentEntry: { label: "Beta" } });
    expect(after.game.sent).not.toContain(sayToAll("Changing mission to Beta"));
    await missionOverOnConsole(after, "Gamma");

    expect(await missionName(after)).toBe("gamma.mn3");
  });

  /** A mission ends and its restart is handed to the launcher; Pyrodeck stops before the old game is stopped. */
  async function stopsMidRestart(h: Harness): Promise<void> {
    h.playlist.removeAllListeners("rotate");
    missionOver(h);
    await saved(h, "restart");
    pyrodeckStops(h);
  }

  /** As stopsMidRestart, during the hold before the restart into Beta, with a human on. */
  async function stopsDuringHold(h: Harness): Promise<void> {
    h.game.humans = ["Pilot"];
    await activatePlaylist(h, 10, ["Alpha", "Beta", "Gamma"]);
    await launchAndLogIn(h);
    await settle(() => h.server.supervisor.humansOnline() === 1, "the roster");
    missionOver(h);
    h.game.process.print("Opening level 'alpha.d3l'\n");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.game.sent).toContain("$wait on");
    await saved(h, "hold");
    pyrodeckStops(h);
  }

  /** The next Pyrodeck once the game the last one ran has quit as well: re-attach finds nothing. */
  async function restartedWithNoGame(h: Harness, opts: Omit<SetUpOptions, "after"> = {}): Promise<Harness> {
    const pid = h.game.process.getStatus().pid;
    const next = await setUp({ ...opts, after: h });
    await next.server.reattach();
    expect(next.logs).toContain(`[Pyrodeck] Not re-attaching to server PID ${pid}: process ${pid} is no longer running`);
    return next;
  }

  /** The launched entry comes up healthy, and the next mission end rotates to `label`. */
  async function healthyThenRotates(h: Harness, label: string): Promise<void> {
    h.game.process.consoleUp();
    await loggedIn(h, 1);
    await settle(() => h.playlist.getStatus().status === "active", "the healthy restart");
    missionOver(h);
    await settle(() => h.game.sent.includes(sayToAll(`Changing mission to ${label}`)), `the rotation into ${label}`);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(() => h.game.process.launches.length === 2, "the relaunch");
    expect(await missionName(h)).toBe(`${label.toLowerCase()}.mn3`);
  }

  it("restarted between a rotation's old game quitting and its new one launching, it launches the entry at startup", async () => {
    const h = await setUp();
    await activatePlaylist(h, 0, ["Alpha", "Beta", "Gamma"]);
    await launchAndLogIn(h);
    await stopsMidRestart(h);

    const after = await restartedWithNoGame(h, { autostartProfileId: PROFILE_ID });
    expect(await after.server.resumeRotation()).toBe(true);
    await after.server.runAutostart();

    expect(after.timeline.filter((e) => e.startsWith("proc start"))).toEqual(["proc start playlist"]);
    expect(await missionName(after)).toBe("beta.mn3");
    expect(after.server.playlistStatusPayload()).toMatchObject({
      status: "restarting",
      currentEntry: { label: "Beta" },
      rotationCheck: { state: "waiting", attempt: 0 },
    });
    expect(after.logs).toContain(
      '[Playlist] The restart of "test" into "Beta" was under way when Pyrodeck stopped, and the server is down; launching it now',
    );
    // Autostart leaves alone the server its playlist is restarting; a second call finds nothing to resume.
    expect(after.server.autostart.snapshot()).toMatchObject({ state: "skipped", reason: "its playlist is restarting it" });
    expect(await after.server.resumeRotation()).toBe(false);

    await healthyThenRotates(after, "Gamma");
    expect(after.logs).toContain('[Playlist] Restart into "Beta" healthy');
  });

  it("restarted during the hold after the held game quit, it launches the held entry with no second hold", async () => {
    const h = await setUp();
    await stopsDuringHold(h);

    const after = await restartedWithNoGame(h);
    expect(await after.server.resumeRotation()).toBe(true);

    expect(after.timeline.filter((e) => e.startsWith("proc start"))).toEqual(["proc start playlist"]);
    expect(await missionName(after)).toBe("beta.mn3");
    expect(after.server.playlistStatusPayload()).toMatchObject({
      status: "restarting",
      holdEntry: null,
      currentEntry: { label: "Beta" },
      rotationCheck: { state: "waiting" },
    });
    await healthyThenRotates(after, "Gamma");
    expect(after.game.sent.filter((c) => c.startsWith("$wait"))).toEqual([]);
  });

  it("a paused playlist is not resumed: the server stays down", async () => {
    const h = await setUp();
    await activatePlaylist(h, 0, ["Alpha", "Beta", "Gamma"]);
    await launchAndLogIn(h);
    await stopsMidRestart(h);
    const state = JSON.parse(await fs.readFile(statePath(h), "utf-8"));
    await fs.writeFile(statePath(h), JSON.stringify({ ...state, paused: { reason: "Paused.", at: Date.now() } }));

    const after = await restartedWithNoGame(h);
    expect(await after.server.resumeRotation()).toBe(false);
    await after.server.runAutostart();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(after.game.process.launches).toHaveLength(0);
    expect(after.server.playlist.getStatus()).toMatchObject({ status: "paused", currentEntry: { label: "Beta" } });
  });

  it("re-attached to the held game, it restarts that game once and launches no second one", async () => {
    const h = await setUp();
    await stopsDuringHold(h);

    const after = await setUp({
      after: h,
      processFacts: (p) => ({
        alive: p === 5001,
        cmdline: [path.join(h.gamePath, "Descent3"), "-dedicated", "./ctf.cfg"],
        linux: { startTicks: `ticks-${p}`, state: "S", bootId: BOOT_ID },
        bootTimeMs: 0,
      }),
    });
    await after.server.reattach();
    expect(await after.server.resumeRotation()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    await loggedIn(after, 1);
    await settle(() => after.game.sent.includes(sayToAll("Changing mission to Beta")), "the rotation into Beta");
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(() => after.game.process.launches.length === 1, "the relaunch");
    expect(await after.server.resumeRotation()).toBe(false);

    expect(inOrder(after.timeline, ["proc adopt 5001", "proc stop playlist", "proc start playlist"])).toEqual([
      "proc adopt 5001",
      "proc stop playlist",
      "proc start playlist",
    ]);
    expect(after.timeline.filter((e) => e.startsWith("proc start"))).toEqual(["proc start playlist"]);
    expect(after.logs.filter((l) => l.includes("and the server is down; launching it now"))).toEqual([]);
  });
});

describe("ServerInstance: re-attach and autostart", () => {
  const record = (h: Harness): RunRecord => ({
    version: 1,
    pid: 4242,
    profileId: PROFILE_ID,
    executablePath: path.join(h.gamePath, "Descent3"),
    gamePath: h.gamePath,
    configFile: "ctf.cfg",
    args: ["-dedicated", "./ctf.cfg"],
    logPath: null,
    telnetPort: CONSOLE_PORT,
    launchOptions: null,
    allowRemoteConsole: false,
    startedAt: "2026-11-15T10:00:00.000Z",
    linux: { startTicks: "ticks-4242", bootId: BOOT_ID },
  });

  it("re-attaches to the server from before Pyrodeck's restart, reads it from its console, and autostart leaves it alone", async () => {
    let alive = true;
    const h = await setUp({
      autostartProfileId: PROFILE_ID,
      processFacts: (pid) => ({
        alive: alive && pid === 4242,
        cmdline: [path.join(h.gamePath, "Descent3"), "-dedicated", "./ctf.cfg"],
        linux: { startTicks: "ticks-4242", state: "S", bootId: BOOT_ID },
        bootTimeMs: 0,
      }),
    });
    await fs.writeFile(runRecordPath(h), JSON.stringify(record(h)));

    await h.server.reattach();
    await h.server.runAutostart();

    const expected = ["proc adopt 4242", "ws process_state running", "bus server.adopted"];
    expect(inOrder(h.timeline, expected)).toEqual(expected);
    expect(h.server.autostart.snapshot()).toMatchObject({ state: "skipped", profileId: PROFILE_ID });
    expect(h.game.process.launches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(0);
    await loggedIn(h, 1);
    expect(h.game.logins).toEqual([{ host: "127.0.0.1", port: CONSOLE_PORT, password: PASSWORD }]);
    expect(h.server.supervisor.snapshot()).toMatchObject({ adopted: true, humans: 0 });

    // No stdout from a re-attached server: its console feeds the playlist's level detection and the quit watch.
    h.game.console.print("Opening level 'beta.d3l'\n");
    expect(h.server.playlist.getCurrentLevel()).toBe("beta");
    expect(h.broadcasts.at(-1)).toEqual({ type: "level_changed", payload: { level: "beta" } });

    h.game.console.print("[192.168.1.5] quit\n");
    alive = false;
    h.game.process.exit(null, null);

    expect(h.server.process.getStatus()).toMatchObject({ state: "stopped", stopReason: "console" });
    expect(h.timeline).toContain("bus server.stopped manual");
    await settle(() => !existsSync(runRecordPath(h)), "the run record's removal");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.game.process.launches).toHaveLength(0);
  });

  it("forgets a run record whose process is gone, and autostart then launches", async () => {
    const h = await setUp({ autostartProfileId: PROFILE_ID });
    await fs.writeFile(runRecordPath(h), JSON.stringify(record(h)));

    await h.server.reattach();

    expect(existsSync(runRecordPath(h))).toBe(false);
    expect(h.logs).toContain("[Pyrodeck] Not re-attaching to server PID 4242: process 4242 is no longer running");
    await h.server.runAutostart();
    expect(h.timeline).toContain("proc start autostart");
    expect(h.server.autostart.snapshot()).toMatchObject({ state: "watching", source: "setting" });
  });

  it("autostart's crash-loop guard stops the supervisor's relaunches after the last allowed failure", async () => {
    const h = await setUp({ autostartProfileId: PROFILE_ID, autostart: { maxFailures: 3 } });
    await h.server.reattach();
    await h.server.runAutostart();
    expect(h.server.autostart.snapshot()).toMatchObject({ state: "watching", profileName: PROFILE_NAME });

    h.game.process.exit(1, null);
    expect(h.server.autostart.snapshot()).toMatchObject({ state: "relaunching", failures: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(() => h.game.process.launches.length === 2, "the first relaunch");
    expect(h.server.autostart.snapshot().state).toBe("watching");

    h.game.process.exit(1, null);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle(() => h.game.process.launches.length === 3, "the second relaunch");

    const mark = h.broadcasts.length;
    h.game.process.exit(1, null);

    expect(h.server.autostart.snapshot()).toMatchObject({ state: "failed", failures: 3 });
    expect(h.server.supervisor.snapshot()).toMatchObject({ pendingRelaunch: null, gaveUp: { reason: expect.stringContaining("autostart") } });
    // The guard hears of the crash before the supervisor: no relaunch is announced for it.
    expect(h.broadcasts.slice(mark).map((b) => b.payload.message).filter(Boolean)).toEqual([
      `Autostart of "${PROFILE_NAME}" gave up after 3 failed starts in a row; the last: the server exited 0 s after starting (exit code 1). Launch it by hand once the cause is fixed.`,
    ]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.timeline.filter((e) => e.startsWith("proc start"))).toEqual([
      "proc start autostart",
      "proc start relaunch",
      "proc start relaunch",
    ]);
  });

  it("a stop by hand while the guard watches ends it and the server stays down", async () => {
    const h = await setUp({ autostartProfileId: PROFILE_ID });
    await h.server.reattach();
    await h.server.runAutostart();
    h.game.process.consoleUp();
    await loggedIn(h, 1);

    await h.server.stop("manual");

    expect(h.server.autostart.snapshot()).toMatchObject({ state: "cancelled", reason: "the server was stopped by hand" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.game.process.launches).toHaveLength(1);
  });
});
