import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RotationHealthMonitor } from "./RotationHealthMonitor.js";

describe("RotationHealthMonitor", () => {
  let m: RotationHealthMonitor;
  let events: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    m = new RotationHealthMonitor({ timeoutMs: 1000, maxRetries: 1 });
    events = [];
    m.on("retry", (attempt: number, reason: string) => events.push(`retry ${attempt}: ${reason}`));
    m.on("healthy", (attempt: number) => events.push(`healthy ${attempt}`));
    m.on("failed", (reason: string) => events.push(`failed: ${reason}`));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports healthy when the server answers before the deadline", () => {
    m.begin();
    m.arm();
    expect(m.snapshot().state).toBe("waiting");
    vi.advanceTimersByTime(500);
    m.healthy();
    expect(events).toEqual(["healthy 0"]);
    expect(m.isPending()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(events).toEqual(["healthy 0"]); // timer was cleared
  });

  it("retries once on timeout, then gives up", () => {
    m.begin();
    m.arm();
    vi.advanceTimersByTime(1000);
    expect(events).toEqual(["retry 1: no answer from the server's remote console within 1s"]);
    expect(m.snapshot()).toMatchObject({ state: "relaunching", attempt: 1 });
    m.arm();
    vi.advanceTimersByTime(1000);
    expect(events[1]).toBe("failed: no answer from the server's remote console within 1s");
    expect(m.isPending()).toBe(false);
  });

  it("treats a crash like a timeout, and a healthy retry completes the rotation", () => {
    m.begin();
    m.arm();
    m.failure("server exited during startup (exit code 1)");
    expect(events).toEqual(["retry 1: server exited during startup (exit code 1)"]);
    m.arm();
    m.healthy();
    expect(events[1]).toBe("healthy 1");
  });

  it("counts a failed spawn (before arm) as a failed attempt", () => {
    m.begin();
    m.failure("restart failed: spawn ENOENT");
    m.failure("restart failed: spawn ENOENT");
    expect(events).toEqual(["retry 1: restart failed: spawn ENOENT", "failed: restart failed: spawn ENOENT"]);
  });

  it("ignores reports while idle and after cancel", () => {
    m.healthy();
    m.failure("stray");
    m.begin();
    m.arm();
    m.cancel();
    vi.advanceTimersByTime(5000);
    m.healthy();
    expect(events).toEqual([]);
  });

  it("accepts healthy before arm (a server faster than the spawn bookkeeping)", () => {
    m.begin();
    m.healthy(m.token());
    expect(events).toEqual(["healthy 0"]);
  });

  it("ignores reports from an attempt that was already given up on", () => {
    m.begin();
    const first = m.token();
    m.arm();
    vi.advanceTimersByTime(1000); // attempt 0 times out -> retry
    expect(events).toEqual(["retry 1: no answer from the server's remote console within 1s"]);
    m.arm();
    // The first server's connection attempt fails late, then succeeds late: both stale.
    m.failure("telnet auto-connect failed: ECONNREFUSED", first);
    m.healthy(first);
    expect(events).toHaveLength(1);
    m.healthy(m.token());
    expect(events[1]).toBe("healthy 1");
  });
});
