import { EventEmitter } from "node:events";
import { NO_PROFILE_ID, type ServerEvents } from "../../events/ServerEvents.js";
import type { ServerConnection } from "../../connection/ServerConnection.js";
import type { AdoptTarget, LaunchConfig, ProcessState, ProcessStatus, StartReason, StopReason } from "../../launcher/ProcessManager.js";
import type { ProcessFacts } from "../../launcher/runRecord.js";
import type { ProcessHost } from "../ServerInstance.js";

/**
 * Stand-in game servers for tests of several servers on one Pyrodeck: each
 * process follows ProcessManager's order of state changes and bus events,
 * each console TelnetConnection's callbacks. A console logs in to whichever
 * process listens on the port it connects to, so a command reaching the
 * wrong server shows in that server's `sent`.
 */

export const SERVERCAPS = "SERVERCAPS version=1 fork=Matcen fork_version=0.10.17 features=bots,roster\n";

export class FakeWorld {
  /** Every process call, console command and bus event, in order, tagged with the server. */
  readonly timeline: string[] = [];
  readonly processes = new Map<string, FakeProcess>();
  /** Processes whose console port answers, by port. */
  readonly listening = new Map<number, FakeProcess>();
  /** Processes alive outside Pyrodeck (for re-attach), by pid. */
  readonly alive = new Map<number, { executable: string }>();
  nextPid = 7001;

  process(serverId: string, bus: ServerEvents): FakeProcess {
    const p = new FakeProcess(this, serverId, bus);
    this.processes.set(serverId, p);
    return p;
  }

  connect(): FakeConsole {
    return new FakeConsole(this);
  }

  /** What re-attach reads about a pid. */
  host(): ProcessHost {
    return {
      platform: "linux",
      readProcessFacts: async (pid: number): Promise<ProcessFacts> => {
        const p = this.alive.get(pid);
        return p
          ? {
              alive: true,
              cmdline: [p.executable, "-dedicated", "./x.cfg"],
              linux: { startTicks: `ticks-${pid}`, state: "S", bootId: "boot-1" },
              bootTimeMs: 0,
            }
          : { alive: false, cmdline: null, linux: null, bootTimeMs: 0 };
      },
      readLinuxIdentity: async (pid: number) => ({ startTicks: `ticks-${pid}`, state: "S", bootId: "boot-1" }),
    };
  }
}

/** One server's game process, as ProcessManager reports it. */
export class FakeProcess extends EventEmitter {
  sendQuitFn: (() => Promise<void>) | null = null;
  readonly launches: LaunchConfig[] = [];
  /** Console commands this server received. */
  readonly sent: string[] = [];
  /** Humans `$players` lists. */
  humans: string[] = [];
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

  constructor(
    private readonly world: FakeWorld,
    readonly serverId: string,
    private readonly bus: ServerEvents,
  ) {
    super();
  }

  private log(entry: string): void {
    this.world.timeline.push(`${this.serverId} ${entry}`);
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

  noteConsoleQuit(): void {}

  async start(config: LaunchConfig, reason: StartReason = "manual"): Promise<void> {
    if (this.isRunning()) throw new Error("Server is already running");
    this.log(`start ${reason}`);
    await Promise.resolve();
    this.launches.push(config);
    this.config = config;
    this.telnetReady = false;
    this.stopReason = "manual";
    this.setState("starting");
    await Promise.resolve();
    const pid = this.world.nextPid++;
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
    this.world.listening.set(this.config!.telnetPort, this);
    this.setState("running");
    this.emit("telnetReady", this.config!.telnetPort, this.consoleHost());
  }

  async stop(reason: StopReason = "manual", options: { kill?: boolean } = {}): Promise<void> {
    if (this.status.pid === null || this.status.state === "stopped" || this.status.state === "stopping") return;
    this.log(`stop ${reason}`);
    this.stopReason = reason;
    this.setState("stopping");
    if (!options.kill && this.sendQuitFn && this.telnetReady) {
      await this.sendQuitFn();
      if (this.status.pid === null) return;
    }
    this.exit(null, options.kill ? "SIGKILL" : "SIGTERM");
  }

  adopt(target: AdoptTarget): void {
    if (this.isRunning()) throw new Error("Server is already running");
    this.log(`adopt ${target.pid}`);
    this.config = target.config;
    this.telnetReady = true;
    this.stopReason = "manual";
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
    this.world.listening.set(target.config.telnetPort, this);
    this.setState("running");
    this.bus.emitEvent("server.adopted", {
      profileId: target.config.profileId ?? NO_PROFILE_ID,
      pid: target.pid,
      startedAt: target.startedAt.toISOString(),
    });
    setTimeout(() => this.emit("telnetReady", target.config.telnetPort, this.consoleHost()), 0);
  }

  print(text: string): void {
    this.emit("stdout", text);
  }

  reply(command: string): string {
    if (command === "$servercaps") return SERVERCAPS;
    if (command === "$players") {
      return ["PNum Name", "00: -Server-", ...this.humans.map((n, i) => `${String(i + 1).padStart(2, "0")}: ${n}`), ""].join(
        "\n",
      );
    }
    return "";
  }

  /** The process ended: after a stop, or on its own (a crash). */
  exit(code: number | null, signal: string | null): void {
    const pid = this.status.pid;
    if (pid === null) return;
    const profileId = this.status.activeProfileId ?? NO_PROFILE_ID;
    if (this.config && this.world.listening.get(this.config.telnetPort) === this) {
      this.world.listening.delete(this.config.telnetPort);
    }
    this.world.alive.delete(pid);
    this.status = { ...this.status, pid: null, exitCode: code, exitSignal: signal, stoppedAt: new Date() };
    if (this.status.state === "stopping") {
      this.status.stopReason = this.stopReason;
      this.setState("stopped");
      if (this.stopReason !== "hang") this.bus.emitEvent("server.stopped", { profileId, pid, reason: this.stopReason });
    } else {
      this.log("crashed");
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

/** One console login, to the process listening on its port. */
export class FakeConsole implements ServerConnection {
  private connected = false;
  private target: FakeProcess | null = null;
  private dataCallbacks: ((data: string) => void)[] = [];
  private disconnectCallbacks: ((reason: string) => void)[] = [];

  constructor(private readonly world: FakeWorld) {}

  async connect(_host: string, port: number): Promise<void> {
    const target = this.world.listening.get(port);
    if (!target) throw new Error(`connect ECONNREFUSED 127.0.0.1:${port}`);
    this.target = target;
    this.world.timeline.push(`${target.serverId} login`);
    this.connected = true;
  }

  async send(command: string): Promise<string> {
    if (!this.connected || !this.target) throw new Error("Not connected");
    this.target.sent.push(command);
    this.world.timeline.push(`${this.target.serverId} console ${command}`);
    const reply = this.target.reply(command);
    if (reply) for (const cb of this.dataCallbacks) cb(reply);
    return reply;
  }

  onData(callback: (data: string) => void): void {
    this.dataCallbacks.push(callback);
  }

  onDisconnect(callback: (reason: string) => void): void {
    this.disconnectCallbacks.push(callback);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.dataCallbacks = [];
    this.disconnectCallbacks = [];
  }

  async quit(): Promise<void> {
    if (!this.connected || !this.target) return;
    this.target.sent.push("quit");
    this.world.timeline.push(`${this.target.serverId} console quit`);
    const target = this.target;
    this.connected = false;
    for (const cb of [...this.disconnectCallbacks]) cb("Connection closed");
    target.exit(0, null);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** The server prints a line nobody asked for. */
  print(text: string): void {
    for (const cb of this.dataCallbacks) cb(text);
  }
}
