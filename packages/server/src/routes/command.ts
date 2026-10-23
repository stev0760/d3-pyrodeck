import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { sessionManager, responseParser, serializeCaps } from "./server.js";
import { playlistManager } from "../launcher/playlistInstance.js";
import type { AddBotResult } from "../parser/parsers/addbot.js";
import { WS_SESSION_ENDED, bindSocketToSession, sessions } from "../auth/sessions.js";

interface WsCommand {
  type: "command";
  payload: { command: string };
}

/** WebSocket with liveness flag for dead-connection culling. */
type AliveWebSocket = WebSocket & { isAlive?: boolean };

/** Connected WebSocket clients for broadcasting. */
const wsClients = new Set<AliveWebSocket>();

/** Broadcast a message to all connected WebSocket clients. */
export function wsBroadcast(type: string, payload: Record<string, unknown>): void {
  // No clients — skip the stringify (process output broadcasts run 10x/sec
  // for the life of a launched server, watched or not).
  if (wsClients.size === 0) return;
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
 * Ping all WS clients every 15s. Two mechanisms, two purposes:
 * - A JSON text message lets browser clients detect dead connections —
 *   browsers can NOT see protocol-level ping frames in onmessage.
 * - A protocol-level ping elicits an automatic pong from live browsers,
 *   which we use to cull connections that died silently (iOS Safari kills
 *   backgrounded sockets without a close frame).
 */
setInterval(() => {
  const msg = JSON.stringify({ type: "ping" });
  for (const ws of wsClients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.isAlive === false) {
      // No pong since the last interval — connection is dead
      ws.terminate();
      wsClients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    ws.send(msg);
    ws.ping();
  }
}, 15_000);

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
  app.get("/ws", { websocket: true }, (socket: AliveWebSocket, request) => {
    socket.isAlive = true;
    wsClients.add(socket);

    // requireAuth let the handshake through. When it came with a session,
    // the socket closes as soon as that session ends (logout, "log out all
    // sessions", lifetime or idle timeout).
    const sessionId = bindSocketToSession(socket, request);

    app.log.info("WebSocket client connected");

    socket.on("pong", () => {
      socket.isAlive = true;
    });

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
      // Push the currently-loaded level so a client joining/refreshing
      // mid-level sees it without waiting for the next level change.
      const level = playlistManager.getCurrentLevel();
      if (level) {
        socket.send(
          JSON.stringify({ type: "level_changed", payload: { level } }),
        );
      }
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
      // A command is activity on the session; a session that ended in the
      // meantime takes no more commands.
      if (sessionId && !sessions.touch(sessionId)) {
        socket.close(WS_SESSION_ENDED, "Session ended");
        return;
      }
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
                  "$botstat": "botstats",
                  "$netgameinfo": "serverinfo",
                  "$botmode": "botmode",
                  "$botpopulation": "botpopulation",
                };
                const msgType = typeMap[commandName];
                if (msgType) {
                  socket.send(
                    JSON.stringify({ type: msgType, payload: parsed.parsed }),
                  );
                }

                // A refused or altered $addbot is otherwise visible only in
                // the console; surface it as an error toast.
                if (commandName === "$addbot") {
                  const result = parsed.parsed as AddBotResult;
                  const problems = [...result.warnings];
                  if (!result.ok && result.error) problems.push(result.error);
                  if (problems.length > 0) {
                    socket.send(
                      JSON.stringify({
                        type: "error",
                        payload: { message: problems.join(" — ") },
                      }),
                    );
                  }
                }

                // Forward $netgameinfo to playlist manager for timer anchoring
                if (commandName === "$netgameinfo") {
                  playlistManager.parseAndAnchorFromNetgameinfo(rawResponse);
                }
              }
            }

            // Detect settimelimit command so playlist timer stays in sync
            if (commandName === "$settimelimit") {
              const parts = command.trim().split(/\s+/);
              const newLimit = parts[1] ? parseInt(parts[1], 10) : NaN;
              if (!isNaN(newLimit)) {
                playlistManager.onTimelimitChanged(newLimit);
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
