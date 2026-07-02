import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

/**
 * Switch a terminal to the GPU-accelerated WebGL renderer. xterm's default
 * DOM renderer chokes on sustained high-rate writes (D3 debug builds emit
 * hundreds of log lines/sec), especially in Firefox. Falls back silently to
 * the DOM renderer when WebGL is unavailable (GPU blocklists, headless
 * browsers, context exhaustion).
 */
export function enableWebglRenderer(terminal: Terminal): void {
  try {
    const addon = new WebglAddon();
    // A lost context (GPU reset, too many live contexts) leaves the addon
    // unusable — dispose so xterm falls back to the DOM renderer.
    addon.onContextLoss(() => addon.dispose());
    terminal.loadAddon(addon);
  } catch {
    // WebGL unavailable — the DOM renderer keeps working, just slower.
  }
}

export interface ManagedTerminal {
  terminal: Terminal;
  /** Tear down the resize observer and the terminal itself. */
  dispose: () => void;
}

/**
 * Create a terminal wired the way every Pyrodeck console needs it: opened in
 * the container, WebGL-rendered where possible, and kept fitted to the
 * container via a ResizeObserver.
 */
export function createManagedTerminal(
  container: HTMLElement,
  options: ITerminalOptions,
): ManagedTerminal {
  const terminal = new Terminal(options);
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  enableWebglRenderer(terminal);
  fitAddon.fit();

  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
  });
  resizeObserver.observe(container);

  return {
    terminal,
    dispose: () => {
      resizeObserver.disconnect();
      terminal.dispose();
    },
  };
}
