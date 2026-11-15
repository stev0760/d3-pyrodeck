import type { FastifyInstance } from "fastify";
import { TelnetConnection } from "../connection/TelnetConnection.js";
import { ResponseParser } from "../parser/ResponseParser.js";
import { parseServercaps, serializeCaps } from "../parser/parsers/servercaps.js";
import { CONNECT_OWNER, type ServerSession } from "../session/SessionManager.js";
import { sessionManager } from "../session/sessionStore.js";
import { probeCapabilities } from "../session/probeCapabilities.js";
import { serverBroadcast } from "../ws/wsHub.js";
import { CONNECT_SERVER_ID, serverRegistry, wireSessionToClients } from "../servers/ServerRegistry.js";
import { isLoopbackName } from "../middleware/requestSource.js";

export { sessionManager };
export const responseParser = new ResponseParser();

import { parseScores } from "../parser/parsers/scores.js";
import { parseBotlist } from "../parser/parsers/botlist.js";
import { parseBotstat } from "../parser/parsers/botstat.js";
import { parseNetgameinfo } from "../parser/parsers/netgameinfo.js";
import { parseAddbot } from "../parser/parsers/addbot.js";
import { parseBotmode } from "../parser/parsers/botmode.js";
import { parseBotpopulation } from "../parser/parsers/botpopulation.js";

// Register parsers
responseParser.register("$servercaps", parseServercaps);
responseParser.register("$scores", parseScores);
responseParser.register("$botlist", parseBotlist);
responseParser.register("$botstat", parseBotstat);
responseParser.register("$netgameinfo", parseNetgameinfo);
responseParser.register("$addbot", parseAddbot);
responseParser.register("$botmode", parseBotmode);
responseParser.register("$botpopulation", parseBotpopulation);

export { serializeCaps };

/**
 * The console session "the server" means for a client of a single-server
 * Pyrodeck: Connect mode's when the default server is Connect mode, else the
 * default server's (servers/ServerRegistry.ts defaultServerId).
 */
export function defaultConsoleSession(): ServerSession | undefined {
  if (!serverRegistry.isReady()) return sessionManager.getActive();
  const id = serverRegistry.defaultServerId();
  if (id === CONNECT_SERVER_ID) return serverRegistry.connectSession();
  return serverRegistry.defaultServer()?.consoleSession() ?? serverRegistry.connectSession();
}

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Connect mode: log in to a server's console that Pyrodeck did not launch.
   * One Connect-mode session at a time; it replaces the one before, and
   * leaves the consoles of the servers Pyrodeck runs alone.
   */
  app.post("/api/server/connect", async (request, reply) => {
    const { host, port, password } = request.body as {
      host?: string;
      port?: number;
      password?: string;
    };

    if (!host || !password) {
      return reply
        .status(400)
        .send({ error: "host and password are required" });
    }

    // Disconnect the Connect-mode session if any
    const existing = sessionManager.getOwned(CONNECT_OWNER);
    if (existing) {
      sessionManager.remove(existing.id);
    }

    const connection = new TelnetConnection();
    const session = sessionManager.create(connection, host, port ?? 2092, password, { owner: CONNECT_OWNER });

    try {
      sessionManager.updateState(session.id, "connecting");
      await connection.connect(host, port ?? 2092, password);

      // Probe for capabilities
      sessionManager.updateState(session.id, "probing");
      const capabilities = await probeCapabilities(connection, (late) => {
        if (sessionManager.getOwned(CONNECT_OWNER)?.id !== session.id) return;
        sessionManager.updateCapabilities(session.id, late);
        serverBroadcast(CONNECT_SERVER_ID, "capabilities", serializeCaps(late));
      });

      sessionManager.updateCapabilities(session.id, capabilities);
      sessionManager.updateState(session.id, "ready");
      wireSessionToClients(CONNECT_SERVER_ID, session);

      return {
        sessionId: session.id,
        state: "ready",
        capabilities: serializeCaps(capabilities),
      };
    } catch (err) {
      sessionManager.remove(session.id);
      let message = err instanceof Error ? err.message : String(err);
      // A refused, silent or prompt-less console on another machine is most
      // often one that takes local connections only.
      if (!isLoopbackName(host) && !message.startsWith("Authentication failed")) {
        message +=
          ". A server on another machine needs AllowRemoteConsole=1 in its dedicated.cfg and its console port " +
          "open to this machine; with AllowRemoteConsole=0 its console takes connections from its own machine only.";
      }
      return reply.status(502).send({ error: message });
    }
  });

  /** Close Connect mode's session; without one, the default server's console session (as with one server). */
  app.post("/api/server/disconnect", async (_request, reply) => {
    const session = serverRegistry.connectSession() ?? defaultConsoleSession();
    if (!session) {
      return reply.status(404).send({ error: "No active connection" });
    }
    sessionManager.remove(session.id);
    return { ok: true };
  });

  /** The default server's console session (GET /api/servers lists every server's). */
  app.get("/api/server/status", async () => {
    const session = defaultConsoleSession();
    if (!session) {
      return { state: "disconnected", capabilities: null };
    }
    return {
      state: session.state,
      sessionId: session.id,
      capabilities: serializeCaps(session.capabilities),
      connectionInfo: {
        host: session.connectionInfo.host,
        port: session.connectionInfo.port,
        connectedAt: session.connectionInfo.connectedAt,
      },
    };
  });
}
