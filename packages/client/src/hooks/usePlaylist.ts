import { useState, useEffect, useCallback } from "react";
import type { ServerView, ServerViews } from "@/lib/serverViews";
import { CONNECT_SERVER_ID, namedMessage, type WsMessage } from "@/lib/servers";
import type { PlaylistDownloads } from "@/lib/playlistDownloads";

// ---------------------------------------------------------------------------
// Types (mirrors backend PlaylistManager)
// ---------------------------------------------------------------------------

export interface PlaylistEntry {
  id: string;
  label: string;
  missionName: string;
  startingLevel?: number;
  weight?: number;
}

export interface PlaylistVoting {
  enabled: boolean;
  preAnnounceSeconds: number;
  voteOpenSeconds: number;
  optionCount: number;
}

export type PlaylistMode = "sequential" | "shuffle" | "weighted";

/** The hold before a restart into the next mission (server PlaylistManager): default and cap, in seconds. */
export const DEFAULT_HOLD_SECONDS = 30;
export const MAX_HOLD_SECONDS = 120;

export interface Playlist {
  id: string;
  name: string;
  mode: PlaylistMode;
  entries: PlaylistEntry[];
  voting: PlaylistVoting;
  /** Seconds the players are held with a countdown before a restart into the next mission; 0 = off; absent = 30. */
  holdSeconds?: number;
  createdAt: string;
  updatedAt: string;
}

/** Health check of the server a rotation restarts (server RotationHealthMonitor). */
export interface RotationCheck {
  state: "idle" | "relaunching" | "waiting";
  attempt: number;
  maxRetries: number;
  deadline: number | null;
}

export interface PlaylistStatus {
  status: "inactive" | "active" | "voting" | "holding" | "restarting" | "paused";
  activePlaylistId: string | null;
  currentIndex: number;
  currentEntry: PlaylistEntry | null;
  gameEndAt: number | null;
  voteOptions: PlaylistEntry[];
  voteDeadline: number | null;
  /** Why rotation is paused (a restart that never came healthy). */
  pausedReason?: string | null;
  pausedAt?: number | null;
  /** While holding: the mission the restart goes to, and when (epoch ms; null until the loop-back level is up). */
  holdEntry?: PlaylistEntry | null;
  holdEndsAt?: number | null;
  /** The last time the active playlist's missions were pointed at the mission host (null while it is off). */
  downloads?: PlaylistDownloads | null;
  rotationCheck?: RotationCheck;
}

/** A server's status before Pyrodeck has said anything about its playlist. */
export const INACTIVE_STATUS: PlaylistStatus = {
  status: "inactive",
  activePlaylistId: null,
  currentIndex: 0,
  currentEntry: null,
  gameEndAt: null,
  voteOptions: [],
  voteDeadline: null,
};

interface UsePlaylistOptions {
  /** The selected server, its view and the store of every server's. */
  serverId: string | null;
  view: ServerView | null;
  views: ServerViews;
  /** Every server's WebSocket messages (useServerConnection's onServerMessage). */
  onServerMessage: (cb: (serverId: string, msg: WsMessage) => void) => () => void;
  /** A server's name, for the toasts. */
  nameOf: (serverId: string) => string | null;
  notify?: (message: string, type?: "error" | "info") => void;
  /** A playlist was activated or deactivated somewhere: the server list shows where. */
  onChanged?: () => void;
}

/**
 * The playlist library (shared by every server) and the selected server's
 * playlist: each server has its own active playlist, position, vote and hold,
 * kept in its view. Activation, deactivation and resume name their server
 * (POST /api/servers/:serverId/playlist/...). Rotations and votes on any
 * server are toasted with that server's name.
 */
export function usePlaylist({ serverId, view, views, onServerMessage, nameOf, notify, onChanged }: UsePlaylistOptions) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = view?.playlist ?? INACTIVE_STATUS;
  /** Connect mode's session has no playlist. */
  const hasPlaylist = !!serverId && serverId !== CONNECT_SERVER_ID;

  const fetchStatus = useCallback(
    async (id: string | null = serverId) => {
      if (!id || id === CONNECT_SERVER_ID) return;
      try {
        const res = await fetch(`/api/servers/${encodeURIComponent(id)}/playlist`, { credentials: "include" });
        if (res.ok) views.patch(id, { playlist: (await res.json()) as PlaylistStatus });
      } catch {
        // ignore
      }
    },
    [serverId, views],
  );

  // Every server's rotations and votes, named.
  useEffect(() => {
    return onServerMessage((id, msg) => {
      const named = (text: string) => namedMessage(nameOf(id), text);
      if (msg.type === "playlist_rotate") {
        // The server stays "restarting" until the restart passes its health
        // check; playlist_status says when.
        const { entry } = msg.payload as { entry: PlaylistEntry };
        notify?.(named(`Rotating to: ${entry.label}`), "info");
        void fetchStatus(id);
        onChanged?.();
      } else if (msg.type === "playlist_vote_announce") {
        const { options } = msg.payload as { options: PlaylistEntry[] };
        notify?.(named(`Vote open: ${options.map((o, i) => `${i + 1}. ${o.label}`).join("  ")}`), "info");
      } else if (msg.type === "playlist_vote_result") {
        const { winner, counts } = msg.payload as { winner: PlaylistEntry; counts: number[] };
        const total = counts?.reduce((a, b) => a + b, 0) ?? 0;
        notify?.(named(`Vote winner: ${winner.label} (${total} vote${total === 1 ? "" : "s"})`), "info");
      } else if (msg.type === "playlist_status") {
        onChanged?.();
      }
    });
  }, [onServerMessage, nameOf, notify, fetchStatus, onChanged]);

  const fetchPlaylists = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/playlists", { credentials: "include" });
      if (res.ok) {
        setPlaylists(await res.json());
      }
    } catch {
      // Network error
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchPlaylists();
  }, [fetchPlaylists]);

  // The selected server's status, when it is shown.
  useEffect(() => {
    void fetchStatus(serverId);
  }, [serverId, fetchStatus]);

  // An error is about the server it happened on.
  useEffect(() => setError(null), [serverId]);

  const createPlaylist = useCallback(async (
    name: string,
    mode: PlaylistMode = "sequential",
    entries: Omit<PlaylistEntry, "id">[] = [],
  ): Promise<Playlist | null> => {
    setError(null);
    try {
      const res = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, mode, entries }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create playlist");
        return null;
      }
      setPlaylists((prev) => [...prev, data]);
      return data;
    } catch {
      setError("Network error");
      return null;
    }
  }, []);

  const updatePlaylist = useCallback(async (
    id: string,
    updates: Partial<Omit<Playlist, "id" | "createdAt">>,
  ): Promise<Playlist | null> => {
    setError(null);
    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to update playlist");
        return null;
      }
      setPlaylists((prev) => prev.map((p) => (p.id === id ? data : p)));
      // Saving an active playlist with other missions hosts them: the status carries the result.
      void fetchStatus();
      return data;
    } catch {
      setError("Network error");
      return null;
    }
  }, [fetchStatus]);

  const deletePlaylist = useCallback(async (id: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to delete playlist");
        return false;
      }
      setPlaylists((prev) => prev.filter((p) => p.id !== id));
      // Deleting deactivates it on every server it was active on.
      for (const sid of views.ids()) {
        const st = views.get(sid).playlist;
        if (st?.activePlaylistId === id) views.patch(sid, { playlist: { ...st, activePlaylistId: null, status: "inactive" } });
      }
      onChanged?.();
      return true;
    } catch {
      setError("Network error");
      return false;
    }
  }, [views, onChanged]);

  /** Activate a playlist on a server (default: the selected one); its entries are checked against that server's profile. */
  const activatePlaylist = useCallback(async (id: string, target: string | null = serverId): Promise<boolean> => {
    setError(null);
    if (!target || target === CONNECT_SERVER_ID) return false;
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(target)}/playlist/activate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to activate playlist");
        return false;
      }
      views.patch(target, { playlist: data.status as PlaylistStatus });
      onChanged?.();
      return true;
    } catch {
      setError("Network error");
      return false;
    } 
  }, [serverId, views, onChanged]);

  const deactivatePlaylist = useCallback(async (target: string | null = serverId): Promise<void> => {
    if (!target || target === CONNECT_SERVER_ID) return;
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(target)}/playlist/deactivate`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        notify?.(namedMessage(nameOf(target), data.error ?? "Failed to deactivate playlist"));
        return;
      }
      const prev = views.get(target).playlist ?? INACTIVE_STATUS;
      views.patch(target, {
        playlist: {
          ...prev,
          activePlaylistId: null,
          status: "inactive",
          gameEndAt: null,
          voteOptions: [],
          voteDeadline: null,
        },
      });
      onChanged?.();
    } catch {
      // ignore
    }
  }, [serverId, views, notify, nameOf, onChanged]);

  const resumePlaylist = useCallback(async (target: string | null = serverId): Promise<void> => {
    if (!target || target === CONNECT_SERVER_ID) return;
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(target)}/playlist/resume`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        views.patch(target, { playlist: data.status as PlaylistStatus });
        onChanged?.();
      } else {
        notify?.(namedMessage(nameOf(target), data.error ?? "Failed to resume playlist"));
      }
    } catch {
      notify?.(namedMessage(nameOf(target), "Failed to resume playlist"));
    }
  }, [serverId, views, notify, nameOf, onChanged]);

  return {
    playlists,
    status,
    hasPlaylist,
    loading,
    error,
    fetchPlaylists,
    fetchStatus,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    activatePlaylist,
    deactivatePlaylist,
    resumePlaylist,
  };
}
