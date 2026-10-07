import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUTOEXEC_FILE, ProcessManager, buildLaunchArgs } from "./ProcessManager.js";
import { ServerEvents } from "../events/ServerEvents.js";

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
