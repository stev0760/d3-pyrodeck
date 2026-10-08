import os from "node:os";
import fs from "node:fs/promises";

/**
 * Process priority class for the game server, applied after each launch and
 * relaunch with os.setPriority (https://nodejs.org/api/os.html#ossetprioritypid-priority).
 *
 * Classes map to Node's os.constants.priority values
 * (https://nodejs.org/api/os.html#priority-constants), which are Unix nice
 * values. On Windows, libuv maps each of them to the matching priority class:
 *   below-normal  PRIORITY_BELOW_NORMAL  10  BELOW_NORMAL_PRIORITY_CLASS
 *   normal        PRIORITY_NORMAL         0  NORMAL_PRIORITY_CLASS
 *   above-normal  PRIORITY_ABOVE_NORMAL  -7  ABOVE_NORMAL_PRIORITY_CLASS
 *   high          PRIORITY_HIGH         -14  HIGH_PRIORITY_CLASS
 * PRIORITY_HIGHEST (REALTIME_PRIORITY_CLASS on Windows) is not offered: it can
 * starve the machine, and Windows reduces it to High without elevation anyway.
 *
 * Linux: a nice value belongs to a thread, and setpriority() on a PID changes
 * only the thread with that ID. Every thread listed in /proc/<pid>/task is set,
 * and threads the server starts later inherit the value, except a thread that
 * runs below the main thread on purpose: the dedicated server's SDL audio
 * hotplug thread (PulseHotplug) sets itself to nice 19, and is left there
 * rather than raised. An unprivileged user
 * may lower the priority (raise the nice value) but not raise it, nor undo a
 * lowering: that needs CAP_SYS_NICE or an RLIMIT_NICE allowance
 * (/etc/security/limits.conf `nice`). Refused changes are a warning; the server
 * keeps running at the priority it has.
 */

export const PRIORITY_CLASSES = ["below-normal", "normal", "above-normal", "high"] as const;
export type PriorityClass = (typeof PRIORITY_CLASSES)[number];

export const DEFAULT_PRIORITY_CLASS: PriorityClass = "normal";

export function isPriorityClass(value: unknown): value is PriorityClass {
  return (PRIORITY_CLASSES as readonly unknown[]).includes(value);
}

/** The os.setPriority value for a class. */
export function priorityValue(cls: PriorityClass): number {
  const p = os.constants.priority;
  switch (cls) {
    case "below-normal":
      return p.PRIORITY_BELOW_NORMAL;
    case "normal":
      return p.PRIORITY_NORMAL;
    case "above-normal":
      return p.PRIORITY_ABOVE_NORMAL;
    case "high":
      return p.PRIORITY_HIGH;
  }
}

export interface PriorityResult {
  pid: number;
  priorityClass: PriorityClass;
  value: number;
  /** Threads (Linux) or processes changed. */
  applied: number;
  /** Set when the change was refused or partial; the server is otherwise unaffected. */
  warning: string | null;
}

export interface PriorityDeps {
  setPriority(pid: number, value: number): void;
  getPriority(pid: number): number;
  /** Thread IDs of `pid`, or null where threads cannot be listed (not Linux). */
  listThreads(pid: number): Promise<number[] | null>;
}

async function listLinuxThreads(pid: number): Promise<number[] | null> {
  if (process.platform !== "linux") return null;
  try {
    const entries = await fs.readdir(`/proc/${pid}/task`);
    const tids = entries.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    return tids.length > 0 ? tids : null;
  } catch {
    return null;
  }
}

export const defaultPriorityDeps: PriorityDeps = {
  setPriority: (pid, value) => os.setPriority(pid, value),
  getPriority: (pid) => os.getPriority(pid),
  listThreads: listLinuxThreads,
};

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: string; info?: { code?: string } };
  // os.setPriority throws ERR_SYSTEM_ERROR with the libuv code in `info`.
  return e?.info?.code ?? e?.code;
}

const NEEDS_PRIVILEGE =
  process.platform === "win32"
    ? "Windows refused the change (High needs an account allowed to raise process priority)."
    : "Raising a process's priority, or undoing a lowering, needs root or CAP_SYS_NICE (or a `nice` limit in /etc/security/limits.conf).";

/** Apply `cls` to the server process `pid`. Never throws. */
export async function applyPriority(
  pid: number,
  cls: PriorityClass,
  deps: PriorityDeps = defaultPriorityDeps,
): Promise<PriorityResult> {
  const value = priorityValue(cls);
  const targets = (await deps.listThreads(pid)) ?? [pid];
  const current = (id: number): number | null => {
    try {
      return deps.getPriority(id);
    } catch {
      return null;
    }
  };
  const base = current(pid);
  let applied = 0;
  let refused = 0;
  let other: string | null = null;
  for (const id of targets) {
    if (id !== pid) {
      const own = current(id);
      if (own === null) continue; // exited meanwhile
      // A thread that put itself below the main thread stays where it is.
      if (base !== null && own > base && own > value) continue;
    }
    try {
      deps.setPriority(id, value);
      applied++;
    } catch (err) {
      const code = errorCode(err);
      if (code === "EACCES" || code === "EPERM") refused++;
      // ESRCH: the thread or process exited meanwhile; nothing to report.
      else if (code !== "ESRCH") other ??= err instanceof Error ? err.message : String(err);
    }
  }
  let warning: string | null = null;
  if (refused > 0) {
    warning = `Could not set the server's priority to ${cls}: permission denied. ${NEEDS_PRIVILEGE} The server keeps running at its current priority.`;
  } else if (other) {
    warning = `Could not set the server's priority to ${cls}: ${other}`;
  }
  return { pid, priorityClass: cls, value, applied, warning };
}
