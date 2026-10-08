import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { AUTOEXEC_FILE, ProcessManager, buildLaunchArgs, survivableCommand, type LaunchConfig } from "./ProcessManager.js";
import { readProcessFacts } from "./runRecord.js";
import { sanitizeStoredLaunchOptions } from "./launchOptions.js";
import { AUTOEXEC_BLOCK_BEGIN, AUTOEXEC_BLOCK_END } from "./autoexecBlock.js";
import { ServerEvents, serverEvents, type ServerEventMap } from "../events/ServerEvents.js";

describe("buildLaunchArgs", () => {
  let dir: string;
  const config = (gamePath: string) => ({
    executablePath: "unused",
    gamePath,
    configFile: "server.cfg",
    telnetPort: 2092,
    telnetPassword: "x",
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-args-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("passes no -autoexec when the game directory has no Startup Commands file", async () => {
    expect(await buildLaunchArgs(config(dir))).toEqual({
      args: ["-dedicated", "./server.cfg"],
      warning: null,
    });
  });

  it("passes the Startup Commands file by absolute path when it exists", async () => {
    const gameDir = path.join(dir, "Descent 3"); // a space, as in a Windows install path
    await fs.mkdir(gameDir);
    await fs.writeFile(path.join(gameDir, AUTOEXEC_FILE), "$killmsgfilter simple\n");
    const { args, warning } = await buildLaunchArgs(config(gameDir));
    expect(args).toEqual(["-dedicated", "./server.cfg", "-autoexec", path.join(gameDir, AUTOEXEC_FILE)]);
    expect(path.isAbsolute(args[3])).toBe(true);
    expect(warning).toBeNull();
  });

  it("does not pass a path the engine would truncate, and says so", async () => {
    const gameDir = path.join(dir, "x".repeat(100));
    await fs.mkdir(gameDir);
    await fs.writeFile(path.join(gameDir, AUTOEXEC_FILE), "$killmsgfilter simple\n");
    const { args, warning } = await buildLaunchArgs(config(gameDir));
    expect(args).toEqual(["-dedicated", "./server.cfg"]);
    expect(warning).toMatch(/Startup Commands not applied/);
  });

  it.each([
    [{ bindIp: "192.168.0.103" }, ["-useip", "192.168.0.103"]],
    [{ gamePort: 2116 }, ["-useport", "2116"]],
    [{ frameCap: 30 }, ["-framecap", "30"]],
    [{ noMultiBmp: true }, ["-nomultibmp"]],
    [{ gameSpyPort: 20206 }, ["-gamespyport", "20206"]],
    [{ gameSpyFile: "pro-gamespy.cfg" }, ["-gspyfile", "pro-gamespy.cfg"]],
  ])("passes the launch option %o right after the config file", async (launchOptions, flags) => {
    const { args } = await buildLaunchArgs({ ...config(dir), launchOptions });
    expect(args).toEqual(["-dedicated", "./server.cfg", ...flags]);
  });

  it("passes no launch flags when the profile sets none", async () => {
    expect((await buildLaunchArgs({ ...config(dir), launchOptions: null })).args).toEqual(["-dedicated", "./server.cfg"]);
    expect((await buildLaunchArgs({ ...config(dir), launchOptions: {} })).args).toEqual(["-dedicated", "./server.cfg"]);
  });

  it("passes no flag for a stored option that no longer validates", async () => {
    for (const stored of [{ gamePort: 0 }, { frameCap: 0 }, { bindIp: "example.org" }, { gameSpyFile: "../x" }]) {
      const launchOptions = sanitizeStoredLaunchOptions(stored);
      expect((await buildLaunchArgs({ ...config(dir), launchOptions })).args).toEqual(["-dedicated", "./server.cfg"]);
    }
  });

  it("puts launch options before additional args and -autoexec", async () => {
    await fs.writeFile(path.join(dir, AUTOEXEC_FILE), "$killmsgfilter simple\n");
    const { args } = await buildLaunchArgs({
      ...config(dir),
      launchOptions: { gamePort: 2116, gameSpyPort: 20206 },
      additionalArgs: ["-useport", "9999"],
    });
    // FindArg takes the first match, so the profile's -useport wins.
    expect(args).toEqual([
      "-dedicated", "./server.cfg",
      "-useport", "2116", "-gamespyport", "20206",
      "-useport", "9999",
      "-autoexec", path.join(dir, AUTOEXEC_FILE),
    ]);
  });
});

// A stand-in for the D3 binary: ignores its arguments and prints a line every
// 50ms until killed. POSIX shell only; the launcher logic under test is the
// same on every platform.
const FAKE_SERVER = "#!/bin/sh\nwhile true; do echo tick; sleep 0.05; done\n";
const UNUSED_PORT = 1; // nothing listens; the telnet probe just keeps failing

describe.skipIf(process.platform === "win32")("ProcessManager log health", () => {
  let dir: string;
  let exe: string;
  let pm: ProcessManager;
  const warnings: string[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-pm-"));
    exe = path.join(dir, "fake-d3");
    await fs.writeFile(exe, FAKE_SERVER, { mode: 0o755 });
    warnings.length = 0;
    pm = new ProcessManager({ logCheckDelayMs: 150, logRecheckMs: 100 });
    pm.on("logWarning", (m: string) => warnings.push(m));
  });

  afterEach(async () => {
    await pm.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const launch = (logPath?: string) =>
    pm.start({
      executablePath: exe,
      gamePath: dir,
      configFile: "server.cfg",
      logPath,
      telnetPort: UNUSED_PORT,
      telnetPassword: "x",
    });

  it("marks a healthy log ok once it holds output", async () => {
    const logPath = path.join(dir, "ok.log");
    await launch(logPath);
    expect(pm.getStatus().log.state).toBe("pending");
    await expect.poll(() => pm.getStatus().log.state, { timeout: 3000 }).toBe("ok");
    expect(pm.getStatus().log.path).toBe(logPath);
    expect(await fs.readFile(logPath, "utf-8")).toContain("tick");
    expect(warnings).toEqual([]);
  });

  it("fails loudly and persistently when the log directory does not exist", async () => {
    await launch(path.join(dir, "missing-dir", "x.log"));
    await expect.poll(() => pm.getStatus().log.state, { timeout: 3000 }).toBe("failed");
    expect(pm.getStatus().log.message).toMatch(/NOT being saved/);
    expect(warnings).toHaveLength(1);
  });

  it("reports a log deleted while the server runs", async () => {
    const logPath = path.join(dir, "gone.log");
    await launch(logPath);
    await expect.poll(() => pm.getStatus().log.state, { timeout: 3000 }).toBe("ok");
    await fs.unlink(logPath);
    await expect.poll(() => pm.getStatus().log.state, { timeout: 3000 }).toBe("failed");
    expect(pm.getStatus().log.message).toMatch(/deleted or moved/);
    expect(warnings).toHaveLength(1);
  });

  it("records the -autoexec argument in the log header when Startup Commands exist", async () => {
    await fs.writeFile(path.join(dir, AUTOEXEC_FILE), "$killmsgfilter simple\n");
    const logPath = path.join(dir, "args.log");
    await launch(logPath);
    await expect
      .poll(() => fs.readFile(logPath, "utf-8"), { timeout: 3000 })
      .toContain(`Args: -dedicated ./server.cfg -autoexec ${path.join(dir, AUTOEXEC_FILE)}\n`);
  });

  it("writes the profile's block into a new Startup Commands file and passes it", async () => {
    const logPath = path.join(dir, "block.log");
    await pm.start({
      executablePath: exe,
      gamePath: dir,
      configFile: "server.cfg",
      logPath,
      telnetPort: UNUSED_PORT,
      telnetPassword: "x",
      autoexecBlock: ["$allowteamchange on", "$setteamname 0 Crimson"],
    });
    expect(await fs.readFile(path.join(dir, AUTOEXEC_FILE), "utf-8")).toBe(
      [AUTOEXEC_BLOCK_BEGIN, "$allowteamchange on", "$setteamname 0 Crimson", AUTOEXEC_BLOCK_END, ""].join("\n"),
    );
    await expect
      .poll(() => fs.readFile(logPath, "utf-8"), { timeout: 3000 })
      .toContain(`-autoexec ${path.join(dir, AUTOEXEC_FILE)}\n`);
  });

  it("reports the launch options in server.started's args, with the start reason", async () => {
    const seen: ServerEventMap["server.started"][] = [];
    const listener = (e: ServerEventMap["server.started"]) => seen.push(e);
    serverEvents.onEvent("server.started", listener);
    try {
      await pm.start(
        {
          executablePath: exe,
          gamePath: dir,
          configFile: "server.cfg",
          telnetPort: UNUSED_PORT,
          telnetPassword: "x",
          profileId: "p1",
          launchOptions: { gamePort: 2116 },
        },
        "playlist",
      );
      expect(seen).toEqual([
        {
          profileId: "p1",
          pid: pm.getStatus().pid,
          args: ["-dedicated", "./server.cfg", "-useport", "2116"],
          reason: "playlist",
        },
      ]);
    } finally {
      serverEvents.offEvent("server.started", listener);
    }
  });

  it("reports no log at all as state none", async () => {
    await launch(undefined);
    expect(pm.getStatus().log).toEqual({ path: null, state: "none", message: null });
  });
});

describe.skipIf(process.platform === "win32")("ProcessManager server events", () => {
  let dir: string;
  let exe: string;
  let pm: ProcessManager;
  let events: ServerEvents;
  let seen: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-pm-ev-"));
    exe = path.join(dir, "fake-d3");
    await fs.writeFile(exe, FAKE_SERVER, { mode: 0o755 });
    events = new ServerEvents();
    seen = [];
    events.onEvent("server.started", (p) => seen.push(`started ${p.profileId} ${p.reason} ${p.args.join(" ")}`));
    events.onEvent("server.stopped", (p) => seen.push(`stopped ${p.reason}${p.via ? ` via ${p.via}` : ""}`));
    events.onEvent("server.crashed", (p) => seen.push(`crashed ${p.signal}`));
    pm = new ProcessManager({ events });
  });

  afterEach(async () => {
    await pm.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const launch = (reason?: Parameters<ProcessManager["start"]>[1]) =>
    pm.start(
      {
        executablePath: exe,
        gamePath: dir,
        configFile: "server.cfg",
        telnetPort: UNUSED_PORT,
        telnetPassword: "x",
        profileId: "p1",
      },
      reason,
    );

  it("reports a start and a requested stop with their reasons", async () => {
    await launch("schedule");
    await pm.stop("schedule");
    expect(pm.getStatus().state).toBe("stopped");
    expect(seen).toEqual(["started p1 schedule -dedicated ./server.cfg", "stopped schedule"]);
  });

  it("reports a kill from outside as a crash", async () => {
    await launch();
    process.kill(pm.getStatus().pid!, "SIGKILL");
    await expect.poll(() => pm.getStatus().state, { timeout: 3000 }).toBe("crashed");
    expect(seen).toEqual(["started p1 manual -dedicated ./server.cfg", "crashed SIGKILL"]);
  });

  it("reports an exit right after a console quit as a stop, not a crash", async () => {
    await launch();
    pm.noteConsoleQuit();
    process.kill(pm.getStatus().pid!, "SIGTERM");
    await expect.poll(() => pm.getStatus().state, { timeout: 3000 }).toBe("stopped");
    expect(seen[1]).toBe("stopped manual via console");
  });

  it("emits nothing for the kill after a hang (the supervisor reported it)", async () => {
    await launch("relaunch");
    await pm.stop("hang", { kill: true });
    expect(pm.getStatus().state).toBe("stopped");
    expect(pm.getStatus().exitSignal).toBe("SIGKILL");
    expect(seen).toEqual(["started p1 relaunch -dedicated ./server.cfg"]);
  });
});

describe.skipIf(process.platform === "win32")("ProcessManager game environment", () => {
  let dir: string;
  let pm: ProcessManager;
  const saved: Record<string, string | undefined> = {};
  const SET = {
    PYRODECK_ADMIN_PASSWORD: "hunter2",
    PYRODECK_SESSION_SECRET: "s3cret",
    PYRODECK_AUTOSTART_PROFILE: "Public CTF",
    DATABASE_URL: "postgres://u:p@db/x",
    LC_TIME: "de_DE.UTF-8",
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-pm-env-"));
    for (const [k, v] of Object.entries(SET)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    pm = new ProcessManager({ events: new ServerEvents() });
  });

  afterEach(async () => {
    await pm.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("starts the game without Pyrodeck's secrets and with what it needs", async () => {
    // A stand-in game that writes the environment it was given, then waits.
    const exe = path.join(dir, "fake-d3");
    const dump = path.join(dir, "env.txt");
    await fs.writeFile(exe, `#!/bin/sh\nenv > "${dump}.tmp" && mv "${dump}.tmp" "${dump}"\nwhile true; do sleep 0.05; done\n`, {
      mode: 0o755,
    });
    await pm.start({ executablePath: exe, gamePath: dir, configFile: "server.cfg", telnetPort: UNUSED_PORT, telnetPassword: "x" });
    await expect.poll(() => fs.access(dump).then(() => true, () => false), { timeout: 3000 }).toBe(true);
    const env = Object.fromEntries(
      (await fs.readFile(dump, "utf-8"))
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(Object.keys(env).filter((k) => k.startsWith("PYRODECK_"))).toEqual([]);
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.LC_TIME).toBe("de_DE.UTF-8");
    expect(env.SDL_VIDEODRIVER).toBe(process.env.SDL_VIDEODRIVER ?? "dummy");
  });
});

describe.skipIf(process.platform === "win32")("ProcessManager re-attach", () => {
  let dir: string;
  let exe: string;
  let pm: ProcessManager;
  let events: ServerEvents;
  let seen: string[];
  let outside: ChildProcess | null;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-pm-adopt-"));
    exe = path.join(dir, "fake-d3");
    await fs.writeFile(exe, FAKE_SERVER, { mode: 0o755 });
    events = new ServerEvents();
    seen = [];
    events.onEvent("server.adopted", (p) => seen.push(`adopted ${p.profileId} ${p.pid}`));
    events.onEvent("server.stopped", (p) => seen.push(`stopped ${p.reason}`));
    events.onEvent("server.crashed", (p) => seen.push(`crashed ${p.code} ${p.signal}`));
    pm = new ProcessManager({ events });
    outside = null;
  });

  afterEach(async () => {
    await pm.stop();
    if (outside?.pid) {
      try {
        process.kill(outside.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A server some earlier Pyrodeck started: not this ProcessManager's child. */
  const adoptOutsideServer = (extra: Partial<LaunchConfig> = {}) => {
    outside = spawn(exe, [], { stdio: "ignore", detached: true });
    const pid = outside.pid!;
    pm.adopt({
      pid,
      startedAt: new Date(Date.now() - 60_000),
      args: ["-dedicated", "./server.cfg"],
      config: {
        executablePath: exe,
        gamePath: dir,
        configFile: "server.cfg",
        telnetPort: UNUSED_PORT,
        telnetPassword: "x",
        profileId: "p1",
        ...extra,
      },
      isAlive: async () => (await readProcessFacts(pid)).alive,
    });
    return pid;
  };

  it("shows a re-attached server as running and stops it on request", async () => {
    const pid = adoptOutsideServer();
    expect(pm.getStatus()).toMatchObject({ state: "running", pid, adopted: true, activeProfileId: "p1" });
    expect(pm.isRunning()).toBe(true);
    await pm.stop("manual");
    expect(pm.getStatus()).toMatchObject({ state: "stopped", pid: null, stopReason: "manual" });
    expect((await readProcessFacts(pid)).alive).toBe(false);
    expect(seen).toEqual([`adopted p1 ${pid}`, "stopped manual"]);
  });

  it("notices a re-attached server that dies, as a crash", async () => {
    const pid = adoptOutsideServer();
    process.kill(pid, "SIGKILL");
    await expect.poll(() => pm.getStatus().state, { timeout: 4000 }).toBe("crashed");
    expect(seen).toEqual([`adopted p1 ${pid}`, "crashed null null"]);
  });

  it("asks the console to log in once re-attached", async () => {
    const ready = new Promise<number>((resolve) => pm.once("telnetReady", resolve));
    adoptOutsideServer();
    expect(await ready).toBe(UNUSED_PORT);
  });

  it("logs in to an AllowRemoteConsole=0 console on 127.0.0.1, whatever -useip says", async () => {
    const ready = new Promise<string>((resolve) => pm.once("telnetReady", (_port: number, host: string) => resolve(host)));
    adoptOutsideServer({ launchOptions: { bindIp: "203.0.113.7" }, allowRemoteConsole: false });
    expect(pm.consoleHost()).toBe("127.0.0.1");
    expect(await ready).toBe("127.0.0.1");
  });

  it("logs in to an AllowRemoteConsole=1 console at its -useip address (also when the setting is unrecorded)", async () => {
    adoptOutsideServer({ launchOptions: { bindIp: "203.0.113.7" }, allowRemoteConsole: true });
    expect(pm.consoleHost()).toBe("203.0.113.7");
    await pm.stop();
    adoptOutsideServer({ launchOptions: { bindIp: "203.0.113.7" } });
    expect(pm.consoleHost()).toBe("203.0.113.7");
  });
});

describe.skipIf(process.platform === "win32")("ProcessManager launch survives Pyrodeck", () => {
  it("keeps the server alive when nothing reads its output any more", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-pm-pipe-"));
    const exe = path.join(dir, "fake-d3");
    await fs.writeFile(exe, FAKE_SERVER, { mode: 0o755 });
    const pm = new ProcessManager({ events: new ServerEvents() });
    try {
      await pm.start({ executablePath: exe, gamePath: dir, configFile: "s.cfg", telnetPort: UNUSED_PORT, telnetPassword: "x" });
      const pid = pm.getStatus().pid!;
      // What Pyrodeck exiting does to the server: the read ends of its pipes close.
      const child = (pm as unknown as { child: ChildProcess }).child;
      child.stdout?.destroy();
      child.stderr?.destroy();
      // The fake server writes every 50 ms; without SIGPIPE ignored it dies on the first one.
      await new Promise((r) => setTimeout(r, 500));
      expect((await readProcessFacts(pid)).alive).toBe(true);
      expect(survivableCommand(exe, ["-dedicated"]).args.slice(2)).toEqual([exe, "-dedicated"]);
    } finally {
      await pm.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start an executable that is not there", async () => {
    const pm = new ProcessManager({ events: new ServerEvents() });
    await expect(
      pm.start({ executablePath: "/nonexistent/Descent3", gamePath: "/", configFile: "s.cfg", telnetPort: UNUSED_PORT, telnetPassword: "x" }),
    ).rejects.toThrow(/Cannot run \/nonexistent\/Descent3/);
    expect(pm.getStatus().state).toBe("stopped");
  });
});
