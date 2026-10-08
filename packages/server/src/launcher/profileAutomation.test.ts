import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServerEvents } from "../events/ServerEvents.js";
import type { ServerConnection } from "../connection/ServerConnection.js";
import { PeriodicCommandScheduler } from "./periodicCommands.js";
import { RESPAWN_DEBOUNCE_MS, RespawnScaler } from "./respawnScaling.js";
import { ProfileAutomation, type AutomationSettings } from "./profileAutomation.js";

const MINUTE = 60_000;

function fakeConnection(sent: string[], connected = { value: true }): ServerConnection {
  return {
    connect: async () => {},
    send: async (line: string) => {
      sent.push(line);
      return "";
    },
    onData: () => {},
    onDisconnect: () => {},
    disconnect: async () => {
      connected.value = false;
    },
    isConnected: () => connected.value,
  };
}

const PROFILE: AutomationSettings = {
  periodicCommands: {
    enabled: true,
    startLines: ["say Welcome"],
    lines: ["say Tip one", "say Tip two"],
    intervalMinutes: 1,
    mode: "sequential",
  },
};

const SCALED: AutomationSettings = {
  respawnScaling: { enabled: true, minSeconds: 20, maxSeconds: 60, playersForMin: 4 },
};

describe("ProfileAutomation", () => {
  let bus: ServerEvents;
  let sent: string[];
  let auto: ProfileAutomation;
  const started = (pid: number, profileId = "p1") =>
    bus.emitEvent("server.started", { profileId, pid, args: [], reason: "manual" });

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new ServerEvents();
    sent = [];
    auto = new ProfileAutomation({
      loadProfile: async (id) => (id === "p1" ? PROFILE : id === "p3" ? SCALED : null),
      periodic: new PeriodicCommandScheduler({ log: () => {} }),
      respawn: new RespawnScaler({ log: () => {} }),
    });
    auto.listen(bus);
  });

  afterEach(() => {
    auto.serverDown();
    vi.useRealTimers();
  });

  it("runs the launched profile's lines from console ready until the server stops", async () => {
    started(100);
    await auto.consoleReady("p1", fakeConnection(sent));
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(sent).toEqual(["say Welcome", "say Tip one", "say Tip two"]);

    bus.emitEvent("server.stopped", { profileId: "p1", pid: 100, reason: "manual" });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sent).toHaveLength(3);
  });

  it("ignores a second server.started for the same process and restarts on a relaunch", async () => {
    started(100);
    await auto.consoleReady("p1", fakeConnection(sent));
    started(100); // reported twice
    await auto.consoleReady("p1", fakeConnection(sent));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["say Welcome"]);

    bus.emitEvent("server.crashed", { profileId: "p1", pid: 100, code: 1, signal: null });
    started(101, "p1");
    await auto.consoleReady("p1", fakeConnection(sent));
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual(["say Welcome", "say Welcome", "say Tip one"]);
  });

  it("ignores the end of an older process and a console for another profile", async () => {
    started(100);
    bus.emitEvent("server.stopped", { profileId: "p1", pid: 99, reason: "manual" });
    await auto.consoleReady("p2", fakeConnection(sent));
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual([]);
    await auto.consoleReady("p1", fakeConnection(sent));
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual(["say Welcome", "say Tip one"]);
  });

  it("sends nothing over a console that has disconnected", async () => {
    const connected = { value: true };
    started(100);
    await auto.consoleReady("p1", fakeConnection(sent, connected));
    await vi.advanceTimersByTimeAsync(0);
    connected.value = false;
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(sent).toEqual(["say Welcome"]);
  });

  it("does nothing for a profile without periodic commands", async () => {
    started(100, "p2");
    await auto.consoleReady("p2", fakeConnection(sent));
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sent).toEqual([]);
  });

  it("scales the respawn time from the launched profile's player events, bots excluded", async () => {
    const join = (name: string, profileId = "p3") => bus.emitEvent("player.joined", { profileId, name });
    started(200, "p3");
    await auto.consoleReady("p3", fakeConnection(sent));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["$setrespawntime 60"]);

    join("alpha");
    join("bravo");
    join("Viper[BOT]");
    join("charlie");
    join("delta", "other-profile");
    await vi.advanceTimersByTimeAsync(RESPAWN_DEBOUNCE_MS);
    expect(sent).toEqual(["$setrespawntime 60", "$setrespawntime 40"]);

    bus.emitEvent("player.left", { profileId: "p3", name: "charlie" });
    await vi.advanceTimersByTimeAsync(RESPAWN_DEBOUNCE_MS);
    expect(sent.at(-1)).toBe("$setrespawntime 60");

    // A relaunch starts the count over.
    started(201, "p3");
    await auto.consoleReady("p3", fakeConnection(sent));
    await vi.advanceTimersByTimeAsync(0);
    expect(auto.respawn.humanCount()).toBe(0);
  });
});
