import { activeInterval, nextScheduleAction, type ProfileSchedule, type ScheduleAction } from "./schedule.js";

/**
 * Runs every profile's weekly schedule (schedule.ts) against its server.
 *
 * - At a window's start, the profile's server is started if it is not
 *   running. With one server for every profile (`getProcess` reports the one
 *   process), another profile's running server is left alone and the start
 *   is skipped; with a server per profile, a start that would share a port
 *   with another running server is refused by the launch and skipped.
 * - At a window's end, the profile's server is stopped as soon as no human is
 *   on it, and after `stopWaitMinutes` at the latest. Players get one `say`
 *   when the wait begins.
 * - Edge-triggered while Pyrodeck runs: a server the operator stops inside a
 *   window stays down until the next window, and one started outside a window
 *   keeps running until a window of its profile ends.
 * - Nothing is stored. After a Pyrodeck restart the schedule is read again:
 *   inside a window, the start that was missed is made; outside one, nothing
 *   is stopped.
 */

export interface ScheduledProfile {
  id: string;
  name: string;
  schedule?: ProfileSchedule;
}

export interface SchedulerDeps {
  now(): Date;
  listProfiles(): Promise<ScheduledProfile[]>;
  /** Whether `profileId`'s server process is up, and from which profile. */
  getProcess(profileId: string): { running: boolean; profileId: string | null };
  /** A playlist restart of `profileId`'s server is in progress: it is down on purpose for a moment. */
  isBusy(profileId: string): boolean;
  start(profileId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  stop(profileId: string): Promise<void>;
  /** Human players on `profileId`'s running server, or null when its console cannot be asked. */
  countHumans(profileId: string): Promise<number | null>;
  /** Say `text` in `profileId`'s game. */
  say(text: string, profileId: string): Promise<void>;
  /** A scheduled action did not happen; `reason` says why. */
  skipped(profileId: string, action: "start" | "stop", reason: string): void;
  log: { info(msg: string): void; warn(msg: string): void };
}

interface PendingStop {
  deadline: number;
  announced: boolean;
}

export interface ScheduleStatusEntry {
  profileId: string;
  name: string;
  enabled: boolean;
  next: ScheduleAction | null;
  /** A window has ended and the server is waiting for its players to leave, until `deadline`. */
  pendingStop: { deadline: number } | null;
}

export const SCHEDULE_TICK_MS = 30_000;
export const SCHEDULE_FIRST_TICK_MS = 10_000;

export class Scheduler {
  /** Per profile: the start (epoch ms) of the run already acted on. */
  private handledRun = new Map<string, { start: number; end: number }>();
  private pendingStops = new Map<string, PendingStop>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;

  constructor(private deps: SchedulerDeps) {}

  /**
   * Tick after `firstDelayMs`, then every `intervalMs`. The first tick waits
   * so that anything Pyrodeck does at boot about a server already running
   * happens before the schedule decides to start one.
   */
  start(intervalMs = SCHEDULE_TICK_MS, firstDelayMs = SCHEDULE_FIRST_TICK_MS): void {
    this.stopTimer();
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      void this.tick();
      this.timer = setInterval(() => void this.tick(), intervalMs);
    }, firstDelayMs);
  }

  stopTimer(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const profiles = await this.deps.listProfiles();
      const seen = new Set<string>();
      for (const p of profiles) {
        seen.add(p.id);
        await this.tickProfile(p);
      }
      for (const id of [...this.handledRun.keys()]) if (!seen.has(id)) this.handledRun.delete(id);
      for (const id of [...this.pendingStops.keys()]) if (!seen.has(id)) this.pendingStops.delete(id);
    } catch (err) {
      this.deps.log.warn(`[Schedule] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async tickProfile(p: ScheduledProfile): Promise<void> {
    const s = p.schedule;
    if (!s?.enabled || s.windows.length === 0) {
      this.handledRun.delete(p.id);
      this.pendingStops.delete(p.id);
      return;
    }
    const now = this.deps.now();
    const t = now.getTime();
    const run = activeInterval(s.windows, now);

    if (run) {
      // Inside a window: nothing to stop, and the start happens once per run.
      this.pendingStops.delete(p.id);
      if (this.handledRun.get(p.id)?.start !== run.start) {
        this.handledRun.set(p.id, run);
        await this.startFor(p);
      }
    } else {
      const ended = this.handledRun.get(p.id);
      if (ended && t >= ended.end) {
        this.handledRun.delete(p.id);
        const proc = this.deps.getProcess(p.id);
        if (proc.running && proc.profileId === p.id) {
          this.pendingStops.set(p.id, { deadline: ended.end + s.stopWaitMinutes * 60_000, announced: false });
        }
      }
    }

    const pending = this.pendingStops.get(p.id);
    if (pending) await this.continueStop(p, pending, t);
  }

  private async startFor(p: ScheduledProfile): Promise<void> {
    const proc = this.deps.getProcess(p.id);
    if (proc.running) {
      if (proc.profileId !== p.id) {
        this.skip(p, "start", "another profile's server is running");
      }
      return;
    }
    if (this.deps.isBusy(p.id)) {
      this.skip(p, "start", "a playlist restart is in progress");
      return;
    }
    this.deps.log.info(`[Schedule] Starting "${p.name}" (window start)`);
    const result = await this.deps.start(p.id);
    if (!result.ok) this.skip(p, "start", result.error);
  }

  private async continueStop(p: ScheduledProfile, pending: PendingStop, t: number): Promise<void> {
    const proc = this.deps.getProcess(p.id);
    if (!proc.running || proc.profileId !== p.id) {
      this.pendingStops.delete(p.id);
      return;
    }
    const humans = await this.deps.countHumans(p.id);
    if (humans === 0 || t >= pending.deadline) {
      this.pendingStops.delete(p.id);
      this.deps.log.info(
        `[Schedule] Stopping "${p.name}" (window end${humans === 0 ? ", no players" : ", wait for players over"})`,
      );
      await this.deps.stop(p.id);
      return;
    }
    if (!pending.announced && humans !== null) {
      pending.announced = true;
      const minutes = Math.max(1, Math.ceil((pending.deadline - t) / 60_000));
      await this.deps
        .say(`Scheduled stop: this server closes within ${minutes} minute${minutes === 1 ? "" : "s"}.`, p.id)
        .catch(() => {});
    }
  }

  private skip(p: ScheduledProfile, action: "start" | "stop", reason: string): void {
    this.deps.log.warn(`[Schedule] Scheduled ${action} of "${p.name}" skipped: ${reason}`);
    this.deps.skipped(p.id, action, reason);
  }

  /** What the Launch panel shows: each scheduled profile's next action and any stop in progress. */
  status(profiles: readonly ScheduledProfile[], now = this.deps.now()): ScheduleStatusEntry[] {
    return profiles
      .filter((p) => p.schedule && p.schedule.windows.length > 0)
      .map((p) => {
        const s = p.schedule!;
        const pending = this.pendingStops.get(p.id);
        return {
          profileId: p.id,
          name: p.name,
          enabled: s.enabled,
          next: s.enabled ? nextScheduleAction(s.windows, now) : null,
          pendingStop: pending ? { deadline: pending.deadline } : null,
        };
      });
  }
}
