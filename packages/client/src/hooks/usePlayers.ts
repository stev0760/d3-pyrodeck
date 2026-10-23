import { useState, useEffect, useCallback } from "react";
import { getJson, sendJson, type PresentPlayer } from "@/lib/players";

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
 * The scoreboard and who is behind each name: `$scores` every 5 s while
 * auto-refresh is on, plus `/api/players/present` for addresses. Kick and ban
 * go through the server, which looks the player's slot up by name (`$scores`
 * is sorted by score, so its row order is not the slot).
 */
export function usePlayers({ sendCommand, onPlayers }: UsePlayersOptions) {
  const [players, setPlayers] = useState<PlayerScore[]>([]);
  const [present, setPresent] = useState<PresentPlayer[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const refresh = useCallback(() => {
    sendCommand("$scores");
    getJson<{ players: PresentPlayer[] }>("/api/players/present")
      .then((d) => setPresent(d.players))
      .catch(() => {});
  }, [sendCommand]);

  const addressOf = useCallback(
    (name: string) => present.find((p) => p.name === name)?.ip,
    [present],
  );

  const kick = useCallback(
    (name: string, reason: string) =>
      sendJson<{ message: string }>("POST", "/api/players/kick", { name, reason }),
    [],
  );

  const ban = useCallback(
    (name: string, options: BanOptions) =>
      sendJson<{ message: string }>("POST", "/api/players/ban", { name, ...options }),
    [],
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
