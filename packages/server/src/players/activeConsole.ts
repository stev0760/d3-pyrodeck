import { sessionManager } from "../session/sessionStore.js";
import { defaultConsoleSession } from "../routes/server.js";
import { consoleProfileId, isThisMachine } from "../events/consoleEventHub.js";
import type { ServerSession } from "../session/SessionManager.js";
import type { ConsoleLink } from "./consoleLink.js";

function linkOf(session: ServerSession): ConsoleLink {
  return {
    profileId: consoleProfileId(session),
    capabilities: session.capabilities,
    send: (command) => session.connection.send(command),
  };
}

/** The logged-in console session of the server whose events carry `profileId`. */
export function activeConsoleLink(profileId: string): ConsoleLink | null {
  const session = sessionManager.list().find((s) => s.state === "ready" && consoleProfileId(s) === profileId);
  return session ? linkOf(session) : null;
}

/** The default server's console session, once logged in. */
export function openConsoleLink(): ConsoleLink | null {
  const session = defaultConsoleSession();
  return session?.state === "ready" ? linkOf(session) : null;
}

/** Every logged-in console session: every server's, and Connect mode's. */
export function openConsoleLinks(): ConsoleLink[] {
  return sessionManager.list().filter((s) => s.state === "ready").map(linkOf);
}

/** Whether the default server's console session is to this machine (where Pyrodeck edits hosts.deny). */
export function openConsoleIsLocal(): boolean | null {
  const session = defaultConsoleSession();
  if (!session) return null;
  return isThisMachine(session.connectionInfo.host);
}
