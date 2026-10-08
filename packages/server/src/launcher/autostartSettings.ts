/**
 * Which profile Pyrodeck launches when it starts (launcher/Autostart.ts).
 *
 * Two places can name it, and the environment wins:
 * - PYRODECK_AUTOSTART_PROFILE: the profile's name, exactly as the Launch
 *   panel shows it (a profile's id also works). Unset or blank leaves it to
 *   the UI setting, as for the other PYRODECK_* settings.
 * - The profile ticked "Start when Pyrodeck starts" (Launch panel → Edit),
 *   saved in pyrodeck.json as one profile id, so only one profile can be it.
 *
 * Neither set: no autostart, as before 0.5.3.
 */

export const AUTOSTART_ENV = "PYRODECK_AUTOSTART_PROFILE";

export interface AutostartSettings {
  /** The profile ticked in the UI, or null. */
  profileId: string | null;
}

export const DEFAULT_AUTOSTART_SETTINGS: AutostartSettings = { profileId: null };

/** Profile ids are UUIDs; anything else in pyrodeck.json is ignored. */
const MAX_ID_LENGTH = 100;

export function sanitizeStoredAutostart(raw: unknown): AutostartSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = typeof r.profileId === "string" ? r.profileId.trim() : "";
  return { profileId: id !== "" && id.length <= MAX_ID_LENGTH ? id : null };
}

/** The profile PYRODECK_AUTOSTART_PROFILE names, or null when it is unset or blank. */
export function readAutostartEnv(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = (env[AUTOSTART_ENV] ?? "").trim();
  return raw === "" ? null : raw;
}

export interface AutostartProfileRef {
  id: string;
  name: string;
}

export type AutostartSource = "env" | "setting";

/** The profile to start, or why the one named cannot be. */
export type AutostartChoice =
  | { source: AutostartSource; profile: AutostartProfileRef }
  | { source: AutostartSource; error: string };

const LISTED_NAMES = 10;

function knownProfiles(profiles: readonly AutostartProfileRef[]): string {
  if (profiles.length === 0) return "there are no profiles";
  const names = profiles.slice(0, LISTED_NAMES).map((p) => `"${p.name}"`);
  const more = profiles.length > LISTED_NAMES ? ` and ${profiles.length - LISTED_NAMES} more` : "";
  return `the profiles are ${names.join(", ")}${more}`;
}

/**
 * Resolve the autostart profile: the environment's name when set (an exact,
 * case-sensitive name match, else a profile id), the UI's profile otherwise.
 * Null when neither names one. An unknown or ambiguous name is an error the
 * caller logs; nothing is started then.
 */
export function chooseAutostartProfile(
  envName: string | null,
  settingId: string | null,
  profiles: readonly AutostartProfileRef[],
): AutostartChoice | null {
  const ref = (p: AutostartProfileRef): AutostartProfileRef => ({ id: p.id, name: p.name });
  if (envName !== null) {
    const byName = profiles.filter((p) => p.name === envName);
    if (byName.length === 1) return { source: "env", profile: ref(byName[0]) };
    if (byName.length > 1) {
      return {
        source: "env",
        error: `${AUTOSTART_ENV}="${envName}" matches ${byName.length} profiles of that name; rename all but one, or set it to the profile's id`,
      };
    }
    const byId = profiles.find((p) => p.id === envName);
    if (byId) return { source: "env", profile: ref(byId) };
    return { source: "env", error: `${AUTOSTART_ENV} names no profile: "${envName}" (${knownProfiles(profiles)})` };
  }
  if (settingId !== null) {
    const p = profiles.find((x) => x.id === settingId);
    if (p) return { source: "setting", profile: ref(p) };
    return { source: "setting", error: `the profile set to start with Pyrodeck no longer exists (id ${settingId})` };
  }
  return null;
}
