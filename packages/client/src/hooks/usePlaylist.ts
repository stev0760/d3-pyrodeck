import { useState, useEffect, useCallback } from "react";
import type { useServerConnection } from "./useServerConnection.ts";

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

export interface Playlist {
  id: string;
  name: string;
  mode: PlaylistMode;
  entries: PlaylistEntry[];
  voting: PlaylistVoting;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistStatus {
  status: "inactive" | "active" | "voting" | "restarting";
  activePlaylistId: string | null;
  currentIndex: number;
  currentEntry: PlaylistEntry | null;
  gameEndAt: number | null;
  voteOptions: PlaylistEntry[];
  voteDeadline: number | null;
}

type OnPlaylistEvent = ReturnType<typeof useServerConnection>["onPlaylistEvent"];

interface UsePlaylistOptions {
  onPlaylistEvent: OnPlaylistEvent;
  notify?: (message: string, type?: "error" | "info") => void;
}

export function usePlaylist({ onPlaylistEvent, notify }: UsePlaylistOptions) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [status, setStatus] = useState<PlaylistStatus>({
    status: "inactive",
    activePlaylistId: null,
    currentIndex: 0,
    currentEntry: null,
    gameEndAt: null,
    voteOptions: [],
    voteDeadline: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to WS playlist events
  useEffect(() => {
    const unsub = onPlaylistEvent((type, data) => {
      if (type === "playlist_timer") {
        const { gameEndAt } = data as { gameEndAt: number | null };
        setStatus((prev) => ({ ...prev, gameEndAt }));
      } else if (type === "playlist_rotate") {
        const { entry } = data as { entry: PlaylistEntry };
        setStatus((prev) => ({ ...prev, currentEntry: entry, status: "active" }));
        notify?.(`Rotating to: ${entry.label}`, "info");
        // Re-fetch status after rotation
        fetchStatus();
      } else if (type === "playlist_status") {
        setStatus(data as PlaylistStatus);
      } else if (type === "playlist_vote_announce") {
        const { options, deadline } = data as { options: PlaylistEntry[]; deadline: number };
        setStatus((prev) => ({ ...prev, status: "voting", voteOptions: options, voteDeadline: deadline }));
        notify?.(`Vote open: ${options.map((o, i) => `${i + 1}. ${o.label}`).join("  ")}`, "info");
      } else if (type === "playlist_vote_result") {
        const { winner, counts } = data as { winner: PlaylistEntry; counts: number[] };
        setStatus((prev) => ({ ...prev, status: "active", voteOptions: [], voteDeadline: null }));
        const total = counts?.reduce((a, b) => a + b, 0) ?? 0;
        notify?.(`Vote winner: ${winner.label} (${total} vote${total === 1 ? "" : "s"})`, "info");
      }
    });
    return unsub;
  }, [onPlaylistEvent, notify]);

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

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/playlists/status", { credentials: "include" });
      if (res.ok) {
        setStatus(await res.json());
      }
    } catch {
      // ignore
    }
  }, []);

  // Load on mount
  useEffect(() => {
    fetchPlaylists();
    fetchStatus();
  }, [fetchPlaylists, fetchStatus]);

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
      return data;
    } catch {
      setError("Network error");
      return null;
    }
  }, []);

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
      if (status.activePlaylistId === id) {
        setStatus((prev) => ({ ...prev, activePlaylistId: null, status: "inactive" }));
      }
      return true;
    } catch {
      setError("Network error");
      return false;
    }
  }, [status.activePlaylistId]);

  const activatePlaylist = useCallback(async (id: string, profileId?: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(id)}/activate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // profileId lets the server validate mission/game-mode compatibility
        // against the profile that will actually be rotated.
        body: JSON.stringify(profileId ? { profileId } : {}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to activate playlist");
        return false;
      }
      setStatus(data.status);
      return true;
    } catch {
      setError("Network error");
      return false;
    }
  }, []);

  const deactivatePlaylist = useCallback(async (): Promise<void> => {
    try {
      await fetch("/api/playlists/deactivate", {
        method: "POST",
        credentials: "include",
      });
      setStatus((prev) => ({
        ...prev,
        activePlaylistId: null,
        status: "inactive",
        gameEndAt: null,
        voteOptions: [],
        voteDeadline: null,
      }));
    } catch {
      // ignore
    }
  }, []);

  return {
    playlists,
    status,
    loading,
    error,
    fetchPlaylists,
    fetchStatus,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    activatePlaylist,
    deactivatePlaylist,
  };
}
