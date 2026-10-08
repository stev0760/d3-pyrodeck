import { sessionManager } from "../routes/server.js";
import { processManager } from "../routes/launcher.js";
import { ConsoleEventSource } from "./ConsoleEventSource.js";
import { NO_PROFILE_ID } from "./ServerEvents.js";
import type { ServerSession } from "../session/SessionManager.js";

/**
 * Whether a console host is this machine: a loopback name, or the address a
 * server Pyrodeck launched with -useip has its console on.
 */
export function isThisMachine(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === processManager.consoleHost();
}

/**
 * The profile a console session belongs to: the launched profile when the
 * session is to Pyrodeck's own launch (this machine, its console port),
 * otherwise "connect:<host>:<port>". A launch without a profile is
 * NO_PROFILE_ID.
 */
export function consoleProfileId(host: string, port: number): string {
  const status = processManager.getStatus();
  const launched = status.state === "running" || status.state === "starting";
  if (launched && isThisMachine(host) && port === processManager.getLaunchConfig()?.telnetPort) {
    return status.activeProfileId ?? NO_PROFILE_ID;
  }
  return `connect:${host}:${port}`;
}

let current: { sessionId: string; source: ConsoleEventSource } | null = null;

/** Read a session from its login on, so nothing printed after the connect is missed. */
function onSessionState(session: ServerSession): void {
  if (session.state === "disconnected") {
    if (current?.sessionId === session.id) {
      current.source.dispose();
      current = null;
    }
    return;
  }
  if (session.state === "connecting" || current?.sessionId === session.id) return;
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
  sessionManager.onStateChange(onSessionState);
}
