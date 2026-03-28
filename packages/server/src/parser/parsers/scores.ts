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
 * - D3 truncates name+colon at 19 chars — long names lose the colon
 * - Team modes append ": TeamName" after callsign (30-char field)
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

/**
 * Try to parse a player line from $scores output.
 *
 * D3 uses fixed-width columns. The name field is 20 chars (Anarchy) or 30 chars
 * (team modes), followed by numeric stats. The name usually ends with ":" but
 * D3 truncates at 19/29 chars, so long names lose the colon.
 *
 * Strategy:
 *   1. Try splitting on the LAST colon that appears before numeric data
 *   2. If no colon, split on the boundary between text and numbers
 *      (find the first digit-or-minus sequence preceded by 2+ spaces)
 */
function parsePlayerLine(
  line: string,
): {
  name: string;
  stats: string;
} | null {
  // Strategy 1: find the last colon before a run of numbers
  // This handles "Name:" and "Name: Team" and "Name:SubName:" formats
  const colonMatch = line.match(/^(.+):\s{2,}(.+)$/);
  if (colonMatch) {
    return { name: colonMatch[1].trim(), stats: colonMatch[2].trim() };
  }

  // Strategy 2: no colon (truncated name) — find where the name ends and
  // stats begin by looking for 2+ spaces followed by a number or minus sign
  const noColonMatch = line.match(/^(.+?)\s{2,}(-?\d.*)$/);
  if (noColonMatch) {
    let name = noColonMatch[1].trim();
    // Strip trailing colon if it ended up stuck to the name
    if (name.endsWith(":")) name = name.slice(0, -1).trim();
    return { name, stats: noColonMatch[2].trim() };
  }

  return null;
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
    const line = lines[i].trimEnd();
    if (!line.trim()) continue;

    // Detect and strip observer/disconnected prefix
    const trimmed = line.trimStart();
    const isObserver = trimmed.startsWith("*");
    const cleaned = isObserver ? trimmed.slice(1) : trimmed;

    const parsed = parsePlayerLine(cleaned);
    if (!parsed) continue;

    const parts = parsed.stats.split(/\s+/);

    // At minimum we expect: points, kills, deaths, suicides, ping
    if (parts.length < 5) continue;

    const name = parsed.name;
    const isBot = name.includes("[BOT]");
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
