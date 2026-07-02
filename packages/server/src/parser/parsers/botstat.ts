/**
 * Parser for $botstat output (Matcen 0.8.16–0.9.5).
 *
 * As of 0.9.1 each bot emits TWO lines: the status line below plus a Phase 11
 * "nav:" router-diagnostic line (Tier 3 — volatile; 0.9.5/Phase 12 may append
 * " via:d=… t=…"). We parse the status line and intentionally skip the nav
 * line by regex non-match (diagnostic only — see D3_PYRODECK_SPEC.md §5.1.1).
 * The status-line format is unchanged from 0.8.16; field casing is fixed by
 * the engine (dedicated_server.cpp): state=UPPERCASE, role=TitleCase,
 * lean=lowercase.
 *
 * Example (0.9.1):
 *   Bot 0 'Phantom [BOT]' slot=2 state=COMBAT role=Freelance lean=balanced speed=10.3 shields=100 target=Viper [BOT]
 *       nav: dest_room=5 num_paths=1 path=0/3 mdir|0.98| ahead:WALL d=12.3 solid=0 portal=1 route:goal=19 dijkstra=3 boa=24 [DIVERGE] gcost=40
 *   Bot 1 'Viper [BOT]' slot=3 state=EXPLORE role=Attack lean=attack speed=51.6 shields=43 target=(none)
 *       nav: dest_room=7 num_paths=1 path=1/4 mdir|1.00| ahead:clear(>30u) route:goal=19 dijkstra=7 boa=7 gcost=0
 *
 * target may also be "(robot)" (non-player target) — kept as a non-null string.
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
