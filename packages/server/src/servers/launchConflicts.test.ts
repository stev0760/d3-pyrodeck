import { describe, it, expect } from "vitest";
import path from "node:path";
import { checkLaunch, defaultTempDir, type OtherLaunch } from "./launchConflicts.js";
import type { LaunchConfig } from "../launcher/ProcessManager.js";
import { ScopedServerEvents, ServerEvents } from "../events/ServerEvents.js";

const base: LaunchConfig = {
  executablePath: "/srv/d3/Descent3",
  gamePath: "/srv/d3",
  configFile: "a.cfg",
  logPath: "/srv/d3/a-2026-11-15T10-00-00.log",
  telnetPort: 2601,
  telnetPassword: "x",
};

function other(launch: Partial<LaunchConfig>, startupFileUsed = false): OtherLaunch {
  return {
    name: "Other",
    launch: { ...base, configFile: "b.cfg", telnetPort: 2602, logPath: "/srv/d3/b.log", ...launch },
    pid: 77,
    why: "running",
    startupFileUsed,
  };
}

const check = (launch: Partial<LaunchConfig>, others: OtherLaunch[], startupFileUsed = false) =>
  checkLaunch({ name: "Mine", launch: { ...base, ...launch }, startupFileUsed, defaultTempDir: "/tmp/pyrodeck-mine", others });

describe("checkLaunch", () => {
  it("adds the server's temp directory and leaves an operator's alone", () => {
    expect(check({}, [])).toMatchObject({ ok: true, launch: { defaultOptions: { tempDir: "/tmp/pyrodeck-mine" } } });
    const own = check({ launchOptions: { tempDir: "/var/d3tmp" } }, []);
    expect(own.ok && own.launch.defaultOptions).toBeNull();
  });

  it("moves the default GameSpy port to a free one, and refuses one the operator set", () => {
    const held = [other({ launchOptions: { gamePort: 2093 } })]; // holds GameSpy 20142
    const moved = check({ launchOptions: { gamePort: 2092 } }, held);
    expect(moved.ok && moved.launch.defaultOptions?.gameSpyPort).toBe(20143);
    const refused = check({ launchOptions: { gamePort: 2092, gameSpyPort: 20142 } }, held);
    expect(refused).toMatchObject({ ok: false });
    expect(!refused.ok && refused.error).toMatch(/GameSpy port 20142\/udp is used by "Other" \(running, PID 77\)/);
    // The next free one skips the server's own game port and the others' ports.
    const crowded = [other({ launchOptions: { gamePort: 20143 } }), other({ launchOptions: { gamePort: 2095, gameSpyPort: 20145 } })];
    const picked = check({ launchOptions: { gamePort: 20144 } }, crowded);
    expect(picked.ok && picked.launch.defaultOptions?.gameSpyPort).toBe(20146);
  });

  it("refuses a game port another server holds as its game or GameSpy port, unless the bind addresses differ", () => {
    expect(check({ launchOptions: { gamePort: 2093 } }, [other({ launchOptions: { gamePort: 2093 } })]).ok).toBe(false);
    expect(check({ launchOptions: { gamePort: 20142 } }, [other({ launchOptions: { gamePort: 2093 } })]).ok).toBe(false);
    expect(
      check({ launchOptions: { gamePort: 2093, bindIp: "10.0.0.1" } }, [other({ launchOptions: { gamePort: 2093, bindIp: "10.0.0.2" } })]).ok,
    ).toBe(true);
    expect(check({ launchOptions: { gamePort: 2093, bindIp: "10.0.0.1" } }, [other({ launchOptions: { gamePort: 2093 } })]).ok).toBe(
      false,
    );
  });

  it("refuses the same console port, config file, or a Startup Commands file in use", () => {
    expect(check({}, [other({ telnetPort: 2601, launchOptions: { gamePort: 2099 } })])).toMatchObject({ ok: false });
    const sameCfg = check({ launchOptions: { gamePort: 2092 } }, [other({ configFile: "a.cfg", launchOptions: { gamePort: 2099 } })]);
    expect(!sameCfg.ok && sameCfg.error).toMatch(/server config \/srv\/d3\/a\.cfg/);
    const unused = check({ launchOptions: { gamePort: 2092 } }, [other({ launchOptions: { gamePort: 2099 } })]);
    expect(unused.ok).toBe(true);
    const used = check({ launchOptions: { gamePort: 2092 } }, [other({ launchOptions: { gamePort: 2099 } }, true)]);
    expect(!used.ok && used.error).toMatch(/Startup Commands file \/srv\/d3\/autoexec\.dmfc/);
    const own = check({ launchOptions: { gamePort: 2092 }, startupFile: "a.dmfc" }, [other({ launchOptions: { gamePort: 2099 } }, true)]);
    expect(own.ok).toBe(true);
  });

  it("gives a log of the same name a suffix", () => {
    const sameLog = check({ launchOptions: { gamePort: 2092 } }, [other({ logPath: base.logPath, launchOptions: { gamePort: 2099 } })]);
    expect(sameLog.ok && sameLog.launch.logPath).toBe("/srv/d3/a-2026-11-15T10-00-00-2.log");
  });

  it("names every clash at once", () => {
    const r = check({}, [other({ telnetPort: 2601, configFile: "a.cfg" })]);
    expect(!r.ok && r.error.match(/Cannot start "Mine"/g)).toHaveLength(3);
  });
});

describe("defaultTempDir", () => {
  it("is short, stable, and differs per server and per config directory", () => {
    const a = defaultTempDir("/etc/pyrodeck", "p1", "/tmp");
    expect(a).toBe(defaultTempDir("/etc/pyrodeck", "p1", "/tmp"));
    expect(a).not.toBe(defaultTempDir("/etc/pyrodeck", "p2", "/tmp"));
    expect(a).not.toBe(defaultTempDir("/home/x/pyrodeck", "p1", "/tmp"));
    expect(path.dirname(a)).toBe("/tmp");
    expect(path.basename(a)).toMatch(/^pyrodeck-[0-9a-f]{12}$/);
  });

  it("falls back to /tmp when the system temp directory's path is too long", () => {
    const long = `/var/${"x".repeat(95)}`;
    const dir = defaultTempDir("/etc/pyrodeck", "p1", long);
    expect(dir.startsWith("/tmp/pyrodeck-")).toBe(true);
    expect(Buffer.byteLength(dir)).toBeLessThanOrEqual(99);
  });
});

describe("scopedEvents", () => {
  it("hears only its server's events, and sends what it emits through the shared bus", () => {
    const bus = new ServerEvents();
    const a = new ScopedServerEvents(bus, "a");
    const b = new ScopedServerEvents(bus, "b");
    const heard: string[] = [];
    bus.onEvent("player.joined", (p) => heard.push(`bus ${p.profileId} ${p.name}`));
    a.onEvent("player.joined", (p) => heard.push(`a ${p.name}`));
    b.onEvent("player.joined", (p) => heard.push(`b ${p.name}`));

    bus.emitEvent("player.joined", { profileId: "a", name: "One" });
    b.emitEvent("player.joined", { profileId: "b", name: "Two" });
    bus.emitEvent("player.joined", { profileId: "connect:x:1", name: "Three" });
    expect(heard).toEqual(["a One", "bus a One", "b Two", "bus b Two", "bus connect:x:1 Three"]);

    a.dispose();
    bus.emitEvent("player.joined", { profileId: "a", name: "Four" });
    expect(heard.at(-1)).toBe("bus a Four");
  });
});
