import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { createManagedTerminal } from "@/lib/xtermRenderer";
import type { Line } from "@/lib/lineBuffer";
import "@xterm/xterm/css/xterm.css";

interface ServerConsoleProps {
  onProcessOutput: (callback: (data: string, stream: string) => void) => () => void;
  /** Output from before this terminal existed, written once under the banner. */
  replay?: readonly Line[];
}

export function ServerConsole({ onProcessOutput, replay }: ServerConsoleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  // Read at mount only: a changing buffer must not rebuild the terminal.
  const replayRef = useRef(replay);
  replayRef.current = replay;

  useEffect(() => {
    if (!containerRef.current) return;

    const { terminal, dispose } = createManagedTerminal(containerRef.current, {
      theme: {
        background: "#0c0a09",
        foreground: "#a8a29e",
        cursor: "#a8a29e",
        selectionBackground: "#f59e0b33",
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 12,
      cursorBlink: false,
      scrollback: 10000,
      disableStdin: true,
    });

    terminalRef.current = terminal;

    terminal.writeln("\x1b[90m--- D3 Server Output ---\x1b[0m");
    terminal.writeln("\x1b[90mWaiting for server process...\x1b[0m");
    for (const line of replayRef.current ?? []) {
      if (line.kind === "err") terminal.write(`\x1b[31m${line.text}\x1b[0m\r\n`);
      else terminal.write(`${line.text}\r\n`);
    }

    return dispose;
  }, []);

  // Subscribe to process output
  useEffect(() => {
    const unsubscribe = onProcessOutput((data: string, stream: string) => {
      if (!terminalRef.current) return;
      const formatted = data.replace(/\r?\n/g, "\r\n");
      if (stream === "stderr") {
        // Stderr in dim red
        terminalRef.current.write(`\x1b[31m${formatted}\x1b[0m`);
      } else {
        terminalRef.current.write(formatted);
      }
    });
    return unsubscribe;
  }, [onProcessOutput]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full min-h-[200px] bg-[#0c0a09] rounded-lg overflow-hidden"
    />
  );
}
