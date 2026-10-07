import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { consoleHostFor, launchOptionArgs, type LaunchOptions } from "./launchOptions.js";

export type ProcessState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed";

/**
 * Whether the current launch's output is reaching its log file.
 * - none: no log for this launch
 * - pending: launched, first write check not yet run
 * - ok: the file exists and holds what was written to it
 * - failed: output is NOT being saved; `message` says why
 */
export interface LogHealth {
  path: string | null;
  state: "none" | "pending" | "ok" | "failed";
  message: string | null;
}

export interface ProcessStatus {
  state: ProcessState;
  pid: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
  /** Profile whose launch produced the current/last process, if launched from a profile. */
  activeProfileId: string | null;
  /** Log file health for the current/last launch (stays "failed" until the next launch). */
  log: LogHealth;
}

export interface ProcessManagerOptions {
  /** Delay before the first log write check (default LOG_WRITE_CHECK_MS). */
  logCheckDelayMs?: number;
  /** Interval of the log re-checks while the process runs (default LOG_RECHECK_MS). */
  logRecheckMs?: number;
}

export interface LaunchConfig {
  /** Full path to D3 executable. */
  executablePath: string;
  /** Directory containing D3 game data, configs, and missions. Used as cwd. */
  gamePath: string;
  /** Config filename in gamePath (e.g., "my-server.cfg"). */
  configFile: string;
  /** Extra CLI flags. -autoexec and the profile's launch options are added by buildLaunchArgs. */
  additionalArgs?: string[];
  /** The profile's launch options (-useip, -useport, -framecap, ...), placed right after the config file. */
  launchOptions?: LaunchOptions | null;
  /** Profile this launch originates from, surfaced in status so the UI can mark the live profile. */
  profileId?: string;
  /** Optional path to write server log file. If set, stdout/stderr are written here. */
  logPath?: string;
  telnetPort: number;
  telnetPassword: string;
}

/** DMFC startup script: the Config tab's "Startup Commands", kept in the game directory. */
export const AUTOEXEC_FILE = "autoexec.dmfc";

// The engine copies each command-line argument into a 100-byte buffer
// (MAX_CHARS_PER_ARG in Descent3/args.h); a longer one reaches DMFC mangled.
const MAX_ENGINE_ARG_BYTES = 99;

export interface LaunchArgs {
  args: string[];
  /** Set when the Startup Commands file exists but cannot be passed to the server. */
  warning: string | null;
}

/**
 * The server's command line. The profile's launch options follow the config
 * file (launchOptions.ts lists what each flag does in the engine). DMFC reads
 * its startup script from the engine's writable directory
 * (`<pref dir>/netgames/autoexec.dmfc`) unless `-autoexec` names a file, so a
 * Startup Commands file in the game directory is passed by absolute path.
 * Without one nothing is passed and DMFC reads its default.
 * spawn() hands each argument over whole, so a path with spaces needs no quoting.
 */
export async function buildLaunchArgs(config: LaunchConfig): Promise<LaunchArgs> {
  // Config files live in gamePath alongside game data — the traditional D3 layout.
  // Use ./ prefix so cfopen() resolves relative to cwd (gamePath).
  // The engine takes the first occurrence of a flag (FindArg), so a launch
  // option wins over the same flag in additionalArgs.
  const args = [
    "-dedicated",
    `./${config.configFile}`,
    ...launchOptionArgs(config.launchOptions),
    ...(config.additionalArgs ?? []),
  ];

  const autoexecPath = path.resolve(config.gamePath, AUTOEXEC_FILE);
  try {
    if (!(await fs.promises.stat(autoexecPath)).isFile()) return { args, warning: null };
  } catch {
    return { args, warning: null };
  }
  if (Buffer.byteLength(autoexecPath) > MAX_ENGINE_ARG_BYTES) {
    return {
      args,
      warning:
        `Startup Commands not applied: ${autoexecPath} is longer than the ${MAX_ENGINE_ARG_BYTES} characters ` +
        "the server accepts in one command-line argument. Use a game directory with a shorter path.",
    };
  }
  // The engine takes the first -autoexec, so one already in additionalArgs wins.
  return { args: [...args, "-autoexec", autoexecPath], warning: null };
}

const TELNET_PROBE_INTERVAL_MS = 500;
// 60s gives D3 plenty of time to initialize its telnet port on slow/Windows hosts.
const TELNET_PROBE_TIMEOUT_MS = 60000;
const GRACEFUL_QUIT_TIMEOUT_MS = 5000;
const SIGTERM_TIMEOUT_MS = 3000;
// How long to wait for a port to be released by the kernel after the previous
// D3 process exited. D3 doesn't use SO_REUSEADDR, so a restart that's too fast
// causes InitDedicatedSocket to fail and the new server silently won't accept
// connections.
// Linux TIME_WAIT is 2*MSL (typically 60s). Give ourselves headroom.
const PORT_RELEASE_WAIT_MS = 90000;
const PORT_RELEASE_POLL_INTERVAL_MS = 500;
// Windows TIME_WAIT upper bound. Windows default TcpTimedWaitDelay is 240s but
// in practice connections from a local loopback client tend to expire sooner.
// We wait up to this long after a managed D3 exit before re-launching on the
// same port.  First-launch never waits (no prior exit to worry about).
const WINDOWS_TIME_WAIT_MS = 120_000;
// After launch, give the log file this long to receive its first bytes. The
// startup banner is written synchronously on open, so a healthy log is non-empty
// almost immediately; if it's still empty (or the stream errored) past this
// window, logging silently failed and we raise a loud warning.
const LOG_WRITE_CHECK_MS = 8000;
// While the server runs, re-check the log this often: a log file deleted or
// moved away mid-run (cleanup scripts, a mis-aimed rm) keeps "working" from
// the writer's side while the output goes to an unlinked inode.
const LOG_RECHECK_MS = 30_000;

/**
 * Manages the D3 dedicated server process lifecycle.
 *
 * Events:
 *   stateChange(state: ProcessState)
 *   stdout(data: string)
 *   stderr(data: string)
 *   telnetReady(port: number, host: string)  — host: where the console listens (-useip, else 127.0.0.1)
 *   exit(code: number | null, signal: string | null)
 *   logWarning(message: string)  — logging failed; server runs but output isn't saved
 */
export class ProcessManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private status: ProcessStatus = {
    state: "stopped",
    pid: null,
    exitCode: null,
    exitSignal: null,
    startedAt: null,
    stoppedAt: null,
    activeProfileId: null,
    log: { path: null, state: "none", message: null },
  };
  private telnetProbeTimer: ReturnType<typeof setInterval> | null = null;
  private telnetReady = false;
  private launchConfig: LaunchConfig | null = null;
  private logStream: fs.WriteStream | null = null;
  private logPath: string | null = null;
  private logStreamFailed = false;
  private writeCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private logRecheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Inode of the log file at the first check; a different one later means it was replaced. */
  private logIno: number | null = null;
  private readonly logCheckDelayMs: number;
  private readonly logRecheckMs: number;
  // Track the last D3 exit so we only apply port-release waits when needed.
  private lastExitedPort: number | null = null;
  private lastExitedAt: number = 0;

  /** Send a quit command over telnet for graceful shutdown. Set externally. */
  sendQuitFn: (() => Promise<void>) | null = null;

  constructor(options: ProcessManagerOptions = {}) {
    super();
    this.logCheckDelayMs = options.logCheckDelayMs ?? LOG_WRITE_CHECK_MS;
    this.logRecheckMs = options.logRecheckMs ?? LOG_RECHECK_MS;
  }

  getStatus(): ProcessStatus {
    return { ...this.status, log: { ...this.status.log } };
  }

  /** Log file the current launch is writing, or null when no child is alive. */
  getActiveLogPath(): string | null {
    return this.child ? this.logPath : null;
  }

  isRunning(): boolean {
    return this.status.state === "running" || this.status.state === "starting";
  }

  async start(config: LaunchConfig): Promise<void> {
    if (this.isRunning()) {
      throw new Error("Server is already running");
    }

    this.launchConfig = config;
    this.telnetReady = false;
    this.setState("starting");

    // Wait for the previous D3's network port to be fully released by the
    // kernel. Matcen-fork D3 binds without SO_REUSEADDR — spawning too quickly
    // causes InitDedicatedSocket to fail and the new server runs without
    // network (bots simulate but nothing connects).
    await this.waitForPortFree(config.telnetPort);

    const { args, warning: argsWarning } = await buildLaunchArgs(config);
    if (argsWarning) this.emit("stderr", `${argsWarning}\n`);

    this.child = spawn(config.executablePath, args, {
      cwd: config.gamePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // D3 dedicated doesn't need a real display but SDL may require this
        SDL_VIDEODRIVER: process.env.SDL_VIDEODRIVER ?? "dummy",
      },
    });

    this.status.pid = this.child.pid ?? null;
    this.status.startedAt = new Date();
    this.status.exitCode = null;
    this.status.exitSignal = null;
    this.status.stoppedAt = null;
    this.status.activeProfileId = config.profileId ?? null;

    // Open log file if configured
    this.logPath = config.logPath ?? null;
    this.logStreamFailed = false;
    this.logIno = null;
    this.status.log = {
      path: this.logPath,
      state: this.logPath ? "pending" : "none",
      message: null,
    };
    if (config.logPath) {
      const logPath = config.logPath;
      try {
        this.logStream = fs.createWriteStream(logPath, { flags: "a" });
        // A bad/unwritable target (e.g. a non-existent parent dir from a mangled
        // path) surfaces here asynchronously rather than throwing. Don't swallow
        // it — flag the failure and raise a warning so the run isn't logging
        // silently into the void.
        this.logStream.on("error", (err) => {
          this.failLog(
            `Logging failed: cannot write ${logPath} (${err.message}). Server is running but its output is NOT being saved.`,
          );
        });
        const timestamp = new Date().toISOString();
        this.logStream.write(`\n--- D3 Server started at ${timestamp} ---\n`);
        this.logStream.write(`  Executable: ${config.executablePath}\n`);
        this.logStream.write(`  Config: ${config.gamePath}/${config.configFile}\n`);
        this.logStream.write(`  Args: ${args.join(" ")}\n`);
        if (argsWarning) this.logStream.write(`  Warning: ${argsWarning}\n`);
        this.logStream.write(`  PID: ${this.child.pid}\n\n`);
      } catch (err) {
        // Log file is optional — don't fail the launch, but don't hide it either.
        this.logStream = null;
        const message = err instanceof Error ? err.message : String(err);
        this.failLog(
          `Logging failed: cannot open ${logPath} (${message}). Server is running but its output is NOT being saved.`,
        );
      }
      this.startLogWriteCheck();
    }

    // Drain stdout/stderr to prevent SIGPIPE if D3 writes faster than we read
    this.child.stdout?.on("data", (chunk: Buffer) => {
      try {
        const text = chunk.toString("utf-8");
        this.emit("stdout", text);
        this.logStream?.write(text);
        this.checkStdoutForReadiness(text);
      } catch {
        // Never let handler errors break the pipe
      }
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      try {
        const text = chunk.toString("utf-8");
        this.emit("stderr", text);
        this.logStream?.write(`[stderr] ${text}`);
      } catch {
        // Never let handler errors break the pipe
      }
    });

    // Prevent unhandled errors on streams from killing the process
    this.child.stdout?.on("error", () => {});
    this.child.stderr?.on("error", () => {});

    this.child.on("error", (err) => {
      this.cleanup();
      this.status.stoppedAt = new Date();
      this.setState("crashed");
      this.emit("exit", null, null);
      this.emit("stderr", `Process error: ${err.message}\n`);
    });

    this.child.on("exit", (code, signal) => {
      this.cleanup();
      this.status.exitCode = code;
      this.status.exitSignal = signal;
      this.status.stoppedAt = new Date();

      if (this.status.state === "stopping") {
        this.setState("stopped");
      } else {
        // Unexpected exit
        this.setState("crashed");
      }
      this.emit("exit", code, signal);
    });

    // Start TCP probe for telnet readiness as a fallback
    this.startTelnetProbe(config.telnetPort, this.consoleHost());
  }

  /** Where the launched server's console listens: its -useip address, else loopback. */
  private consoleHost(): string {
    return consoleHostFor(this.launchConfig?.launchOptions) ?? "127.0.0.1";
  }

  async stop(): Promise<void> {
    if (!this.child || this.status.state === "stopped" || this.status.state === "stopping") {
      return;
    }

    this.setState("stopping");

    // Step 1: Try graceful quit via telnet
    if (this.sendQuitFn && this.telnetReady) {
      try {
        await this.sendQuitFn();
      } catch {
        // Telnet quit failed, proceed to signals
      }

      if (await this.waitForExit(GRACEFUL_QUIT_TIMEOUT_MS)) return;
    }

    // Step 2: SIGTERM
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      if (await this.waitForExit(SIGTERM_TIMEOUT_MS)) return;
    }

    // Step 3: SIGKILL
    if (this.child && !this.child.killed) {
      this.child.kill("SIGKILL");
      await this.waitForExit(2000);
    }
  }

  private setState(state: ProcessState): void {
    this.status.state = state;
    this.emit("stateChange", state);
  }

  /** Record a logging failure once: persistent in status, plus a logWarning event. */
  private failLog(message: string): void {
    if (this.logStreamFailed) return;
    this.logStreamFailed = true;
    this.status.log = { path: this.logPath, state: "failed", message };
    this.stopLogChecks();
    this.emit("logWarning", message);
  }

  private stopLogChecks(): void {
    if (this.writeCheckTimer) {
      clearTimeout(this.writeCheckTimer);
      this.writeCheckTimer = null;
    }
    if (this.logRecheckTimer) {
      clearInterval(this.logRecheckTimer);
      this.logRecheckTimer = null;
    }
  }

  /**
   * Backstop for the log stream's async 'error': a short while after launch,
   * confirm the log file actually exists and has received bytes. If it's still
   * empty (or the stream already errored), logging silently failed — raise a
   * loud warning so it's caught in seconds rather than after an overnight soak.
   * After a pass, keep re-checking while the server runs, so a log deleted,
   * moved or replaced mid-run is reported too.
   */
  private startLogWriteCheck(): void {
    this.stopLogChecks();
    const logPath = this.logPath;
    if (!logPath) return;
    const secs = Math.round(this.logCheckDelayMs / 1000);
    this.writeCheckTimer = setTimeout(() => {
      this.writeCheckTimer = null;
      // Stream error path already warned; don't double-report.
      if (this.logStreamFailed) return;
      fs.promises
        .stat(logPath)
        .then((st) => {
          if (this.logStreamFailed || this.logPath !== logPath) return;
          if (st.size === 0) {
            this.failLog(
              `Logging failed: ${logPath} exists but is empty ${secs}s after launch. Server output is NOT being saved.`,
            );
            return;
          }
          this.logIno = st.ino;
          this.status.log = { path: logPath, state: "ok", message: null };
          if (this.child) {
            this.logRecheckTimer = setInterval(() => this.recheckLog(logPath), this.logRecheckMs);
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.failLog(
            `Logging failed: ${logPath} not found ${secs}s after launch (${message}). Server output is NOT being saved.`,
          );
        });
    }, this.logCheckDelayMs);
  }

  /** Periodic check: the log file is still the one being written. */
  private recheckLog(logPath: string): void {
    if (this.logStreamFailed || this.logPath !== logPath) return;
    fs.promises
      .stat(logPath)
      .then((st) => {
        if (this.logStreamFailed || this.logPath !== logPath) return;
        if (this.logIno !== null && st.ino !== this.logIno) {
          this.failLog(
            `Logging failed: ${logPath} was replaced by another file; server output is going to the old one and is NOT being saved where expected.`,
          );
        }
      })
      .catch(() => {
        if (this.logStreamFailed || this.logPath !== logPath) return;
        this.failLog(
          `Logging failed: ${logPath} was deleted or moved while the server runs. Server output is NOT being saved.`,
        );
      });
  }

  /**
   * Wait until the target port has no sockets in TIME_WAIT or other non-LISTEN
   * states that would prevent D3 from binding.
   *
   * Why we can't use node's bind() as a probe: node's net.Server.listen() sets
   * SO_REUSEADDR=1 by default via libuv, which lets it bind right through
   * TIME_WAIT sockets. D3 does not set SO_REUSEADDR, so a node bind success
   * is a false positive — observed empirically as 8ms stop→start gap followed
   * by D3 logging "Unable to bind listen socket for dedicated server!".
   *
   * Authoritative check on Linux: read /proc/net/tcp{,6} and /proc/net/udp{,6}
   * for any socket holding the port. Only LISTEN is safe to ignore (that's
   * what D3 is about to create). TIME_WAIT, CLOSE_WAIT, ESTABLISHED, etc.
   * would all make D3's bind fail.
   *
   * On non-Linux platforms (not our dev target, but don't crash), fall back
   * to a simple setTimeout for TIME_WAIT's typical duration.
   */
  private async waitForPortFree(port: number): Promise<void> {
    const deadline = Date.now() + PORT_RELEASE_WAIT_MS;
    const portHex = port.toString(16).toUpperCase().padStart(4, "0");
    const procFiles = [
      "/proc/net/tcp",
      "/proc/net/tcp6",
      "/proc/net/udp",
      "/proc/net/udp6",
    ];
    // Linux TCP state code 0A = LISTEN; any other non-zero code on a port we
    // just vacated means a socket is lingering (TIME_WAIT is 06).
    const LISTEN = "0A";

    const portHeld = async (): Promise<boolean> => {
      for (const file of procFiles) {
        let contents: string;
        try {
          contents = await fs.promises.readFile(file, "utf-8");
        } catch {
          continue; // file missing (e.g. no ipv6) or permission denied
        }
        const lines = contents.split("\n").slice(1); // skip header
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 4) continue;
          // local_address is parts[1] = "IP:PORT" in hex
          const local = parts[1];
          const colonIdx = local.lastIndexOf(":");
          if (colonIdx < 0) continue;
          const localPort = local.slice(colonIdx + 1);
          if (localPort !== portHex) continue;
          const state = parts[3];
          // UDP sockets in /proc/net/udp always have state 07 (UDP_ESTABLISHED,
          // effectively "in use") — anything non-LISTEN on our port blocks bind.
          if (state !== LISTEN) return true;
        }
      }
      return false;
    };

    // On non-Linux, /proc doesn't exist; portHeld always returns false.
    // Detect and fall back to a simple delay so we still wait for TIME_WAIT.
    let procAvailable = false;
    try {
      await fs.promises.access("/proc/net/tcp");
      procAvailable = true;
    } catch { /* not Linux */ }

    if (!procAvailable) {
      // On non-Linux (Windows) we can't read /proc/net/tcp, so we fall back to
      // a timer-based heuristic.  Only wait if we recently managed a D3 process
      // on this exact port — a first-ever launch has nothing in TIME_WAIT and
      // should start immediately.
      if (this.lastExitedPort === port) {
        const elapsed = Date.now() - this.lastExitedAt;
        if (elapsed < WINDOWS_TIME_WAIT_MS) {
          const waitMs = WINDOWS_TIME_WAIT_MS - elapsed;
          this.emit(
            "stderr",
            `Waiting ${Math.ceil(waitMs / 1000)}s for port ${port} to be released by the OS (Windows TIME_WAIT)...\n`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      return;
    }

    while (Date.now() < deadline) {
      if (!(await portHeld())) return;
      await new Promise((r) => setTimeout(r, PORT_RELEASE_POLL_INTERVAL_MS));
    }
    this.emit(
      "stderr",
      `Warning: port ${port} still held after ${PORT_RELEASE_WAIT_MS}ms; starting anyway.\n`,
    );
  }

  private cleanup(): void {
    this.stopTelnetProbe();
    this.stopLogChecks();
    // Record exit so waitForPortFree() can skip the delay on first-ever launch.
    if (this.launchConfig) {
      this.lastExitedPort = this.launchConfig.telnetPort;
      this.lastExitedAt = Date.now();
    }
    if (this.logStream) {
      const timestamp = new Date().toISOString();
      this.logStream.write(`\n--- D3 Server stopped at ${timestamp} ---\n`);
      this.logStream.end();
      this.logStream = null;
    }
    this.child = null;
    this.status.pid = null;
  }

  /**
   * Watch stdout for patterns indicating the telnet console is ready.
   * D3 prints "Remote administration enabled" or sends a password prompt.
   */
  private checkStdoutForReadiness(text: string): void {
    if (this.telnetReady) return;
    const lower = text.toLowerCase();
    if (
      lower.includes("remote administration enabled") ||
      lower.includes("enter server password") ||
      lower.includes("remote console")
    ) {
      this.onTelnetReady();
    }
  }

  /**
   * TCP probe: try connecting to the telnet port periodically.
   * Handles the case where stdout patterns don't match (different D3 versions).
   */
  private startTelnetProbe(port: number, host: string): void {
    this.stopTelnetProbe();

    const startTime = Date.now();

    this.telnetProbeTimer = setInterval(() => {
      if (this.telnetReady || this.status.state !== "starting") {
        this.stopTelnetProbe();
        return;
      }

      if (Date.now() - startTime > TELNET_PROBE_TIMEOUT_MS) {
        this.stopTelnetProbe();
        this.emit(
          "stderr",
          `Telnet readiness probe timed out after ${TELNET_PROBE_TIMEOUT_MS / 1000}s. Server may not have remote console enabled.\n`,
        );
        return;
      }

      const socket = new net.Socket();
      socket.setTimeout(400);

      socket.connect(port, host, () => {
        // Graceful half-close so D3 sees a FIN rather than an RST.
        // An abrupt RST can leave D3's accept queue in an odd state and
        // cause the immediately-following auto-connect attempt to be refused.
        socket.end();
        if (!this.telnetReady) {
          this.onTelnetReady();
        }
      });

      socket.on("error", () => {
        socket.destroy();
      });

      socket.on("timeout", () => {
        socket.destroy();
      });
    }, TELNET_PROBE_INTERVAL_MS);
  }

  private stopTelnetProbe(): void {
    if (this.telnetProbeTimer) {
      clearInterval(this.telnetProbeTimer);
      this.telnetProbeTimer = null;
    }
  }

  private onTelnetReady(): void {
    if (this.telnetReady) return;
    this.telnetReady = true;
    this.stopTelnetProbe();
    this.setState("running");
    const port = this.launchConfig?.telnetPort ?? 2092;
    const host = this.consoleHost();
    // Brief pause so D3 can finish processing the probe socket close before
    // the auto-connect handler opens its own connection to the same port.
    setTimeout(() => {
      this.emit("telnetReady", port, host);
    }, 300);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.child) {
        resolve(true);
        return;
      }

      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);

      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
