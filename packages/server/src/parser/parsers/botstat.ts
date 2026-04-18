/**
 * Parser for $botstat output.
 *
 * Example:
 *   Bot 0 'Phantom [BOT]' slot=2 state=COMBAT speed=10.3 vel=(0.0,-7.2,7.3) shields=100 target=Viper [BOT]
 *   Bot 1 'Viper [BOT]' slot=3 state=EXPLORE speed=51.6 vel=(36.3,-2.5,36.5) shields=43 target=(none)
 */

export interface BotStatus {
  index: number;
  callsign: string;
  slot: number;
  state: string;
  speed: number;
  velocity: { x: number; y: number; z: number };
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
      /Bot (\d+) '(.+?)' slot=(\d+) state=(\S+) speed=([\d.]+) vel=\(([-\d.]+),([-\d.]+),([-\d.]+)\) shields=([\d.]+) target=(.+)/,
    );
    if (match) {
      const target = match[10].trim();
      bots.push({
        index: parseInt(match[1], 10),
        callsign: match[2],
        slot: parseInt(match[3], 10),
        state: match[4],
        speed: parseFloat(match[5]),
        velocity: {
          x: parseFloat(match[6]),
          y: parseFloat(match[7]),
          z: parseFloat(match[8]),
        },
        shields: parseFloat(match[9]),
        target: target === "(none)" ? null : target,
      });
    }
  }

  return bots.length > 0 ? { bots } : null;
}
