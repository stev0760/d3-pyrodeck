import { sessionManager } from "../routes/server.js";
import { activeConsoleProfileId } from "../events/consoleEventHub.js";
import type { ConsoleLink } from "./consoleLink.js";

/** The open console session, when it belongs to `profileId`. */
export function activeConsoleLink(profileId: string): ConsoleLink | null {
  if (activeConsoleProfileId() !== profileId) return null;
  const session = sessionManager.getActive();
  if (!session || session.state !== "ready") return null;
  return {
    profileId,
    capabilities: session.capabilities,
    send: (command) => session.connection.send(command),
  };
}

/** The open console session, whatever profile it belongs to. */
export function openConsoleLink(): ConsoleLink | null {
  const profileId = activeConsoleProfileId();
  return profileId ? activeConsoleLink(profileId) : null;
}

/** Whether the open console session is to this machine (where Pyrodeck edits hosts.deny). */
export function openConsoleIsLocal(): boolean | null {
  const session = sessionManager.getActive();
  if (!session) return null;
  const host = session.connectionInfo.host;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
