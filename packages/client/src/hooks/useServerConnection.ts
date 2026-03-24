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
  const playersCallbacksRef = useRef<Array<(data: unknown) => void>>([]);
  const botsCallbacksRef = useRef<Array<(data: unknown) => void>>([]);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const shouldReconnectRef = useRef(false);

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
    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.close();
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
          case "output":
            for (const cb of outputCallbacksRef.current) {
              cb((msg.payload as { raw: string }).raw);
            }
            break;
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
          case "connection_state": {
            const newState = (msg.payload as { state: ConnectionState }).state;
            setConnectionState(newState);
            // If server reports disconnected, stop reconnecting
            if (newState === "disconnected") {
              shouldReconnectRef.current = false;
              setWsReconnecting(false);
            }
            break;
          }
          case "capabilities":
            setCapabilities(msg.payload as unknown as ServerCapabilities);
            break;
          case "error":
            setError((msg.payload as { message: string }).message);
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

        // Open WebSocket for live streaming with auto-reconnect
        shouldReconnectRef.current = true;
        connectWs();
        return true;
      } catch (err) {
        setConnectionState("disconnected");
        setError(err instanceof Error ? err.message : "Connection failed");
        return false;
      }
    },
    [connectWs],
  );

  const disconnect = useCallback(async () => {
    shouldReconnectRef.current = false;
    setWsReconnecting(false);
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    setWsConnected(false);

    await fetch("/api/server/disconnect", {
      method: "POST",
      credentials: "include",
    });

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

  const hasFeature = useCallback(
    (feature: string): boolean => {
      return capabilities?.features.includes(feature) ?? false;
    },
    [capabilities],
  );

  return {
    connectionState,
    capabilities,
    error,
    wsConnected,
    wsReconnecting,
    connect,
    disconnect,
    sendCommand,
    onOutput,
    onPlayers,
    onBots,
    hasFeature,
  };
}
