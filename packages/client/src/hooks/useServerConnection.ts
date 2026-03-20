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

  const wsRef = useRef<WebSocket | null>(null);
  const outputCallbacksRef = useRef<Array<(data: string) => void>>([]);

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;

        switch (msg.type) {
          case "output":
            for (const cb of outputCallbacksRef.current) {
              cb((msg.payload as { raw: string }).raw);
            }
            break;
          case "connection_state":
            setConnectionState(
              (msg.payload as { state: ConnectionState }).state,
            );
            break;
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

    ws.onclose = () => {
      wsRef.current = null;
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

        // Open WebSocket for live streaming
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
    wsRef.current?.close();
    wsRef.current = null;

    await fetch("/api/server/disconnect", {
      method: "POST",
      credentials: "include",
    });

    setConnectionState("disconnected");
    setCapabilities(null);
  }, []);

  const sendCommand = useCallback((command: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ type: "command", payload: { command } }),
      );
    }
  }, []);

  const onOutput = useCallback((callback: (data: string) => void) => {
    outputCallbacksRef.current.push(callback);
    return () => {
      outputCallbacksRef.current = outputCallbacksRef.current.filter(
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
    connect,
    disconnect,
    sendCommand,
    onOutput,
    hasFeature,
  };
}
