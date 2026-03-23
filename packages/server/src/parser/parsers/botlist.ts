/**
 * Parser for $botlist output.
 *
 * Example:
 *   Bot 0: '[BOT] Phantom' slot=2 ship=Pyro-GL diff=Hotshot (alive)
 *   Bot 1: '[BOT] Viper' slot=3 ship=Phoenix diff=Ace (dead)
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
