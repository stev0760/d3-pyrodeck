/**
 * The gate for the restart-when-empty rule: the server has run longer than
 * the limit, no human is on it, and the last one left at least `graceMs` ago
 * (D3Server3 waits 130 s). Bots do not count; the caller passes humans only.
 */
export interface EmptyRestartInput {
  now: number;
  /** Process start (epoch ms), null when no server runs. */
  startedAt: number | null;
  afterMs: number;
  graceMs: number;
  /** Humans on the server, null when not known (re-attached, roster not read yet). */
  humans: number | null;
  /** When the server last became empty (epoch ms); its start if nobody ever joined. */
  emptySince: number | null;
}

export interface EmptyRestartDecision {
  due: boolean;
  /** Why (not) yet, for the status line. */
  reason: string;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 300) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

export function emptyRestartDecision(input: EmptyRestartInput): EmptyRestartDecision {
  const { now, startedAt, afterMs, graceMs, humans, emptySince } = input;
  if (startedAt === null) return { due: false, reason: "no server is running" };
  const uptime = now - startedAt;
  if (uptime < afterMs) {
    return { due: false, reason: `up ${formatDuration(uptime)} of ${formatDuration(afterMs)}` };
  }
  if (humans === null) return { due: false, reason: "waiting to read who is on the server" };
  if (humans > 0) return { due: false, reason: `${humans} player${humans === 1 ? "" : "s"} on` };
  const empty = now - (emptySince ?? now);
  if (empty < graceMs) {
    return {
      due: false,
      reason: `last player left ${formatDuration(empty)} ago; waits ${formatDuration(graceMs)}`,
    };
  }
  return { due: true, reason: `up ${formatDuration(uptime)} and empty for ${formatDuration(empty)}` };
}
