import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RESPAWN_DEBOUNCE_MS,
  RespawnScaler,
  isBotName,
  sanitizeStoredRespawnScaling,
  scaledRespawnSeconds,
  validateRespawnScaling,
  type RespawnScaling,
} from "./respawnScaling.js";

const S: RespawnScaling = { enabled: true, minSeconds: 20, maxSeconds: 60, playersForMin: 10 };

describe("scaledRespawnSeconds", () => {
  it("holds the longest time with two players or fewer and the shortest from playersForMin up", () => {
    expect([0, 1, 2].map((n) => scaledRespawnSeconds(n, S))).toEqual([60, 60, 60]);
    expect([10, 11, 32].map((n) => scaledRespawnSeconds(n, S))).toEqual([20, 20, 20]);
  });

  it("falls linearly in between, rounded to whole seconds", () => {
    // 60 - (n - 2) / 8 * 40
    expect([3, 4, 6, 9].map((n) => scaledRespawnSeconds(n, S))).toEqual([55, 50, 40, 25]);
    expect(scaledRespawnSeconds(4, { ...S, minSeconds: 30, maxSeconds: 31, playersForMin: 5 })).toBe(30);
  });

  it("is flat when min equals max", () => {
    expect([0, 5, 20].map((n) => scaledRespawnSeconds(n, { ...S, minSeconds: 45, maxSeconds: 45 }))).toEqual([
      45, 45, 45,
    ]);
  });
});

describe("validateRespawnScaling", () => {
  it("accepts form strings and defaults playersForMin to 8", () => {
    expect(validateRespawnScaling({ enabled: true, minSeconds: "15", maxSeconds: "90", playersForMin: "" })).toEqual({
      settings: { enabled: true, minSeconds: 15, maxSeconds: 90, playersForMin: 8 },
      errors: [],
    });
  });

  it("stores nothing for an untouched, disabled form", () => {
    expect(validateRespawnScaling({ enabled: false, minSeconds: "", maxSeconds: "" })).toEqual({
      settings: null,
      errors: [],
    });
    expect(validateRespawnScaling(null)).toEqual({ settings: null, errors: [] });
  });

  it("keeps disabled settings that are filled in", () => {
    expect(validateRespawnScaling({ enabled: false, minSeconds: 10, maxSeconds: 30 }).settings?.enabled).toBe(false);
  });

  it("refuses out-of-range times, min above max, and playersForMin outside 3-32", () => {
    expect(validateRespawnScaling({ enabled: true, minSeconds: 0, maxSeconds: 60 }).errors).toHaveLength(1);
    expect(validateRespawnScaling({ enabled: true, minSeconds: 10, maxSeconds: 10001 }).errors).toHaveLength(1);
    expect(validateRespawnScaling({ enabled: true, minSeconds: 61, maxSeconds: 60 }).errors).toEqual([
      "The shortest respawn time cannot be longer than the longest.",
    ]);
    expect(validateRespawnScaling({ enabled: true, minSeconds: 10, maxSeconds: 60, playersForMin: 2 }).errors).toHaveLength(1);
    expect(validateRespawnScaling({ enabled: true, minSeconds: 10, maxSeconds: 60, playersForMin: 33 }).errors).toHaveLength(1);
  });

  it("turns off stored settings that no longer validate", () => {
    expect(sanitizeStoredRespawnScaling({ enabled: true, minSeconds: 90, maxSeconds: 10 })).toBeNull();
  });
});

describe("isBotName", () => {
  it("matches the [BOT] suffix with or without a space", () => {
    expect(isBotName("Viper[BOT]")).toBe(true);
    expect(isBotName("Viper [BOT]")).toBe(true);
    expect(isBotName("Viper[bot] ")).toBe(true);
    expect(isBotName("[BOT]Hunter")).toBe(false);
    expect(isBotName("Viper")).toBe(false);
  });
});

describe("RespawnScaler", () => {
  let sent: string[];
  let scaler: RespawnScaler;
  const send = async (line: string) => {
    sent.push(line);
    return "";
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    scaler = new RespawnScaler({ log: () => {} });
  });

  afterEach(() => {
    scaler.stop();
    vi.useRealTimers();
  });

  it("sends the empty-server value when the console is ready", async () => {
    scaler.arm(S);
    scaler.consoleReady(send);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["$setrespawntime 60"]);
  });

  it("debounces joins and leaves and sends only when the value changes", async () => {
    scaler.arm(S);
    scaler.consoleReady(send);
    await vi.advanceTimersByTimeAsync(0);
    for (const name of ["a", "b", "c", "d"]) scaler.playerJoined(name);
    await vi.advanceTimersByTimeAsync(RESPAWN_DEBOUNCE_MS - 1);
    expect(sent).toEqual(["$setrespawntime 60"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["$setrespawntime 60", "$setrespawntime 50"]);

    // Two left, then back to four: no change once the dust settles.
    scaler.playerLeft("d");
    scaler.playerLeft("c");
    scaler.playerJoined("c");
    scaler.playerJoined("d");
    await vi.advanceTimersByTimeAsync(RESPAWN_DEBOUNCE_MS);
    expect(sent).toHaveLength(2);

    scaler.playerLeft("d");
    scaler.playerLeft("c");
    await vi.advanceTimersByTimeAsync(RESPAWN_DEBOUNCE_MS);
    expect(sent.at(-1)).toBe("$setrespawntime 60");
  });

  it("counts humans only and ignores leaves of players it never saw", async () => {
    scaler.arm(S);
    scaler.consoleReady(send);
    for (const name of ["Viper[BOT]", "Shadow[BOT]", "Rex [BOT]", "human1"]) scaler.playerJoined(name);
    scaler.playerLeft("ghost");
    await vi.advanceTimersByTimeAsync(RESPAWN_DEBOUNCE_MS);
    expect(scaler.humanCount()).toBe(1);
    expect(sent).toEqual(["$setrespawntime 60"]);
  });

  it("counts two players with the same name twice", async () => {
    scaler.arm(S);
    for (const name of ["pilot", "pilot", "pilot"]) scaler.playerJoined(name);
    scaler.playerLeft("pilot");
    expect(scaler.humanCount()).toBe(2);
  });

  it("sends nothing when disabled, before the console is ready, or after stop", async () => {
    scaler.arm({ ...S, enabled: false });
    scaler.consoleReady(send);
    scaler.playerJoined("a");
    await vi.advanceTimersByTimeAsync(RESPAWN_DEBOUNCE_MS);
    expect(sent).toEqual([]);

    scaler.arm(S);
    for (const name of ["a", "b", "c"]) scaler.playerJoined(name);
    await vi.advanceTimersByTimeAsync(RESPAWN_DEBOUNCE_MS);
    expect(sent).toEqual([]);
    scaler.consoleReady(send);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["$setrespawntime 55"]);

    scaler.stop();
    scaler.playerJoined("d");
    await vi.advanceTimersByTimeAsync(RESPAWN_DEBOUNCE_MS);
    expect(sent).toHaveLength(1);
  });

  it("retries a failed send at the next change", async () => {
    let fail = true;
    scaler.arm(S);
    scaler.consoleReady(async (line) => {
      if (fail) throw new Error("console not connected");
      sent.push(line);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    fail = false;
    scaler.playerJoined("a");
    await vi.advanceTimersByTimeAsync(RESPAWN_DEBOUNCE_MS);
    expect(sent).toEqual(["$setrespawntime 60"]);
  });
});
