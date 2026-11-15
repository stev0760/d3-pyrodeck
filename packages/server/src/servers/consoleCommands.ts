import { responseParser } from "../routes/server.js";
import { sessionManager } from "../session/sessionStore.js";
import type { ServerSession } from "../session/SessionManager.js";
import type { AddBotResult } from "../parser/parsers/addbot.js";
import type { PlaylistManager } from "../launcher/PlaylistManager.js";
import { playlistManager } from "../launcher/playlistInstance.js";
import { CONNECT_SERVER_ID, serverRegistry } from "./ServerRegistry.js";

/** A console to send commands to: a server Pyrodeck runs, or Connect mode's. */
export interface ConsoleTarget {
  /** The server's id (CONNECT_SERVER_ID for Connect mode); null before the servers exist. */
  serverId: string | null;
  session: ServerSession | undefined;
  /** The playlist that follows the server's timer ($netgameinfo, $settimelimit); none in Connect mode. */
  playlist: PlaylistManager | null;
}

/** The console of `serverId`, or of the default server; null for an unknown id. */
export function consoleTarget(serverId?: string | null): ConsoleTarget | null {
  if (!serverRegistry.isReady()) {
    // Before the servers exist: the one open session, as with one server.
    return { serverId: null, session: sessionManager.getActive(), playlist: playlistManager };
  }
  const id = serverId ?? serverRegistry.defaultServerId();
  if (id === CONNECT_SERVER_ID) return { serverId: id, session: serverRegistry.connectSession(), playlist: null };
  const server = id ? serverRegistry.get(id) : undefined;
  if (!server) return null;
  return { serverId: server.id, session: server.consoleSession(), playlist: server.playlist };
}

/** WebSocket message types for the replies Pyrodeck parses. */
const PARSED_TYPES: Record<string, string> = {
  $scores: "players",
  $botlist: "bots",
  $botstat: "botstats",
  $netgameinfo: "serverinfo",
  $botmode: "botmode",
  $botpopulation: "botpopulation",
};

export interface ConsoleCommandResult {
  raw: string;
  /** The parsed reply as the message the browsers know ($scores → players, ...), or null. */
  message: { type: string; payload: Record<string, unknown> } | null;
  /** What to show as an error toast (a refused or altered $addbot). */
  problems: string[];
}

/**
 * Send one console command and read the reply the way the console tab does:
 * parsed when Pyrodeck has a parser for it, with the playlist's timer kept
 * in step ($netgameinfo anchors it, $settimelimit moves it).
 */
export async function runConsoleCommand(target: ConsoleTarget, command: string): Promise<ConsoleCommandResult> {
  const session = target.session;
  if (!session) throw new Error("No active server connection");
  const raw = await session.connection.send(command);
  const result: ConsoleCommandResult = { raw, message: null, problems: [] };

  const commandName = command.split(" ")[0];
  if (responseParser.has(commandName)) {
    const parsed = responseParser.parse(commandName, raw);
    if (parsed.parsed) {
      const type = PARSED_TYPES[commandName];
      if (type) result.message = { type, payload: parsed.parsed as Record<string, unknown> };

      // A refused or altered $addbot is otherwise visible only in the console.
      if (commandName === "$addbot") {
        const added = parsed.parsed as AddBotResult;
        result.problems.push(...added.warnings);
        if (!added.ok && added.error) result.problems.push(added.error);
      }

      // $netgameinfo anchors the playlist's timer.
      if (commandName === "$netgameinfo") target.playlist?.parseAndAnchorFromNetgameinfo(raw);
    }
  }

  // $settimelimit: keep the playlist's timer in step.
  if (commandName === "$settimelimit") {
    const parts = command.trim().split(/\s+/);
    const newLimit = parts[1] ? parseInt(parts[1], 10) : NaN;
    if (!isNaN(newLimit)) target.playlist?.onTimelimitChanged(newLimit);
  }
  return result;
}
