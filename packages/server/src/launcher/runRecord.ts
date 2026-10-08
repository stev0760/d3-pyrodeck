import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The running server, kept on disk so that Pyrodeck can re-attach to it after
 * Pyrodeck itself restarts (D3Server3 keeps its servers' process IDs the same
 * way). Written when a process starts, removed when it stops. The console
 * password is not stored: it is read from the config file again.
 */
export interface RunRecord {
  version: 1;
  pid: number;
  profileId: string | null;
  executablePath: string;
  gamePath: string;
  configFile: string;
  args: string[];
  logPath: string | null;
  telnetPort: number;
  /** ISO time Pyrodeck spawned the process. */
  startedAt: string;
  /**
   * Linux: what makes the process unique across PID reuse and reboots, the
   * start time in clock ticks since boot (/proc/<pid>/stat field 22) and the
   * kernel's boot ID.
   */
  linux?: { startTicks: string; bootId: string };
}

export const RUN_RECORD_FILE = "running-server.json";

export async function writeRunRecord(dir: string, record: RunRecord): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, RUN_RECORD_FILE);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(record, null, 2));
  await fs.rename(`${file}.tmp`, file);
}

export async function clearRunRecord(dir: string): Promise<void> {
  await fs.rm(path.join(dir, RUN_RECORD_FILE), { force: true });
}

/** The saved record, or null when there is none or it is not one. */
export async function readRunRecord(dir: string): Promise<RunRecord | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path.join(dir, RUN_RECORD_FILE), "utf-8"));
  } catch {
    return null;
  }
  const r = raw as Partial<RunRecord>;
  const ok =
    r?.version === 1 &&
    Number.isInteger(r.pid) &&
    (r.pid ?? 0) > 0 &&
    typeof r.executablePath === "string" &&
    typeof r.gamePath === "string" &&
    typeof r.configFile === "string" &&
    Array.isArray(r.args) &&
    Number.isInteger(r.telnetPort) &&
    typeof r.startedAt === "string" &&
    !Number.isNaN(Date.parse(r.startedAt));
  return ok ? (r as RunRecord) : null;
}

export interface LinuxIdentity {
  startTicks: string;
  /** Process state letter from /proc/<pid>/stat ("Z" = exited, not reaped yet). */
  state: string;
  bootId: string;
}

/** The process's identity on Linux, or null when /proc has no such process. */
export async function readLinuxIdentity(pid: number): Promise<LinuxIdentity | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf-8");
    // "pid (comm) state ppid ...": comm may hold spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf-8")).trim();
    // fields[0] is field 3 (state); starttime is field 22.
    return { state: fields[0], startTicks: fields[19], bootId };
  } catch {
    return null;
  }
}

export interface ProcessFacts {
  alive: boolean;
  /** Linux only (null elsewhere or unreadable). */
  cmdline: string[] | null;
  linux: LinuxIdentity | null;
  /** Epoch ms the machine booted. */
  bootTimeMs: number;
}

export async function readProcessFacts(pid: number): Promise<ProcessFacts> {
  const bootTimeMs = Date.now() - os.uptime() * 1000;
  let alive: boolean;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    alive = (err as NodeJS.ErrnoException).code === "EPERM";
  }
  if (process.platform !== "linux") return { alive, cmdline: null, linux: null, bootTimeMs };
  const linux = await readLinuxIdentity(pid);
  if (!linux || linux.state === "Z") alive = false;
  let cmdline: string[] | null = null;
  try {
    cmdline = (await fs.readFile(`/proc/${pid}/cmdline`, "utf-8")).split("\0").filter(Boolean);
  } catch {
    // gone, or not ours to read
  }
  return { alive, cmdline, linux, bootTimeMs };
}

export type AdoptDecision = { adopt: true } | { adopt: false; reason: string };

/**
 * Whether the process in `record` is still the server Pyrodeck launched.
 * Linux checks the process's identity exactly (start time and boot ID) and
 * that its command line is the executable with `-dedicated`. Elsewhere only
 * "a process with that PID is alive and started after the machine booted" is
 * known; the caller must also log in to the server's console before
 * adopting, so a reused PID is never taken for the server.
 */
export function decideAdopt(record: RunRecord, facts: ProcessFacts, platform: NodeJS.Platform): AdoptDecision {
  const pid = record.pid;
  if (!facts.alive) return { adopt: false, reason: `process ${pid} is no longer running` };

  if (platform === "linux") {
    if (!record.linux) return { adopt: false, reason: "the record has no process identity to check" };
    if (!facts.linux) return { adopt: false, reason: `cannot read /proc/${pid}` };
    if (facts.linux.bootId !== record.linux.bootId) return { adopt: false, reason: "the machine restarted since" };
    if (facts.linux.startTicks !== record.linux.startTicks) {
      return { adopt: false, reason: `PID ${pid} now belongs to another process` };
    }
    const argv = facts.cmdline;
    if (!argv || argv.length === 0) return { adopt: false, reason: `cannot read the command line of process ${pid}` };
    if (argv[0] !== record.executablePath && path.basename(argv[0]) !== path.basename(record.executablePath)) {
      return { adopt: false, reason: `process ${pid} is ${argv[0]}, not ${record.executablePath}` };
    }
    if (!argv.includes("-dedicated")) return { adopt: false, reason: `process ${pid} is not a dedicated server` };
    return { adopt: true };
  }

  // A minute of slack for clock and uptime rounding.
  if (Date.parse(record.startedAt) < facts.bootTimeMs - 60_000) {
    return { adopt: false, reason: "the machine restarted since" };
  }
  return { adopt: true };
}
