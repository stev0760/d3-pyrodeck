import { EventEmitter } from "node:events";

/**
 * Notices a server whose main loop stopped, from its remote console.
 *
 * The engine services the console once per server frame (DoDedicatedServerFrame
 * → DedicatedReadTelnet, dedicated_server.cpp), and echoes every line it reads
 * back to all consoles before running it. So any console output proves the
 * loop is turning, and any command, answered or not, makes it print. An idle
 * server prints nothing, which is why a quiet console is probed rather than
 * declared dead.
 *
 *   off ──start()──► listening ──quiet probeAfterMs──► probing ──no output for
 *                       ▲   (emit "probe")                (restartAfterMs − probeAfterMs)
 *                       └────────── any output ───────────┘        └──► off (emit "hung")
 *
 * After a level starts (`levelLoad()`), neither the probe nor "hung" fires for
 * `loadAllowanceMs`: the server cannot service its console while it loads.
 * Loads measured in the lab take about a second (3202 loads in the Matcen soak
 * logs: at most 0.98 s from "Opening level" to the end of the load), but
 * Matcen builds before 0.9.15 stopped running frames for up to 100 s at a
 * level start while they built navigation data (spec §3.3).
 *
 * Events:
 *   probe()                 — send the probe command now
 *   hung(silentForMs)       — no output for restartAfterMs, probe unanswered
 */
export type HangWatchState = "off" | "listening" | "probing" | "loading";

export interface HangWatchOptions {
  probeAfterMs: number;
  restartAfterMs: number;
  loadAllowanceMs?: number;
  tickMs?: number;
}

export interface HangWatchSnapshot {
  state: HangWatchState;
  /** Console silence so far (null when off). */
  silentForMs: number | null;
  /** Epoch ms the probe is due (listening) or was sent (probing). */
  probeAt: number | null;
  /** Epoch ms the server counts as hung if nothing arrives first. */
  restartAt: number | null;
}

export const LEVEL_LOAD_ALLOWANCE_MS = 120_000;

export class HangWatch extends EventEmitter {
  private probeAfterMs: number;
  private restartAfterMs: number;
  private readonly loadAllowanceMs: number;
  private readonly tickMs: number;
  private state: HangWatchState = "off";
  private lastActivity = 0;
  private probeSentAt: number | null = null;
  private loadUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: HangWatchOptions) {
    super();
    this.probeAfterMs = options.probeAfterMs;
    this.restartAfterMs = options.restartAfterMs;
    this.loadAllowanceMs = options.loadAllowanceMs ?? LEVEL_LOAD_ALLOWANCE_MS;
    this.tickMs = options.tickMs ?? 1000;
  }

  /** New thresholds; a watch in progress keeps its silence so far. */
  configure(probeAfterMs: number, restartAfterMs: number): void {
    this.probeAfterMs = probeAfterMs;
    this.restartAfterMs = restartAfterMs;
  }

  /** The console is up: start counting silence from now. */
  start(): void {
    this.stop();
    this.state = "listening";
    this.lastActivity = Date.now();
    this.probeSentAt = null;
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = "off";
    this.probeSentAt = null;
    this.loadUntil = 0;
  }

  isWatching(): boolean {
    return this.state !== "off";
  }

  /** Console output arrived. */
  activity(): void {
    if (this.state === "off") return;
    this.lastActivity = Date.now();
    this.probeSentAt = null;
    if (this.state === "probing") this.state = "listening";
  }

  /** A level started loading. */
  levelLoad(): void {
    if (this.state === "off") return;
    this.loadUntil = Date.now() + this.loadAllowanceMs;
  }

  snapshot(): HangWatchSnapshot {
    if (this.state === "off") return { state: "off", silentForMs: null, probeAt: null, restartAt: null };
    const now = Date.now();
    const answerWindow = this.restartAfterMs - this.probeAfterMs;
    const probeAt = this.probeSentAt ?? Math.max(this.lastActivity + this.probeAfterMs, this.loadUntil);
    return {
      state: this.state,
      silentForMs: now - this.lastActivity,
      probeAt,
      restartAt: probeAt + answerWindow,
    };
  }

  private tick(): void {
    const now = Date.now();
    if (now < this.loadUntil) {
      this.state = "loading";
      return;
    }
    if (this.state === "loading") this.state = this.probeSentAt === null ? "listening" : "probing";

    if (this.probeSentAt === null) {
      if (now - this.lastActivity >= this.probeAfterMs) {
        this.probeSentAt = now;
        this.state = "probing";
        this.emit("probe");
      }
      return;
    }

    if (now - this.probeSentAt >= this.restartAfterMs - this.probeAfterMs) {
      const silentForMs = now - this.lastActivity;
      this.stop();
      this.emit("hung", silentForMs);
    }
  }
}
