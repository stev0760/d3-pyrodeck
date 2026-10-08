import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  activeInterval,
  formatLocalWhen,
  nextScheduleAction,
  parseHm,
  scheduleIntervals,
  validateSchedule,
  type ScheduleWindow,
} from "./schedule.js";

// Local wall-clock rules: pin the zone so the daylight-saving cases are real.
// Europe/Berlin: summer time starts 2026-03-29 02:00 -> 03:00 and ends
// 2026-10-25 03:00 -> 02:00.
const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Berlin";
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

/** Local time; month is 1-based here for readability. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

// 2026-10-09 is a Friday, 2026-10-10 a Saturday, 2026-10-11 a Sunday.
const FRI_EVENING: ScheduleWindow = { day: 5, start: "20:00", end: "23:00" };
const SAT_LATE: ScheduleWindow = { day: 6, start: "22:00", end: "02:00" };

describe("parseHm", () => {
  it("reads 24-hour HH:MM and refuses anything else", () => {
    expect(parseHm("00:00")).toBe(0);
    expect(parseHm("23:59")).toBe(23 * 60 + 59);
    expect(parseHm("24:00")).toBeNull();
    expect(parseHm("9:00")).toBeNull();
    expect(parseHm("12:60")).toBeNull();
  });
});

describe("activeInterval / nextScheduleAction", () => {
  it("is inside a window from its start up to (not including) its end", () => {
    expect(activeInterval([FRI_EVENING], at(2026, 10, 9, 19, 59))).toBeNull();
    expect(activeInterval([FRI_EVENING], at(2026, 10, 9, 20, 0))).not.toBeNull();
    expect(activeInterval([FRI_EVENING], at(2026, 10, 9, 22, 59))).not.toBeNull();
    expect(activeInterval([FRI_EVENING], at(2026, 10, 9, 23, 0))).toBeNull();
  });

  it("names the next start outside a window and the stop inside one", () => {
    expect(nextScheduleAction([FRI_EVENING], at(2026, 10, 7, 12))).toEqual({
      action: "start",
      at: at(2026, 10, 9, 20).getTime(),
    });
    expect(nextScheduleAction([FRI_EVENING], at(2026, 10, 9, 21))).toEqual({
      action: "stop",
      at: at(2026, 10, 9, 23).getTime(),
    });
    expect(nextScheduleAction([], at(2026, 10, 9, 21))).toBeNull();
  });

  it("runs an end at or before the start into the next day", () => {
    expect(activeInterval([SAT_LATE], at(2026, 10, 10, 23, 30))).not.toBeNull();
    expect(activeInterval([SAT_LATE], at(2026, 10, 11, 1, 59))).not.toBeNull();
    expect(activeInterval([SAT_LATE], at(2026, 10, 11, 2, 0))).toBeNull();
    const midnight = { day: 2, start: "18:00", end: "00:00" };
    expect(activeInterval([midnight], at(2026, 10, 6, 23, 59))).not.toBeNull();
    expect(activeInterval([midnight], at(2026, 10, 7, 0, 0))).toBeNull();
  });

  it("wraps the week: a Saturday-night window is still on early Sunday, and comes round again", () => {
    // Sunday 01:00 is in the window that began the previous (Saturday) week day.
    const sunday = at(2026, 10, 11, 1, 0);
    expect(activeInterval([SAT_LATE], sunday)).toEqual({
      start: at(2026, 10, 10, 22).getTime(),
      end: at(2026, 10, 11, 2).getTime(),
    });
    // After it ends, the next start is six days on.
    expect(nextScheduleAction([SAT_LATE], at(2026, 10, 11, 3))).toEqual({
      action: "start",
      at: at(2026, 10, 17, 22).getTime(),
    });
    // From Saturday morning the next start is that evening, not next week's.
    expect(nextScheduleAction([SAT_LATE], at(2026, 10, 10, 9))?.at).toBe(at(2026, 10, 10, 22).getTime());
  });

  it("merges overlapping and back-to-back windows into one run", () => {
    const a = { day: 1, start: "10:00", end: "12:00" };
    const b = { day: 1, start: "11:00", end: "13:00" };
    const c = { day: 1, start: "13:00", end: "14:00" };
    const run = activeInterval([a, b, c], at(2026, 10, 12, 12, 30));
    expect(run).toEqual({ start: at(2026, 10, 12, 10).getTime(), end: at(2026, 10, 12, 14).getTime() });
    expect(nextScheduleAction([a, b, c], at(2026, 10, 12, 11))).toEqual({
      action: "stop",
      at: at(2026, 10, 12, 14).getTime(),
    });
  });

  it("ignores windows that are not valid (equal times, bad day)", () => {
    expect(scheduleIntervals([{ day: 1, start: "10:00", end: "10:00" }], at(2026, 10, 12))).toEqual([]);
    expect(scheduleIntervals([{ day: 7, start: "10:00", end: "11:00" }], at(2026, 10, 12))).toEqual([]);
  });
});

describe("daylight saving (Europe/Berlin)", () => {
  it("spring forward: a start inside the skipped hour moves forward by the gap", () => {
    // Sunday 2026-03-29: 02:00 does not exist; 02:30 resolves to 03:30 summer time.
    const w = { day: 0, start: "02:30", end: "05:00" };
    const next = nextScheduleAction([w], at(2026, 3, 29, 1, 0));
    expect(next?.action).toBe("start");
    expect(new Date(next!.at).getHours()).toBe(3);
    expect(new Date(next!.at).getMinutes()).toBe(30);
    // The run is 1.5 h of real time, not 2.5 h.
    const run = activeInterval([w], new Date(next!.at));
    expect(run && (run.end - run.start) / 60_000).toBe(90);
  });

  it("fall back: an end inside the repeated hour ends at its first occurrence and the repeat stays outside", () => {
    // Saturday 22:00 to Sunday 02:30; on 2026-10-25 the clock goes 03:00 -> 02:00.
    const w = { day: 6, start: "22:00", end: "02:30" };
    const run = activeInterval([w], at(2026, 10, 25, 1, 0))!;
    expect(new Date(run.end).toISOString()).toBe("2026-10-25T00:30:00.000Z"); // 02:30 summer time
    // 02:45 on the second pass through the hour (winter time) is 01:45 UTC: outside.
    expect(activeInterval([w], new Date("2026-10-25T01:45:00.000Z"))).toBeNull();
    // 22:00 to the first 02:30 is 4.5 h of real time.
    expect((run.end - run.start) / 3_600_000).toBe(4.5);
  });
});

describe("formatLocalWhen", () => {
  it("prints weekday and 24-hour time in local time", () => {
    expect(formatLocalWhen(at(2026, 10, 9, 20, 5).getTime())).toBe("Fri 20:05");
  });
});

describe("validateSchedule", () => {
  it("accepts a valid schedule and fills the default wait", () => {
    const check = validateSchedule({ enabled: true, windows: [FRI_EVENING, SAT_LATE] });
    expect(check.errors).toEqual([]);
    expect(check.schedule).toEqual({ enabled: true, windows: [FRI_EVENING, SAT_LATE], stopWaitMinutes: 15 });
  });

  it("refuses bad days, bad times, equal times and an out-of-range wait", () => {
    const check = validateSchedule({
      enabled: true,
      stopWaitMinutes: 999,
      windows: [
        { day: 9, start: "10:00", end: "11:00" },
        { day: 1, start: "25:00", end: "11:00" },
        { day: 1, start: "10:00", end: "10:00" },
      ],
    });
    expect(check.errors).toHaveLength(4);
  });

  it("needs a window to turn the schedule on, but keeps an empty one off", () => {
    expect(validateSchedule({ enabled: true, windows: [] }).errors).toHaveLength(1);
    expect(validateSchedule({ enabled: false, windows: [] }).errors).toEqual([]);
  });
});
