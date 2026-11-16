import { useState, useEffect, useCallback } from "react";
import type { ServerView, ServerViews } from "@/lib/serverViews";

export interface NetGameInfo {
  gameName: string;
  missionName: string;
  scriptName: string;
  pps: number;
  maxPlayers: number;
  accurateCollisions: boolean;
  sendRotationalVelocity: boolean;
  timeLimit: number;
  timeLeft: string | null;
  goalLimit: number;
  respawnTime: string;
  networkModel: string;
  /**
   * The level file currently loaded (".d3l" stripped). Merged in from the
   * server's level_changed signal, not from $netgameinfo (which has no level
   * field). Null in Connect mode (no stdout to parse) or before the first
   * level loads.
   */
  currentLevel?: string | null;
}

interface UseServerInfoOptions {
  /** The selected server, its view and the store of every server's. */
  serverId: string | null;
  view: ServerView | null;
  views: ServerViews;
  /** A command to the selected server. */
  sendCommand: (cmd: string) => void;
  /** The WebSocket is open and has said hello: a command sent now arrives. */
  canSend: boolean;
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * The selected server's game settings and time left, from its `$netgameinfo`.
 *
 * IMPORTANT: $netgameinfo permanently leaks a fixed-size engine text buffer
 * on dedicated D3 servers (retail 1999 bug — the buffer is only flushed by
 * rendering, which a dedicated server never does). After ~30 calls the
 * server aborts. So this hook NEVER polls it: it asks once per console login
 * of each server (when that server is first shown), keeps the answer in the
 * server's view, so switching servers back and forth asks nothing more, and
 * derives the live countdown locally. Level changes re-anchor from the cached
 * time limit; the server pushes a fresh serverinfo on rotation.
 */
export function useServerInfo({ serverId, view, views, sendCommand, canSend }: UseServerInfoOptions) {
  const connected = view?.connectionState === "ready";
  const [now, setNow] = useState(() => Date.now());

  // Ask once per console login, for the server on screen.
  useEffect(() => {
    if (!serverId || !connected || !canSend || view?.infoAsked) return;
    views.patch(serverId, { infoAsked: true });
    sendCommand("$netgameinfo");
  }, [serverId, connected, canSend, view?.infoAsked, views, sendCommand]);

  // Tick every second to count down locally.
  const anchored = view?.anchor != null;
  useEffect(() => {
    if (!anchored) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [anchored]);

  // Manual refresh (refresh button) — the only on-demand $netgameinfo. Bounded
  // by user clicks, never a timer.
  const refresh = useCallback(() => {
    if (connected) sendCommand("$netgameinfo");
  }, [connected, sendCommand]);

  // Action helpers. Each sends a command and updates the cached display
  // optimistically — re-querying $netgameinfo to confirm would burn the
  // server's limited call budget, so we trust the value we just set.
  const patchInfo = useCallback(
    (patch: Partial<NetGameInfo>, anchor?: ServerView["anchor"]) => {
      if (!serverId) return;
      const info = views.get(serverId).info;
      views.patch(serverId, {
        ...(info ? { info: { ...info, ...patch } } : {}),
        ...(anchor !== undefined ? { anchor } : {}),
      });
    },
    [serverId, views],
  );

  const setMaxPlayers = useCallback(
    (n: number) => {
      sendCommand(`$setmaxplayers ${n}`);
      patchInfo({ maxPlayers: n });
    },
    [sendCommand, patchInfo],
  );

  const setPps = useCallback(
    (n: number) => {
      sendCommand(`$setpps ${n}`);
      patchInfo({ pps: n });
    },
    [sendCommand, patchInfo],
  );

  const setTimeLimit = useCallback(
    (minutes: number) => {
      sendCommand(`$settimelimit ${minutes}`);
      // Changing the limit restarts the clock at the new full value.
      const limitSec = minutes * 60;
      patchInfo({ timeLimit: minutes }, limitSec > 0 ? { seconds: limitSec, at: Date.now() } : null);
    },
    [sendCommand, patchInfo],
  );

  const setGoalLimit = useCallback(
    (points: number) => {
      sendCommand(`$setgoallimit ${points}`);
      patchInfo({ goalLimit: points });
    },
    [sendCommand, patchInfo],
  );

  const setRespawnTime = useCallback(
    (seconds: number) => {
      sendCommand(`$setrespawntime ${seconds}`);
      patchInfo({ respawnTime: formatSeconds(seconds) });
    },
    [sendCommand, patchInfo],
  );

  // Level changes: drop the stale countdown immediately. In Launch mode the
  // level_changed signal re-anchors once the new level loads.
  const endLevel = useCallback(() => {
    sendCommand("$endlevel");
    patchInfo({}, null);
  }, [sendCommand, patchInfo]);

  const warp = useCallback(
    (level: number) => {
      sendCommand(`$warp ${level}`);
      patchInfo({}, null);
    },
    [sendCommand, patchInfo],
  );

  const balanceTeams = useCallback(() => {
    sendCommand("$balance");
  }, [sendCommand]);

  const quitServer = useCallback(() => {
    sendCommand("quit");
  }, [sendCommand]);

  let timeLeft: string | null = null;
  if (view?.anchor) {
    const elapsed = Math.floor((Math.max(now, view.anchor.at) - view.anchor.at) / 1000);
    timeLeft = formatSeconds(Math.max(0, view.anchor.seconds - elapsed));
  }
  const displayInfo: NetGameInfo | null = view?.info ? { ...view.info, timeLeft, currentLevel: view.level } : null;

  return {
    serverInfo: displayInfo,
    refresh,
    setMaxPlayers,
    setPps,
    setTimeLimit,
    setGoalLimit,
    setRespawnTime,
    endLevel,
    warp,
    balanceTeams,
    quitServer,
  };
}
