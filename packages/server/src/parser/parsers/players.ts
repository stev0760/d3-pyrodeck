/**
 * Parsers for the DMFC player commands (netgames/dmfc/dmfcinputcommand.cpp).
 *
 * `$players` (DMFCInputCommand_Players, :394) prints a header and one line per
 * player that passes CheckPlayerNum (connected and in the level; bots too):
 *   PNum Name
 *   00: -Server-
 *   01: Alpha[BOT]
 * The slot is printf'd "%02d". Players still loading a level are not listed.
 *
 * `$playerinfo <slot>` (DMFCInputCommand_PlayerInfo, :238) prints, through
 * DMFCBase::DisplayPlayerInfo (dmfcbase.cpp:1622):
 *   *Getting Playerinfo for Alpha[BOT]      (HUD line, only for a valid slot)
 *   Alpha[BOT] (Client)
 *   Team: Red                               (team games only)
 *   PlayerNum: 1
 *   IP: 127.0.1.1:0                         (nw_GetNumbersFromHostAddress, networking.cpp:825)
 *   Ship: Pyro-GL
 *   (blank line)
 *   Total Time In Game: 6 seconds
 * For a slot that is not in the game it prints the PREVIOUS player shown, if
 * that one is still in the game (DisplayPlayerInfo reads m_iPlayerDisplayed),
 * so a caller must check that the reply names the slot it asked for.
 *
 * Unsolicited lines (kills, joins) can land inside a reply; both parsers pick
 * their lines out by shape and ignore the rest.
 */

export interface PlayerSlot {
  slot: number;
  name: string;
}

export interface ParsedPlayers {
  players: PlayerSlot[];
}

export function parsePlayers(raw: string): ParsedPlayers | null {
  const lines = raw.split(/\r?\n/);
  if (!lines.some((l) => /^PNum Name\s*$/.test(l.trim()))) return null;
  const players: PlayerSlot[] = [];
  for (const line of lines) {
    const m = /^(\d{2,3}): (.*)$/.exec(line.replace(/\r$/, ""));
    if (m) players.push({ slot: Number(m[1]), name: m[2] });
  }
  return { players };
}

export interface PlayerInfo {
  name: string;
  role: "Server" | "Client";
  slot: number;
  team: string | null;
  ip: string | null;
  port: number | null;
  ship: string | null;
}

export function parsePlayerinfo(raw: string): PlayerInfo | null {
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/\r$/, ""));
  let name: string | null = null;
  let role: "Server" | "Client" = "Client";
  let slot: number | null = null;
  let team: string | null = null;
  let ip: string | null = null;
  let port: number | null = null;
  let ship: string | null = null;

  for (const line of lines) {
    if (line.startsWith("*")) continue;
    let m: RegExpExecArray | null;
    if (slot === null && (m = /^PlayerNum: (\d+)$/.exec(line))) {
      slot = Number(m[1]);
    } else if ((m = /^IP: (\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/.exec(line))) {
      ip = m[1];
      port = m[2] !== undefined ? Number(m[2]) : null;
    } else if ((m = /^Ship: (.+)$/.exec(line))) {
      ship = m[1];
    } else if ((m = /^Team: (.+)$/.exec(line))) {
      team = m[1];
    } else if (name === null && (m = /^(.+) \((Server|Client)\)$/.exec(line))) {
      name = m[1];
      role = m[2] as "Server" | "Client";
    }
  }
  if (name === null || slot === null) return null;
  return { name, role, slot, team, ip, port, ship };
}
