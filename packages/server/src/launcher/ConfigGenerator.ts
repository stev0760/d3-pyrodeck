import crypto from "node:crypto";

/**
 * D3 dedicated.cfg parser and generator.
 *
 * Config format: Key=Value, one per line. Some keys can repeat
 * (AllowPowerup, DisallowPowerup). Lines starting with # or ; are comments.
 * Blank lines are preserved.
 */

export interface DedicatedCfgEntry {
  key: string;
  value: string;
}

/**
 * Parse a dedicated.cfg file into key-value entries.
 * Preserves order and duplicate keys (e.g. AllowPowerup appearing multiple times).
 */
export function parseDedicatedCfg(content: string): DedicatedCfgEntry[] {
  const entries: DedicatedCfgEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    entries.push({
      key: trimmed.slice(0, eqIndex),
      value: trimmed.slice(eqIndex + 1),
    });
  }
  return entries;
}

/**
 * Get a single value from parsed config entries.
 * Returns the last occurrence if the key appears multiple times.
 */
export function getCfgValue(
  entries: DedicatedCfgEntry[],
  key: string,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].key.toLowerCase() === key.toLowerCase()) {
      return entries[i].value;
    }
  }
  return undefined;
}

/**
 * Extract telnet connection info from a parsed config.
 * Used by ProcessManager to auto-connect after launching.
 */
export function extractTelnetConfig(entries: DedicatedCfgEntry[]): {
  enabled: boolean;
  port: number;
  password: string | undefined;
} {
  const allowRemote = getCfgValue(entries, "AllowRemoteConsole");
  const port = getCfgValue(entries, "RemoteConsolePort");
  const password = getCfgValue(entries, "ConsolePassword");

  return {
    enabled: allowRemote === "1",
    port: port ? parseInt(port, 10) : 2092,
    password,
  };
}

export interface DedicatedCfgDefaults {
  gameName?: string;
  missionName?: string;
  scriptName?: string;
  maxPlayers?: number;
  pps?: number;
  timeLimit?: number;
  killGoal?: number;
  consolePassword?: string;
  remoteConsolePort?: number;
}

/**
 * Generate a dedicated.cfg with sensible defaults for Pyrodeck-managed servers.
 *
 * D3's config format requires:
 * - First line must be "[server config file]" (tag_check in InfFile::Open)
 * - Key=Value syntax, one per line (no comments — D3 only strips ; and # in some parsers)
 * - Key casing must match CVar registration (e.g. Scriptname not ScriptName)
 * - ConnectionName is required for network mode
 * - AllowRemoteConsole=1 is required for Pyrodeck telnet access
 */
export function generateDedicatedCfg(
  opts: DedicatedCfgDefaults = {},
): string {
  const password =
    opts.consolePassword ?? crypto.randomBytes(4).toString("hex");
  const port = opts.remoteConsolePort ?? 2092;

  const lines = [
    "[server config file]",
    `GameName=${opts.gameName ?? "Pyrodeck Server"}`,
    `MissionName=${opts.missionName ?? "fury.mn3"}`,
    `Scriptname=${opts.scriptName ?? "anarchy.d3m"}`,
    `ConnectionName=Direct TCP~IP`,
    `MaxPlayers=${opts.maxPlayers ?? 8}`,
    `PPS=${opts.pps ?? 30}`,
    `Timelimit=${opts.timeLimit ?? 0}`,
    `Killgoal=${opts.killGoal ?? 0}`,
    `AllowRemoteConsole=1`,
    `RemoteConsolePort=${port}`,
    `ConsolePassword=${password}`,
  ];

  return lines.join("\n") + "\n";
}
