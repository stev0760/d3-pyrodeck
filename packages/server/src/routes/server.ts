import type { FastifyInstance } from "fastify";
import { TelnetConnection } from "../connection/TelnetConnection.js";
import { ResponseParser } from "../parser/ResponseParser.js";
import {
  parseServercaps,
  VANILLA_CAPS,
  type ServerCapabilities,
} from "../parser/parsers/servercaps.js";
import { SessionManager } from "../session/SessionManager.js";
import { wireSessionToClients } from "./command.js";

export const sessionManager = new SessionManager();
export const responseParser = new ResponseParser();

import { parseScores } from "../parser/parsers/scores.js";
import { parseBotlist } from "../parser/parsers/botlist.js";
import { parseBotstat } from "../parser/parsers/botstat.js";
import { parseNetgameinfo } from "../parser/parsers/netgameinfo.js";

// Register parsers
responseParser.register("$servercaps", parseServercaps);
responseParser.register("$scores", parseScores);
responseParser.register("$botlist", parseBotlist);
responseParser.register("$botstat", parseBotstat);
responseParser.register("$netgameinfo", parseNetgameinfo);

/** Serialize capabilities for JSON (Set -> array). */
export function serializeCaps(caps: ServerCapabilities) {
  return {
    version: caps.version,
    fork: caps.fork,
    forkVersion: caps.forkVersion,
    features: [...caps.features],
  };
}

export async function serverRoutes(app: FastifyInstance): Promise<void> {
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

    // Disconnect existing session if any
    const existing = sessionManager.getActive();
    if (existing) {
      sessionManager.remove(existing.id);
    }

    const connection = new TelnetConnection();
    const session = sessionManager.create(
      connection,
      host,
      port ?? 2092,
      password,
    );

    try {
      sessionManager.updateState(session.id, "connecting");
      await connection.connect(host, port ?? 2092, password);

      // Probe for capabilities
      sessionManager.updateState(session.id, "probing");
      let capabilities: ServerCapabilities;
      try {
        const capsResponse = await connection.send("$servercaps");
        const parsed = parseServercaps(capsResponse);
        capabilities = parsed ?? { ...VANILLA_CAPS, features: new Set() };
      } catch {
        // Probe failure is non-fatal — treat as vanilla
        capabilities = { ...VANILLA_CAPS, features: new Set() };
      }

      sessionManager.updateCapabilities(session.id, capabilities);
      sessionManager.updateState(session.id, "ready");
      wireSessionToClients();

      return {
        sessionId: session.id,
        state: "ready",
        capabilities: serializeCaps(capabilities),
      };
    } catch (err) {
      sessionManager.remove(session.id);
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: message });
    }
  });

  app.post("/api/server/disconnect", async (_request, reply) => {
    const session = sessionManager.getActive();
    if (!session) {
      return reply.status(404).send({ error: "No active connection" });
    }
    sessionManager.remove(session.id);
    return { ok: true };
  });

  app.get("/api/server/status", async () => {
    const session = sessionManager.getActive();
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
