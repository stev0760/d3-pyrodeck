import { useState, useCallback, useRef, useEffect } from "react";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "probing"
  | "ready";

export interface ServerCapabilities {
  version: number;
  fork: string;
  forkVersion: string;
  features: string[];
}

interface WsMessage {
  type: string;
  payload: Record<string, unknown>;
}

export function useServerConnection() {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsReconnecting, setWsReconnecting] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const outputCallbacksRef = useRef<Array<(data: string) => void>>([]);
  const processOutputCallbacksRef = useRef<Array<(data: string, stream: string) => void>>([]);
  const playersCallbacksRef = useRef<Array<(data: unknown) => void>>([]);
  const botsCallbacksRef = useRef<Array<(data: unknown) => void>>([]);
  const serverInfoCallbacksRef = useRef<Array<(data: unknown) => void>>([]);
  const playlistCallbacksRef = useRef<Array<(type: string, data: unknown) => void>>([]);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const shouldReconnectRef = useRef(false);
  const lastPongRef = useRef<number>(0);

  // Cleanup WebSocket and reconnect timer on unmount
  useEffect(() => {
    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, []);


  const connectWs = useCallback(() => {
    // Close existing connection if any — clear handlers to prevent
    // stale onclose from clobbering the new WS reference
    if (wsRef.current) {
      const old = wsRef.current;
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      old.close();
      wsRef.current = null;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[Pyrodeck] WebSocket connected");
      setWsConnected(true);
      setWsReconnecting(false);
      reconnectDelayRef.current = 1000; // Reset backoff on successful connect
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;

        switch (msg.type) {
          case "ping":
            // Respond to server ping with pong
            if (ws.readyState === WebSocket.OPEN) {
              ws.pong?.(event.data);
            }
            lastPongRef.current = Date.now();
            break;
          case "output":
            for (const cb of outputCallbacksRef.current) {
              cb((msg.payload as { raw: string }).raw);
            }
            break;
          case "process_output": {
            const { stream, data } = msg.payload as { stream: string; data: string };
            for (const cb of processOutputCallbacksRef.current) {
              cb(data, stream);
            }
            break;
          }
          case "players":
            for (const cb of playersCallbacksRef.current) {
              cb(msg.payload);
            }
            break;
          case "bots":
            for (const cb of botsCallbacksRef.current) {
              cb(msg.payload);
            }
            break;
          case "serverinfo":
            for (const cb of serverInfoCallbacksRef.current) {
              cb(msg.payload);
            }
            break;
          case "connection_state": {
            const newState = (msg.payload as { state: ConnectionState }).state;
            setConnectionState(newState);
            break;
          }
          case "capabilities":
            setCapabilities(msg.payload as unknown as ServerCapabilities);
            break;
          case "error":
            setError((msg.payload as { message: string }).message);
            break;
          case "playlist_timer":
          case "playlist_rotate":
          case "playlist_status":
          case "playlist_vote_announce":
          case "playlist_vote_result":
            for (const cb of playlistCallbacksRef.current) {
              cb(msg.type, msg.payload);
            }
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onerror = (event) => {
      console.error("[Pyrodeck] WebSocket error:", event);
    };

    ws.onclose = (event) => {
      // Only handle close if this is still the current WS
      if (wsRef.current !== ws) return;

      console.log("[Pyrodeck] WebSocket closed:", event.code, event.reason);
      wsRef.current = null;
      setWsConnected(false);

      // Auto-reconnect with exponential backoff
      if (shouldReconnectRef.current) {
        const delay = reconnectDelayRef.current;
        console.log(`[Pyrodeck] Reconnecting in ${delay}ms...`);
        setWsReconnecting(true);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (shouldReconnectRef.current) {
            connectWs();
          }
        }, delay);
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
        reconnectDelayRef.current = Math.min(delay * 2, 30000);
      }
    };
  }, []);

  // Always open WebSocket on mount so we can receive broadcasts
  // (e.g. Launch Mode auto-connect, process state changes)
  useEffect(() => {
    shouldReconnectRef.current = true;
    connectWs();
  }, [connectWs]);

  // HTTP fallback: also fetch the current session state on mount.
  // iOS Safari can miss the initial WS "connection_state" message due to
  // bfcache restore or message-timing quirks, leaving the UI stuck in
  // "disconnected" even though the server has an active session.
  // Also re-runs on bfcache restore via the pageshow event.
  useEffect(() => {
    const syncStatus = async () => {
      try {
        const res = await fetch("/api/server/status", {
          credentials: "include",
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.state) setConnectionState(data.state);
        if (data.capabilities) setCapabilities(data.capabilities);
      } catch {
        // Ignore — WS will deliver state when it reconnects
      }
    };

    syncStatus();

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        // Restored from bfcache — WS was likely closed, so reconnect and resync
        syncStatus();
        connectWs();
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [connectWs]);

  // Liveness check: iOS Safari silently kills WS connections when the app
  // is backgrounded without firing onclose. If we haven't received a ping
  // from the server in > 30s, force a reconnect.
  useEffect(() => {
    const checkInterval = setInterval(() => {
      const now = Date.now();
      if (lastPongRef.current > 0 && now - lastPongRef.current > 30_000) {
        console.log("[Pyrodeck] No ping received in 30s — reconnecting");
        connectWs();
      }
    }, 10_000);
    return () => clearInterval(checkInterval);
  }, [connectWs]);

  const connect = useCallback(
    async (host: string, port: number, password: string) => {
      setError(null);
      setConnectionState("connecting");

      try {
        const res = await fetch("/api/server/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ host, port, password }),
        });

        const data = await res.json();

        if (!res.ok) {
          setConnectionState("disconnected");
          setError(data.error || "Connection failed");
          return false;
        }

        setConnectionState(data.state);
        setCapabilities(data.capabilities);
        return true;
      } catch (err) {
        setConnectionState("disconnected");
        setError(err instanceof Error ? err.message : "Connection failed");
        return false;
      }
    },
    [],
  );

  const reconnect = useCallback(() => {
    connectWs();
  }, [connectWs]);

  const disconnect = useCallback(async () => {
    try {
      await fetch("/api/server/disconnect", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Server may be unreachable
    }

    // Server will broadcast connection_state: disconnected via WS,
    // but set it locally too for immediate UI feedback
    setConnectionState("disconnected");
    setCapabilities(null);
  }, []);

  const sendCommand = useCallback((command: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn(
        "[Pyrodeck] Cannot send command — WebSocket not open. State:",
        ws?.readyState,
      );
      return;
    }
    ws.send(JSON.stringify({ type: "command", payload: { command } }));
  }, []);

  const onOutput = useCallback((callback: (data: string) => void) => {
    outputCallbacksRef.current.push(callback);
    return () => {
      outputCallbacksRef.current = outputCallbacksRef.current.filter(
        (cb) => cb !== callback,
      );
    };
  }, []);

  const onProcessOutput = useCallback((callback: (data: string, stream: string) => void) => {
    processOutputCallbacksRef.current.push(callback);
    return () => {
      processOutputCallbacksRef.current = processOutputCallbacksRef.current.filter(
        (cb) => cb !== callback,
      );
    };
  }, []);

  const onPlayers = useCallback((callback: (data: unknown) => void) => {
    playersCallbacksRef.current.push(callback);
    return () => {
      playersCallbacksRef.current = playersCallbacksRef.current.filter(
        (cb) => cb !== callback,
      );
    };
  }, []);

  const onBots = useCallback((callback: (data: unknown) => void) => {
    botsCallbacksRef.current.push(callback);
    return () => {
      botsCallbacksRef.current = botsCallbacksRef.current.filter(
        (cb) => cb !== callback,
      );
    };
  }, []);

  const onServerInfo = useCallback((callback: (data: unknown) => void) => {
    serverInfoCallbacksRef.current.push(callback);
    return () => {
      serverInfoCallbacksRef.current = serverInfoCallbacksRef.current.filter(
        (cb) => cb !== callback,
      );
    };
  }, []);

  const hasFeature = useCallback(
    (feature: string): boolean => {
      return capabilities?.features.includes(feature) ?? false;
    },
    [capabilities],
  );

  const onPlaylistEvent = useCallback((callback: (type: string, data: unknown) => void) => {
    playlistCallbacksRef.current.push(callback);
    return () => {
      playlistCallbacksRef.current = playlistCallbacksRef.current.filter(
        (cb) => cb !== callback,
      );
    };
  }, []);

  return {
    connectionState,
    capabilities,
    error,
    wsConnected,
    wsReconnecting,
    connect,
    reconnect,
    disconnect,
    sendCommand,
    onOutput,
    onProcessOutput,
    onPlayers,
    onBots,
    onServerInfo,
    onPlaylistEvent,
    hasFeature,
  };
}
