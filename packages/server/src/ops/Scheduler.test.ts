import { describe, it, expect, beforeEach } from "vitest";
import { Scheduler, type ScheduledProfile, type SchedulerDeps } from "./Scheduler.js";

/** A fake clock and server the scheduler drives; times are local, month 1-based. */
function harness(profiles: ScheduledProfile[]) {
  const state = {
    now: new Date(2026, 9, 9, 19, 0), // Fri 19:00
    running: false,
    profileId: null as string | null,
    humans: 0 as number | null,
    busy: false,
    calls: [] as string[],
    startResult: { ok: true } as { ok: true } | { ok: false; error: string },
  };
  const deps: SchedulerDeps = {
    now: () => state.now,
    listProfiles: async () => profiles,
    getProcess: () => ({ running: state.running, profileId: state.profileId }),
    isBusy: () => state.busy,
    start: async (id) => {
      state.calls.push(`start ${id}`);
      if (state.startResult.ok) {
        state.running = true;
        state.profileId = id;
      }
      return state.startResult;
    },
    stop: async () => {
      state.calls.push("stop");
      state.running = false;
    },
    countHumans: async () => state.humans,
    say: async (text) => {
      state.calls.push(`say ${text}`);
    },
    skipped: (id, action, reason) => {
      state.calls.push(`skipped ${action} ${id}: ${reason}`);
    },
    log: { info: () => {}, warn: () => {} },
  };
  const set = (mo: number, d: number, h: number, mi = 0) => {
    state.now = new Date(2026, mo - 1, d, h, mi);
  };
  return { state, scheduler: new Scheduler(deps), set };
}

const friday: ScheduledProfile = {
  id: "p1",
  name: "Friday CTF",
  schedule: { enabled: true, windows: [{ day: 5, start: "20:00", end: "23:00" }], stopWaitMinutes: 10 },
};

describe("Scheduler", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness([friday]);
  });

  it("starts at the window start, once per window", async () => {
    await h.scheduler.tick();
    expect(h.state.calls).toEqual([]);
    h.set(10, 9, 20, 0);
    await h.scheduler.tick();
    h.set(10, 9, 20, 1);
    await h.scheduler.tick();
    expect(h.state.calls).toEqual(["start p1"]);
  });

  it("does not restart a server the operator stopped inside the window", async () => {
    h.set(10, 9, 20, 0);
    await h.scheduler.tick();
    h.state.running = false; // operator pressed Stop
    h.set(10, 9, 21, 0);
    await h.scheduler.tick();
    expect(h.state.calls).toEqual(["start p1"]);
  });

  it("stops at the window end when nobody is on", async () => {
    h.set(10, 9, 20, 0);
    await h.scheduler.tick();
    h.state.humans = 0;
    h.set(10, 9, 23, 0);
    await h.scheduler.tick();
    expect(h.state.calls).toEqual(["start p1", "stop"]);
  });

  it("with players on, says so once, waits, and stops when they leave", async () => {
    h.set(10, 9, 20, 0);
    await h.scheduler.tick();
    h.state.humans = 2;
    h.set(10, 9, 23, 0);
    await h.scheduler.tick();
    h.set(10, 9, 23, 3);
    await h.scheduler.tick();
    expect(h.state.calls).toEqual(["start p1", "say Scheduled stop: this server closes within 10 minutes."]);
    expect(h.scheduler.status([friday])[0].pendingStop).toEqual({ deadline: new Date(2026, 9, 9, 23, 10).getTime() });
    h.state.humans = 0;
    h.set(10, 9, 23, 4);
    await h.scheduler.tick();
    expect(h.state.calls.at(-1)).toBe("stop");
  });

  it("stops at the end of the wait even with players on, and when it cannot count them", async () => {
    h.set(10, 9, 20, 0);
    await h.scheduler.tick();
    h.state.humans = null; // no console session
    h.set(10, 9, 23, 0);
    await h.scheduler.tick();
    h.set(10, 9, 23, 9);
    await h.scheduler.tick();
    expect(h.state.calls).toEqual(["start p1"]);
    h.set(10, 9, 23, 10);
    await h.scheduler.tick();
    expect(h.state.calls).toEqual(["start p1", "stop"]);
  });

  it("leaves another profile's server alone at both ends", async () => {
    h.state.running = true;
    h.state.profileId = "other";
    h.set(10, 9, 20, 0);
    await h.scheduler.tick();
    h.set(10, 9, 23, 0);
    await h.scheduler.tick();
    expect(h.state.calls).toEqual(["skipped start p1: another profile's server is running"]);
  });

  it("reports a failed start as skipped", async () => {
    h.state.startResult = { ok: false, error: "Cannot read config file" };
    h.set(10, 9, 20, 0);
    await h.scheduler.tick();
    expect(h.state.calls).toEqual(["start p1", "skipped start p1: Cannot read config file"]);
  });

  it("after a Pyrodeck restart inside a window, makes the missed start; outside one, stops nothing", async () => {
    h.set(10, 9, 21, 30);
    await h.scheduler.tick();
    expect(h.state.calls).toEqual(["start p1"]);

    const fresh = harness([friday]);
    fresh.state.running = true;
    fresh.state.profileId = "p1"; // a server running outside the window
    fresh.set(10, 10, 9, 0);
    await fresh.scheduler.tick();
    expect(fresh.state.calls).toEqual([]);
  });

  it("does nothing for a disabled schedule and lists the next action only when enabled", async () => {
    const off = { ...friday, schedule: { ...friday.schedule!, enabled: false } };
    const h2 = harness([off]);
    h2.set(10, 9, 20, 0);
    await h2.scheduler.tick();
    expect(h2.state.calls).toEqual([]);
    expect(h2.scheduler.status([off])[0].next).toBeNull();
    expect(h.scheduler.status([friday])[0].next).toEqual({
      action: "start",
      at: new Date(2026, 9, 9, 20, 0).getTime(),
    });
  });
});
