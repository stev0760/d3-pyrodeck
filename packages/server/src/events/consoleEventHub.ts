import { sessionManager } from "../routes/server.js";
import { processManager } from "../routes/launcher.js";
import { ConsoleEventSource } from "./ConsoleEventSource.js";

/** How often to look for a new console session to read. */
const SESSION_CHECK_MS = 1000;

/**
 * The profile a console session belongs to: the launched profile when the
 * session is Pyrodeck's own launch, otherwise "connect:<host>:<port>". A
 * launch without a profile is "launch".
 */
export function consoleProfileId(host: string, port: number): string {
  const status = processManager.getStatus();
  const launched = status.state === "running" || status.state === "starting";
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (launched && local) return status.activeProfileId ?? "launch";
  return `connect:${host}:${port}`;
}

let current: { sessionId: string; source: ConsoleEventSource } | null = null;

function attachToActiveSession(): void {
  const session = sessionManager.getActive();
  if (!session || session.state !== "ready") {
    if (current && (!session || session.id !== current.sessionId)) {
      current.source.dispose();
      current = null;
    }
    return;
  }
  if (current?.sessionId === session.id) return;
  current?.source.dispose();
  const { host, port } = session.connectionInfo;
  const source = new ConsoleEventSource(consoleProfileId(host, port));
  session.connection.onData((chunk) => {
    if (current?.source === source) source.feed(chunk);
  });
  current = { sessionId: session.id, source };
}

/** The profile id of the console session being read, or null. */
export function activeConsoleProfileId(): string | null {
  return current?.source.profileId ?? null;
}

/** Start reading every console session Pyrodeck opens (Connect and Launch mode). */
export function startConsoleEvents(): void {
  setInterval(attachToActiveSession, SESSION_CHECK_MS).unref();
}
