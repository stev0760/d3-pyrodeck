/**
 * Parser for $addbot output (Matcen contract, PYRODECK_CONTRACT §4, Tier 1).
 *
 *   $addbot <name> [ship] [difficulty] [team]
 *
 * Arguments are positional: difficulty is read only after a ship, team only
 * after a difficulty. The base name is cut to 14 characters and split on
 * whitespace, so a name must be one token.
 *
 * Success:
 *   Bot 'Phantom[BOT]' added in slot 2 (ship=Pyro-GL, diff=Hotshot, team=2)
 * team is 1-based; a free-for-all bot prints team=1.
 *
 * Failure:
 *   Failed to add bot (server full or max bots reached)
 *
 * Warnings printed before the result line:
 *   Unknown ship 'x', using default. Valid: pyro, phoenix, magnum, blackpyro
 *   BOT: team 3 out of range for 2-team game — auto-balancing 'Phantom[BOT]'
 */

export interface AddBotResult {
  ok: boolean;
  callsign: string | null;
  slot: number | null;
  ship: string | null;
  difficulty: string | null;
  /** 1-based team as printed; 1 in a free-for-all game. */
  team: number | null;
  /** The failure line, when ok is false. */
  error: string | null;
  /** Unknown-ship and team-out-of-range lines, in order. */
  warnings: string[];
}

/** Bot base names longer than this are cut by the server (19-char callsign minus "[BOT]"). */
export const BOT_BASE_NAME_MAX = 14;

const SUCCESS_RE =
  /Bot '(.+)' added in slot (\d+) \(ship=(.+), diff=(\S+)(?:, team=(\d+))?\)/;
const FAILURE_RE = /Failed to add bot \(.*\)/;
const WARNING_RE = /^(Unknown ship '.*', using default\..*|BOT: team \d+ out of range for .*)$/;

export function parseAddbot(raw: string): AddBotResult | null {
  const warnings: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (WARNING_RE.test(trimmed)) {
      warnings.push(trimmed);
      continue;
    }

    const ok = trimmed.match(SUCCESS_RE);
    if (ok) {
      return {
        ok: true,
        callsign: ok[1],
        slot: parseInt(ok[2], 10),
        ship: ok[3],
        difficulty: ok[4],
        team: ok[5] !== undefined ? parseInt(ok[5], 10) : null,
        error: null,
        warnings,
      };
    }

    const fail = trimmed.match(FAILURE_RE);
    if (fail) {
      return {
        ok: false,
        callsign: null,
        slot: null,
        ship: null,
        difficulty: null,
        team: null,
        error: fail[0],
        warnings,
      };
    }
  }
  return null;
}
