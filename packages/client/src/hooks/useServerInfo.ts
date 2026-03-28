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
  connected: boolean;
}

export function useServerInfo({
  sendCommand,
  onServerInfo,
  connected,
}: UseServerInfoOptions) {
  const [serverInfo, setServerInfo] = useState<NetGameInfo | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to serverinfo WS messages
  useEffect(() => {
    return onServerInfo((data: unknown) => {
      setServerInfo(data as NetGameInfo);
    });
  }, [onServerInfo]);

  // Query on connect
  useEffect(() => {
    if (connected) {
      sendCommand("$netgameinfo");
    } else {
      setServerInfo(null);
    }
  }, [connected, sendCommand]);

  const refresh = useCallback(() => {
    if (connected) {
      sendCommand("$netgameinfo");
    }
  }, [connected, sendCommand]);

  // Re-query after a setting change (debounced)
  const refreshAfterChange = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refresh();
    }, 500);
  }, [refresh]);

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
  }, [sendCommand]);

  const warp = useCallback(
    (level: number) => {
      sendCommand(`$warp ${level}`);
    },
    [sendCommand],
  );

  const balanceTeams = useCallback(() => {
    sendCommand("$balance");
  }, [sendCommand]);

  const quitServer = useCallback(() => {
    sendCommand("quit");
  }, [sendCommand]);

  return {
    serverInfo,
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
