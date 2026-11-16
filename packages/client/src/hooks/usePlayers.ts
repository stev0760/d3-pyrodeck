import { useState, useEffect, useCallback } from "react";
import { getJson, sendJson, type PresentPlayer } from "@/lib/players";
import { useSession } from "@/session/SessionProvider";

export interface PlayerScore {
  name: string;
  points: number;
  kills: number;
  deaths: number;
  suicides: number;
  ping: number | null;
  isBot: boolean;
  isObserver: boolean;
}

export interface BanOptions {
  reason: string;
  /** Put the address into hosts.deny. */
  hostsDeny: boolean;
  /** Ban the name as well. */
  nameBan: boolean;
}

interface UsePlayersOptions {
  sendCommand: (command: string) => void;
  onPlayers: (callback: (data: unknown) => void) => () => void;
}

/**
 * The selected server's scoreboard and who is behind each name: `$scores`
 * every 5 s while auto-refresh is on, plus `GET /api/servers/:serverId/players`
 * for addresses. Kick and ban name the server (its events' profile id) and go
 * through Pyrodeck, which looks the player's slot up by name (`$scores` is
 * sorted by score, so its row order is not the slot).
 */
export function usePlayers({ sendCommand, onPlayers }: UsePlayersOptions) {
  const { serverId, eventProfileId } = useSession();
  const [players, setPlayers] = useState<PlayerScore[]>([]);
  const [present, setPresent] = useState<PresentPlayer[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const refresh = useCallback(() => {
    sendCommand("$scores");
    if (!serverId) return;
    getJson<{ profileId: string | null; players: PresentPlayer[] }>(`/api/servers/${encodeURIComponent(serverId)}/players`)
      .then((d) => {
        setPresent(d.players);
        setProfileId(d.profileId);
      })
      .catch(() => {});
  }, [sendCommand, serverId]);

  /** The server a kick or ban is for, named: never "whichever console is open". */
  const target = profileId ?? eventProfileId;

  const addressOf = useCallback(
    (name: string) => present.find((p) => p.name === name)?.ip,
    [present],
  );

  const kick = useCallback(
    (name: string, reason: string) =>
      target
        ? sendJson<{ message: string }>("POST", "/api/players/kick", { name, reason, profileId: target })
        : Promise.reject(new Error("No server selected")),
    [target],
  );

  const ban = useCallback(
    (name: string, options: BanOptions) =>
      target
        ? sendJson<{ message: string }>("POST", "/api/players/ban", { name, ...options, profileId: target })
        : Promise.reject(new Error("No server selected")),
    [target],
  );

  useEffect(() => {
    if (!autoRefresh) return;
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, refresh]);

  useEffect(() => {
    const unsubscribe = onPlayers((data: unknown) => {
      const payload = data as { players: PlayerScore[] };
      if (payload.players) {
        setPlayers(payload.players);
      }
    });
    return unsubscribe;
  }, [onPlayers]);

  return { players, present, addressOf, refresh, autoRefresh, setAutoRefresh, kick, ban };
}
