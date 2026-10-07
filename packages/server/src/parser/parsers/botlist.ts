/**
 * Parser for $botlist output (Matcen contract, PYRODECK_CONTRACT §4, Tier 1).
 *
 * One line per active bot, two leading spaces:
 *   Bot 0: 'Phantom[BOT]' slot=2 ship=Black Pyro diff=Ace (alive)
 *   Bot 1: 'Viper[BOT]' slot=3 ship=Phoenix diff=Hotshot (dead)
 *
 * Callsigns end in "[BOT]" with no space before it. The ship is the game's
 * ship name and can contain a space ("Black Pyro"). Difficulty is one of
 * Trainee, Rookie, Hotshot, Ace, Insane.
 *
 * Empty list: "No bots active"
 */

export interface BotEntry {
  index: number;
  callsign: string;
  slot: number;
  ship: string;
  difficulty: string;
  alive: boolean;
}

export interface ParsedBotList {
  bots: BotEntry[];
}

export function parseBotlist(raw: string): ParsedBotList | null {
  if (raw.includes("No bots active")) {
    return { bots: [] };
  }

  const bots: BotEntry[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(
      /Bot (\d+): '(.+?)' slot=(\d+) ship=(.+?) diff=(\S+) \((alive|dead)\)/,
    );
    if (match) {
      bots.push({
        index: parseInt(match[1], 10),
        callsign: match[2],
        slot: parseInt(match[3], 10),
        ship: match[4],
        difficulty: match[5],
        alive: match[6] === "alive",
      });
    }
  }

  return bots.length > 0 ? { bots } : null;
}
