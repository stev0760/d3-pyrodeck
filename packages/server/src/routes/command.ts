import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
// TODO: Re-enable auth import when web admin auth is added back
import { sessionManager, responseParser, serializeCaps } from "./server.js";

interface WsCommand {
  type: "command";
  payload: { command: string };
}

/** Connected WebSocket clients for broadcasting. */
const wsClients = new Set<WebSocket>();

/** Broadcast a message to all connected WebSocket clients. */
export function wsBroadcast(type: string, payload: Record<string, unknown>): void {
  const msg = JSON.stringify({ type, payload });
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  }
}

/** Track which session is currently wired to prevent duplicate callbacks. */
let wiredSessionId: string | null = null;

/**
 * Wire up telnet data streaming from the active session to all connected WS clients.
 * Called when a new session is created (by Connect Mode or Launch Mode).
 * Idempotent — skips if the same session is already wired.
 */
export function wireSessionToClients(): void {
  const session = sessionManager.getActive();
  if (!session) return;

  if (wiredSessionId === session.id) return;
  wiredSessionId = session.id;

  session.connection.onData((data: string) => {
    const msg = JSON.stringify({ type: "output", payload: { raw: data } });
    for (const ws of wsClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  });

  session.connection.onDisconnect((reason: string) => {
    wiredSessionId = null;
    wsBroadcast("connection_state", { state: "disconnected", reason });
  });
}

export async function commandRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
    wsClients.add(socket);
    // TODO: Re-enable web admin auth in a later phase.
    // For now, the D3 server's console password is the only auth gate.

    app.log.info("WebSocket client connected");

    const session = sessionManager.getActive();

    if (session) {
      // Send current state and capabilities on connect
      socket.send(
        JSON.stringify({
          type: "connection_state",
          payload: { state: session.state },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "capabilities",
          payload: serializeCaps(session.capabilities),
        }),
      );
      app.log.info(
        "WebSocket client linked to session %s (state: %s)",
        session.id,
        session.state,
      );
    } else {
      socket.send(
        JSON.stringify({
          type: "connection_state",
          payload: { state: "disconnected" },
        }),
      );
      app.log.info("WebSocket client connected but no active session");
    }

    socket.on("message", async (msg: Buffer | string) => {
      try {
        const data = JSON.parse(msg.toString()) as WsCommand;

        if (data.type === "command" && data.payload?.command) {
          const activeSession = sessionManager.getActive();
          if (!activeSession) {
            socket.send(
              JSON.stringify({
                type: "error",
                payload: { message: "No active server connection" },
              }),
            );
            return;
          }

          const command = data.payload.command;
          app.log.info("Sending command to D3 server: %s", command);

          try {
            const rawResponse = await activeSession.connection.send(command);
            app.log.info(
              "Command response (%d bytes): %s",
              rawResponse.length,
              rawResponse.slice(0, 200),
            );

            // Parse if we have a parser for this command
            const commandName = command.split(" ")[0];
            if (responseParser.has(commandName)) {
              const parsed = responseParser.parse(commandName, rawResponse);
              if (parsed.parsed) {
                const typeMap: Record<string, string> = {
                  "$scores": "players",
                  "$botlist": "bots",
                  "$netgameinfo": "serverinfo",
                };
                const msgType = typeMap[commandName];
                if (msgType) {
                  socket.send(
                    JSON.stringify({ type: msgType, payload: parsed.parsed }),
                  );
                }
              }
            }
          } catch (cmdErr) {
            const msg =
              cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
            app.log.error("Command failed: %s", msg);
            socket.send(
              JSON.stringify({ type: "error", payload: { message: msg } }),
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error("WebSocket message handler error: %s", message);
        socket.send(
          JSON.stringify({ type: "error", payload: { message } }),
        );
      }
    });

    socket.on("close", () => {
      wsClients.delete(socket);
      app.log.info("WebSocket client disconnected");
    });
  });
}
