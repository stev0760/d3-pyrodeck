/**
 * What the panel knows about each server, kept apart per server: its console
 * login and capabilities, its process state, the level it runs, its cached
 * `$netgameinfo`, its playlist status, and its console and process text.
 * Every tagged WebSocket message lands on its own server's view, whichever
 * server is on screen, so switching servers shows that server's history and
 * nothing of another's.
 *
 * Views are replaced, never mutated, on a change: `get(id)` is a stable
 * snapshot for `useSyncExternalStore` until that server's view changes. The
 * two line buffers are carried along by reference (they notify on their own).
 */

import { LineBuffer } from "./lineBuffer.ts";
import type { ServerState, WsMessage } from "./servers.ts";
import type { ConnectionState, ServerCapabilities } from "../hooks/useServerConnection.ts";
import type { NetGameInfo } from "../hooks/useServerInfo.ts";
import type { PlaylistEntry, PlaylistStatus } from "../hooks/usePlaylist.ts";

/** Console lines kept per server for the telnet console (replies and typed commands). */
export const CONSOLE_LINES = 2000;
/** Lines kept per server of the game process's stdout and stderr. */
export const PROCESS_LINES = 5000;

export interface ServerView {
  id: string;
  connectionState: ConnectionState;
  capabilities: ServerCapabilities | null;
  /** The game process (from process_state); null until one is heard of. */
  processState: ServerState | null;
  /** The level file loaded now (level_changed), null before the first. */
  level: string | null;
  /** The last `$netgameinfo` answer (or the one pushed after a rotation). */
  info: NetGameInfo | null;
  /** Where the time-left countdown started: seconds left at `at` (epoch ms). */
  anchor: { seconds: number; at: number } | null;
  /** `$netgameinfo` has been asked once during this console login (it is never polled). */
  infoAsked: boolean;
  playlist: PlaylistStatus | null;
  console: LineBuffer;
  process: LineBuffer;
}

/** "M:SS", "MM:SS" or "H:MM:SS" to seconds; 0 when unreadable. */
export function parseTimeLeft(str: string): number {
  const parts = str.split(":").map((s) => parseInt(s, 10));
  if (parts.some((n) => isNaN(n))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function fullLimitAnchor(info: NetGameInfo | null, now: number): ServerView["anchor"] {
  const seconds = (info?.timeLimit ?? 0) * 60;
  return seconds > 0 ? { seconds, at: now } : null;
}

export class ServerViews {
  private views = new Map<string, ServerView>();
  private listeners = new Set<() => void>();
  /** Increments on every change of any view. */
  version = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** A server's view; an empty one the first time a server is named. */
  get(id: string): ServerView {
    let view = this.views.get(id);
    if (!view) {
      view = {
        id,
        connectionState: "disconnected",
        capabilities: null,
        processState: null,
        level: null,
        info: null,
        anchor: null,
        infoAsked: false,
        playlist: null,
        console: new LineBuffer(CONSOLE_LINES),
        process: new LineBuffer(PROCESS_LINES),
      };
      this.views.set(id, view);
    }
    return view;
  }

  ids(): string[] {
    return [...this.views.keys()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Change a server's view (a new object; the buffers stay). */
  patch(id: string, patch: Partial<Omit<ServerView, "id" | "console" | "process">>): void {
    const old = this.get(id);
    this.views.set(id, { ...old, ...patch });
    this.notify();
  }

  /**
   * After a (re)connect's hello: no server's console is known to be logged
   * in until Pyrodeck greets it again, which it does next for every server
   * with a console.
   */
  resetConsoles(): void {
    let changed = false;
    for (const [id, view] of this.views) {
      if (view.connectionState !== "disconnected") {
        this.views.set(id, { ...view, connectionState: "disconnected" });
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /** Apply one server's message to its view. Messages that only notify (players, bots) change nothing here. */
  apply(serverId: string, msg: WsMessage): void {
    const p = msg.payload ?? {};
    const view = this.get(serverId);
    switch (msg.type) {
      case "output":
        view.console.push(String((p as { raw?: unknown }).raw ?? ""), "out");
        return;
      case "process_output": {
        const { stream, data } = p as { stream?: string; data?: unknown };
        view.process.push(String(data ?? ""), stream === "stderr" ? "err" : "out");
        return;
      }
      case "connection_state": {
        const state = (p as { state?: ConnectionState }).state ?? "disconnected";
        if (state === "ready") {
          this.patch(serverId, { connectionState: state });
        } else {
          // Logged out: what the console told us is stale; the next login asks again.
          this.patch(serverId, {
            connectionState: state,
            ...(view.connectionState === "ready" ? { info: null, anchor: null, infoAsked: false, level: null } : {}),
          });
        }
        return;
      }
      case "capabilities":
        this.patch(serverId, { capabilities: p as unknown as ServerCapabilities });
        return;
      case "process_state":
        this.patch(serverId, { processState: (p as { state?: ServerState }).state ?? null });
        return;
      case "level_changed":
        // A new level starts the clock at the full limit.
        this.patch(serverId, {
          level: (p as { level?: string | null }).level ?? null,
          anchor: fullLimitAnchor(view.info, this.now()),
        });
        return;
      case "serverinfo": {
        const info = p as unknown as NetGameInfo;
        const seconds = info?.timeLeft ? parseTimeLeft(info.timeLeft) : 0;
        this.patch(serverId, { info, anchor: seconds > 0 ? { seconds, at: this.now() } : null });
        return;
      }
      case "playlist_status":
        this.patch(serverId, { playlist: p as unknown as PlaylistStatus });
        return;
      case "playlist_timer":
        if (view.playlist) {
          this.patch(serverId, {
            playlist: { ...view.playlist, gameEndAt: (p as { gameEndAt?: number | null }).gameEndAt ?? null },
          });
        }
        return;
      case "playlist_rotate":
        if (view.playlist) {
          this.patch(serverId, { playlist: { ...view.playlist, currentEntry: (p as { entry: PlaylistEntry }).entry } });
        }
        return;
      case "playlist_vote_announce":
        if (view.playlist) {
          const { options, deadline } = p as { options: PlaylistEntry[]; deadline: number };
          this.patch(serverId, {
            playlist: { ...view.playlist, status: "voting", voteOptions: options, voteDeadline: deadline },
          });
        }
        return;
      case "playlist_vote_result":
        if (view.playlist) {
          this.patch(serverId, { playlist: { ...view.playlist, status: "active", voteOptions: [], voteDeadline: null } });
        }
        return;
    }
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
