import { describe, it, expect } from "vitest";
import { emptyRestartDecision, formatDuration } from "./emptyRestart.js";

const H = 3_600_000;
const base = { afterMs: 24 * H, graceMs: 130_000 };

describe("emptyRestartDecision", () => {
  it("waits for the uptime limit", () => {
    expect(emptyRestartDecision({ ...base, now: 23 * H, startedAt: 0, humans: 0, emptySince: 0 })).toEqual({
      due: false,
      reason: "up 23 h of 24 h",
    });
  });

  it("never restarts with a human on", () => {
    const d = emptyRestartDecision({ ...base, now: 30 * H, startedAt: 0, humans: 1, emptySince: null });
    expect(d).toEqual({ due: false, reason: "1 player on" });
  });

  it("waits the grace period after the last player left", () => {
    const left = 30 * H - 60_000;
    expect(emptyRestartDecision({ ...base, now: 30 * H, startedAt: 0, humans: 0, emptySince: left })).toEqual({
      due: false,
      reason: "last player left 60 s ago; waits 130 s",
    });
    expect(
      emptyRestartDecision({ ...base, now: left + 130_000, startedAt: 0, humans: 0, emptySince: left }).due,
    ).toBe(true);
  });

  it("restarts a server nobody ever joined once the limit passes", () => {
    const d = emptyRestartDecision({ ...base, now: 24 * H, startedAt: 0, humans: 0, emptySince: 0 });
    expect(d).toEqual({ due: true, reason: "up 24 h and empty for 24 h" });
  });

  it("does not restart while the roster is unknown or nothing runs", () => {
    expect(emptyRestartDecision({ ...base, now: 30 * H, startedAt: 0, humans: null, emptySince: null }).due).toBe(false);
    expect(emptyRestartDecision({ ...base, now: 30 * H, startedAt: null, humans: 0, emptySince: 0 }).due).toBe(false);
  });
});

describe("formatDuration", () => {
  it("picks a unit people read", () => {
    expect(formatDuration(59_400)).toBe("59 s");
    expect(formatDuration(5 * 60_000)).toBe("5 min");
    expect(formatDuration(3 * H + 12 * 60_000)).toBe("3 h 12 min");
  });
});
