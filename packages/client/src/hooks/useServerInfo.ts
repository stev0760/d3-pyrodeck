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
  connected,
}: UseServerInfoOptions) {
  const [serverInfo, setServerInfo] = useState<NetGameInfo | null>(null);
  const [localTimeLeft, setLocalTimeLeft] = useState<string | null>(null);
  const anchorRef = useRef<{ seconds: number; at: number } | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to serverinfo WS messages
  useEffect(() => {
    return onServerInfo((data: unknown) => {
      setServerInfo(data as NetGameInfo);
    });
  }, [onServerInfo]);

  // Re-anchor countdown whenever serverInfo.timeLeft changes
  useEffect(() => {
    if (!serverInfo?.timeLeft) {
      anchorRef.current = null;
      setLocalTimeLeft(null);
      return;
    }
    const seconds = parseTimeLeftToSeconds(serverInfo.timeLeft);
    if (seconds <= 0) {
      anchorRef.current = null;
      setLocalTimeLeft(serverInfo.timeLeft);
      return;
    }
    anchorRef.current = { seconds, at: Date.now() };
    setLocalTimeLeft(serverInfo.timeLeft);
  }, [serverInfo?.timeLeft]);

  // Tick every second to count down locally
  useEffect(() => {
    const interval = setInterval(() => {
      if (!anchorRef.current) return;
      const elapsed = Math.floor((Date.now() - anchorRef.current.at) / 1000);
      const remaining = Math.max(0, anchorRef.current.seconds - elapsed);
      setLocalTimeLeft(formatSeconds(remaining));
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
