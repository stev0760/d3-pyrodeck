/**
 * Team settings and the Hoard orb count: DMFC options with no dedicated.cfg
 * key, stored per profile and written into the Startup Commands file at
 * launch (autoexecBlock.ts), so they hold from the first second of the game.
 *
 * Commands as the DMFC source parses them (Matcen tree):
 *   $allowteamchange on|off   netgames/dmfc/dmfcinputcommand.cpp:301-327
 *   $autobalance on|off       netgames/dmfc/dmfcinputcommand.cpp:274-299
 *   $setteamname <0-3> <name> netgames/dmfc/dmfcinputcommand.cpp:817-846: the
 *                             name is one word, cut to 15 characters
 *                             (MAX_TEAMNAME_LEN 16, netgames/includes/DMFC.h:380);
 *                             teams 0-3 are red, blue, green, yellow (DMFC.h:364-367)
 *   $mincount <1-12>          netgames/hoard/hoard.cpp:236-263, Hoard on a
 *                             dedicated server only; clamped to 1..12. The
 *                             open-source Hoard has no maximum-orbs command.
 *
 * DMFC reads the startup script after loading its saved settings
 * (dmfcbase.cpp:1199, :1327), so these win over what the last game saved. It
 * also saves allow-team-change and auto-balance in the engine's preferences
 * when a game ends (SaveSettings, dmfcbase.cpp:732-768), so "server default"
 * means whatever the last server on this machine left. Team names and the
 * Hoard count are not saved. A game type without a command ignores the line
 * (an unknown command is dropped silently, dmfcbase.cpp:3476-3491).
 */

export const TEAM_KEYS = ["red", "blue", "green", "yellow"] as const;
export type TeamKey = (typeof TEAM_KEYS)[number];

export const TEAM_NAME_MAX = 15;
export const HOARD_MIN_ORBS_MIN = 1;
export const HOARD_MIN_ORBS_MAX = 12;

export interface TeamSettings {
  allowTeamChange?: boolean;
  autoBalance?: boolean;
  /** Team display names; an unset team keeps its default name. */
  teamNames?: Partial<Record<TeamKey, string>>;
  /** Hoard: orbs a player must carry to score. */
  hoardMinOrbs?: number;
}

export interface TeamSettingsCheck {
  /** The settings to store, or null when none are set. Not to be saved when `errors` is non-empty. */
  settings: TeamSettings | null;
  errors: string[];
}

const TEAM_NAME_RE = /^[A-Za-z0-9_\-.!?'+*#@&()[\]]+$/;

/** Validate untrusted team settings from the profile form. */
export function validateTeamSettings(raw: unknown): TeamSettingsCheck {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const out: TeamSettings = {};

  if (typeof r.allowTeamChange === "boolean") out.allowTeamChange = r.allowTeamChange;
  if (typeof r.autoBalance === "boolean") out.autoBalance = r.autoBalance;

  if (r.teamNames && typeof r.teamNames === "object") {
    const names = r.teamNames as Record<string, unknown>;
    const kept: Partial<Record<TeamKey, string>> = {};
    for (const key of TEAM_KEYS) {
      const v = names[key];
      if (typeof v !== "string" || v.trim() === "") continue;
      const name = v.trim();
      if (name.length > TEAM_NAME_MAX || !TEAM_NAME_RE.test(name)) {
        errors.push(
          `The ${key} team name must be one word of at most ${TEAM_NAME_MAX} letters, digits or simple punctuation (no spaces or %).`,
        );
        continue;
      }
      kept[key] = name;
    }
    if (Object.keys(kept).length > 0) out.teamNames = kept;
  }

  if (r.hoardMinOrbs !== undefined && r.hoardMinOrbs !== null && r.hoardMinOrbs !== "") {
    const n = typeof r.hoardMinOrbs === "string" ? Number(r.hoardMinOrbs) : r.hoardMinOrbs;
    if (typeof n !== "number" || !Number.isInteger(n) || n < HOARD_MIN_ORBS_MIN || n > HOARD_MIN_ORBS_MAX) {
      errors.push(`Hoard orbs to score must be a whole number from ${HOARD_MIN_ORBS_MIN} to ${HOARD_MIN_ORBS_MAX}.`);
    } else {
      out.hoardMinOrbs = n;
    }
  }

  return { settings: Object.keys(out).length > 0 ? out : null, errors };
}

/** Settings as stored in profiles.json, made safe for use: anything invalid is dropped. */
export function sanitizeStoredTeamSettings(raw: unknown): TeamSettings | null {
  const check = validateTeamSettings(raw);
  return check.errors.length === 0 ? check.settings : null;
}

/** The startup-script lines that apply these settings, in a fixed order. */
export function buildTeamSettingLines(settings: TeamSettings | null | undefined): string[] {
  if (!settings) return [];
  const lines: string[] = [];
  if (settings.allowTeamChange !== undefined) {
    lines.push(`$allowteamchange ${settings.allowTeamChange ? "on" : "off"}`);
  }
  if (settings.autoBalance !== undefined) {
    lines.push(`$autobalance ${settings.autoBalance ? "on" : "off"}`);
  }
  TEAM_KEYS.forEach((key, index) => {
    const name = settings.teamNames?.[key];
    if (name) lines.push(`$setteamname ${index} ${name}`);
  });
  if (settings.hoardMinOrbs !== undefined) lines.push(`$mincount ${settings.hoardMinOrbs}`);
  return lines;
}
