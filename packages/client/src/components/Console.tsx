import { useEffect, useRef, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { createManagedTerminal } from "@/lib/xtermRenderer";
import type { Line } from "@/lib/lineBuffer";
import "@xterm/xterm/css/xterm.css";

interface ConsoleProps {
  onCommand: (command: string) => void;
  onOutput: (callback: (data: string) => void) => () => void;
  disabled?: boolean;
  /** Lines from before this terminal existed, written once under the banner. */
  replay?: readonly Line[];
}

export function Console({ onCommand, onOutput, disabled, replay }: ConsoleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const inputBufferRef = useRef("");
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  // Read at mount only: a changing buffer must not rebuild the terminal.
  const replayRef = useRef(replay);
  replayRef.current = replay;

  const writePrompt = useCallback(() => {
    terminalRef.current?.write("\r\n\x1b[33m>\x1b[0m ");
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const { terminal, dispose } = createManagedTerminal(containerRef.current, {
      theme: {
        background: "#09090b",
        foreground: "#d4d4d8",
        cursor: "#f59e0b",
        selectionBackground: "#f59e0b33",
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    });

    terminalRef.current = terminal;

    terminal.writeln("\x1b[1;33mD3 Pyrodeck Console\x1b[0m");
    terminal.writeln("\x1b[90mType commands to send to the D3 server\x1b[0m");
    for (const line of replayRef.current ?? []) {
      if (line.kind === "cmd") terminal.write(`\r\n\x1b[33m>\x1b[0m ${line.text}\r\n`);
      else if (line.kind === "out") terminal.write(`${line.text}\r\n`);
    }
    writePrompt();

    // Handle keyboard input
    terminal.onKey(({ key, domEvent }) => {
      if (disabled) return;

      const code = domEvent.keyCode;

      if (code === 13) {
        // Enter
        const command = inputBufferRef.current.trim();
        if (command) {
          historyRef.current.push(command);
          historyIndexRef.current = historyRef.current.length;
          terminal.write("\r\n");
          onCommand(command);
        }
        inputBufferRef.current = "";
        writePrompt();
      } else if (code === 8) {
        // Backspace
        if (inputBufferRef.current.length > 0) {
          inputBufferRef.current = inputBufferRef.current.slice(0, -1);
          terminal.write("\b \b");
        }
      } else if (code === 38) {
        // Arrow up — history
        if (historyIndexRef.current > 0) {
          historyIndexRef.current--;
          const cmd = historyRef.current[historyIndexRef.current];
          // Clear current input
          const clearLen = inputBufferRef.current.length;
          terminal.write("\b \b".repeat(clearLen));
          inputBufferRef.current = cmd;
          terminal.write(cmd);
        }
      } else if (code === 40) {
        // Arrow down — history
        const clearLen = inputBufferRef.current.length;
        terminal.write("\b \b".repeat(clearLen));

        if (historyIndexRef.current < historyRef.current.length - 1) {
          historyIndexRef.current++;
          const cmd = historyRef.current[historyIndexRef.current];
          inputBufferRef.current = cmd;
          terminal.write(cmd);
        } else {
          historyIndexRef.current = historyRef.current.length;
          inputBufferRef.current = "";
        }
      } else if (key.length === 1 && !domEvent.ctrlKey && !domEvent.altKey) {
        // Regular character
        inputBufferRef.current += key;
        terminal.write(key);
      }
    });

    return dispose;
  }, [disabled, onCommand, writePrompt]);

  // Subscribe to output from the server
  useEffect(() => {
    const unsubscribe = onOutput((data: string) => {
      if (terminalRef.current) {
        // D3 color codes are stripped server-side on raw bytes.
        // Just handle line endings for the terminal.
        const formatted = data.replace(/\r?\n/g, "\r\n");
        terminalRef.current.write(formatted);
      }
    });
    return unsubscribe;
  }, [onOutput]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full min-h-[300px] bg-[#09090b] rounded-lg overflow-hidden"
    />
  );
}
