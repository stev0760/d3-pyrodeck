import profanityDefaults from "./profanityDefaults.json" with { type: "json" };

/**
 * Join and chat rules, stored in pyrodeck.json under `playerRules`. Both are
 * off by default.
 */

export interface NicknameRules {
  enabled: boolean;
  /** Kick a name that is empty or only spaces. */
  rejectEmpty: boolean;
  /** Kick a name containing `%`, which DMFC prints as a format string in places. */
  rejectPercent: boolean;
  /** Kick a name with control characters. */
  rejectControl: boolean;
  /** Kick a name shorter than this (0 = no minimum). */
  minLength: number;
}

export interface ProfanityRules {
  enabled: boolean;
  /** Words and phrases, matched as whole words without regard to case; a trailing `*` matches any ending. */
  words: string[];
  /** Warnings before the first kick. */
  warnings: number;
  /** Kicks before a ban. */
  kicks: number;
  /** After the kicks, ban the name and the address (hosts.deny). Off: keep kicking. */
  ban: boolean;
  /** After a warning or a kick, further matches within this many seconds are not counted. */
  cooldownSeconds: number;
}

export interface PlayerRules {
  nickname: NicknameRules;
  profanity: ProfanityRules;
}

export const DEFAULT_PROFANITY_WORDS: readonly string[] = profanityDefaults.words;

export const DEFAULT_PLAYER_RULES: PlayerRules = {
  nickname: { enabled: false, rejectEmpty: true, rejectPercent: true, rejectControl: true, minLength: 0 },
  profanity: {
    enabled: false,
    words: [...DEFAULT_PROFANITY_WORDS],
    warnings: 2,
    kicks: 1,
    ban: true,
    cooldownSeconds: 10,
  },
};

const MAX_WORDS = 500;
const MAX_WORD_LENGTH = 40;
const MAX_CALLSIGN = 31;

function int(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** Validate untrusted input on top of `current`; on errors nothing is to be saved. */
export function validatePlayerRules(raw: unknown, current: PlayerRules): { rules: PlayerRules; errors: string[] } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const nickname = { ...current.nickname };
  const profanity = { ...current.profanity, words: [...current.profanity.words] };

  const n = (r.nickname && typeof r.nickname === "object" ? r.nickname : {}) as Record<string, unknown>;
  for (const key of ["enabled", "rejectEmpty", "rejectPercent", "rejectControl"] as const) {
    if (n[key] === undefined) continue;
    if (typeof n[key] === "boolean") nickname[key] = n[key];
    else errors.push(`nickname.${key} must be true or false.`);
  }
  if (n.minLength !== undefined) {
    const v = int(n.minLength, 0, MAX_CALLSIGN);
    if (v === null) errors.push(`The minimum name length must be a whole number from 0 to ${MAX_CALLSIGN}.`);
    else nickname.minLength = v;
  }

  const p = (r.profanity && typeof r.profanity === "object" ? r.profanity : {}) as Record<string, unknown>;
  for (const key of ["enabled", "ban"] as const) {
    if (p[key] === undefined) continue;
    if (typeof p[key] === "boolean") profanity[key] = p[key];
    else errors.push(`profanity.${key} must be true or false.`);
  }
  for (const [key, max, label] of [
    ["warnings", 10, "Warnings"],
    ["kicks", 10, "Kicks"],
    ["cooldownSeconds", 600, "The cooldown"],
  ] as const) {
    if (p[key] === undefined) continue;
    const v = int(p[key], 0, max);
    if (v === null) errors.push(`${label} must be a whole number from 0 to ${max}.`);
    else profanity[key] = v;
  }
  if (p.words !== undefined) {
    const list = Array.isArray(p.words) ? p.words : typeof p.words === "string" ? p.words.split(/\r?\n/) : null;
    if (!list || list.some((w) => typeof w !== "string")) {
      errors.push("The word list must be a list of words.");
    } else {
      const words = [...new Set(list.map((w: string) => w.trim().toLowerCase()).filter(Boolean))];
      const bad = words.find((w) => w.length > MAX_WORD_LENGTH || w === "*" || w.slice(0, -1).includes("*"));
      if (words.length > MAX_WORDS) errors.push(`At most ${MAX_WORDS} words.`);
      else if (bad) errors.push(`"${bad}": words are at most ${MAX_WORD_LENGTH} characters, with * only at the end.`);
      else profanity.words = words;
    }
  }
  return { rules: { nickname, profanity }, errors };
}

/** Rules as stored, made safe for use (bad values fall back to defaults, never enabled). */
export function sanitizeStoredPlayerRules(raw: unknown): PlayerRules {
  const check = validatePlayerRules(raw, DEFAULT_PLAYER_RULES);
  if (check.errors.length === 0) return check.rules;
  return {
    nickname: { ...check.rules.nickname, enabled: false },
    profanity: { ...check.rules.profanity, enabled: false },
  };
}
