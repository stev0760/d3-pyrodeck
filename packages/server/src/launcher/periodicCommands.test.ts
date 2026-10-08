import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MAX_LINES_PER_TICK,
  PeriodicCommandScheduler,
  checkConsoleLine,
  sanitizeStoredPeriodic,
  validatePeriodicSettings,
  type PeriodicCommandSettings,
} from "./periodicCommands.js";

const MINUTE = 60_000;

function settings(overrides: Partial<PeriodicCommandSettings> = {}): PeriodicCommandSettings {
  return {
    enabled: true,
    startLines: [],
    lines: ["say one", "say two", "say three"],
    intervalMinutes: 5,
    mode: "sequential",
    ...overrides,
  };
}

describe("periodic command settings", () => {
  it("accepts $ commands and say lines, trimmed, blank lines dropped", () => {
    const check = validatePeriodicSettings({
      startLines: [" say Welcome ", ""],
      lines: "say Rules: no spawn camping\n\n$scores\n",
      intervalMinutes: "15",
      mode: "random",
    });
    expect(check).toEqual({
      settings: {
        enabled: true,
        startLines: ["say Welcome"],
        lines: ["say Rules: no spawn camping", "$scores"],
        intervalMinutes: 15,
        mode: "random",
      },
      errors: [],
    });
  });

  it("stores nothing when there are no lines", () => {
    expect(validatePeriodicSettings({ lines: [], startLines: [""], intervalMinutes: 5 })).toEqual({
      settings: null,
      errors: [],
    });
  });

  it("refuses lines the console would mangle or that are not commands", () => {
    expect(checkConsoleLine("quit")).toMatch(/must start with/);
    expect(checkConsoleLine("hello there")).toMatch(/must start with/);
    expect(checkConsoleLine("say")).toMatch(/must start with/);
    expect(checkConsoleLine(`say ${"x".repeat(200)}`)).toMatch(/longer than 200/);
    expect(checkConsoleLine("say café")).toMatch(/ASCII/);
    expect(checkConsoleLine("say tab\there")).toMatch(/ASCII/);
    expect(checkConsoleLine("SAY hi")).toBeNull();
    expect(checkConsoleLine("$setrespawntime 30")).toBeNull();
  });

  it("caps the list lengths: all mode and start lines by the per-tick limit", () => {
    const six = Array.from({ length: MAX_LINES_PER_TICK + 1 }, (_, i) => `say ${i}`);
    expect(validatePeriodicSettings({ lines: six, mode: "all" }).errors).toHaveLength(1);
    expect(validatePeriodicSettings({ lines: six, mode: "sequential" }).errors).toEqual([]);
    expect(validatePeriodicSettings({ startLines: six, lines: [] }).errors).toHaveLength(1);
    const many = Array.from({ length: 21 }, (_, i) => `say ${i}`);
    expect(validatePeriodicSettings({ lines: many }).errors).toHaveLength(1);
  });

  it("refuses an interval outside 1-1440 minutes and an unknown mode", () => {
    for (const bad of [0, 1441, "1.5", "soon"]) {
      expect(validatePeriodicSettings({ lines: ["say x"], intervalMinutes: bad }).errors).toHaveLength(1);
    }
    expect(validatePeriodicSettings({ lines: ["say x"], mode: "burst" }).errors).toHaveLength(1);
  });

  it("turns off stored settings that no longer validate", () => {
    expect(sanitizeStoredPeriodic({ lines: ["quit"] })).toBeNull();
    expect(sanitizeStoredPeriodic({ lines: ["say ok"], enabled: false })?.enabled).toBe(false);
  });
});

describe("PeriodicCommandScheduler", () => {
  let sent: string[];
  let log: string[];
  const send = async (line: string) => {
    sent.push(line);
    return "";
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    log = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (random = () => 0) => new PeriodicCommandScheduler({ random, log: (m) => log.push(m) });

  it("sends the start lines once when the console is ready, then a line per interval in order", async () => {
    const s = make();
    s.arm("101", settings({ startLines: ["say Welcome", "$scores"] }));
    s.consoleReady(send);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["say Welcome", "$scores"]);

    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.slice(2)).toEqual(["say one"]);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(sent.slice(2)).toEqual(["say one", "say two", "say three", "say one"]);

    // A console reconnect in the same run does not resend the start lines.
    s.consoleReady(send);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((l) => l === "say Welcome")).toHaveLength(1);
    s.stop();
  });

  it("sends every line each tick in all mode, never more than the per-tick limit", async () => {
    const s = make();
    const lines = Array.from({ length: MAX_LINES_PER_TICK + 3 }, (_, i) => `say ${i}`);
    s.arm("1", settings({ lines, mode: "all", intervalMinutes: 1 }));
    s.consoleReady(send);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual(lines.slice(0, MAX_LINES_PER_TICK));
    s.stop();
  });

  it("picks one random line per tick, never the same line twice running", async () => {
    const s = make(() => 0.5); // always index 1 of 3 before the repeat guard
    s.arm("1", settings({ mode: "random", intervalMinutes: 1 }));
    s.consoleReady(send);
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(sent).toEqual(["say two", "say three", "say two"]);
    s.stop();
  });

  it("sends nothing before the console is ready, while it is gone, or after stop", async () => {
    const s = make();
    s.arm("1", settings({ startLines: ["say hi"], intervalMinutes: 1 }));
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(sent).toEqual([]);

    s.consoleReady(send);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual(["say hi", "say one"]);

    s.consoleLost();
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(sent).toEqual(["say hi", "say one"]);

    s.consoleReady(send);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual(["say hi", "say one", "say two"]);

    s.stop();
    expect(s.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sent).toHaveLength(3);
  });

  it("starts over on a new run: start lines again, sequence from the top", async () => {
    const s = make();
    s.arm("1", settings({ startLines: ["say hi"], intervalMinutes: 1 }));
    s.consoleReady(send);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    s.arm("1", settings({ startLines: ["say ignored"] })); // the same run again: no-op
    s.arm("2", settings({ startLines: ["say hi again"], intervalMinutes: 1 }));
    s.consoleReady(send);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual(["say hi", "say one", "say two", "say hi again", "say one"]);
    s.stop();
  });

  it("does nothing for disabled settings or no settings", async () => {
    const s = make();
    s.arm("1", settings({ enabled: false, startLines: ["say hi"], intervalMinutes: 1 }));
    s.consoleReady(send);
    s.arm("2", null);
    s.consoleReady(send);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sent).toEqual([]);
    expect(s.isRunning()).toBe(false);
  });

  it("stops a tick at the first failed send and keeps ticking", async () => {
    const s = make();
    let fail = true;
    s.arm("1", settings({ mode: "all", lines: ["say a", "say b"], intervalMinutes: 1 }));
    s.consoleReady(async (line) => {
      if (fail) throw new Error("console not connected");
      sent.push(line);
    });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual([]);
    expect(log.some((m) => m.includes('"say a" not sent: console not connected'))).toBe(true);
    fail = false;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual(["say a", "say b"]);
    s.stop();
  });
});
