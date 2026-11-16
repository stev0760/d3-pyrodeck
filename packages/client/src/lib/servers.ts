/**
 * The servers one Pyrodeck runs (server: routes/servers.ts, GET /api/servers),
 * which one the panel shows, and which server a WebSocket message is about.
 * Pure functions; the React side is session/SessionProvider.tsx.
 */

/** Connect mode's console session: one remote server, no process. */
export const CONNECT_SERVER_ID = "connect";

/** The server launched from the global dedicated.cfg without a profile. */
export const LAUNCH_SERVER_ID = "launch";

export type ServerState = "stopped" | "starting" | "running" | "stopping" | "crashed";

export interface ServerPlaylistRow {
  id: string;
  name: string;
  status: "inactive" | "active" | "voting" | "holding" | "restarting" | "paused";
  currentEntry: string | null;
  pausedReason: string | null;
}

/** One row of GET /api/servers. */
export interface ServerRow {
  id: string;
  kind: "profile" | "launch" | "connect";
  name: string;
  profileId: string | null;
  profileExists?: boolean;
  default: boolean;
  /** Null for Connect mode's session (no process). */
  state: ServerState | null;
  pid?: number | null;
  startedAt?: string | null;
  adopted?: boolean;
  stopReason?: string | null;
  /** The console login: disconnected, connecting, probing, ready. */
  console: string;
  log?: string | null;
  gameName?: string | null;
  gameType?: string | null;
  mission?: string | null;
  level?: string | null;
  humans?: number | null;
  maxPlayers?: number | null;
  playlist?: ServerPlaylistRow | null;
  ports?: {
    bindIp: string | null;
    game: number | null;
    gameSpy: number | null;
    console: number | null;
    tempDir: string | null;
    startupFile: string | null;
  };
  /** A game from before Pyrodeck restarted that it could not log in to: it keeps its ports. */
  held?: { why: string; pid: number | null } | null;
  supervisor?: {
    enabled: boolean;
    relaunchCount: number;
    pendingRelaunch: { at: string; cause: string } | null;
    gaveUp: { at: string; reason: string } | null;
    hang: string;
    uptimeMs: number | null;
  };
  autostart?: { listed: boolean; state: string; reason: string | null };
  connectedAt?: string;
}

export interface ServerList {
  defaultServerId: string | null;
  servers: ServerRow[];
}

/** A process that holds its ports: starting, running or stopping. */
export function isActiveState(state: string | null | undefined): boolean {
  return state === "starting" || state === "running" || state === "stopping";
}

/** What a row's state reads as: a held server, a playlist restart or hold, else the process state. */
export function rowStateLabel(row: ServerRow): string {
  if (row.held && !isActiveState(row.state)) return "holding ports";
  if (row.playlist?.status === "restarting") return "restarting";
  if (row.playlist?.status === "holding") return "holding";
  return row.state ?? (row.console === "ready" ? "connected" : "disconnected");
}

/** The servers the Launch-mode list shows: every server Pyrodeck launches (not Connect mode's session). */
export function launchRows(rows: readonly ServerRow[]): ServerRow[] {
  return rows.filter((r) => r.kind !== "connect");
}

/** How many of them hold a process now. */
export function runningCount(rows: readonly ServerRow[]): number {
  return launchRows(rows).filter((r) => isActiveState(r.state)).length;
}

// ---------------------------------------------------------------------------
// Which server is selected
// ---------------------------------------------------------------------------

export const SELECTED_SERVER_KEY = "pyrodeck-server";

export function readStoredServer(storage: Pick<Storage, "getItem"> | null = safeStorage()): string | null {
  try {
    const v = storage?.getItem(SELECTED_SERVER_KEY);
    return v ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredServer(id: string, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(SELECTED_SERVER_KEY, id);
  } catch {
    // storage unavailable: the selection still holds for this page
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The server to show: the one asked for (the phone's `?s=`, then the one
 * this browser chose last) while it exists; else the default server (the one
 * running, else the last one used); else the first. `null` until the list
 * has a server Pyrodeck launches. Connect mode's session is never picked
 * here: Connect mode shows it on its own.
 */
export function chooseServer(options: {
  wanted: readonly (string | null | undefined)[];
  list: ServerList | null;
}): string | null {
  const rows = launchRows(options.list?.servers ?? []);
  if (rows.length === 0) return null;
  const known = (id: string | null | undefined): id is string => !!id && rows.some((r) => r.id === id);
  for (const id of options.wanted) if (known(id)) return id;
  const fallback = options.list?.defaultServerId;
  if (known(fallback)) return fallback;
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

export interface WsMessage {
  type: string;
  serverId?: string;
  payload: Record<string, unknown>;
}

/**
 * Message types that belong to one server: protocol 2 tags them with
 * `serverId`. Everything else (ping, hello, errors of no server) is global.
 */
export const SERVER_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "process_state",
  "process_output",
  "output",
  "connection_state",
  "capabilities",
  "level_changed",
  "serverinfo",
  "players",
  "bots",
  "botstats",
  "botmode",
  "botpopulation",
  "playlist_timer",
  "playlist_rotate",
  "playlist_status",
  "playlist_vote_announce",
  "playlist_vote_result",
]);

export type Route = { scope: "server"; serverId: string } | { scope: "global" } | { scope: "drop" };

/**
 * Which server a message is about. A tagged message is its server's. The
 * client says hello (protocol 2) at once, so an untagged message of a
 * server's kind is the greeting Pyrodeck sends every socket before the hello
 * (the default server's state, sent again tagged after it): dropped, never
 * guessed. An untagged error belongs to no server.
 */
export function routeMessage(msg: WsMessage): Route {
  if (typeof msg.serverId === "string" && msg.serverId) return { scope: "server", serverId: msg.serverId };
  if (SERVER_MESSAGE_TYPES.has(msg.type)) return { scope: "drop" };
  return { scope: "global" };
}

/**
 * "CTF: message", so a toast says which server it is about; unprefixed
 * without a name, or when the message names the server already ('Cannot
 * start "CTF": ...').
 */
export function namedMessage(name: string | null | undefined, message: string): string {
  if (!name || message.includes(`"${name}"`)) return message;
  return `${name}: ${message}`;
}

/** A refusal Pyrodeck joined from several reasons ("Cannot start ...: ... Cannot start ...: ..."), one per line. */
export function refusalLines(message: string): string[] {
  return message
    .split(/(?=Cannot start ")/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The mission and level a row runs, short: "gamma.mn3 · level1". */
export function missionLine(row: ServerRow): string | null {
  const parts = [row.mission, row.level].filter((s): s is string => !!s);
  return parts.length > 0 ? parts.join(" · ") : null;
}
