import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface ServerConsoleProps {
  onProcessOutput: (callback: (data: string, stream: string) => void) => () => void;
}

export function ServerConsole({ onProcessOutput }: ServerConsoleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
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

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.writeln("\x1b[90m--- D3 Server Output ---\x1b[0m");
    terminal.writeln("\x1b[90mWaiting for server process...\x1b[0m");

    // Handle window resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
    };
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
