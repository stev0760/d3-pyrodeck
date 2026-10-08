import { LineSplitter } from "../events/consoleLines.js";

const QUIT_ECHO_RE = /^\[([^\]]+)\] quit(?:\s.*)?$/i;

/**
 * The echo of a `quit` someone typed at a remote console, `[<address>] quit`:
 * the address, or null for any other line. The server echoes every console
 * line to its output (dedicated_server.cpp DedicatedReadTelnet); `Quit` is a
 * console variable whose setter leaves the game (SetCVarNone, CVAR_QUIT).
 */
export function parseConsoleQuit(line: string): string | null {
  return QUIT_ECHO_RE.exec(line.replace(/^[\s\b]+/, "").replace(/\s+$/, ""))?.[1] ?? null;
}

/**
 * Watches one server's output for a `quit` typed at a remote console, so its
 * exit counts as a stop on request (ProcessManager.noteConsoleQuit), not a
 * crash. Fed from the launched process's stdout, or from the console for a
 * re-attached one (no stdout then). Joins, leaves, chat and level starts are
 * read by the console event hub (events/consoleEventHub.ts), not here.
 */
export class ConsoleQuitWatch {
  private splitter = new LineSplitter();

  constructor(private readonly onQuit: (from: string) => void) {}

  /** Start reading a new process's output. */
  reset(): void {
    this.splitter = new LineSplitter();
  }

  push(chunk: string): void {
    for (const line of this.splitter.push(chunk)) {
      const from = parseConsoleQuit(line);
      if (from !== null) this.onQuit(from);
    }
  }
}
