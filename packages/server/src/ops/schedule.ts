/**
 * Weekly schedule windows for a server profile: when the server should run,
 * by weekday and local time. Pure rules, no timers; Scheduler.ts acts on them.
 *
 * Times are the wall clock of the machine Pyrodeck runs on. Each occurrence of
 * a window is turned into two absolute instants with the local Date
 * constructor, so a daylight-saving change behaves the way ECMAScript resolves
 * local times: a time inside the hour skipped in spring moves forward by the
 * gap (02:30 becomes 03:30), and a time inside the hour repeated in autumn is
 * its first occurrence, so a window ending at 01:30 that night ends at the
 * first 01:30 and the repeated half hour stays outside it.
 */

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface ScheduleWindow {
  /** 0 = Sunday … 6 = Saturday, as Date#getDay counts. */
  day: number;
  /** Local start time, "HH:MM" (24-hour). */
  start: string;
  /** Local end time, "HH:MM". At or before `start`, the window ends the next day. */
  end: string;
}

export interface ProfileSchedule {
  enabled: boolean;
  windows: ScheduleWindow[];
  /** At a window's end, how long to wait for the last player to leave before stopping anyway. */
  stopWaitMinutes: number;
}

export const DEFAULT_STOP_WAIT_MINUTES = 15;
export const MAX_STOP_WAIT_MINUTES = 240;
export const MAX_SCHEDULE_WINDOWS = 28;

/** One run of the server in absolute time: [start, end), epoch milliseconds. */
export interface ScheduleInterval {
  start: number;
  end: number;
}

export interface ScheduleAction {
  action: "start" | "stop";
  /** Epoch milliseconds. */
  at: number;
}

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight for "HH:MM", or null. */
export function parseHm(value: string): number | null {
  const m = HM.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Every occurrence of `windows` from the week before `now`'s week to the week
 * after, as absolute intervals, sorted and merged where they overlap or touch
 * (back-to-back windows are one run, so the server is not stopped between them).
 */
export function scheduleIntervals(windows: readonly ScheduleWindow[], now: Date): ScheduleInterval[] {
  const y = now.getFullYear();
  const mo = now.getMonth();
  const sunday = now.getDate() - now.getDay();
  const raw: ScheduleInterval[] = [];
  for (const w of windows) {
    const s = parseHm(w.start);
    const e = parseHm(w.end);
    if (s === null || e === null || s === e || !Number.isInteger(w.day) || w.day < 0 || w.day > 6) continue;
    const endDayOffset = e <= s ? 1 : 0;
    for (const week of [-1, 0, 1]) {
      const day = sunday + week * 7 + w.day;
      const start = new Date(y, mo, day, Math.floor(s / 60), s % 60).getTime();
      const end = new Date(y, mo, day + endDayOffset, Math.floor(e / 60), e % 60).getTime();
      // A window that falls wholly inside a skipped spring hour can collapse.
      if (end > start) raw.push({ start, end });
    }
  }
  raw.sort((a, b) => a.start - b.start);
  const merged: ScheduleInterval[] = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

/** The run `now` falls in, or null when the schedule has the server down. */
export function activeInterval(windows: readonly ScheduleWindow[], now: Date): ScheduleInterval | null {
  const t = now.getTime();
  return scheduleIntervals(windows, now).find((iv) => iv.start <= t && t < iv.end) ?? null;
}

/** The next start or stop after `now`, or null for a schedule with no windows. */
export function nextScheduleAction(windows: readonly ScheduleWindow[], now: Date): ScheduleAction | null {
  const t = now.getTime();
  for (const iv of scheduleIntervals(windows, now)) {
    if (iv.start <= t && t < iv.end) return { action: "stop", at: iv.end };
    if (iv.start > t) return { action: "start", at: iv.start };
  }
  return null;
}

/** "Fri 20:00" in the machine's local time. */
export function formatLocalWhen(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${WEEKDAY_NAMES[d.getDay()]} ${hh}:${mm}`;
}

export interface ScheduleCheck {
  schedule: ProfileSchedule;
  errors: string[];
}

/** Validate untrusted schedule input. On errors, `schedule` is not to be saved. */
export function validateSchedule(raw: unknown): ScheduleCheck {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];

  let stopWaitMinutes = DEFAULT_STOP_WAIT_MINUTES;
  if (r.stopWaitMinutes !== undefined) {
    const n = typeof r.stopWaitMinutes === "string" ? Number(r.stopWaitMinutes) : r.stopWaitMinutes;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_STOP_WAIT_MINUTES) {
      stopWaitMinutes = n;
    } else {
      errors.push(`The wait for players must be a whole number of minutes from 0 to ${MAX_STOP_WAIT_MINUTES}.`);
    }
  }

  const windows: ScheduleWindow[] = [];
  const list = Array.isArray(r.windows) ? r.windows : [];
  if (r.windows !== undefined && !Array.isArray(r.windows)) errors.push("windows must be a list.");
  if (list.length > MAX_SCHEDULE_WINDOWS) errors.push(`At most ${MAX_SCHEDULE_WINDOWS} windows.`);
  list.slice(0, MAX_SCHEDULE_WINDOWS).forEach((item, i) => {
    const w = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const n = i + 1;
    const day = typeof w.day === "string" ? Number(w.day) : w.day;
    const start = typeof w.start === "string" ? w.start.trim() : "";
    const end = typeof w.end === "string" ? w.end.trim() : "";
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
      errors.push(`Window ${n}: the day must be 0 (Sunday) to 6 (Saturday).`);
      return;
    }
    if (parseHm(start) === null || parseHm(end) === null) {
      errors.push(`Window ${n}: times must be HH:MM, 00:00 to 23:59.`);
      return;
    }
    if (start === end) {
      errors.push(`Window ${n}: the start and end are the same time.`);
      return;
    }
    windows.push({ day, start, end });
  });

  const enabled = r.enabled === true;
  if (enabled && windows.length === 0 && errors.length === 0) {
    errors.push("Add at least one window before turning the schedule on.");
  }
  return { schedule: { enabled, windows, stopWaitMinutes }, errors };
}
