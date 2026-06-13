import { useState, useEffect, useCallback, useRef } from "react";

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
}

interface UseServerInfoOptions {
  sendCommand: (cmd: string) => void;
  onServerInfo: (cb: (data: unknown) => void) => () => void;
  /** Fires when the server starts loading a new level (Launch mode only). */
  onLevelChanged?: (cb: () => void) => () => void;
  connected: boolean;
}

// Periodically re-sync with the server so the local countdown can't drift
// far from the real game timer.
const SYNC_INTERVAL_MS = 30_000;

// How long after a level change ($warp, $endlevel, natural transition) to
// wait before re-querying — the new level needs a moment to load.
const LEVEL_CHANGE_REFRESH_DELAY_MS = 4_000;

function parseTimeLeftToSeconds(str: string): number {
  const parts = str.split(":").map((s) => parseInt(s, 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function useServerInfo({
  sendCommand,
  onServerInfo,
  onLevelChanged,
  connected,
}: UseServerInfoOptions) {
  const [serverInfo, setServerInfo] = useState<NetGameInfo | null>(null);
  const [localTimeLeft, setLocalTimeLeft] = useState<string | null>(null);
  const anchorRef = useRef<{ seconds: number; at: number } | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to serverinfo WS messages. Re-anchor the countdown on EVERY
  // response — a new level can start with the same "Time Left" string, so
  // anchoring off string changes alone misses level transitions.
  useEffect(() => {
    return onServerInfo((data: unknown) => {
      const info = data as NetGameInfo;
      setServerInfo(info);
      if (info?.timeLeft) {
        const seconds = parseTimeLeftToSeconds(info.timeLeft);
        anchorRef.current = seconds > 0 ? { seconds, at: Date.now() } : null;
        setLocalTimeLeft(info.timeLeft);
      } else {
        anchorRef.current = null;
        setLocalTimeLeft(null);
      }
    });
  }, [onServerInfo]);

  const refresh = useCallback(() => {
    if (connected) {
      sendCommand("$netgameinfo");
    }
  }, [connected, sendCommand]);

  // Re-query after a change (debounced). Settings apply near-instantly
  // (default 500ms); level changes need a longer delay while the level loads.
  const refreshAfterChange = useCallback(
    (delayMs: number = 500) => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        refresh();
      }, delayMs);
    },
    [refresh],
  );

  // Keep the latest refreshAfterChange reachable from the 1s tick interval
  // without re-creating the interval.
  const refreshAfterChangeRef = useRef(refreshAfterChange);
  useEffect(() => {
    refreshAfterChangeRef.current = refreshAfterChange;
  }, [refreshAfterChange]);

  // Tick every second to count down locally. When the countdown hits zero
  // the level is about to rotate — drop the anchor and re-query shortly so
  // the timer picks up the next level instead of sitting at 0:00.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!anchorRef.current) return;
      const elapsed = Math.floor((Date.now() - anchorRef.current.at) / 1000);
      const remaining = Math.max(0, anchorRef.current.seconds - elapsed);
      setLocalTimeLeft(formatSeconds(remaining));
      if (remaining <= 0) {
        anchorRef.current = null;
        refreshAfterChangeRef.current(LEVEL_CHANGE_REFRESH_DELAY_MS);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Query on connect
  useEffect(() => {
    if (connected) {
      sendCommand("$netgameinfo");
    } else {
      setServerInfo(null);
    }
  }, [connected, sendCommand]);

  // Periodic re-sync while connected — catches level changes Pyrodeck can't
  // observe (e.g. Connect mode, where there's no stdout) and corrects drift.
  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(() => {
      sendCommand("$netgameinfo");
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [connected, sendCommand]);

  // Launch mode: the server tells us when a new level starts loading.
  // Clear the stale countdown right away and re-query once it's loaded.
  useEffect(() => {
    if (!onLevelChanged) return;
    return onLevelChanged(() => {
      anchorRef.current = null;
      setLocalTimeLeft(null);
      refreshAfterChange(LEVEL_CHANGE_REFRESH_DELAY_MS);
    });
  }, [onLevelChanged, refreshAfterChange]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  // Action helpers — each sends a command then refreshes
  const setMaxPlayers = useCallback(
    (n: number) => {
      sendCommand(`$setmaxplayers ${n}`);
      refreshAfterChange();
    },
    [sendCommand, refreshAfterChange],
  );

  const setPps = useCallback(
    (n: number) => {
      sendCommand(`$setpps ${n}`);
      refreshAfterChange();
    },
    [sendCommand, refreshAfterChange],
  );

  const setTimeLimit = useCallback(
    (minutes: number) => {
      sendCommand(`$settimelimit ${minutes}`);
      refreshAfterChange();
    },
    [sendCommand, refreshAfterChange],
  );

  const setGoalLimit = useCallback(
    (points: number) => {
      sendCommand(`$setgoallimit ${points}`);
      refreshAfterChange();
    },
    [sendCommand, refreshAfterChange],
  );

  const setRespawnTime = useCallback(
    (seconds: number) => {
      sendCommand(`$setrespawntime ${seconds}`);
      refreshAfterChange();
    },
    [sendCommand, refreshAfterChange],
  );

  const endLevel = useCallback(() => {
    sendCommand("$endlevel");
    refreshAfterChange(LEVEL_CHANGE_REFRESH_DELAY_MS);
  }, [sendCommand, refreshAfterChange]);

  const warp = useCallback(
    (level: number) => {
      sendCommand(`$warp ${level}`);
      refreshAfterChange(LEVEL_CHANGE_REFRESH_DELAY_MS);
    },
    [sendCommand, refreshAfterChange],
  );

  const balanceTeams = useCallback(() => {
    sendCommand("$balance");
  }, [sendCommand]);

  const quitServer = useCallback(() => {
    sendCommand("quit");
  }, [sendCommand]);

  const displayInfo = serverInfo
    ? { ...serverInfo, timeLeft: localTimeLeft }
    : null;

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
