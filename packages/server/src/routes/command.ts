import type { FastifyInstance } from "fastify";
import { serializeCaps } from "./server.js";
import { WS_SESSION_ENDED, bindSocketToSession, sessions } from "../auth/sessions.js";
import {
  WS_PROTOCOL,
  addClient,
  removeClient,
  sendTo,
  speaksProtocol2,
  useProtocol2,
  wsBroadcast,
  type HubSocket,
} from "../ws/wsHub.js";
import { CONNECT_SERVER_ID, serverRegistry } from "../servers/ServerRegistry.js";
import { consoleTarget, runConsoleCommand, type ConsoleTarget } from "../servers/consoleCommands.js";

export { wsBroadcast };

interface WsMessage {
  type?: string;
  payload?: { command?: string; serverId?: string; protocol?: number };
}

/**
 * The state a browser needs of one console on connecting: its connection
 * state, capabilities and the loaded level. `serverId` tags the messages
 * (protocol 2); without it they go out as before.
 */
function greet(socket: HubSocket, target: ConsoleTarget | null, serverId?: string): void {
  const session = target?.session;
  if (!session) {
    sendTo(socket, "connection_state", { state: "disconnected" }, serverId);
    return;
  }
  sendTo(socket, "connection_state", { state: session.state }, serverId);
  sendTo(socket, "capabilities", serializeCaps(session.capabilities), serverId);
  // The level loaded now, so a client joining or refreshing mid-level sees it
  // without waiting for the next level change.
  const level = target?.playlist?.getCurrentLevel();
  if (level) sendTo(socket, "level_changed", { level }, serverId);
}

/** Every server with something to greet a protocol 2 client about, and Connect mode's session. */
function greetAll(socket: HubSocket): void {
  for (const server of serverRegistry.list()) {
    if (!server.consoleSession() && server.heldLaunch() === null) continue;
    greet(socket, consoleTarget(server.id), server.id);
  }
  if (serverRegistry.connectSession()) greet(socket, consoleTarget(CONNECT_SERVER_ID), CONNECT_SERVER_ID);
}

export async function commandRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, (ws, request) => {
    const socket = ws as HubSocket;
    socket.isAlive = true;
    addClient(socket);

    // requireAuth let the handshake through. When it came with a session,
    // the socket closes as soon as that session ends (logout, "log out all
    // sessions", lifetime or idle timeout).
    const sessionId = bindSocketToSession(socket, request);

    app.log.info("WebSocket client connected");

    socket.on("pong", () => {
      socket.isAlive = true;
    });

    // The default server's console, as a single-server Pyrodeck sent it. A
    // client that says hello (protocol 2) gets every server's next.
    const target = consoleTarget();
    greet(socket, target);
    if (target?.session) {
      app.log.info("WebSocket client linked to session %s (state: %s)", target.session.id, target.session.state);
    } else {
      app.log.info("WebSocket client connected but no active session");
    }

    socket.on("message", async (msg: Buffer | string) => {
      // A command is activity on the session; a session that ended in the
      // meantime takes no more commands.
      if (sessionId && !sessions.touch(sessionId)) {
        socket.close(WS_SESSION_ENDED, "Session ended");
        return;
      }
      try {
        const data = JSON.parse(msg.toString()) as WsMessage;

        if (data.type === "hello") {
          if (data.payload?.protocol === WS_PROTOCOL) useProtocol2(socket);
          sendTo(socket, "hello", {
            protocol: speaksProtocol2(socket) ? WS_PROTOCOL : 1,
            defaultServerId: serverRegistry.defaultServerId(),
            servers: serverRegistry.list().map((s) => s.id),
          });
          if (speaksProtocol2(socket)) greetAll(socket);
          return;
        }

        if (data.type === "command" && data.payload?.command) {
          // A protocol 2 client names the server; else the default server's console.
          const serverId = speaksProtocol2(socket) && typeof data.payload.serverId === "string" ? data.payload.serverId : undefined;
          const commandTarget = consoleTarget(serverId);
          const tag = commandTarget?.serverId ?? undefined;
          if (!commandTarget?.session) {
            sendTo(
              socket,
              "error",
              { message: commandTarget ? "No active server connection" : `No such server: ${serverId}` },
              tag,
            );
            return;
          }

          const command = data.payload.command;
          app.log.info("Sending command to D3 server%s: %s", tag ? ` ${tag}` : "", command);

          try {
            const result = await runConsoleCommand(commandTarget, command);
            app.log.info("Command response (%d bytes): %s", result.raw.length, result.raw.slice(0, 200));
            if (result.message) sendTo(socket, result.message.type, result.message.payload, tag);
            if (result.problems.length > 0) sendTo(socket, "error", { message: result.problems.join(" — ") }, tag);
          } catch (cmdErr) {
            const message = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
            app.log.error("Command failed: %s", message);
            sendTo(socket, "error", { message }, tag);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error("WebSocket message handler error: %s", message);
        sendTo(socket, "error", { message });
      }
    });

    socket.on("close", () => {
      removeClient(socket);
      app.log.info("WebSocket client disconnected");
    });
  });
}
