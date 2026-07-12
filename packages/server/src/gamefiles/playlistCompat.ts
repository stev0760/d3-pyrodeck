import fs from "node:fs/promises";
import path from "node:path";
import { parseDedicatedCfg, getCfgValue } from "../launcher/ConfigGenerator.js";
import { parseMn3Cached, normalizeScriptKey, isKnownModeKey } from "./Mn3Scanner.js";

/**
 * Playlist ↔ game-mode compatibility validation.
 *
 * A playlist rotates MissionName= in a profile's dedicated.cfg; the game mode
 * comes from that profile's Scriptname=. An entry whose mission doesn't
 * support the script makes the rotated server fail to start the game — the
 * exact launch-crash class the .mn3 scan exists to eliminate.
 */

export interface IncompatibleEntry {
  label: string;
  missionName: string;
  reason: string;
}

/**
 * Check playlist entries against the profile's Scriptname.
 *
 * Lenient by design: no Scriptname, a custom/unknown script, or a mission the
 * scanner can't parse all pass — only a definite mismatch (or a mission file
 * that doesn't exist) is flagged.
 */
export async function findIncompatibleEntries(
  gamePath: string,
  configFile: string,
  entries: { label: string; missionName: string }[],
): Promise<{ scriptName: string | null; incompatible: IncompatibleEntry[] }> {
  let scriptName: string | null;
  try {
    const cfgContent = await fs.readFile(path.join(gamePath, configFile), "utf-8");
    scriptName = getCfgValue(parseDedicatedCfg(cfgContent), "Scriptname") ?? null;
  } catch {
    return { scriptName: null, incompatible: [] };
  }
  if (!scriptName) return { scriptName: null, incompatible: [] };

  const key = normalizeScriptKey(scriptName);
  if (!isKnownModeKey(key)) return { scriptName, incompatible: [] };

  const modeLabel = scriptName.replace(/\.d3m$/i, "");
  const missionsDir = path.join(gamePath, "missions");
  const incompatible: IncompatibleEntry[] = [];
  for (const entry of entries) {
    const missionPath = path.join(missionsDir, path.basename(entry.missionName));
    try {
      await fs.access(missionPath);
    } catch {
      incompatible.push({
        label: entry.label,
        missionName: entry.missionName,
        reason: "mission file not found",
      });
      continue;
    }
    const info = await parseMn3Cached(missionPath);
    if (info.error) continue;
    const mode = info.modes[key];
    if (mode && !mode.compatible) {
      incompatible.push({
        label: entry.label,
        missionName: entry.missionName,
        reason: `no ${modeLabel} support`,
      });
    }
  }
  return { scriptName, incompatible };
}
