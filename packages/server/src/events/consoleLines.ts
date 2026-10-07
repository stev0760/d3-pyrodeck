/**
 * Unsolicited remote-console lines that say who joined, who left, who said
 * what, and which level is loading.
 *
 * Everything here reaches the console through PrintDedicatedMessage
 * (Descent3/dedicated_server.cpp), which writes to stdout and to every
 * logged-in console connection. A HUD message on a dedicated server is printed
 * as "*<text>" (AddLineToHUDMessages, Descent3/hudmessage.cpp:425). Texts
 * marked TXT_* come from the game's string tables; the strings below are the
 * ones a Matcen 0.9.16 server printed (verified 2026-10-07).
 *
 *   join   "*<name> has joined the Anarchy"     netgames/anarchy (also Robo-Anarchy)
 *          "*<name> has joined CTF"             netgames/ctf
 *          "*<name> has joined the Hyper Anarchy!"
 *          "*<name> has joined the Hoard"
 *          "*<name> has joined the game"        Co-op
 *          "*<name> has joined the <team> Team" Team Anarchy
 *          "*<name> Has Joined The <team> Team" Monsterball, Entropy
 *          Printed by the game DLL's OnClientPlayerEntersGame for every player
 *          entering a level, so it repeats for each player at every level.
 *   leave  "*<name> has left the game"   MultiDoLeaveGame, Descent3/multi.cpp:3635
 *          "*<name> disconnected!"       MultiDisconnectPlayer, Descent3/multi_server.cpp:1108
 *                                        (time-outs, $kick, $ban)
 *   bots   "Bot '<name>' added in slot <n> (ship=..., team=<t>)"  $addbot, dedicated_server.cpp:905
 *          "  Bot '<name>' spawned (ship=..., slot=<n>)"         roster load, bot.cpp:9983
 *          "Removing bot '<name>' from slot <n>"                 $removebot, dedicated_server.cpp:918
 *          "All bots removed"                                    $removebots, dedicated_server.cpp:930
 *          A removed bot prints no "has left" line (BotRemove, bot.cpp:9115).
 *   chat   "*<name> says: <text>"  TXT_HUDSAY (stringtable.h:148). A client builds this
 *          text itself (SendHUDChatText, hudmessage.cpp:828) and the server prints it
 *          as received (MultiDoMessageToServer, multi.cpp:4993), so the name is the
 *          sender's own claim. Team and private chat do not reach the console.
 *   level  "Opening level '<file>'..."  TXT_DS_OPENLEVEL, Descent3/LoadLevel.cpp:3688
 *
 * The dedicated server's own player is "-Server-" (TXT_DS_SERVERNAME,
 * dedicated_server.cpp:301); its `say` lines are not player chat.
 */

export const SERVER_CALLSIGN = "-Server-";

export type ConsoleLine =
  | { kind: "join"; name: string }
  | { kind: "leave"; name: string; how: "left" | "dropped" }
  | { kind: "bot-added"; name: string; slot: number }
  | { kind: "bot-removed"; name: string; slot: number }
  | { kind: "bots-cleared" }
  | { kind: "chat"; name: string; text: string }
  | { kind: "level"; level: string };

/** Bot callsigns carry an engine-added "[BOT]" tag ("Viper[BOT]"; "[BOT] Viper" before Matcen 0.9.9). */
export function isBotName(name: string): boolean {
  return /\[BOT\]$/.test(name) || /^\[BOT\] /.test(name);
}

const JOIN_TAIL = "(?:CTF|the Anarchy|the Hyper Anarchy!|the Hoard|the game|[Tt]he .+ Team)";
const JOIN_RE = new RegExp(`^\\*(.+) (?:has joined|Has Joined) ${JOIN_TAIL}$`);
const LEFT_RE = /^\*(.+) has left the game!?$/;
const DROPPED_RE = /^\*(.+) disconnected!$/;
const CHAT_RE = /^\*(.+?) says: (.*)$/;
const BOT_ADDED_RE = /^Bot '(.+)' added in slot (\d+) \(/;
const BOT_SPAWNED_RE = /^\s*Bot '(.+)' spawned \(.*slot=(\d+)\)$/;
const BOT_REMOVED_RE = /^Removing bot '(.+)' from slot (\d+)$/;
const OPENING_RE = /Opening level '([^']+)'/;

/**
 * Classify one console line (CR/LF already removed). Returns null for lines
 * that are none of the above, including command echoes ("[127.0.0.1] ...")
 * and command replies.
 */
export function parseConsoleLine(rawLine: string): ConsoleLine | null {
  // "Ending level." is printed without a newline, so the next line can follow
  // it on the same line (see PlaylistManager).
  let line = rawLine.trim().replace(/^(?:Ending level\.)+/, "");
  if (!line) return null;

  const opening = OPENING_RE.exec(line);
  if (opening) return { kind: "level", level: opening[1].replace(/\.d3l$/i, "") };

  if (line.startsWith("*")) {
    // Chat first: a chat line's text must never read as a join or a leave.
    const chat = CHAT_RE.exec(line);
    if (chat) return { kind: "chat", name: chat[1], text: chat[2] };
    const join = JOIN_RE.exec(line);
    if (join) return { kind: "join", name: join[1] };
    const left = LEFT_RE.exec(line);
    if (left) return { kind: "leave", name: left[1], how: "left" };
    const dropped = DROPPED_RE.exec(line);
    if (dropped) return { kind: "leave", name: dropped[1], how: "dropped" };
    return null;
  }

  line = line.replace(/\s+$/, "");
  const added = BOT_ADDED_RE.exec(line) ?? BOT_SPAWNED_RE.exec(line);
  if (added) return { kind: "bot-added", name: added[1], slot: Number(added[2]) };
  const removed = BOT_REMOVED_RE.exec(line);
  if (removed) return { kind: "bot-removed", name: removed[1], slot: Number(removed[2]) };
  if (line === "All bots removed") return { kind: "bots-cleared" };
  return null;
}

/** Splits a console byte stream into lines, holding back a partial last line. */
export class LineSplitter {
  private carry = "";

  push(chunk: string): string[] {
    let text = this.carry + chunk;
    // The console ends lines with CR LF; a chunk ending in CR may be half of one.
    const heldCr = text.endsWith("\r");
    if (heldCr) text = text.slice(0, -1);
    const parts = text.split(/\r\n|\n|\r/);
    this.carry = (parts.pop() ?? "") + (heldCr ? "\r" : "");
    // A single huge partial line (no newline for a long time) is not ours to keep.
    if (this.carry.length > 4096) this.carry = "";
    return parts;
  }
}
