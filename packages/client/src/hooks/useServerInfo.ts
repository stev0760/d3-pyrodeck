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
  /**
   * The level file currently loaded (".d3l" stripped). Merged in from the
   * server's level_changed signal, not from $netgameinfo (which has no level
   * field). Null in Connect mode (no stdout to parse) or before the first
   * level loads.
   */
  currentLevel?: string | null;
}

interface UseServerInfoOptions {
  sendCommand: (cmd: string) => void;
  onServerInfo: (cb: (data: unknown) => void) => () => void;
  /** Fires when the server starts loading a new level (Launch mode only). */
  onLevelChanged?: (cb: (level: string | null) => void) => () => void;
  connected: boolean;
}

function parseTimeLeftToSeconds(str: string): number {
  // Handles "M:SS", "MM:SS", and "H:MM:SS".
  const parts = str.split(":").map((s) => parseInt(s, 10));
  if (parts.some((n) => isNaN(n))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
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
  const [currentLevel, setCurrentLevel] = useState<string | null>(null);
  const anchorRef = useRef<{ seconds: number; at: number } | null>(null);
  // Latest serverInfo, readable from callbacks without re-subscribing.
  const serverInfoRef = useRef<NetGameInfo | null>(null);

  // IMPORTANT: $netgameinfo permanently leaks a fixed-size engine text buffer
  // on dedicated D3 servers (retail 1999 bug — the buffer is only flushed by
  // rendering, which a dedicated server never does). After ~30 calls the
  // server aborts. So this hook NEVER polls it: it queries once on connect (and
  // on the manual refresh button), caches the result, and derives the live
  // countdown locally. Level changes re-anchor from the cached time limit; the
  // server pushes a fresh serverinfo on rotation so static fields stay current.

  // Re-anchor the local countdown to the full time limit — a new level starts
  // the clock fresh. Pure client-side; issues no command.
  const reanchorToFullLimit = useCallback(() => {
    const limitSec = (serverInfoRef.current?.timeLimit ?? 0) * 60;
    if (limitSec > 0) {
      anchorRef.current = { seconds: limitSec, at: Date.now() };
      setLocalTimeLeft(formatSeconds(limitSec));
    } else {
      anchorRef.current = null;
      setLocalTimeLeft(null);
    }
  }, []);

  // Subscribe to serverinfo WS messages. Re-anchor the countdown on EVERY
  // response — a new level can start with the same "Time Left" string, so
  // anchoring off string changes alone misses level transitions.
  useEffect(() => {
    return onServerInfo((data: unknown) => {
      const info = data as NetGameInfo;
      setServerInfo(info);
      serverInfoRef.current = info;
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

  // Manual refresh (refresh button) — the only on-demand $netgameinfo. Bounded
  // by user clicks, never a timer.
  const refresh = useCallback(() => {
    if (connected) {
      sendCommand("$netgameinfo");
    }
  }, [connected, sendCommand]);

  // Tick every second to count down locally. When the countdown hits zero the
  // level is about to rotate — drop the anchor and let the level_changed signal
  // re-anchor the next level (we never re-query to find out).
  useEffect(() => {
    const interval = setInterval(() => {
      if (!anchorRef.current) return;
      const elapsed = Math.floor((Date.now() - anchorRef.current.at) / 1000);
      const remaining = Math.max(0, anchorRef.current.seconds - elapsed);
      setLocalTimeLeft(formatSeconds(remaining));
      if (remaining <= 0) {
        anchorRef.current = null;
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Query once on connect; clear on disconnect.
  useEffect(() => {
    if (connected) {
      sendCommand("$netgameinfo");
    } else {
      setServerInfo(null);
      serverInfoRef.current = null;
      setCurrentLevel(null);
    }
  }, [connected, sendCommand]);

  // Launch mode: the server tells us when a new level starts loading (and
  // pushes the current level on connect). Record which level is loaded and
  // re-anchor the countdown locally from the cached time limit — no re-query.
  useEffect(() => {
    if (!onLevelChanged) return;
    return onLevelChanged((level) => {
      setCurrentLevel(level);
      reanchorToFullLimit();
    });
  }, [onLevelChanged, reanchorToFullLimit]);

  // Action helpers. Each sends a command and updates the cached display
  // optimistically — re-querying $netgameinfo to confirm would burn the
  // server's limited call budget, so we trust the value we just set.
  const patchInfo = useCallback((patch: Partial<NetGameInfo>) => {
    setServerInfo((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      serverInfoRef.current = next;
      return next;
    });
  }, []);

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
      patchInfo({ timeLimit: minutes });
      // Changing the limit restarts the clock at the new full value.
      const limitSec = minutes * 60;
      if (limitSec > 0) {
        anchorRef.current = { seconds: limitSec, at: Date.now() };
        setLocalTimeLeft(formatSeconds(limitSec));
      } else {
        anchorRef.current = null;
        setLocalTimeLeft(null);
      }
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
    anchorRef.current = null;
    setLocalTimeLeft(null);
  }, [sendCommand]);

  const warp = useCallback(
    (level: number) => {
      sendCommand(`$warp ${level}`);
      anchorRef.current = null;
      setLocalTimeLeft(null);
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
    ? { ...serverInfo, timeLeft: localTimeLeft, currentLevel }
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
