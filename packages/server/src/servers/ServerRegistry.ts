import { ServerInstance } from "./ServerInstance.js";
import { sessionManager } from "../routes/server.js";
import { wsBroadcast, wireSessionToClients } from "../routes/command.js";
import { pyrodeckConfig } from "../routes/pyrodeck-config.js";
import { playlistManager, rotationHealth } from "../launcher/playlistInstance.js";
import { serverEvents } from "../events/ServerEvents.js";
import { logServerEvents } from "../events/serverEventLog.js";
import { readAutostartEnv } from "../launcher/autostartSettings.js";

/** The game servers Pyrodeck runs, by id. Pyrodeck runs one: the default. */
export class ServerRegistry {
  private readonly servers = new Map<string, ServerInstance>();
  private defaultId: string | null = null;

  /** Add a server; the first one added is the default. */
  add(server: ServerInstance): ServerInstance {
    if (this.servers.has(server.id)) throw new Error(`A server with id "${server.id}" is already registered`);
    this.servers.set(server.id, server);
    this.defaultId ??= server.id;
    return server;
  }

  get(id: string): ServerInstance | undefined {
    return this.servers.get(id);
  }

  list(): ServerInstance[] {
    return [...this.servers.values()];
  }

  getDefault(): ServerInstance {
    const server = this.defaultId === null ? undefined : this.servers.get(this.defaultId);
    if (!server) throw new Error("No server is registered");
    return server;
  }
}

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

export const DEFAULT_SERVER_ID = "default";

/** The one registry; routes resolve their server from it. */
export const serverRegistry = new ServerRegistry();

logServerEvents(serverEvents);

serverRegistry.add(
  new ServerInstance({
    id: DEFAULT_SERVER_ID,
    configDir: CONFIG_DIR,
    settings: () => pyrodeckConfig.get(),
    sessions: sessionManager,
    playlist: playlistManager,
    rotationHealth,
    broadcast: wsBroadcast,
    wireSessionToClients,
    autostartEnv: readAutostartEnv(process.env),
    events: serverEvents,
  }),
);
