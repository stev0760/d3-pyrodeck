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
