import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

export type ProcessState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed";

export interface ProcessStatus {
  state: ProcessState;
  pid: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
}

export interface LaunchConfig {
  /** Full path to D3 executable. */
  executablePath: string;
  /** Directory containing D3 game data, configs, and missions. Used as cwd. */
  gamePath: string;
  /** Config filename in gamePath (e.g., "my-server.cfg"). */
  configFile: string;
  /** Extra CLI flags (e.g., -autoexec). */
  additionalArgs?: string[];
  /** Optional path to write server log file. If set, stdout/stderr are written here. */
  logPath?: string;
  telnetPort: number;
  telnetPassword: string;
}

const TELNET_PROBE_INTERVAL_MS = 500;
const TELNET_PROBE_TIMEOUT_MS = 15000;
const GRACEFUL_QUIT_TIMEOUT_MS = 5000;
const SIGTERM_TIMEOUT_MS = 3000;

/**
 * Manages the D3 dedicated server process lifecycle.
 *
 * Events:
 *   stateChange(state: ProcessState)
 *   stdout(data: string)
 *   stderr(data: string)
 *   telnetReady(port: number)
 *   exit(code: number | null, signal: string | null)
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
  };
  private telnetProbeTimer: ReturnType<typeof setInterval> | null = null;
  private telnetReady = false;
  private launchConfig: LaunchConfig | null = null;
  private logStream: fs.WriteStream | null = null;

  /** Send a quit command over telnet for graceful shutdown. Set externally. */
  sendQuitFn: (() => Promise<void>) | null = null;

  getStatus(): ProcessStatus {
    return { ...this.status };
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

    // Config files live in gamePath alongside game data — the traditional D3 layout.
    // Use ./ prefix so cfopen() resolves relative to cwd (gamePath).
    const args = [
      "-dedicated", `./${config.configFile}`,
      ...(config.additionalArgs ?? []),
    ];

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

    // Open log file if configured
    if (config.logPath) {
      try {
        this.logStream = fs.createWriteStream(config.logPath, { flags: "a" });
        this.logStream.on("error", () => {}); // Don't crash on log write errors
        const timestamp = new Date().toISOString();
        this.logStream.write(`\n--- D3 Server started at ${timestamp} ---\n`);
        this.logStream.write(`  Executable: ${config.executablePath}\n`);
        this.logStream.write(`  Config: ${config.gamePath}/${config.configFile}\n`);
        this.logStream.write(`  Args: ${args.join(" ")}\n`);
        this.logStream.write(`  PID: ${this.child.pid}\n\n`);
      } catch {
        // Log file is optional — don't fail the launch
        this.logStream = null;
      }
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
    this.startTelnetProbe(config.telnetPort);
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

  private cleanup(): void {
    this.stopTelnetProbe();
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
  private startTelnetProbe(port: number): void {
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
          "Telnet readiness probe timed out after 15s. Server may not have remote console enabled.\n",
        );
        return;
      }

      const socket = new net.Socket();
      socket.setTimeout(400);

      socket.connect(port, "127.0.0.1", () => {
        socket.destroy();
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
    this.emit("telnetReady", this.launchConfig?.telnetPort ?? 2092);
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
