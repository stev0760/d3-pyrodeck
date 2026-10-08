/**
 * Periodic console commands per profile: lines sent once when Pyrodeck's
 * console session to a launched server is up, and lines sent every N
 * minutes while the server runs (rules, a Discord link, tips).
 *
 * Engine limits behind the rules (Matcen tree):
 * - The remote console keeps one input line in a 255-byte buffer and drops a
 *   line that overflows it (Descent3/dedicated_server.cpp:1424, :1656-1657).
 * - `say` is the Say cvar, a string of at most 200 characters
 *   (dedicated_server.cpp:181), sent to every player as "<server> says: ...".
 * - The in-game chat shows only the last couple of lines, so a burst of
 *   `say` lines scrolls itself away; one tick never sends more than
 *   MAX_LINES_PER_TICK lines.
 */

export type PeriodicMode = "all" | "sequential" | "random";

export const PERIODIC_MODES: readonly PeriodicMode[] = ["all", "sequential", "random"];
export const MAX_LINES_PER_TICK = 5;
export const MAX_PERIODIC_LINES = 20;
export const PERIODIC_LINE_MAX = 200;
export const PERIODIC_INTERVAL_MIN = 1;
export const PERIODIC_INTERVAL_MAX = 1440;

export interface PeriodicCommandSettings {
  enabled: boolean;
  /** Sent once per launch, as soon as the console session is ready. */
  startLines: string[];
  /** Sent every `intervalMinutes` while the server runs. */
  lines: string[];
  intervalMinutes: number;
  /** all: every line each tick; sequential: one line per tick, in order; random: one random line per tick. */
  mode: PeriodicMode;
}

export interface PeriodicSettingsCheck {
  /** The settings to store, or null when there is nothing to send. Not to be saved when `errors` is non-empty. */
  settings: PeriodicCommandSettings | null;
  errors: string[];
}

/** Why a console line is refused, or null when it may be sent. */
export function checkConsoleLine(line: string): string | null {
  if (line.length > PERIODIC_LINE_MAX) return `"${line.slice(0, 40)}…" is longer than ${PERIODIC_LINE_MAX} characters.`;
  if (!/^[\x20-\x7e]+$/.test(line)) return `"${line.slice(0, 40)}" contains characters other than plain printable ASCII.`;
  if (!/^\$\S/.test(line) && !/^say \S/i.test(line)) {
    return `"${line.slice(0, 40)}" must start with $ (a command) or "say " (a chat message).`;
  }
  return null;
}

function lineList(raw: unknown, label: string, max: number, errors: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  const items = typeof raw === "string" ? raw.split(/\r?\n/) : Array.isArray(raw) ? raw : null;
  if (!items) {
    errors.push(`${label} must be a list of lines.`);
    return [];
  }
  const lines = items.map((l) => (typeof l === "string" ? l.trim() : "")).filter((l) => l !== "");
  for (const line of lines) {
    const problem = checkConsoleLine(line);
    if (problem) errors.push(`${label}: ${problem}`);
  }
  if (lines.length > max) errors.push(`${label}: at most ${max} lines.`);
  return lines;
}

/** Validate untrusted periodic-command settings from the profile form. */
export function validatePeriodicSettings(raw: unknown): PeriodicSettingsCheck {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];

  const mode: PeriodicMode =
    typeof r.mode === "string" && (PERIODIC_MODES as readonly string[]).includes(r.mode)
      ? (r.mode as PeriodicMode)
      : "sequential";
  if (r.mode !== undefined && r.mode !== mode) errors.push("Mode must be all, sequential or random.");

  const startLines = lineList(r.startLines, "Start lines", MAX_LINES_PER_TICK, errors);
  const lines = lineList(
    r.lines,
    mode === "all" ? "Lines (all each time)" : "Lines",
    mode === "all" ? MAX_LINES_PER_TICK : MAX_PERIODIC_LINES,
    errors,
  );

  let intervalMinutes = 10;
  if (r.intervalMinutes !== undefined && r.intervalMinutes !== "") {
    const n = typeof r.intervalMinutes === "string" ? Number(r.intervalMinutes) : r.intervalMinutes;
    if (typeof n === "number" && Number.isInteger(n) && n >= PERIODIC_INTERVAL_MIN && n <= PERIODIC_INTERVAL_MAX) {
      intervalMinutes = n;
    } else {
      errors.push(
        `The interval must be a whole number of minutes from ${PERIODIC_INTERVAL_MIN} to ${PERIODIC_INTERVAL_MAX}.`,
      );
    }
  }

  const enabled = r.enabled !== false;
  if (startLines.length === 0 && lines.length === 0) return { settings: null, errors };
  return { settings: { enabled, startLines, lines, intervalMinutes, mode }, errors };
}

/** Settings as stored in profiles.json, made safe for use: anything invalid turns them off. */
export function sanitizeStoredPeriodic(raw: unknown): PeriodicCommandSettings | null {
  const check = validatePeriodicSettings(raw);
  return check.errors.length === 0 ? check.settings : null;
}

export type SendLine = (line: string) => Promise<unknown>;

export interface PeriodicSchedulerOptions {
  /** Random source in [0, 1) for random mode. */
  random?: () => number;
  log?: (message: string) => void;
}

/**
 * Sends a profile's periodic lines for one server run. `arm` starts a run
 * (a new server process), `consoleReady` hands it the console: the start
 * lines go out once per run, then a tick every interval. Nothing is sent
 * while no console is attached, and `stop` ends the run.
 */
export class PeriodicCommandScheduler {
  private settings: PeriodicCommandSettings | null = null;
  private runKey: string | null = null;
  private send: SendLine | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startSent = false;
  private cursor = 0;
  private lastRandom = -1;
  private sending = false;
  private readonly random: () => number;
  private readonly log: (message: string) => void;

  constructor(options: PeriodicSchedulerOptions = {}) {
    this.random = options.random ?? Math.random;
    this.log = options.log ?? ((m) => console.log(m));
  }

  /**
   * Begin a run for a newly started server. Re-arming the same run is a
   * no-op. `resumed`: the server has run for a while (Pyrodeck re-attached to
   * it), so its start lines went out already.
   */
  arm(runKey: string, settings: PeriodicCommandSettings | null, options: { resumed?: boolean } = {}): void {
    if (this.runKey === runKey) return;
    this.stop();
    this.runKey = runKey;
    this.settings = settings?.enabled ? settings : null;
    this.startSent = options.resumed === true;
  }

  /** The console session is ready: send the start lines (once per run) and start the ticks. */
  consoleReady(send: SendLine): void {
    if (!this.runKey || !this.settings) return;
    this.send = send;
    if (!this.startSent) {
      this.startSent = true;
      void this.sendLines(this.settings.startLines.slice(0, MAX_LINES_PER_TICK), "start");
    }
    if (!this.timer && this.settings.lines.length > 0) {
      this.timer = setInterval(() => void this.tick(), this.settings.intervalMinutes * 60_000);
    }
  }

  /** The console session is gone: ticks send nothing until the next consoleReady. */
  consoleLost(): void {
    this.send = null;
  }

  /** End the run (the server stopped). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.send = null;
    this.settings = null;
    this.runKey = null;
    this.startSent = false;
    this.cursor = 0;
    this.lastRandom = -1;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /** The lines the next tick sends (advances the sequential cursor and the random pick). */
  nextTickLines(): string[] {
    const s = this.settings;
    if (!s || s.lines.length === 0) return [];
    switch (s.mode) {
      case "all":
        return s.lines.slice(0, MAX_LINES_PER_TICK);
      case "sequential": {
        const line = s.lines[this.cursor % s.lines.length];
        this.cursor = (this.cursor + 1) % s.lines.length;
        return [line];
      }
      case "random": {
        let i = Math.min(Math.floor(this.random() * s.lines.length), s.lines.length - 1);
        // Never the same line twice running when there is a choice.
        if (s.lines.length > 1 && i === this.lastRandom) i = (i + 1) % s.lines.length;
        this.lastRandom = i;
        return [s.lines[i]];
      }
    }
  }

  private async tick(): Promise<void> {
    if (!this.send || this.sending) return;
    await this.sendLines(this.nextTickLines(), "tick");
  }

  private async sendLines(lines: string[], what: "start" | "tick"): Promise<void> {
    const run = this.runKey;
    this.sending = true;
    try {
      for (const line of lines) {
        const send = this.send;
        if (!send || this.runKey !== run) return;
        try {
          await send(line);
          this.log(`[Pyrodeck] Periodic (${what}): ${line}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log(`[Pyrodeck] Periodic (${what}) "${line}" not sent: ${message}`);
          return;
        }
      }
    } finally {
      this.sending = false;
    }
  }
}
