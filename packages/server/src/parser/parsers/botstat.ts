/**
 * Parser for the $botstat status line (Matcen contract, PYRODECK_CONTRACT §5).
 *
 * The status line is Tier 2: shown in the Bots tab as text, parsed softly.
 * A line that doesn't match is skipped, never an error. Each bot usually
 * prints a second, indented "nav:" diagnostics line (Tier 3, format changes
 * without notice); the regex below never matches it, so it is dropped.
 *
 *   Bot 0 'Phantom[BOT]' slot=2 state=COMBAT role=Freelance lean=balanced speed=10.3 shields=100 target=Viper[BOT]
 *       nav: dest_room=5 num_paths=1 path=0/3 ...
 *
 * Field values as the fork prints them:
 * - state: EXPLORE, HUNT, COMBAT, FLEE, EVADE
 * - role: Freelance, Attack, Defend, Follow, Cover (TitleCase)
 * - lean: balanced, attack, defend, runner, flex, or "?" for an unknown value
 * - target: a callsign (ends in "[BOT]" for a bot), "(robot)", or "(none)"
 *
 * A dead bot prints shields=-1. A bot with no object prints
 * "Bot N 'Name[BOT]' slot=N (no object — respawning?)" instead; it has no
 * status fields and is skipped.
 */

export interface BotStatus {
  index: number;
  callsign: string;
  slot: number;
  state: string;
  role: string;
  lean: string;
  speed: number;
  shields: number;
  target: string | null;
}

export interface ParsedBotStats {
  bots: BotStatus[];
}

export function parseBotstat(raw: string): ParsedBotStats | null {
  const bots: BotStatus[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(
      /Bot (\d+) '(.+?)' slot=(\d+) state=(\S+) role=(\S+) lean=(\S+) speed=(-?[\d.]+) shields=(-?[\d.]+) target=(.+)/,
    );
    if (match) {
      const target = match[9].trim();
      bots.push({
        index: parseInt(match[1], 10),
        callsign: match[2],
        slot: parseInt(match[3], 10),
        state: match[4],
        role: match[5],
        lean: match[6],
        speed: parseFloat(match[7]),
        shields: parseFloat(match[8]),
        target: target === "(none)" ? null : target,
      });
    }
  }

  return bots.length > 0 ? { bots } : null;
}
