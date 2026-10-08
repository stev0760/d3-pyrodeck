import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServerEvents } from "../events/ServerEvents.js";
import { Supervisor, type ProcessDown, type SupervisorActions } from "./Supervisor.js";
import { DEFAULT_SUPERVISOR_SETTINGS } from "./supervisorSettings.js";

const H = 3_600_000;

describe("Supervisor", () => {
  let events: ServerEvents;
  let sup: Supervisor;
  let log: string[];
  let running: boolean;
  let rotation: boolean;
  let reply: () => Promise<string>;
  let pid: number;

  const crash = (extra: Partial<ProcessDown> = {}) => {
    running = false;
    sup.processDown({ crashed: true, stopReason: null, rotationOwned: false, code: null, signal: "SIGKILL", ...extra });
  };
  const stopped = (stopReason: ProcessDown["stopReason"]) => {
    running = false;
    sup.processDown({ crashed: false, stopReason, rotationOwned: false, code: 0, signal: null });
  };
  const start = (reason: "manual" | "relaunch" | "autostart" = "manual") => {
    running = true;
    events.emitEvent("server.started", { profileId: "p1", pid: ++pid, args: [], reason });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    events = new ServerEvents();
    log = [];
    running = false;
    rotation = false;
    pid = 100;
    reply = () => new Promise(() => {}); // a hung server never answers
    const actions: SupervisorActions = {
      relaunch: async () => {
        log.push(`relaunch@${Date.now() / 1000}`);
        start("relaunch");
      },
      stop: async (reason, options) => {
        log.push(`stop ${reason}${options?.kill ? " kill" : ""}`);
      },
      command: async (cmd) => {
        log.push(`cmd ${cmd}`);
        return reply();
      },
      isRunning: () => running,
      rotationPending: () => rotation,
      notify: (message, level) => log.push(`${level}: ${message}`),
    };
    sup = new Supervisor(actions, { events, emptyCheckMs: 10 * H });
    events.onEvent("server.hung", (p) => log.push(`hung pid ${p.pid} ${p.silentForMs / 1000}s`));
  });

  afterEach(() => {
    sup.dispose();
    vi.useRealTimers();
  });

  describe("relaunch after a crash", () => {
    it("relaunches after 5 s", async () => {
      start();
      crash();
      expect(sup.snapshot().pendingRelaunch).toEqual({ at: new Date(5000).toISOString(), cause: "crash" });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(log.filter((l) => l.startsWith("relaunch"))).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(log).toEqual(["error: The server crashed; relaunching in 5 s.", "relaunch@5"]);
      expect(sup.snapshot()).toMatchObject({ relaunchCount: 1, pendingRelaunch: null, recentFailures: 1 });
      expect(sup.snapshot().lastCrash).toMatchObject({ signal: "SIGKILL" });
    });

    it("leaves a server stopped on request alone", async () => {
      for (const reason of ["manual", "playlist", "schedule", "console"] as const) {
        start();
        stopped(reason);
      }
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(log).toEqual([]);
    });

    it("leaves a crash during a playlist restart to the rotation", async () => {
      start();
      crash({ rotationOwned: true });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(log).toEqual([]);
      expect(sup.snapshot().lastCrash).not.toBeNull();
    });

    it("does nothing when relaunch is off", async () => {
      sup.applySettings({ ...DEFAULT_SUPERVISOR_SETTINGS, relaunchOnCrash: false });
      start();
      crash();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(log).toEqual([]);
    });

    it("backs off on repeated crashes and gives up, until someone launches it", async () => {
      start();
      const waits: number[] = [];
      for (let i = 0; i < 7; i++) {
        const before = Date.now();
        crash();
        const pending = sup.snapshot().pendingRelaunch;
        if (!pending) break;
        waits.push((Date.parse(pending.at) - before) / 1000);
        await vi.advanceTimersByTimeAsync(Date.parse(pending.at) - before);
      }
      expect(waits).toEqual([5, 10, 20, 40, 80, 120]);
      expect(sup.snapshot().gaveUp?.reason).toBe("the server went down 7 times in 30 minutes");
      expect(log.at(-1)).toMatch(/^error: Supervisor gave up/);
      expect(sup.snapshot().relaunchCount).toBe(6);

      start("manual");
      expect(sup.snapshot()).toMatchObject({ gaveUp: null, recentFailures: 0 });
    });

    it("gives up on another part's verdict (autostart's guard) until someone launches it", async () => {
      start();
      crash();
      expect(sup.snapshot().pendingRelaunch).not.toBeNull();
      sup.giveUp("autostart gave up");
      expect(sup.snapshot()).toMatchObject({ pendingRelaunch: null, gaveUp: { reason: "autostart gave up" } });
      // Nothing it would otherwise relaunch is relaunched.
      start("relaunch");
      crash();
      stopped("hang");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(log.filter((l) => l.startsWith("relaunch@"))).toEqual([]);
      expect(sup.snapshot().pendingRelaunch).toBeNull();

      start("autostart");
      expect(sup.snapshot().gaveUp).toBeNull();
      crash();
      expect(sup.snapshot().pendingRelaunch).not.toBeNull();
    });

    it("a launch by hand cancels the pending relaunch", async () => {
      start();
      crash();
      start("manual");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(log.filter((l) => l.startsWith("relaunch"))).toEqual([]);
    });

    it("the operator can cancel a pending relaunch", async () => {
      start();
      crash();
      expect(sup.cancelRelaunch()).toBe(true);
      expect(sup.cancelRelaunch()).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(log.filter((l) => l.startsWith("relaunch"))).toEqual([]);
    });

    it("a relaunch that cannot spawn is retried with backoff", async () => {
      let fail = true;
      const actions = (sup as unknown as { actions: SupervisorActions }).actions;
      const original = actions.relaunch;
      actions.relaunch = async () => {
        if (fail) throw new Error("spawn ENOENT");
        return original();
      };
      start();
      crash();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(log).toContain("error: Relaunch failed: spawn ENOENT");
      expect(sup.snapshot().pendingRelaunch?.cause).toBe("crash");
      fail = false;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sup.snapshot().relaunchCount).toBe(1);
    });
  });

  describe("hang", () => {
    it("probes a quiet console, then kills and relaunches the server", async () => {
      start();
      sup.consoleReady();
      expect(log).toEqual(["cmd $players"]); // roster read at login
      await vi.advanceTimersByTimeAsync(59_000);
      expect(log).toEqual(["cmd $players", "cmd $players"]);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(log.slice(2)).toEqual([
        "hung pid 101 120s",
        "error: The server's console has been silent for 120 s and did not answer $players; killing it.",
        "stop hang kill",
      ]);
      expect(sup.snapshot().lastHang).toMatchObject({ silentForMs: 120_000 });
      stopped("hang");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(log.at(-1)).toBe("relaunch@125");
    });

    it("a server that answers is left running", async () => {
      reply = async () => "PNum Name\n00: Server\n";
      start();
      sup.consoleReady();
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(60_000);
        sup.consoleActivity(); // the reply arrived on the console
      }
      expect(log.filter((l) => !l.startsWith("cmd"))).toEqual([]);
      expect(sup.snapshot().hang.state).toBe("listening");
    });

    it("is not watched when the hang check is off", async () => {
      sup.applySettings({ ...DEFAULT_SUPERVISOR_SETTINGS, hangCheck: false });
      start();
      sup.consoleReady();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(log).toEqual(["cmd $players"]);
      expect(sup.snapshot().hang.state).toBe("off");
    });
  });

  describe("restart when empty", () => {
    beforeEach(() => {
      sup.applySettings({ ...DEFAULT_SUPERVISOR_SETTINGS, hangCheck: false, emptyRestart: true, emptyRestartAfterHours: 1 });
    });

    it("waits for the limit, the last player to leave, and the grace period", async () => {
      reply = async () => "PNum Name\n00: Server\n01: Phantom[BOT]\n";
      start();
      vi.setSystemTime(30 * 60_000);
      events.emitEvent("player.joined", { profileId: "p1", name: "Hunter" });
      vi.setSystemTime(H + 60_000);
      await sup.checkEmptyRestart();
      expect(sup.snapshot().emptyRestart).toBe("1 player on");
      events.emitEvent("player.left", { profileId: "p1", name: "Hunter" });
      vi.setSystemTime(H + 60_000 + 129_000);
      await sup.checkEmptyRestart();
      expect(sup.snapshot().emptyRestart).toBe("last player left 129 s ago; waits 130 s");
      expect(log).toEqual([]);

      vi.setSystemTime(H + 60_000 + 130_000);
      await sup.checkEmptyRestart();
      expect(log).toEqual([
        "cmd $players",
        "info: Restarting the empty server: up 63 min and empty for 130 s.",
        "stop empty-restart",
      ]);

      stopped("empty-restart");
      await vi.advanceTimersByTimeAsync(0);
      expect(log.at(-1)).toMatch(/^relaunch@/);
      expect(sup.snapshot().recentFailures).toBe(0);
    });

    it("counts a player once however often the join line repeats (every level start)", async () => {
      reply = async () => "PNum Name\n00: Server\n";
      start();
      for (let level = 0; level < 3; level++) {
        events.emitEvent("level.started", { profileId: "p1", level: `L${level}` });
        events.emitEvent("player.joined", { profileId: "p1", name: "Hunter", bot: false });
      }
      expect(sup.snapshot().humans).toBe(1);
      events.emitEvent("player.left", { profileId: "p1", name: "Hunter", bot: false, reason: "left the game" });
      expect(sup.snapshot().humans).toBe(0);
      expect(sup.snapshot().emptySince).not.toBeNull();
    });

    it("bots do not count as players", async () => {
      reply = async () => "PNum Name\n00: Server\n01: Phantom[BOT]\n02: Reaper[BOT]\n";
      start();
      events.emitEvent("player.joined", { profileId: "p1", name: "Phantom[BOT]" });
      vi.setSystemTime(2 * H);
      await sup.checkEmptyRestart();
      expect(log).toContain("stop empty-restart");
    });

    it("does not restart when $players shows a human the join lines missed", async () => {
      reply = async () => "PNum Name\n00: Server\n01: Hunter\n";
      start();
      vi.setSystemTime(2 * H);
      await sup.checkEmptyRestart();
      expect(log).toEqual(["cmd $players"]);
      expect(sup.snapshot()).toMatchObject({ humans: 1, emptyRestart: "1 player on" });
    });

    it("does not restart when it cannot confirm", async () => {
      reply = async () => "";
      start();
      vi.setSystemTime(2 * H);
      await sup.checkEmptyRestart();
      expect(log).toEqual(["cmd $players"]);
      expect(sup.snapshot().emptyRestart).toBe("could not read $players; not restarting");
    });

    it("does not restart during a playlist restart", async () => {
      start();
      rotation = true;
      vi.setSystemTime(2 * H);
      await sup.checkEmptyRestart();
      expect(log).toEqual([]);
    });

    it("a re-attached server waits until it has read who is on", async () => {
      reply = async () => "PNum Name\n00: Server\n";
      running = true;
      sup.processAdopted("p1", 4242, -3 * H);
      await sup.checkEmptyRestart();
      expect(sup.snapshot()).toMatchObject({ adopted: true, humans: null, emptyRestart: "waiting to read who is on the server" });
      sup.consoleReady(); // reads $players: nobody; empty from now
      await vi.advanceTimersByTimeAsync(0);
      expect(sup.snapshot().humans).toBe(0);
      vi.setSystemTime(130_000);
      await sup.checkEmptyRestart();
      expect(log).toContain("stop empty-restart");
    });
  });
});
