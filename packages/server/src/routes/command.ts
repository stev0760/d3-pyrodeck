import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { isAuthenticated } from "./auth.js";
import { sessionManager, responseParser, serializeCaps } from "./server.js";

interface WsCommand {
  type: "command";
  payload: { command: string };
}

export async function commandRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
    // Authenticate WebSocket via cookie
    const token = request.cookies?.[
      "pyrodeck_session"
    ] as string | undefined;
    if (!isAuthenticated(token)) {
      socket.close(4001, "Not authenticated");
      return;
    }

    const session = sessionManager.getActive();

    // Stream raw telnet output to the WebSocket client
    const dataHandler = (data: string) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "output", payload: { raw: data } }));
      }
    };

    const disconnectHandler = (reason: string) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "connection_state",
            payload: { state: "disconnected", reason },
          }),
        );
      }
    };

    if (session) {
      session.connection.onData(dataHandler);
      session.connection.onDisconnect(disconnectHandler);

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
    } else {
      socket.send(
        JSON.stringify({
          type: "connection_state",
          payload: { state: "disconnected" },
        }),
      );
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
          const rawResponse = await activeSession.connection.send(command);

          // Parse if we have a parser for this command
          const commandName = command.split(" ")[0];
          if (responseParser.has(commandName)) {
            const parsed = responseParser.parse(commandName, rawResponse);
            if (parsed.parsed) {
              // Send structured data based on command type
              const typeMap: Record<string, string> = {
                "$scores": "players",
                "$botlist": "bots",
              };
              const msgType = typeMap[commandName];
              if (msgType) {
                socket.send(
                  JSON.stringify({ type: msgType, payload: parsed.parsed }),
                );
              }
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        socket.send(
          JSON.stringify({ type: "error", payload: { message } }),
        );
      }
    });

    socket.on("close", () => {
      // Cleanup: nothing to do since dataHandler is garbage-collected
      // when the session is removed
    });
  });
}
