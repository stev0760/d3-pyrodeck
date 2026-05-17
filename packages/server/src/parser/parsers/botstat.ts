/**
 * Parser for $botstat output (Matcen 0.8.16+).
 *
 * Example:
 *   Bot 0 'Phantom [BOT]' slot=2 state=COMBAT role=Freelance lean=balanced speed=10.3 shields=100 target=Viper [BOT]
 *   Bot 1 'Viper [BOT]' slot=3 state=EXPLORE role=Attack lean=attack speed=51.6 shields=43 target=(none)
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
      /Bot (\d+) '(.+?)' slot=(\d+) state=(\S+) role=(\S+) lean=(\S+) speed=([\d.]+) shields=([\d.]+) target=(.+)/,
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
