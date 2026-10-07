/**
 * Mission ↔ game-mode compatibility helpers, shared by the config form and
 * playlist editor. Mirrors the server's Mn3Scanner output shapes.
 */

/** Per-mode compatibility from the server's .mn3 scan (Mn3Scanner). */
export interface ModeSupport {
  compatible: boolean;
  maxTeams: number;
}

export interface MissionDetails {
  file: string;
  name: string | null;
  numLevels: number | null;
  keywords: string;
  multi: boolean;
  /** Mission-level URL lines: the download links offered to clients that lack the mission. */
  urls?: string[];
  /** Pyrodeck rewrote the links and holds the original .mn3 (restorable). */
  urlBackup?: boolean;
  error?: string;
  modes: Record<string, ModeSupport>;
}

/** Display labels for normalized mode keys, in badge display order. */
export const MODE_LABELS: [string, string][] = [
  ["anarchy", "Anarchy"],
  ["teamanarchy", "Team Anarchy"],
  ["hyperanarchy", "Hyper-Anarchy"],
  ["ctf", "CTF"],
  ["hoard", "Hoard"],
  ["entropy", "Entropy"],
  ["monsterball", "Monsterball"],
  ["coop", "Co-op"],
  ["roboanarchy", "Robo-Anarchy"],
];

export const MODE_LABEL_MAP: Record<string, string> = Object.fromEntries(MODE_LABELS);

/** Normalize a script name to the mode key used by the .mn3 scan ("team anarchy.d3m" → "teamanarchy"). */
export function scriptKey(script: string): string {
  return script
    .replace(/\.d3m$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Human label for a script name, preferring the canonical mode label. */
export function scriptModeLabel(script: string): string {
  return MODE_LABEL_MAP[scriptKey(script)] ?? script.replace(/\.d3m$/i, "");
}

/**
 * Whether a mission supports the given script. Unknown missions, scan errors,
 * and custom scripts the scan doesn't know all pass — never block on missing data.
 */
export function missionSupports(details: MissionDetails | undefined, script: string): boolean {
  if (!details || details.error) return true;
  const mode = details.modes[scriptKey(script)];
  return mode ? mode.compatible : true;
}
