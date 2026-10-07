import { serverEvents, type ServerEvents } from "../events/ServerEvents.js";
import { LineSplitter, isBotCallsign, parseServerLine } from "./serverLines.js";

/**
 * Reads one server's output and puts what it means on the event bus:
 * `player.joined`, `player.left` and `player.chat` for humans, and
 * `level.started` when a level opens.
 *
 * Fed from exactly one source per process so nothing is reported twice: the
 * process's stdout when Pyrodeck launched it, the remote console when it
 * re-attached to a running server (no stdout then). Both carry the same
 * lines (see serverLines.ts).
 */
export class ServerLineMonitor {
  /** Called when someone typed `quit` at a remote console (the echo was seen). */
  onConsoleQuit: ((from: string) => void) | null = null;

  private readonly splitter = new LineSplitter();
  private profileId = "";

  constructor(private readonly events: ServerEvents = serverEvents) {}

  /** Start reading a new process's output for `profileId`. */
  reset(profileId: string): void {
    this.profileId = profileId;
    this.splitter.reset();
  }

  push(chunk: string): void {
    for (const raw of this.splitter.push(chunk)) {
      const line = parseServerLine(raw);
      if (!line) continue;
      const profileId = this.profileId;
      switch (line.kind) {
        case "join":
          if (!isBotCallsign(line.name)) this.events.emitEvent("player.joined", { profileId, name: line.name });
          break;
        case "leave":
          if (!isBotCallsign(line.name)) this.events.emitEvent("player.left", { profileId, name: line.name });
          break;
        case "chat":
          if (!isBotCallsign(line.name)) {
            this.events.emitEvent("player.chat", { profileId, name: line.name, text: line.text });
          }
          break;
        case "level-opening":
          this.events.emitEvent("level.started", { profileId, level: line.level });
          break;
        case "console-quit":
          this.onConsoleQuit?.(line.from);
          break;
        case "level-ending":
          break;
      }
    }
  }
}
