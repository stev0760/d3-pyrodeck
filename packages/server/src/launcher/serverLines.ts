/**
 * Parsers for the dedicated server's output lines that Pyrodeck acts on.
 *
 * Everything here reaches both the process's stdout and every remote console
 * connection: the engine prints it with PrintDedicatedMessage, which writes to
 * the console and to each telnet socket (Matcen `Descent3/dedicated_server.cpp`
 * PrintDedicatedMessage). HUD messages, the join, leave and chat lines among
 * them, are printed as `*<text>` on a dedicated server (hudmessage.cpp
 * AddLineToHUDMessages). The texts come from the English string tables; a
 * server running other string tables prints other words and these parsers
 * miss them.
 */

export type ServerLine =
  /** A player entered the game (the game mode's welcome line). */
  | { kind: "join"; name: string }
  /** A player left or was disconnected. */
  | { kind: "leave"; name: string }
  /** `*<name> says: <text>` (D3.STR string 117). */
  | { kind: "chat"; name: string; text: string }
  /** `Opening level '<file>'...` (LoadLevel.cpp, TXT_DS_OPENLEVEL); `level` has no `.d3l`. */
  | { kind: "level-opening"; level: string }
  /** `Ending level.` (multi.cpp, TXT_DS_ENDINGLEVEL). */
  | { kind: "level-ending" }
  /**
   * The console echo of a `quit` someone typed at a remote console:
   * `[<address>] quit` (dedicated_server.cpp DedicatedReadTelnet echoes every
   * line; `Quit` is a console variable whose setter leaves the game).
   */
  | { kind: "console-quit"; from: string };

/**
 * The welcome line each game mode prints when another player enters, after
 * the name (netgames `DisplayWelcomeMessage`, English string tables):
 * Anarchy and Robo-Anarchy "has joined the Anarchy", CTF "has joined CTF",
 * Hyper-Anarchy "has joined the Hyper Anarchy!", Hoard "has joined the Hoard",
 * Co-op "has joined the game", Team Anarchy "has joined the <team> Team",
 * Entropy and Monsterball "Has Joined The <team> Team".
 */
const JOIN_RE = /^(.+?) has joined (?:the Anarchy|CTF|the Hyper Anarchy!|the Hoard|the game|the .+ Team)$/i;

/**
 * "%s has left the game" (D3.STR 147, multi.cpp MultiDoLeaveGame: the client
 * quit) and "%s disconnected!" (D3.STR 247, multi_server.cpp
 * MultiDisconnectPlayer: timeout or kick). String 149, "%s disconnected", is
 * the client-side variant; it is accepted too.
 */
const LEAVE_RE = /^(.+?) (?:has left the game!?|disconnected!?)$/;

const CHAT_RE = /^(.+?) says: (.*)$/;

const OPENING_RE = /Opening level '([^']+)'/;

const QUIT_ECHO_RE = /^\[([^\]]+)\] quit(?:\s.*)?$/i;

/** Matcen bot callsigns end in `[BOT]` (bot.h BOT_NAME_SUFFIX). */
export function isBotCallsign(name: string): boolean {
  return /\[BOT\]$/.test(name.trim());
}

/**
 * Drop what a level-load status line left in front of the text. The engine
 * prints its load progress without a newline and erases it with backspaces
 * (Mission.cpp LoadLevelProgress), so the next message can land on the same
 * line: "...level 1 100 Percent Complete*Reaper[BOT] has joined CTF".
 * A line that already starts as a HUD message is left alone, so chat text
 * cannot pose as a status prefix and smuggle in a join or leave.
 */
function normalize(raw: string): string {
  let text = raw.replace(/\r/g, "").trim();
  if (text.startsWith("*")) return text;
  const lastBackspace = text.lastIndexOf("\b");
  if (lastBackspace >= 0) text = text.slice(lastBackspace + 1);
  const progress = text.lastIndexOf("Percent Complete");
  if (progress >= 0) text = text.slice(progress + "Percent Complete".length);
  return text.trim();
}

/** Parse one output line; null when it is none of the lines in {@link ServerLine}. */
export function parseServerLine(raw: string): ServerLine | null {
  const line = normalize(raw);
  if (!line) return null;

  // HUD messages. Chat first: a player can type "x has joined CTF".
  if (line.startsWith("*")) {
    const hud = line.slice(1);
    const chat = CHAT_RE.exec(hud);
    if (chat) return { kind: "chat", name: chat[1], text: chat[2] };
    const join = JOIN_RE.exec(hud);
    if (join) return { kind: "join", name: join[1] };
    const leave = LEAVE_RE.exec(hud);
    if (leave) return { kind: "leave", name: leave[1] };
    return null;
  }

  const quit = QUIT_ECHO_RE.exec(line);
  if (quit) return { kind: "console-quit", from: quit[1] };

  // Debug builds glue a log line onto these (the engine prints them without
  // a newline), so match anywhere in the line.
  const opening = OPENING_RE.exec(line);
  if (opening) return { kind: "level-opening", level: opening[1].replace(/\.d3l$/i, "") };
  if (line.includes("Ending level.")) return { kind: "level-ending" };
  return null;
}

export interface PlayersEntry {
  slot: number;
  name: string;
}

/**
 * Parse a `$players` reply: the header "PNum Name" (DMFC.str 240), then
 * "%02d: %s" per player in the game (dmfcinputcommand.cpp
 * DMFCInputCommand_Players). Slot 0 is the dedicated server itself. Other
 * lines that arrived in the reply window (kill messages, chat) are skipped.
 * Null when the reply has no header: not a `$players` answer.
 */
export function parsePlayersReply(reply: string): PlayersEntry[] | null {
  const lines = reply.split("\n").map((l) => l.replace(/\r/g, "").trim());
  const header = lines.findIndex((l) => /^PNum\s+Name$/.test(l));
  if (header < 0) return null;
  const entries: PlayersEntry[] = [];
  for (const line of lines.slice(header + 1)) {
    const m = /^(\d{1,2}): (.+)$/.exec(line);
    if (m) entries.push({ slot: Number(m[1]), name: m[2] });
  }
  return entries;
}

/** The humans in a `$players` reply: not slot 0 (the server), not bots. */
export function humansIn(entries: PlayersEntry[]): string[] {
  return entries.filter((e) => e.slot !== 0 && !isBotCallsign(e.name)).map((e) => e.name);
}

// A load-status run without a newline can grow for the whole load; anything
// longer than this without a newline is not a line we parse.
const MAX_PARTIAL_LINE = 64 * 1024;

/** Cuts a stream of output chunks into complete lines. */
export class LineSplitter {
  private partial = "";

  push(chunk: string): string[] {
    this.partial += chunk;
    const lines = this.partial.split("\n");
    this.partial = lines.pop() ?? "";
    if (this.partial.length > MAX_PARTIAL_LINE) this.partial = "";
    return lines;
  }

  reset(): void {
    this.partial = "";
  }
}
