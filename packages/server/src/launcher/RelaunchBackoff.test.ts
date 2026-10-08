import { describe, it, expect } from "vitest";
import { RelaunchBackoff } from "./RelaunchBackoff.js";

describe("RelaunchBackoff", () => {
  it("doubles from 5 s, caps at 2 min, and gives up after the sixth failure in the window", () => {
    const b = new RelaunchBackoff();
    const delays: unknown[] = [];
    for (let i = 0; i < 7; i++) delays.push(b.next(i * 1000));
    expect(delays).toEqual([
      { delayMs: 5_000, failures: 1 },
      { delayMs: 10_000, failures: 2 },
      { delayMs: 20_000, failures: 3 },
      { delayMs: 40_000, failures: 4 },
      { delayMs: 80_000, failures: 5 },
      { delayMs: 120_000, failures: 6 },
      { giveUp: true, failures: 7 },
    ]);
  });

  it("forgets failures older than the window", () => {
    const b = new RelaunchBackoff({ windowMs: 60_000 });
    b.next(0);
    b.next(10_000);
    expect(b.count(30_000)).toBe(2);
    // Both earlier failures are more than a minute old: back to the short wait.
    expect(b.next(75_000)).toEqual({ delayMs: 5_000, failures: 1 });
  });

  it("starts over after reset", () => {
    const b = new RelaunchBackoff({ maxFailures: 1 });
    b.next(0);
    expect(b.next(1)).toEqual({ giveUp: true, failures: 2 });
    b.reset();
    expect(b.next(2)).toEqual({ delayMs: 5_000, failures: 1 });
  });
});
