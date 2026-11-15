import type { WebSocket } from "ws";

/**
 * The browsers' WebSocket connections and what is sent to them.
 *
 * Two kinds of message: global ones (pings, errors that belong to no server)
 * go to every socket as they always did; a server's own messages (its process
 * state and output, its console, its playlist) carry that server's id. A
 * socket that has said `hello` with protocol 2 gets every server's messages,
 * tagged `serverId`. A socket that never says hello (a client from before
 * Pyrodeck ran several servers, or a tab left open across the upgrade) gets
 * only the default server's messages, without the tag, exactly as before.
 */

/** The protocol a client asks for with `{ type: "hello", payload: { protocol: 2 } }`. */
export const WS_PROTOCOL = 2;

/** A socket with its liveness flag (dead-connection culling) and the protocol it speaks. */
export type HubSocket = WebSocket & { isAlive?: boolean; pyrodeckProtocol?: number };

const clients = new Set<HubSocket>();

/** The server whose messages reach a socket that never said hello; null: every server's. */
let defaultServerId: () => string | null = () => null;

export function setDefaultServerResolver(resolver: () => string | null): void {
  defaultServerId = resolver;
}

export function addClient(socket: HubSocket): void {
  socket.pyrodeckProtocol ??= 1;
  clients.add(socket);
}

export function removeClient(socket: HubSocket): void {
  clients.delete(socket);
}

export function clientCount(): number {
  return clients.size;
}

/** The socket asked for protocol 2: tagged messages from every server from now on. */
export function useProtocol2(socket: HubSocket): void {
  socket.pyrodeckProtocol = WS_PROTOCOL;
}

export function speaksProtocol2(socket: HubSocket): boolean {
  return socket.pyrodeckProtocol === WS_PROTOCOL;
}

function encode(type: string, payload: Record<string, unknown>, serverId?: string): string {
  return JSON.stringify(serverId === undefined ? { type, payload } : { type, serverId, payload });
}

/** Whether a socket that never said hello gets `serverId`'s messages. */
function reachesProtocol1(serverId: string): boolean {
  const id = defaultServerId();
  return id === null || id === serverId;
}

/** Send a message that belongs to no server to every socket. */
export function wsBroadcast(type: string, payload: Record<string, unknown>): void {
  // No clients: skip the stringify (process output is sent 10 times a second
  // for the life of a launched server, watched or not).
  if (clients.size === 0) return;
  const msg = encode(type, payload);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

/** Send one server's message: tagged to protocol 2 sockets, as before to the others when it is the default server. */
export function serverBroadcast(serverId: string, type: string, payload: Record<string, unknown>): void {
  if (clients.size === 0) return;
  let tagged: string | null = null;
  let plain: string | null = null;
  const toProtocol1 = reachesProtocol1(serverId);
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (speaksProtocol2(ws)) {
      tagged ??= encode(type, payload, serverId);
      ws.send(tagged);
    } else if (toProtocol1) {
      plain ??= encode(type, payload);
      ws.send(plain);
    }
  }
}

/** Send to one socket; a server's message is tagged when the socket speaks protocol 2. */
export function sendTo(socket: HubSocket, type: string, payload: Record<string, unknown>, serverId?: string): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(encode(type, payload, serverId !== undefined && speaksProtocol2(socket) ? serverId : undefined));
}

/**
 * Ping every socket every 15 s. Two mechanisms, two purposes:
 * - A JSON text message lets browser clients detect dead connections:
 *   browsers can NOT see protocol-level ping frames in onmessage.
 * - A protocol-level ping elicits an automatic pong from live browsers,
 *   which culls connections that died silently (iOS Safari kills
 *   backgrounded sockets without a close frame).
 */
setInterval(() => {
  const msg = JSON.stringify({ type: "ping" });
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.isAlive === false) {
      // No pong since the last interval: the connection is dead.
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    ws.send(msg);
    ws.ping();
  }
}, 15_000);
