import { sessionManager } from "../session/sessionStore.js";
import { serverRegistry } from "../servers/ServerRegistry.js";
import { defaultConsoleSession } from "../routes/server.js";
import { ConsoleEventSource } from "./ConsoleEventSource.js";
import type { ServerSession } from "../session/SessionManager.js";

/**
 * Whether a console host is this machine: a loopback name, or the address a
 * server Pyrodeck launched with -useip has its console on.
 */
export function isThisMachine(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    serverRegistry.list().some((s) => s.process.consoleHost() === host)
  );
}

/**
 * The server a console session's player and level events belong to: the
 * server Pyrodeck runs that opened it (its profile id, NO_PROFILE_ID without
 * one), or "connect:<host>:<port>" for Connect mode.
 */
export function consoleProfileId(session: ServerSession): string {
  if (session.profileId) return session.profileId;
  const { host, port } = session.connectionInfo;
  return `connect:${host}:${port}`;
}

/** One event source per open session, by session id. */
const sources = new Map<string, ConsoleEventSource>();

/** Read a session from its login on, so nothing printed after the connect is missed. */
function onSessionState(session: ServerSession): void {
  if (session.state === "disconnected") {
    sources.get(session.id)?.dispose();
    sources.delete(session.id);
    return;
  }
  if (session.state === "connecting" || sources.has(session.id)) return;
  const source = new ConsoleEventSource(consoleProfileId(session));
  session.connection.onData((chunk) => {
    if (sources.get(session.id) === source) source.feed(chunk);
  });
  sources.set(session.id, source);
}

/** The profile id of the default server's console session (routes/server.ts defaultConsoleSession), or null. */
export function activeConsoleProfileId(): string | null {
  const session = defaultConsoleSession();
  return session ? (sources.get(session.id)?.profileId ?? null) : null;
}

/** The profile id each open console session's events carry. */
export function openConsoleProfileIds(): string[] {
  return [...sources.values()].map((s) => s.profileId);
}

/** Start reading every console session Pyrodeck opens (every server's and Connect mode's). */
export function startConsoleEvents(): void {
  sessionManager.onStateChange(onSessionState);
}
