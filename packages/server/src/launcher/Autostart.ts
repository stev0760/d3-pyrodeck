import { serverEvents, type ServerEventMap, type ServerEvents } from "../events/ServerEvents.js";
import { backoffDelayMs } from "./RelaunchBackoff.js";
import { formatDuration } from "./emptyRestart.js";
import type { ProcessDown } from "./Supervisor.js";
import type { AutostartChoice, AutostartSource } from "./autostartSettings.js";

/**
 * Autostart: launch one profile when Pyrodeck starts, so that the game comes
 * back after a reboot without anyone pressing Launch. Which profile is
 * autostartSettings.ts's business; with none set this does nothing.
 *
 * Order at startup (servers/ServerInstance.ts): Pyrodeck first tries to
 * re-attach to a server that kept running across its restart. If one runs,
 * re-attached or not, autostart leaves it alone. Otherwise it launches the
 * profile through the Launch button's own path (ServerInstance.start), active
 * playlist included.
 *
 * Crash-loop guard. A launch that fails, or a server that goes down within
 * `quickExitMs` of starting, is a failure; `maxFailures` in a row and
 * autostart stops, logs why, and tells the supervisor to stop relaunching.
 * The retries are split by who can make them:
 * - a launch that failed before a process existed is retried here, after
 *   5 s, 10 s, 20 s ... (the supervisor's backoff), since the supervisor has
 *   no launch to repeat yet;
 * - a server that started and then went down is relaunched by the
 *   supervisor, as after any crash (and only if its "relaunch on crash" is
 *   on); the guard counts those relaunches and their failures.
 * A server that stays up for `quickExitMs` ends the guard. So does anyone
 * else starting or stopping the server meanwhile: the Launch or Stop button,
 * the weekly schedule, a playlist restart.
 *
 * It runs once per Pyrodeck process. Changing the setting takes effect at the
 * next start of Pyrodeck.
 */

/** A server that goes down sooner than this after starting counts as a failed start. */
export const AUTOSTART_QUICK_EXIT_MS = 60_000;
/** Failed starts in a row before autostart gives up. */
export const AUTOSTART_MAX_FAILURES = 5;

export type AutostartState =
  /** No profile is set to start with Pyrodeck. */
  | "off"
  /** A profile is set but cannot be found (unknown or ambiguous name); nothing was launched. */
  | "error"
  /** A server was already running at startup (re-attached); nothing was launched. */
  | "skipped"
  /** A launch is in progress. */
  | "launching"
  /** The launch failed; autostart tries again at `nextAttemptAt`. */
  | "retrying"
  /** The server started; the guard ends at `watchUntil` if it stays up. */
  | "watching"
  /** The server went down too soon; the supervisor relaunches it. */
  | "relaunching"
  /** The server stayed up past the guard. */
  | "started"
  /** The guard gave up, or nothing will retry; `reason` says why. */
  | "failed"
  /** Someone else started or stopped the server, or the retry was cancelled. */
  | "cancelled";

export interface AutostartSnapshot {
  state: AutostartState;
  /** The profile this run started (or tried to), with where the choice came from. */
  profileId: string | null;
  profileName: string | null;
  source: AutostartSource | null;
  /** Why the state is what it is: the error, the last failure, who took over. */
  reason: string | null;
  /** Failed starts in a row so far. */
  failures: number;
  maxFailures: number;
  quickExitSec: number;
  /** When the state was entered (ISO). */
  at: string | null;
  /** State "retrying": when the next launch attempt runs. */
  nextAttemptAt: string | null;
  /** State "watching": when the guard ends if the server is still up. */
  watchUntil: string | null;
  /** State "relaunching": whether the supervisor has a relaunch pending (it may have been cancelled). */
  relaunchPending: boolean | null;
}

export interface AutostartDeps {
  /** The profile to start, or null when none is set. Read once, by run(). */
  choose(): Promise<AutostartChoice | null>;
  /** Why no server may be launched now (one is running, re-attached or not), or null. */
  blockedBy(): string | null;
  /** Launch the profile exactly as the Launch button does. */
  launch(profileId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Whether the supervisor relaunches a server that went down like this. */
  supervisorRelaunches(down: ProcessDown): boolean;
  /** Whether the supervisor has a relaunch pending. */
  relaunchPending(): boolean;
  /** The guard tripped: the supervisor must not relaunch the server. */
  stopRelaunching(reason: string): void;
  /** Tell the operator (a toast); the log gets every line anyway. */
  notify(message: string): void;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export interface AutostartOptions {
  events?: ServerEvents;
  quickExitMs?: number;
  maxFailures?: number;
  /** First retry delay of a failed launch; doubles per failure up to 2 min. */
  retryInitialMs?: number;
}

/** States in which the guard is still deciding. */
const ACTIVE: ReadonlySet<AutostartState> = new Set(["launching", "retrying", "watching", "relaunching"]);

function startedBy(reason: ServerEventMap["server.started"]["reason"]): string {
  switch (reason) {
    case "manual":
      return "by hand";
    case "schedule":
      return "by the weekly schedule";
    case "playlist":
      return "by a playlist restart";
    default:
      return `(${reason})`;
  }
}

function stoppedHow(reason: ProcessDown["stopReason"]): string {
  switch (reason) {
    case "manual":
      return "by hand";
    case "schedule":
      return "by the weekly schedule";
    case "playlist":
      return "for a playlist restart";
    case "console":
      return "with quit at its console";
    case "empty-restart":
      return "for its restart when empty";
    default:
      return "on request";
  }
}

function exitStatus(down: ProcessDown): string {
  if (down.signal) return `signal ${down.signal}`;
  if (down.code !== null) return `exit code ${down.code}`;
  return "exit status unknown";
}

export class Autostart {
  private readonly events: ServerEvents;
  private readonly quickExitMs: number;
  private readonly maxFailures: number;
  private readonly retryInitialMs: number | undefined;
  private ran = false;
  private state: AutostartState = "off";
  private profile: { id: string; name: string } | null = null;
  private source: AutostartSource | null = null;
  private reason: string | null = null;
  private failures = 0;
  private at: number | null = null;
  private nextAttemptAt: number | null = null;
  private watchUntil: number | null = null;
  private runStartedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onStartedListener = (p: ServerEventMap["server.started"]) => this.onStarted(p);

  constructor(
    private readonly deps: AutostartDeps,
    options: AutostartOptions = {},
  ) {
    this.events = options.events ?? serverEvents;
    this.quickExitMs = options.quickExitMs ?? AUTOSTART_QUICK_EXIT_MS;
    this.maxFailures = options.maxFailures ?? AUTOSTART_MAX_FAILURES;
    this.retryInitialMs = options.retryInitialMs;
    this.events.onEvent("server.started", this.onStartedListener);
  }

  /**
   * Decide and act, once, after re-attach has run. Never throws: an error
   * becomes the "error" state and a log line.
   */
  async run(): Promise<void> {
    if (this.ran) return;
    this.ran = true;
    let choice: AutostartChoice | null;
    try {
      choice = await this.deps.choose();
    } catch (err) {
      this.enter("error", `could not read the profiles: ${err instanceof Error ? err.message : String(err)}`);
      this.deps.log.error(`[Autostart] Nothing started: ${this.reason}.`);
      return;
    }
    if (!choice) return; // off: nothing set, nothing logged
    this.source = choice.source;
    if ("error" in choice) {
      this.enter("error", choice.error);
      this.deps.log.error(`[Autostart] Nothing started: ${choice.error}.`);
      return;
    }
    this.profile = choice.profile;
    const blocked = this.deps.blockedBy();
    if (blocked) {
      this.enter("skipped", blocked);
      this.deps.log.info(`[Autostart] Not starting "${this.profile.name}": ${blocked}.`);
      return;
    }
    const from = choice.source === "env" ? "PYRODECK_AUTOSTART_PROFILE" : "Start when Pyrodeck starts";
    this.deps.log.info(`[Autostart] Starting "${this.profile.name}" (${from}).`);
    await this.attempt();
  }

  /**
   * The process went down (called before the supervisor hears of it, so a
   * tripped guard is in place before it would schedule a relaunch).
   */
  processDown(down: ProcessDown): void {
    if (this.state !== "watching" && this.state !== "launching") return;
    this.clearTimer();
    if (!down.crashed && down.stopReason !== "hang") {
      this.finish("cancelled", `the server was stopped ${stoppedHow(down.stopReason)}`, "info");
      return;
    }
    const lived = this.runStartedAt !== null ? formatDuration(Date.now() - this.runStartedAt) : "at once";
    const what =
      down.stopReason === "hang"
        ? `the server stopped answering its console ${lived} after starting`
        : `the server exited ${lived} after starting (${exitStatus(down)})`;
    this.failure(what, this.deps.supervisorRelaunches(down) ? "supervisor" : null);
  }

  /** The supervisor's relaunch of the autostarted server could not be spawned. */
  relaunchFailed(message: string): void {
    if (this.state !== "relaunching") return;
    this.failure(`the relaunch failed: ${message}`, "supervisor");
  }

  /** Cancel a pending retry of a failed launch. False when none is pending. */
  cancelRetry(why = "the retry was cancelled"): boolean {
    if (this.state !== "retrying") return false;
    this.finish("cancelled", why, "info");
    return true;
  }

  snapshot(): AutostartSnapshot {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return {
      state: this.state,
      profileId: this.profile?.id ?? null,
      profileName: this.profile?.name ?? null,
      source: this.source,
      reason: this.reason,
      failures: this.failures,
      maxFailures: this.maxFailures,
      quickExitSec: Math.round(this.quickExitMs / 1000),
      at: iso(this.at),
      nextAttemptAt: this.state === "retrying" ? iso(this.nextAttemptAt) : null,
      watchUntil: this.state === "watching" ? iso(this.watchUntil) : null,
      relaunchPending: this.state === "relaunching" ? this.deps.relaunchPending() : null,
    };
  }

  /** Stop the timers and the event listener (tests, shutdown). */
  dispose(): void {
    this.clearTimer();
    this.events.offEvent("server.started", this.onStartedListener);
  }

  // ---------------------------------------------------------------------------

  private async attempt(): Promise<void> {
    const profile = this.profile;
    if (!profile) return;
    const blocked = this.deps.blockedBy();
    if (blocked) {
      this.finish("cancelled", blocked, "info");
      return;
    }
    this.enter("launching", this.reason);
    let result: { ok: true } | { ok: false; error: string };
    try {
      result = await this.deps.launch(profile.id);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // A started server has already moved the state on (server.started).
    if (!result.ok && this.state === "launching") this.failure(`the launch failed: ${result.error}`, "self");
  }

  private onStarted(p: ServerEventMap["server.started"]): void {
    if (!ACTIVE.has(this.state)) return;
    const ours =
      (p.reason === "autostart" && this.state === "launching") ||
      (p.reason === "relaunch" && this.state === "relaunching");
    if (!ours) {
      this.finish("cancelled", `the server was started ${startedBy(p.reason)}`, "info");
      return;
    }
    this.clearTimer();
    const now = Date.now();
    this.runStartedAt = now;
    this.watchUntil = now + this.quickExitMs;
    this.enter("watching", this.reason);
    this.timer = setTimeout(() => {
      this.timer = null;
      const after = this.failures > 0 ? `, after ${this.failures} failed start${this.failures === 1 ? "" : "s"}` : "";
      this.finish("started", `up for ${formatDuration(this.quickExitMs)}${after}`, "info");
    }, this.quickExitMs);
  }

  /** Count a failed start, then retry, leave it to the supervisor, or give up. */
  private failure(what: string, retryBy: "self" | "supervisor" | null): void {
    this.failures++;
    const name = this.profile?.name ?? "?";
    const count = `failure ${this.failures} of ${this.maxFailures}`;
    if (this.failures >= this.maxFailures) {
      const why = `${this.failures} failed starts in a row; the last: ${what}`;
      this.deps.stopRelaunching(`autostart of "${name}" stopped after ${why}`);
      this.finish("failed", why, "error");
      this.deps.notify(`Autostart of "${name}" gave up after ${why}. Launch it by hand once the cause is fixed.`);
      return;
    }
    if (retryBy === "self") {
      const delayMs = backoffDelayMs(this.failures, this.retryInitialMs);
      this.nextAttemptAt = Date.now() + delayMs;
      this.enter("retrying", what);
      this.deps.log.warn(`[Autostart] "${name}": ${what}; trying again in ${formatDuration(delayMs)} (${count}).`);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.state === "retrying") void this.attempt();
      }, delayMs);
      return;
    }
    if (retryBy === "supervisor") {
      this.enter("relaunching", what);
      this.deps.log.warn(`[Autostart] "${name}": ${what}; the supervisor relaunches it (${count}).`);
      return;
    }
    this.finish("failed", `${what}; relaunch on crash is off, so it stays down`, "error");
    this.deps.notify(`Autostart of "${name}": ${this.reason}.`);
  }

  private enter(state: AutostartState, reason: string | null): void {
    this.state = state;
    this.reason = reason;
    this.at = Date.now();
  }

  private finish(state: AutostartState, reason: string, level: "info" | "error"): void {
    this.clearTimer();
    this.enter(state, reason);
    const name = this.profile?.name ?? "?";
    const line =
      state === "started"
        ? `[Autostart] "${name}" is up (${reason}).`
        : state === "failed"
          ? `[Autostart] Gave up on "${name}": ${reason}.`
          : `[Autostart] Stopped watching "${name}": ${reason}.`;
    if (level === "error") this.deps.log.error(line);
    else this.deps.log.info(line);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
