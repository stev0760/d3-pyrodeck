/**
 * Parser for $scores output.
 *
 * Example output (Anarchy):
 *   Pilot                Points K D S Ping
 *   [BOT] Viper:         5      6 1 1 0
 *   [BOT] Shadow:        4      6 2 2 0
 *   *[BOT] Reaper:       0      0 0 0 ---
 *
 * - First line is header
 * - '*' prefix = observer/disconnected
 * - '[BOT]' prefix in name = bot player
 * - Ping '---' = no network connection (bots)
 * - Column layout varies by game type
 */

export interface PlayerScore {
  name: string;
  points: number;
  kills: number;
  deaths: number;
  suicides: number;
  ping: number | null;
  isBot: boolean;
  isObserver: boolean;
}

export interface ParsedScores {
  players: PlayerScore[];
}

export function parseScores(raw: string): ParsedScores | null {
  const lines = raw.split("\n").map((l) => l.trimEnd());

  // Need at least a header line
  if (lines.length < 1) return null;

  // Find the header line (contains "Pilot" or "Points")
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("Pilot") || lines[i].includes("Points")) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) return null;

  const players: PlayerScore[] = [];

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const isObserver = line.startsWith("*");
    const cleaned = isObserver ? line.slice(1).trim() : line;

    // Split on the colon that follows the pilot name, then parse the numbers
    const colonIndex = cleaned.indexOf(":");
    if (colonIndex === -1) continue;

    const name = cleaned.slice(0, colonIndex).trim();
    const rest = cleaned.slice(colonIndex + 1).trim();
    const parts = rest.split(/\s+/);

    // At minimum we expect: points, kills, deaths, suicides, ping
    if (parts.length < 5) continue;

    const isBot = name.startsWith("[BOT]");
    const pingStr = parts[parts.length - 1];
    const ping = pingStr === "---" ? null : parseInt(pingStr, 10);

    players.push({
      name,
      points: parseInt(parts[0], 10) || 0,
      kills: parseInt(parts[1], 10) || 0,
      deaths: parseInt(parts[2], 10) || 0,
      suicides: parseInt(parts[3], 10) || 0,
      ping: isNaN(ping as number) ? null : ping,
      isBot,
      isObserver,
    });
  }

  return players.length > 0 ? { players } : null;
}
