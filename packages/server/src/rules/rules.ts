import type { NicknameRules, ProfanityRules } from "./ruleSettings.js";

/**
 * Nickname checks for joining players (the D3Server3 anti-cheat options),
 * the profanity matcher, and the warn/kick/ban escalation.
 *
 * What the names are checked against is the callsign as Pyrodeck reads it on
 * the console. The console reader drops NUL bytes and the engine's colour
 * codes (0x01 and the three bytes after it) before Pyrodeck sees a line, so a
 * name carrying those reads as its visible text. A `%` in a callsign reaches
 * printf-style calls as part of the format: in DMFC (DisplayPlayerInfo,
 * dmfcbase.cpp:1654; `$banlist`, dmfcinputcommand.cpp:753) and in every
 * console line, since PrintDedicatedMessage hands its formatted text to
 * con_Printf as the format (dedicated_server.cpp:1388). On Matcen 0.9.16
 * `$addbot Pct%sX` crashed the server at the bot's join line, so there a `%`
 * name may crash the server before this rule acts. A client's callsign cannot
 * be set from the server console, so the client cases were not tried.
 */

export type NicknameVerdict =
  | { ok: true }
  | { ok: false; code: "empty" | "percent" | "control" | "short"; label: string; detail: string };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

export function checkNickname(name: string, rules: NicknameRules): NicknameVerdict {
  if (!rules.enabled) return { ok: true };
  if (rules.rejectEmpty && name.trim() === "") {
    return { ok: false, code: "empty", label: "INVALID NICKNAME", detail: "an empty name" };
  }
  if (rules.rejectPercent && name.includes("%")) {
    return { ok: false, code: "percent", label: "INVALID NICKNAME", detail: "names cannot contain %" };
  }
  if (rules.rejectControl && CONTROL.test(name)) {
    return { ok: false, code: "control", label: "HACKED NICKNAME", detail: "control characters in the name" };
  }
  if (rules.minLength > 0 && name.trim().length < rules.minLength) {
    return {
      ok: false,
      code: "short",
      label: "INVALID NICKNAME",
      detail: `names need at least ${rules.minLength} characters`,
    };
  }
  return { ok: true };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A matcher for a word list: each entry matches as a whole word (or phrase),
 * without regard to case; a trailing `*` matches any ending ("shit*" matches
 * "shitty"). Returns the entry that matched, or null.
 */
export function compileWordList(words: readonly string[]): (text: string) => string | null {
  const entries = words
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
    .map((w) => {
      const wildcard = w.endsWith("*");
      const stem = wildcard ? w.slice(0, -1) : w;
      const body = stem
        .split(/\s+/)
        .map(escapeRegExp)
        .join("[\\s\\p{P}]+");
      return { word: w, re: new RegExp(`(?<![\\p{L}\\p{N}])${body}${wildcard ? "[\\p{L}\\p{N}]*" : ""}(?![\\p{L}\\p{N}])`, "iu") };
    });
  return (text: string) => entries.find((e) => e.re.test(text))?.word ?? null;
}

export type EscalationAction = "warn" | "kick" | "ban";

export interface OffenderView {
  name: string;
  offences: number;
  warnings: number;
  kicks: number;
  lastAction: EscalationAction | null;
  lastActionAt: string | null;
}

export interface EscalationStep {
  /** What to do now; null while the player is in the cooldown after the last action. */
  action: EscalationAction | null;
  /** Counted offences, this one included. */
  offences: number;
  warnings: number;
  kicks: number;
}

interface Offender {
  name: string;
  offences: number;
  warnings: number;
  kicks: number;
  lastActionAt: number;
  lastAction: EscalationAction | null;
}

/**
 * Per-player escalation: `warnings` warnings, then `kicks` kicks, then a ban
 * (or more kicks when banning is off). After a warning or a kick, matches
 * within the cooldown are not counted, so one burst of lines is one offence.
 * Keyed by callsign without regard to case; reset when the server restarts.
 */
export class Escalation {
  private readonly offenders = new Map<string, Offender>();

  constructor(private readonly policy: () => Pick<ProfanityRules, "warnings" | "kicks" | "ban" | "cooldownSeconds">) {}

  hit(name: string, now: number): EscalationStep {
    const policy = this.policy();
    const key = name.toLowerCase();
    let o = this.offenders.get(key);
    if (!o) {
      o = { name, offences: 0, warnings: 0, kicks: 0, lastActionAt: -Infinity, lastAction: null };
      this.offenders.set(key, o);
    }
    if (now - o.lastActionAt < policy.cooldownSeconds * 1000) {
      return { action: null, offences: o.offences, warnings: o.warnings, kicks: o.kicks };
    }
    o.offences++;
    let action: EscalationAction;
    if (o.warnings < policy.warnings) {
      action = "warn";
      o.warnings++;
    } else if (o.kicks < policy.kicks || !policy.ban) {
      action = "kick";
      o.kicks++;
    } else {
      action = "ban";
    }
    o.lastAction = action;
    o.lastActionAt = now;
    return { action, offences: o.offences, warnings: o.warnings, kicks: o.kicks };
  }

  /** Offenders this run, most recent first. */
  list(): OffenderView[] {
    return [...this.offenders.values()]
      .sort((a, b) => b.lastActionAt - a.lastActionAt)
      .map((o) => ({ ...o, lastActionAt: Number.isFinite(o.lastActionAt) ? new Date(o.lastActionAt).toISOString() : null }));
  }

  forget(name: string): void {
    this.offenders.delete(name.toLowerCase());
  }

  reset(): void {
    this.offenders.clear();
  }
}
