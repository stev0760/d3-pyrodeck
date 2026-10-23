/**
 * Parser for the $botpopulation status line (Matcen contract, PYRODECK_CONTRACT
 * §4, Tier 1):
 *
 *   Population: manager=on target=6 reserve=1 humans=0 bots=6 seats=7/8 bot_limit=6
 *
 * `manager` is on or off; `target` is BotTargetPlayers (0 = none); `reserve` the
 * seats kept free for humans; `seats` is used/total; `bot_limit` the most bots
 * the server will hold. The lines that may follow the status (Tier 2 notes, why
 * the manager is idle and so on) are kept as free text in `note`.
 *
 * The mutation forms ($botpopulation on|off|target n|reserve n) reply with a
 * sentence instead of the status line and parse to null; the client re-queries.
 */

export interface BotPopulation {
  manager: boolean;
  target: number;
  reserve: number;
  humans: number;
  bots: number;
  seatsUsed: number;
  seats: number;
  botLimit: number;
  note?: string;
}

const STATUS_RE =
  /^Population: manager=(on|off) target=(\d+) reserve=(\d+) humans=(\d+) bots=(\d+) seats=(\d+)\/(\d+) bot_limit=(\d+)\s*$/;

export function parseBotpopulation(raw: string): BotPopulation | null {
  const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""));
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(STATUS_RE);
    if (!m) continue;
    const note = lines
      .slice(i + 1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join("\n");
    return {
      manager: m[1] === "on",
      target: parseInt(m[2], 10),
      reserve: parseInt(m[3], 10),
      humans: parseInt(m[4], 10),
      bots: parseInt(m[5], 10),
      seatsUsed: parseInt(m[6], 10),
      seats: parseInt(m[7], 10),
      botLimit: parseInt(m[8], 10),
      ...(note ? { note } : {}),
    };
  }
  return null;
}
