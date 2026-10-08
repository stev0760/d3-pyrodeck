import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServerEvents } from "../events/ServerEvents.js";
import { Autostart, AUTOSTART_MAX_FAILURES, AUTOSTART_QUICK_EXIT_MS, type AutostartDeps } from "./Autostart.js";
import {
  AUTOSTART_ENV,
  chooseAutostartProfile,
  readAutostartEnv,
  sanitizeStoredAutostart,
  type AutostartChoice,
} from "./autostartSettings.js";
import { Supervisor, type ProcessDown } from "./Supervisor.js";

const CTF = { id: "id-ctf", name: "Public CTF" };
const ANARCHY = { id: "id-anarchy", name: "Anarchy" };

describe("chooseAutostartProfile", () => {
  const profiles = [CTF, ANARCHY];

  it("starts nothing when neither the environment nor the UI names a profile", () => {
    expect(chooseAutostartProfile(null, null, profiles)).toBeNull();
  });

  it("takes the profile ticked in the UI", () => {
    expect(chooseAutostartProfile(null, ANARCHY.id, profiles)).toEqual({ source: "setting", profile: ANARCHY });
  });

  it("lets the environment win over the UI", () => {
    expect(chooseAutostartProfile("Public CTF", ANARCHY.id, profiles)).toEqual({ source: "env", profile: CTF });
  });

  it("matches the name exactly, then a profile id", () => {
    expect(chooseAutostartProfile("public ctf", null, profiles)).toMatchObject({ source: "env", error: expect.any(String) });
    expect(chooseAutostartProfile("id-anarchy", null, profiles)).toEqual({ source: "env", profile: ANARCHY });
  });

  it("names an unknown profile and the ones that exist", () => {
    const choice = chooseAutostartProfile("Pubic CTF", ANARCHY.id, profiles);
    expect(choice).toEqual({
      source: "env",
      error: `${AUTOSTART_ENV} names no profile: "Pubic CTF" (the profiles are "Public CTF", "Anarchy")`,
    });
    expect(chooseAutostartProfile("x", null, [])).toMatchObject({ error: expect.stringContaining("there are no profiles") });
  });

  it("refuses a name two profiles share", () => {
    const choice = chooseAutostartProfile("Public CTF", null, [CTF, { id: "id-2", name: "Public CTF" }]);
    expect(choice).toMatchObject({ source: "env", error: expect.stringMatching(/matches 2 profiles/) });
  });

  it("reports a UI choice whose profile was deleted", () => {
    expect(chooseAutostartProfile(null, "gone", profiles)).toMatchObject({
      source: "setting",
      error: expect.stringContaining("no longer exists"),
    });
  });
});

describe("autostart settings", () => {
  it("reads the environment; unset or blank leaves it to the UI", () => {
    expect(readAutostartEnv({})).toBeNull();
    expect(readAutostartEnv({ [AUTOSTART_ENV]: "   " })).toBeNull();
    expect(readAutostartEnv({ [AUTOSTART_ENV]: " Public CTF " })).toBe("Public CTF");
  });

  it("is off by default and drops what is not a profile id", () => {
    expect(sanitizeStoredAutostart(undefined)).toEqual({ profileId: null });
    expect(sanitizeStoredAutostart({ profileId: 42 })).toEqual({ profileId: null });
    expect(sanitizeStoredAutostart({ profileId: "" })).toEqual({ profileId: null });
    expect(sanitizeStoredAutostart({ profileId: "x".repeat(101) })).toEqual({ profileId: null });
    expect(sanitizeStoredAutostart({ profileId: CTF.id })).toEqual({ profileId: CTF.id });
  });
});

describe("Autostart", () => {
  let events: ServerEvents;
  let auto: Autostart;
  let log: string[];
  let running: boolean;
  let blocked: string | null;
  let choice: AutostartChoice | null;
  let launchResults: ({ ok: true } | { ok: false; error: string })[];
  let relaunchOnCrash: boolean;
  let pid: number;
  let deps: AutostartDeps;

  const started = (reason: "autostart" | "relaunch" | "manual" | "schedule") => {
    running = true;
    events.emitEvent("server.started", { profileId: CTF.id, pid: ++pid, args: [], reason });
  };
  const down = (extra: Partial<ProcessDown> = {}): ProcessDown => ({
    crashed: true,
    stopReason: null,
    rotationOwned: false,
    code: 1,
    signal: null,
    ...extra,
  });
  const exit = (extra: Partial<ProcessDown> = {}) => {
    running = false;
    auto.processDown(down(extra));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    events = new ServerEvents();
    log = [];
    running = false;
    blocked = null;
    choice = { source: "env", profile: CTF };
    launchResults = [];
    relaunchOnCrash = true;
    pid = 100;
    deps = {
      choose: async () => choice,
      blockedBy: () => blocked ?? (running ? "a server is already running" : null),
      launch: async (profileId) => {
        log.push(`launch ${profileId}@${Date.now() / 1000}`);
        const result = launchResults.shift() ?? { ok: true };
        if (result.ok) started("autostart");
        return result;
      },
      supervisorRelaunches: (d) => d.stopReason === "hang" || relaunchOnCrash,
      relaunchPending: () => true,
      stopRelaunching: (reason) => log.push(`stopRelaunching: ${reason}`),
      notify: (m) => log.push(`notify: ${m}`),
      log: {
        info: (m) => log.push(`info ${m}`),
        warn: (m) => log.push(`warn ${m}`),
        error: (m) => log.push(`error ${m}`),
      },
    };
    auto = new Autostart(deps, { events });
  });

  afterEach(() => {
    auto.dispose();
    vi.useRealTimers();
  });

  const launches = () => log.filter((l) => l.startsWith("launch "));

  it("does nothing when no profile is set (the default)", async () => {
    choice = null;
    await auto.run();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(log).toEqual([]);
    expect(auto.snapshot()).toMatchObject({ state: "off", profileId: null, reason: null, failures: 0 });
  });

  it("launches the profile when nothing is running, and is done once it stays up", async () => {
    await auto.run();
    expect(launches()).toEqual(["launch id-ctf@0"]);
    expect(log).toContain('info [Autostart] Starting "Public CTF" (PYRODECK_AUTOSTART_PROFILE).');
    expect(auto.snapshot()).toMatchObject({
      state: "watching",
      profileId: CTF.id,
      profileName: "Public CTF",
      source: "env",
      watchUntil: new Date(AUTOSTART_QUICK_EXIT_MS).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(AUTOSTART_QUICK_EXIT_MS);
    expect(auto.snapshot()).toMatchObject({ state: "started", failures: 0, watchUntil: null });
    expect(log.at(-1)).toBe('info [Autostart] "Public CTF" is up (up for 60 s).');

    // Past the guard, a crash is the supervisor's alone.
    exit();
    expect(auto.snapshot().state).toBe("started");
    expect(log.filter((l) => l.startsWith("stopRelaunching"))).toEqual([]);
  });

  it("names the UI setting as the source when it chose the profile", async () => {
    choice = { source: "setting", profile: ANARCHY };
    await auto.run();
    expect(log).toContain('info [Autostart] Starting "Anarchy" (Start when Pyrodeck starts).');
    expect(auto.snapshot()).toMatchObject({ source: "setting", profileId: ANARCHY.id });
  });

  it("leaves a re-attached server alone: re-attach wins over autostart", async () => {
    running = true; // re-attach adopted the server before autostart ran
    blocked = "a server Pyrodeck launched before it restarted is running (PID 4242) and was re-attached";
    await auto.run();
    expect(launches()).toEqual([]);
    expect(auto.snapshot()).toMatchObject({ state: "skipped", reason: blocked, profileName: "Public CTF" });
    expect(log).toEqual([`info [Autostart] Not starting "Public CTF": ${blocked}.`]);
  });

  it("logs an unknown profile name as an error and starts nothing", async () => {
    choice = chooseAutostartProfile("Pubic CTF", null, [CTF, ANARCHY]);
    await expect(auto.run()).resolves.toBeUndefined();
    expect(launches()).toEqual([]);
    expect(auto.snapshot()).toMatchObject({ state: "error", source: "env" });
    expect(log).toEqual([
      `error [Autostart] Nothing started: ${AUTOSTART_ENV} names no profile: "Pubic CTF" (the profiles are "Public CTF", "Anarchy").`,
    ]);
  });

  it("survives a failure to read the profiles", async () => {
    deps.choose = async () => {
      throw new Error("EACCES: profiles.json");
    };
    await expect(auto.run()).resolves.toBeUndefined();
    expect(auto.snapshot()).toMatchObject({ state: "error", reason: "could not read the profiles: EACCES: profiles.json" });
  });

  it("runs once per Pyrodeck process", async () => {
    await auto.run();
    await auto.run();
    expect(launches()).toHaveLength(1);
  });

  describe("crash-loop guard", () => {
    it("retries a failed launch with backoff and gives up after five in a row", async () => {
      launchResults = Array.from({ length: 5 }, () => ({ ok: false as const, error: "Cannot read config file: /srv/d3/ctf.cfg" }));
      await auto.run();
      expect(auto.snapshot()).toMatchObject({
        state: "retrying",
        failures: 1,
        maxFailures: AUTOSTART_MAX_FAILURES,
        nextAttemptAt: new Date(5_000).toISOString(),
        reason: "the launch failed: Cannot read config file: /srv/d3/ctf.cfg",
      });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(launches()).toEqual(["launch id-ctf@0", "launch id-ctf@5", "launch id-ctf@15", "launch id-ctf@35", "launch id-ctf@75"]);
      expect(auto.snapshot()).toMatchObject({
        state: "failed",
        failures: 5,
        nextAttemptAt: null,
        reason: "5 failed starts in a row; the last: the launch failed: Cannot read config file: /srv/d3/ctf.cfg",
      });
      expect(log).toContain(
        'error [Autostart] Gave up on "Public CTF": 5 failed starts in a row; the last: the launch failed: Cannot read config file: /srv/d3/ctf.cfg.',
      );
      expect(log.filter((l) => l.startsWith("stopRelaunching"))).toHaveLength(1);
      expect(log.filter((l) => l.startsWith("notify"))).toHaveLength(1);
    });

    it("counts quick exits the supervisor relaunches, and gives up on the fifth", async () => {
      await auto.run();
      for (let i = 1; i <= 4; i++) {
        await vi.advanceTimersByTimeAsync(2_000);
        exit({ code: 139 });
        expect(auto.snapshot()).toMatchObject({ state: "relaunching", failures: i, relaunchPending: true });
        await vi.advanceTimersByTimeAsync(5_000);
        started("relaunch"); // the supervisor's relaunch
        expect(auto.snapshot().state).toBe("watching");
      }
      await vi.advanceTimersByTimeAsync(2_000);
      exit({ code: 139 });
      expect(auto.snapshot()).toMatchObject({
        state: "failed",
        failures: 5,
        reason: "5 failed starts in a row; the last: the server exited 2 s after starting (exit code 139)",
      });
      expect(log.filter((l) => l.startsWith("stopRelaunching"))).toEqual([
        'stopRelaunching: autostart of "Public CTF" stopped after 5 failed starts in a row; the last: the server exited 2 s after starting (exit code 139)',
      ]);
      expect(launches()).toHaveLength(1); // the relaunches were the supervisor's
    });

    it("ends the guard once a relaunched server stays up", async () => {
      await auto.run();
      exit({ signal: "SIGSEGV", code: null });
      started("relaunch");
      await vi.advanceTimersByTimeAsync(AUTOSTART_QUICK_EXIT_MS);
      expect(auto.snapshot()).toMatchObject({ state: "started", failures: 1, reason: "up for 60 s, after 1 failed start" });
    });

    it("counts a mix of failed launches and quick exits as one run of failures", async () => {
      launchResults = [{ ok: false, error: "Cannot run /srv/d3/Descent3: ENOENT" }];
      await auto.run();
      await vi.advanceTimersByTimeAsync(5_000); // second launch works
      expect(auto.snapshot()).toMatchObject({ state: "watching", failures: 1 });
      exit();
      expect(auto.snapshot()).toMatchObject({ state: "relaunching", failures: 2 });
      auto.relaunchFailed("Cannot run /srv/d3/Descent3: ENOENT");
      expect(auto.snapshot()).toMatchObject({ state: "relaunching", failures: 3, reason: "the relaunch failed: Cannot run /srv/d3/Descent3: ENOENT" });
    });

    it("counts a hang inside the window, which the supervisor always relaunches", async () => {
      relaunchOnCrash = false;
      await auto.run();
      exit({ crashed: false, stopReason: "hang", code: null, signal: "SIGKILL" });
      expect(auto.snapshot()).toMatchObject({ state: "relaunching", failures: 1 });
      expect(auto.snapshot().reason).toMatch(/stopped answering its console/);
    });

    it("stops at the first quick exit when the supervisor does not relaunch crashes", async () => {
      relaunchOnCrash = false;
      await auto.run();
      await vi.advanceTimersByTimeAsync(3_000);
      exit({ code: 1 });
      expect(auto.snapshot()).toMatchObject({
        state: "failed",
        failures: 1,
        reason: "the server exited 3 s after starting (exit code 1); relaunch on crash is off, so it stays down",
      });
      expect(log.filter((l) => l.startsWith("stopRelaunching"))).toEqual([]);
    });

    it("hands over to someone who starts the server during a retry wait", async () => {
      launchResults = [{ ok: false, error: "boom" }];
      await auto.run();
      started("manual");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(launches()).toHaveLength(1);
      expect(auto.snapshot()).toMatchObject({ state: "cancelled", reason: "the server was started by hand" });
    });

    it("hands over to someone who stops the server inside the window", async () => {
      await auto.run();
      exit({ crashed: false, stopReason: "manual", code: 0 });
      expect(auto.snapshot()).toMatchObject({ state: "cancelled", reason: "the server was stopped by hand" });
      await vi.advanceTimersByTimeAsync(AUTOSTART_QUICK_EXIT_MS);
      expect(auto.snapshot().state).toBe("cancelled");
    });

    it("cancels a pending retry on request", async () => {
      launchResults = [{ ok: false, error: "boom" }];
      await auto.run();
      expect(auto.cancelRetry()).toBe(true);
      expect(auto.cancelRetry()).toBe(false);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(launches()).toHaveLength(1);
      expect(auto.snapshot()).toMatchObject({ state: "cancelled", nextAttemptAt: null });
    });

    it("stops the real supervisor's relaunches when it trips", async () => {
      const sup = new Supervisor(
        {
          relaunch: async () => started("relaunch"),
          stop: async () => {},
          command: async () => "",
          isRunning: () => running,
          rotationPending: () => false,
          notify: (m) => log.push(`supervisor: ${m}`),
        },
        { events, emptyCheckMs: 3_600_000 },
      );
      deps.stopRelaunching = (reason) => sup.giveUp(reason);
      deps.relaunchPending = () => sup.snapshot().pendingRelaunch !== null;
      try {
        // As routes/launcher.ts does on every exit: the guard first, then the supervisor.
        const crash = () => {
          running = false;
          const d = down({ code: 1 });
          auto.processDown(d);
          sup.processDown(d);
        };
        await auto.run();
        for (let i = 0; i < 10 && auto.snapshot().state !== "failed"; i++) {
          await vi.advanceTimersByTimeAsync(1_000);
          crash();
          const pending = sup.snapshot().pendingRelaunch;
          if (pending) await vi.advanceTimersByTimeAsync(Date.parse(pending.at) - Date.now());
        }
        expect(auto.snapshot()).toMatchObject({ state: "failed", failures: 5 });
        expect(sup.snapshot().relaunchCount).toBe(4);
        expect(sup.snapshot().pendingRelaunch).toBeNull();
        expect(sup.snapshot().gaveUp?.reason).toMatch(/^autostart of "Public CTF" stopped after 5 failed starts in a row/);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(sup.snapshot().relaunchCount).toBe(4);
        expect(running).toBe(false);

        // A launch by hand starts the count over, as after the supervisor's own give-up.
        started("manual");
        expect(sup.snapshot().gaveUp).toBeNull();
      } finally {
        sup.dispose();
      }
    });
  });
});
