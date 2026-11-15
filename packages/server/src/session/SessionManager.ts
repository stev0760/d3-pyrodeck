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
  /**
   * Who opened it: a server instance's id (servers/ServerInstance.ts), or
   * CONNECT_OWNER for Connect mode. Each owner has at most one open session.
   */
  owner: string;
  /**
   * The server the session's player and level events belong to
   * (events/ServerEvents.ts `profileId`); unset for Connect mode, whose
   * events are named after the host and port.
   */
  profileId?: string;
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

/** The owner of a session opened in Connect mode (POST /api/server/connect). */
export const CONNECT_OWNER = "connect";

export interface CreateSessionOptions {
  /** Default CONNECT_OWNER. */
  owner?: string;
  profileId?: string;
}

/**
 * The console sessions Pyrodeck has open: one per server it runs (owned by
 * that server's instance) and one for Connect mode.
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
    options: CreateSessionOptions = {},
  ): ServerSession {
    const session: ServerSession = {
      id: crypto.randomUUID(),
      owner: options.owner ?? CONNECT_OWNER,
      ...(options.profileId !== undefined ? { profileId: options.profileId } : {}),
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

  /** The first open session, whoever owns it (with one server, the only one). */
  getActive(): ServerSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.state !== "disconnected") {
        return session;
      }
    }
    return undefined;
  }

  /** The open session `owner` opened, if any. */
  getOwned(owner: string): ServerSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.owner === owner && session.state !== "disconnected") return session;
    }
    return undefined;
  }

  /** Every open session. */
  list(): ServerSession[] {
    return [...this.sessions.values()].filter((s) => s.state !== "disconnected");
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
