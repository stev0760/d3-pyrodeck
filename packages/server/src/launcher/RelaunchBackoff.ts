/**
 * How long the supervisor waits before relaunching a server that died, and
 * when it stops trying. Each failure inside the window doubles the wait (5 s,
 * 10 s, 20 s ... capped at 2 min); one failure more than `maxFailures` inside
 * the window gives up. Failures older than the window are forgotten, so a
 * server that ran for a while starts again from the short wait.
 */
export interface RelaunchBackoffOptions {
  initialMs?: number;
  maxMs?: number;
  maxFailures?: number;
  windowMs?: number;
}

export type BackoffStep = { delayMs: number; failures: number } | { giveUp: true; failures: number };

export const RELAUNCH_INITIAL_MS = 5_000;
export const RELAUNCH_MAX_MS = 120_000;
export const RELAUNCH_MAX_FAILURES = 6;
export const RELAUNCH_WINDOW_MS = 30 * 60_000;

/** The wait before attempt `failures + 1`: `initialMs` doubled per failure, at most `maxMs`. */
export function backoffDelayMs(failures: number, initialMs = RELAUNCH_INITIAL_MS, maxMs = RELAUNCH_MAX_MS): number {
  return Math.min(initialMs * 2 ** (Math.max(1, failures) - 1), maxMs);
}

export class RelaunchBackoff {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly maxFailures: number;
  readonly windowMs: number;
  private failures: number[] = [];

  constructor(options: RelaunchBackoffOptions = {}) {
    this.initialMs = options.initialMs ?? RELAUNCH_INITIAL_MS;
    this.maxMs = options.maxMs ?? RELAUNCH_MAX_MS;
    this.maxFailures = options.maxFailures ?? RELAUNCH_MAX_FAILURES;
    this.windowMs = options.windowMs ?? RELAUNCH_WINDOW_MS;
  }

  /** Record a failure at `now`: the wait before the next relaunch, or give up. */
  next(now: number): BackoffStep {
    this.prune(now);
    this.failures.push(now);
    const failures = this.failures.length;
    if (failures > this.maxFailures) return { giveUp: true, failures };
    return { delayMs: backoffDelayMs(failures, this.initialMs, this.maxMs), failures };
  }

  /** Failures still inside the window at `now`. */
  count(now: number): number {
    this.prune(now);
    return this.failures.length;
  }

  reset(): void {
    this.failures = [];
  }

  private prune(now: number): void {
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
  }
}
