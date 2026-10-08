import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HangWatch } from "./HangWatch.js";

describe("HangWatch", () => {
  let w: HangWatch;
  let events: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    w = new HangWatch({ probeAfterMs: 59_000, restartAfterMs: 120_000, loadAllowanceMs: 120_000, tickMs: 1000 });
    events = [];
    w.on("probe", () => events.push(`probe@${Math.round(Date.now() / 1000)}`));
    w.on("hung", (ms: number) => events.push(`hung ${Math.round(ms / 1000)}s`));
    vi.setSystemTime(0);
  });

  afterEach(() => {
    w.stop();
    vi.useRealTimers();
  });

  it("probes after 59 s of silence and declares a hang at 120 s", () => {
    w.start();
    vi.advanceTimersByTime(58_000);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual(["probe@59"]);
    expect(w.snapshot().state).toBe("probing");
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual(["probe@59"]);
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual(["probe@59", "hung 120s"]);
    expect(w.isWatching()).toBe(false);
  });

  it("an answer to the probe resets the count", () => {
    w.start();
    vi.advanceTimersByTime(59_000);
    vi.advanceTimersByTime(2_000);
    w.activity(); // the $players reply
    expect(w.snapshot().state).toBe("listening");
    vi.advanceTimersByTime(58_000);
    expect(events).toEqual(["probe@59"]);
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual(["probe@59", "probe@120"]);
  });

  it("any console output keeps a busy server from being probed", () => {
    w.start();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(30_000);
      w.activity();
    }
    expect(events).toEqual([]);
  });

  it("neither probes nor declares a hang while a level loads", () => {
    w.start();
    vi.advanceTimersByTime(10_000);
    w.activity();
    w.levelLoad(); // "Opening level" at t=10 s; the server then goes quiet
    vi.advanceTimersByTime(119_000);
    expect(events).toEqual([]);
    expect(w.snapshot().state).toBe("loading");
    // Allowance over at t=130 s: silent for 120 s, so it probes now and
    // gives the probe its full answer window.
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual(["probe@130"]);
    vi.advanceTimersByTime(61_000);
    expect(events).toEqual(["probe@130", "hung 181s"]);
  });

  it("does nothing while off, and stop() cancels a watch", () => {
    w.activity();
    w.levelLoad();
    vi.advanceTimersByTime(300_000);
    expect(events).toEqual([]);
    w.start();
    vi.advanceTimersByTime(30_000);
    w.stop();
    vi.advanceTimersByTime(300_000);
    expect(events).toEqual([]);
    expect(w.snapshot()).toEqual({ state: "off", silentForMs: null, probeAt: null, restartAt: null });
  });

  it("reports when the probe and the restart are due", () => {
    w.start();
    vi.advanceTimersByTime(20_000);
    expect(w.snapshot()).toEqual({ state: "listening", silentForMs: 20_000, probeAt: 59_000, restartAt: 120_000 });
  });

  it("takes new thresholds without losing the silence so far", () => {
    w.start();
    vi.advanceTimersByTime(20_000);
    w.configure(30_000, 60_000);
    vi.advanceTimersByTime(10_000);
    expect(events).toEqual(["probe@30"]);
  });
});
