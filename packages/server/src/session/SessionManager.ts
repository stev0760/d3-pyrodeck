import crypto from "node:crypto";
import type { ServerConnection } from "../connection/ServerConnection.js";
import type { ServerCapabilities } from "../parser/parsers/servercaps.js";
import { VANILLA_CAPS } from "../parser/parsers/servercaps.js";

export type SessionState =
  | "connecting"
  | "probing"
  | "ready"
  | "disconnected"
  | "reconnecting";

export interface ServerSession {
  id: string;
  connection: ServerConnection;
  capabilities: ServerCapabilities;
  connectionInfo: {
    host: string;
    port: number;
    password: string;
    connectedAt: Date;
  };
  state: SessionState;
}

/**
 * Manages server sessions. Phase 1 supports a single active session;
 * the interface uses session IDs so multi-server is a future drop-in.
 */
export class SessionManager {
  private sessions = new Map<string, ServerSession>();
  private stateListeners: Array<(session: ServerSession) => void> = [];

  /** Called after every state change of any session, removal ("disconnected") included. */
  onStateChange(listener: (session: ServerSession) => void): void {
    this.stateListeners.push(listener);
  }

  private notify(session: ServerSession): void {
    for (const listener of this.stateListeners) listener(session);
  }

  create(
    connection: ServerConnection,
    host: string,
    port: number,
    password: string,
  ): ServerSession {
    const session: ServerSession = {
      id: crypto.randomUUID(),
      connection,
      capabilities: { ...VANILLA_CAPS, features: new Set() },
      connectionInfo: {
        host,
        port,
        password,
        connectedAt: new Date(),
      },
      state: "connecting",
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): ServerSession | undefined {
    return this.sessions.get(id);
  }

  /** Get the single active session (Phase 1 convenience). */
  getActive(): ServerSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.state !== "disconnected") {
        return session;
      }
    }
    return undefined;
  }

  updateState(id: string, state: SessionState): void {
    const session = this.sessions.get(id);
    if (session) {
      session.state = state;
      this.notify(session);
    }
  }

  updateCapabilities(id: string, capabilities: ServerCapabilities): void {
    const session = this.sessions.get(id);
    if (session) {
      session.capabilities = capabilities;
    }
  }

  remove(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.state = "disconnected";
      session.connection.disconnect();
      this.sessions.delete(id);
      this.notify(session);
    }
  }

  /** Disconnect and remove all sessions. */
  clear(): void {
    for (const id of this.sessions.keys()) {
      this.remove(id);
    }
  }
}
