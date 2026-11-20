import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RUN_RECORD_FILE,
  clearRunRecord,
  decideAdopt,
  readLinuxIdentity,
  readProcessFacts,
  readRunRecord,
  writeRunRecord,
  type ProcessFacts,
  type RunRecord,
} from "./runRecord.js";

// A queued state write may still land while the temp directory is being removed (ENOTEMPTY): retry.
const RM_TEMP = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 } as const;

const record: RunRecord = {
  version: 1,
  pid: 4242,
  profileId: "p1",
  executablePath: "/games/d3/Descent3",
  gamePath: "/games/d3",
  configFile: "ctf.cfg",
  args: ["-dedicated", "./ctf.cfg"],
  logPath: "/games/d3/ctf-2026-10-07T20-00-00.log",
  telnetPort: 2105,
  startedAt: "2026-10-07T20:00:00.000Z",
  linux: { startTicks: "123456", bootId: "boot-a" },
};

const linuxFacts = (over: Partial<ProcessFacts> = {}): ProcessFacts => ({
  alive: true,
  cmdline: ["/games/d3/Descent3", "-dedicated", "./ctf.cfg"],
  linux: { startTicks: "123456", state: "S", bootId: "boot-a" },
  bootTimeMs: Date.parse("2026-10-01T00:00:00Z"),
  ...over,
});

describe("decideAdopt", () => {
  it("adopts the same process on Linux", () => {
    expect(decideAdopt(record, linuxFacts(), "linux")).toEqual({ adopt: true });
  });

  it("refuses a process that is gone", () => {
    expect(decideAdopt(record, linuxFacts({ alive: false }), "linux")).toEqual({
      adopt: false,
      reason: "process 4242 is no longer running",
    });
  });

  it("refuses a reused PID or a reboot", () => {
    const other = linuxFacts({ linux: { startTicks: "999", state: "S", bootId: "boot-a" } });
    expect(decideAdopt(record, other, "linux")).toEqual({ adopt: false, reason: "PID 4242 now belongs to another process" });
    const rebooted = linuxFacts({ linux: { startTicks: "123456", state: "S", bootId: "boot-b" } });
    expect(decideAdopt(record, rebooted, "linux")).toEqual({ adopt: false, reason: "the machine restarted since" });
  });

  it("refuses a process that is not the dedicated server", () => {
    expect(decideAdopt(record, linuxFacts({ cmdline: ["/usr/bin/vim", "notes"] }), "linux")).toMatchObject({
      adopt: false,
      reason: "process 4242 is /usr/bin/vim, not /games/d3/Descent3",
    });
    expect(decideAdopt(record, linuxFacts({ cmdline: ["/games/d3/Descent3"] }), "linux")).toMatchObject({
      adopt: false,
      reason: "process 4242 is not a dedicated server",
    });
  });

  it("refuses on Linux without a recorded identity", () => {
    const { linux: _, ...bare } = record;
    expect(decideAdopt(bare, linuxFacts(), "linux").adopt).toBe(false);
  });

  it("elsewhere, adopts a live PID started after the last boot (the console login is checked by the caller)", () => {
    const facts: ProcessFacts = { alive: true, cmdline: null, linux: null, bootTimeMs: Date.parse("2026-10-07T19:00:00Z") };
    expect(decideAdopt(record, facts, "win32")).toEqual({ adopt: true });
    const rebooted = { ...facts, bootTimeMs: Date.parse("2026-10-07T21:00:00Z") };
    expect(decideAdopt(record, rebooted, "win32")).toEqual({ adopt: false, reason: "the machine restarted since" });
  });
});

describe("run record file", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-run-"));
  });

  afterEach(async () => {
    await fs.rm(dir, RM_TEMP);
  });

  it("writes, reads and clears", async () => {
    expect(await readRunRecord(dir)).toBeNull();
    await writeRunRecord(dir, record);
    expect(await readRunRecord(dir)).toEqual(record);
    await clearRunRecord(dir);
    expect(await readRunRecord(dir)).toBeNull();
    await clearRunRecord(dir); // no file: fine
  });

  it("ignores a damaged file", async () => {
    await fs.writeFile(path.join(dir, RUN_RECORD_FILE), "{ not json");
    expect(await readRunRecord(dir)).toBeNull();
    await fs.writeFile(path.join(dir, RUN_RECORD_FILE), JSON.stringify({ ...record, pid: "4242" }));
    expect(await readRunRecord(dir)).toBeNull();
  });
});

describe.skipIf(process.platform !== "linux")("process facts on Linux", () => {
  it("reads this process's identity and command line", async () => {
    const id = await readLinuxIdentity(process.pid);
    expect(id?.startTicks).toMatch(/^\d+$/);
    expect(id?.bootId).toMatch(/^[0-9a-f-]{36}$/);
    const facts = await readProcessFacts(process.pid);
    expect(facts.alive).toBe(true);
    expect(facts.cmdline?.length).toBeGreaterThan(0);
    expect(facts.linux?.startTicks).toBe(id?.startTicks);
  });

  it("reports a PID nobody has as not alive", async () => {
    const facts = await readProcessFacts(2 ** 22 + 12345);
    expect(facts.alive).toBe(false);
    expect(facts.linux).toBeNull();
  });
});
