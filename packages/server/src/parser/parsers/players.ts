/**
 * Parser for $players output (DMFC, any game type).
 *
 * DMFCInputCommand_Players (netgames/dmfc/dmfcinputcommand.cpp:394) prints a
 * "PNum Name" header, then "%02d: %s\n" for every slot with a connected,
 * playing player (DMFCBase::CheckPlayerNum, netgames/dmfc/dmfcbase.cpp:1801):
 *
 *   PNum Name
 *   00: -Server-
 *   01: Viper[BOT]
 *   03: Hunter
 *
 * On a dedicated server slot 0 is the server itself (multi_server.cpp:757
 * sets Player_num = 0 and flags it NPF_SERVER; dedicated_server.cpp:301 names
 * it "-Server-"). Matcen bots carry a "[BOT]" callsign suffix.
 */

export interface ListedPlayer {
  slot: number;
  name: string;
  isServer: boolean;
  isBot: boolean;
}

const LINE = /^\s*(\d{1,2}): (.*)$/;

export function parsePlayers(raw: string): ListedPlayer[] {
  const players: ListedPlayer[] = [];
  for (const line of raw.split("\n")) {
    const m = LINE.exec(line.trimEnd());
    if (!m) continue;
    const slot = Number(m[1]);
    const name = m[2];
    players.push({ slot, name, isServer: slot === 0, isBot: /\[BOT\]$/.test(name.trim()) });
  }
  return players;
}

/** Human players in a $players listing: not the server's own slot, not a bot. */
export function countHumanPlayers(raw: string): number {
  return parsePlayers(raw).filter((p) => !p.isServer && !p.isBot).length;
}
