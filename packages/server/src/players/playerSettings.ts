/**
 * Player settings stored in pyrodeck.json under `players`.
 */

export interface PlayerSettings {
  /** Send one `$playerinfo` per human join to record the address. */
  ipLookup: boolean;
  /**
   * `$playerinfo` queries allowed per server run on an engine that never
   * clears its text buffer (anything but Matcen 0.9.3+; see consoleLink.ts).
   */
  ipLookupBudget: number;
}

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  ipLookup: true,
  ipLookupBudget: 20,
};

export const MAX_IP_LOOKUP_BUDGET = 30;

export interface PlayerSettingsCheck {
  settings: PlayerSettings;
  errors: string[];
}

/** Validate untrusted input on top of `current`; on errors nothing is to be saved. */
export function validatePlayerSettings(raw: unknown, current: PlayerSettings): PlayerSettingsCheck {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const settings: PlayerSettings = { ...current };

  if (r.ipLookup !== undefined) {
    if (typeof r.ipLookup === "boolean") settings.ipLookup = r.ipLookup;
    else errors.push("ipLookup must be true or false.");
  }
  if (r.ipLookupBudget !== undefined) {
    const n = typeof r.ipLookupBudget === "string" ? Number(r.ipLookupBudget) : r.ipLookupBudget;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_IP_LOOKUP_BUDGET) {
      settings.ipLookupBudget = n;
    } else {
      errors.push(`The lookup limit must be a whole number from 0 to ${MAX_IP_LOOKUP_BUDGET}.`);
    }
  }
  return { settings, errors };
}

/** Settings as stored, made safe for use (bad values fall back to defaults). */
export function sanitizeStoredPlayerSettings(raw: unknown): PlayerSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: PlayerSettings = { ...DEFAULT_PLAYER_SETTINGS };
  if (typeof r.ipLookup === "boolean") out.ipLookup = r.ipLookup;
  const budget = r.ipLookupBudget;
  if (typeof budget === "number" && Number.isInteger(budget) && budget >= 0 && budget <= MAX_IP_LOOKUP_BUDGET) {
    out.ipLookupBudget = budget;
  }
  return out;
}
