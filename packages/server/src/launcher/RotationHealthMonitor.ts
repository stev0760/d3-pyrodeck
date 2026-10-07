import { EventEmitter } from "node:events";

/**
 * Health check for the server a playlist rotation restarts.
 *
 * Rotation is a full stop → config swap → relaunch (D3 has no in-place mission
 * change), and a relaunch can fail: a mission that crashes the server, a port
 * that won't bind, a remote console that never answers. Without a check the
 * playlist would sit in "restarting" behind a dead server nobody notices.
 *
 * The launcher reports what it sees; this class keeps the deadline and decides:
 *
 *   begin() ──► relaunching ──arm()──► waiting ──healthy()──► idle  (emit "healthy")
 *                    ▲                    │
 *                    │   failure()/timeout│
 *                    └──── "retry" ◄──────┤ attempt < maxRetries
 *                                         └──► idle (emit "failed") otherwise
 *
 * healthy() and failure() are also accepted while relaunching (a server can
 * answer before arm() runs; a spawn can fail before it).
 *
 * "Healthy" means the restarted server's remote console accepted the login and
 * answered `$servercaps` within `timeoutMs` of the spawn.
 *
 * Each launch attempt has a token (from token()). Reports carrying an older
 * token are ignored: the connection attempt of a server that was already
 * given up on can still fail or succeed after the retry started.
 *
 * Events:
 *   retry(attempt: number, reason: string)  — relaunch now; call arm() once spawned
 *   healthy(attempt: number)                — rotation complete
 *   failed(reason: string)                  — give up (the launcher pauses the playlist)
 */
export type RotationHealthState = "idle" | "relaunching" | "waiting";

export interface RotationHealthSnapshot {
  state: RotationHealthState;
  /** 0 on the first launch, 1.. on retries. */
  attempt: number;
  maxRetries: number;
  /** Epoch ms by which the current launch must be healthy (waiting only). */
  deadline: number | null;
}

export interface RotationHealthOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

/** Long enough for the telnet readiness probe (60 s) plus a slow first $servercaps answer. */
export const ROTATION_HEALTH_TIMEOUT_MS = 120_000;
export const ROTATION_MAX_RETRIES = 1;

export class RotationHealthMonitor extends EventEmitter {
  readonly timeoutMs: number;
  readonly maxRetries: number;
  private state: RotationHealthState = "idle";
  private attempt = 0;
  private generation = 0;
  private deadline: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RotationHealthOptions = {}) {
    super();
    this.timeoutMs = options.timeoutMs ?? ROTATION_HEALTH_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? ROTATION_MAX_RETRIES;
  }

  /** A rotation is about to (re)launch the server: start counting attempts. */
  begin(): void {
    this.clearTimer();
    this.attempt = 0;
    this.generation++;
    this.state = "relaunching";
    this.deadline = null;
  }

  /** Token identifying the current launch attempt, for healthy()/failure(). */
  token(): number {
    return this.generation;
  }

  /** The server process for the current attempt has been spawned: start the deadline. */
  arm(): void {
    if (this.state !== "relaunching") return;
    this.state = "waiting";
    this.deadline = Date.now() + this.timeoutMs;
    const token = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.failure(
        `no answer from the server's remote console within ${Math.round(this.timeoutMs / 1000)}s`,
        token,
      );
    }, this.timeoutMs);
  }

  /** The restarted server answered. */
  healthy(token?: number): void {
    if (this.state === "idle" || this.isStale(token)) return;
    const attempt = this.attempt;
    this.reset();
    this.emit("healthy", attempt);
  }

  /** The current attempt failed (crash, refused connection, failed spawn, timeout). */
  failure(reason: string, token?: number): void {
    if (this.state === "idle" || this.isStale(token)) return;
    this.clearTimer();
    this.deadline = null;
    if (this.attempt < this.maxRetries) {
      this.attempt++;
      this.generation++;
      this.state = "relaunching";
      this.emit("retry", this.attempt, reason);
    } else {
      this.reset();
      this.emit("failed", reason);
    }
  }

  /** Stop watching (the operator stopped or relaunched the server by hand). */
  cancel(): void {
    this.reset();
  }

  isPending(): boolean {
    return this.state !== "idle";
  }

  snapshot(): RotationHealthSnapshot {
    return {
      state: this.state,
      attempt: this.attempt,
      maxRetries: this.maxRetries,
      deadline: this.deadline,
    };
  }

  private isStale(token: number | undefined): boolean {
    return token !== undefined && token !== this.generation;
  }

  private reset(): void {
    this.clearTimer();
    this.state = "idle";
    this.attempt = 0;
    this.deadline = null;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
