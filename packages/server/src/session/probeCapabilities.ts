import type { ServerConnection } from "../connection/ServerConnection.js";
import {
  parseServercaps,
  VANILLA_CAPS,
  type ServerCapabilities,
} from "../parser/parsers/servercaps.js";

// Matcen spec §3.3 (2026-09-20): builds before Matcen 0.9.15 can stop
// servicing the console for seconds (up to ~100s) at a level start, so one
// unanswered probe must not permanently mean "vanilla". An EMPTY reply means
// the server hasn't answered yet; any non-empty reply without a SERVERCAPS
// line is a real answer from a vanilla server.
//
// The first probe decides the connect result so the UI never waits on it.
// After an empty reply we keep re-probing in the background (each send waits
// up to TelnetConnection's 5s first-chunk timeout, so ~30s total) and report
// fork capabilities through onLateCaps if they turn up.
export const LATE_PROBE_ATTEMPTS = 5;
export const LATE_PROBE_INTERVAL_MS = 1000;

function vanilla(): ServerCapabilities {
  return { ...VANILLA_CAPS, features: new Set() };
}

async function probeOnce(
  connection: ServerConnection,
): Promise<{ caps: ServerCapabilities | null; answered: boolean }> {
  try {
    const response = await connection.send("$servercaps");
    return { caps: parseServercaps(response), answered: response.trim() !== "" };
  } catch {
    return { caps: null, answered: false };
  }
}

export async function probeCapabilities(
  connection: ServerConnection,
  onLateCaps: (caps: ServerCapabilities) => void,
  intervalMs = LATE_PROBE_INTERVAL_MS,
): Promise<ServerCapabilities> {
  return (await probeCapabilitiesDetailed(connection, onLateCaps, intervalMs)).caps;
}

/**
 * As probeCapabilities, but also says whether the first probe got any answer.
 * `answered: false` means the console was silent (the vanilla caps returned
 * are a placeholder); the playlist restart health check waits for late caps
 * in that case instead of calling the server healthy.
 */
export async function probeCapabilitiesDetailed(
  connection: ServerConnection,
  onLateCaps: (caps: ServerCapabilities) => void,
  intervalMs = LATE_PROBE_INTERVAL_MS,
): Promise<{ caps: ServerCapabilities; answered: boolean }> {
  const first = await probeOnce(connection);
  if (first.caps) return { caps: first.caps, answered: true };
  if (first.answered) return { caps: vanilla(), answered: true };

  void (async () => {
    for (let i = 0; i < LATE_PROBE_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (!connection.isConnected()) return;
      const retry = await probeOnce(connection);
      if (retry.caps) {
        onLateCaps(retry.caps);
        return;
      }
      if (retry.answered) return;
    }
  })();

  return { caps: vanilla(), answered: false };
}
