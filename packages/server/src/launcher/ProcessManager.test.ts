import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessManager } from "./ProcessManager.js";

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

  it("reports no log at all as state none", async () => {
    await launch(undefined);
    expect(pm.getStatus().log).toEqual({ path: null, state: "none", message: null });
  });
});
