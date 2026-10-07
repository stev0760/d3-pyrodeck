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
