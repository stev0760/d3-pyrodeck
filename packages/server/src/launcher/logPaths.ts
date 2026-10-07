import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

/**
 * Resolve the directory where server logs are written.
 *
 * When the user hasn't pinned a logDir, logs go next to the D3 executable —
 * the install directory — rather than a Pyrodeck-internal path. That keeps
 * logs discoverable alongside the game and (on a VPS) in a predictable place
 * the panel can enumerate.
 */
export function resolveLogDir(
  configLogDir: string | null | undefined,
  resolvedExecutablePath: string,
): string {
  if (configLogDir && configLogDir.trim()) return configLogDir.trim();
  return path.dirname(resolvedExecutablePath);
}

/**
 * Build a filesystem-safe, timestamped log filename for a single launch, e.g.
 * "testing-2026-06-17T22-20-31.log". Auto-naming removes the hand-edited path
 * that previously let a paste-glitch send a soak's output into the void, and
 * gives the log viewer predictable, enumerable names to list and download.
 */
export function buildLogFilename(label: string, now: Date = new Date()): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "server";
  // ISO without millis/zone, ":" → "-" so it's valid on every filesystem.
  // 2026-06-17T22:20:31.434Z → 2026-06-17T22-20-31
  const ts = now.toISOString().slice(0, 19).replace(/:/g, "-");
  return `${slug}-${ts}.log`;
}

/**
 * Check a user-entered log directory when it is saved, before any launch.
 * It must be absolute (a relative path would resolve against Pyrodeck's own
 * working directory, not the game's), and it must be a writable directory or
 * not exist yet under a writable directory (launch creates it).
 */
export async function validateLogDir(dir: string): Promise<{ valid: boolean; errors: string[] }> {
  const trimmed = dir.trim();
  if (!path.isAbsolute(trimmed)) {
    return {
      valid: false,
      errors: [`Log directory must be an absolute path (got "${trimmed}"); "~" is not expanded.`],
    };
  }
  // Walk up to the nearest path that exists.
  let probe = path.resolve(trimmed);
  for (;;) {
    try {
      const st = await fs.stat(probe);
      if (!st.isDirectory()) {
        return { valid: false, errors: [`${probe} exists and is not a directory.`] };
      }
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return { valid: false, errors: [`No part of ${trimmed} exists.`] };
      probe = parent;
    }
  }
  try {
    await fs.access(probe, fsConstants.W_OK);
  } catch {
    return { valid: false, errors: [`${probe} is not writable by Pyrodeck.`] };
  }
  return { valid: true, errors: [] };
}

/**
 * Make sure a launch's log file can really be written: create the directory,
 * then create (append-open) the file itself. Opening the actual file is a
 * stronger test than an access() check, which can pass on filesystems and ACL
 * setups that still refuse the write. Returns an error message, or null.
 */
export async function prepareLogFile(logPath: string): Promise<string | null> {
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const handle = await fs.open(logPath, "a");
    await handle.close();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Cannot write the server log ${logPath} (${message}).`;
  }
}
