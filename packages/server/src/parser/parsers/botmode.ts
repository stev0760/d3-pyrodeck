/**
 * Parser for $botmode output (Matcen contract, PYRODECK_CONTRACT §4, Tier 1).
 *
 *   Game mode: Team Anarchy (scriptname='team anarchy', teams=2)
 *
 * Mode names, exactly as the fork's BotGameModeName returns them: Anarchy,
 * Team Anarchy, Robo-Anarchy, Co-op, CTF, Hyper-Anarchy, Hoard, Entropy,
 * Monsterball, Unknown. Two contain a space and three a hyphen, so the name is
 * matched up to " (scriptname=".
 *
 * $botobj also prints a "Game mode: <name>" line, without the parenthesised
 * part; that line does not match here.
 */

export interface BotMode {
  mode: string;
  scriptName: string;
  teams: number;
}

const BOTMODE_RE = /Game mode: (.+?) \(scriptname='(.*)', teams=(\d+)\)/;

export function parseBotmode(raw: string): BotMode | null {
  for (const line of raw.split("\n")) {
    const m = line.trim().match(BOTMODE_RE);
    if (m) {
      return { mode: m[1], scriptName: m[2], teams: parseInt(m[3], 10) };
    }
  }
  return null;
}
