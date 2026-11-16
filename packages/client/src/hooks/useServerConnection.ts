import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from "react";
import { WS_SESSION_ENDED, notifySessionEnded, sessionIsGone } from "@/lib/session";
import { CONNECT_SERVER_ID, routeMessage, type WsMessage } from "@/lib/servers";
import { ServerViews, type ServerView } from "@/lib/serverViews";

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

/** The WebSocket protocol this client speaks (server: ws/wsHub.ts). */
const WS_PROTOCOL = 2;

type Callback<A extends unknown[]> = (...args: A) => void;

/** A set of callbacks with a subscribe function that returns its own unsubscribe. */
function useCallbacks<A extends unknown[]>() {
  const ref = useRef(new Set<Callback<A>>());
  const subscribe = useCallback((cb: Callback<A>) => {
    ref.current.add(cb);
    return () => {
      ref.current.delete(cb);
    };
  }, []);
  const emit = useCallback((...args: A) => {
    for (const cb of ref.current) cb(...args);
  }, []);
  return [subscribe, emit] as const;
}

/**
 * The one WebSocket to Pyrodeck, and the console of the server on screen.
 *
 * The socket says hello with protocol 2, so every server's messages arrive
 * tagged with their server's id. Each lands on that server's view (state,
 * capabilities, level, cached server info, playlist status, console and
 * process text) whichever server is on screen; the `on...` subscriptions and
 * the returned state are the selected server's only, so a switch of server
 * never shows one server's replies or roster on another. `sendCommand` names
 * the selected server; nothing goes to "whichever server is the default".
 */
export function useServerConnection(serverId: string | null) {
  const viewsRef = useRef<ServerViews | null>(null);
  if (!viewsRef.current) viewsRef.current = new ServerViews();
  const views = viewsRef.current;

  const selectedRef = useRef(serverId);
  selectedRef.current = serverId;

  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsReconnecting, setWsReconnecting] = useState(false);
  /** Pyrodeck answered the hello: messages carry their server. */
  const [helloDone, setHelloDone] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const shouldReconnectRef = useRef(false);
  const lastPongRef = useRef<number>(0);

  // The selected server's subscriptions.
  const [onOutput, emitOutput] = useCallbacks<[string]>();
  const [onProcessOutput, emitProcessOutput] = useCallbacks<[string, string]>();
  const [onPlayers, emitPlayers] = useCallbacks<[unknown]>();
  const [onBots, emitBots] = useCallbacks<[unknown]>();
  const [onBotStats, emitBotStats] = useCallbacks<[unknown]>();
  const [onBotMode, emitBotMode] = useCallbacks<[unknown]>();
  const [onBotPopulation, emitBotPopulation] = useCallbacks<[unknown]>();
  const [onServerInfo, emitServerInfo] = useCallbacks<[unknown]>();
  const [onLevelChanged, emitLevelChanged] = useCallbacks<[string | null]>();
  const [onPlaylistEvent, emitPlaylistEvent] = useCallbacks<[string, unknown]>();
  // Every server's messages (toasts, the server list), and errors (null: of no server).
  const [onServerMessage, emitServerMessage] = useCallbacks<[string, WsMessage]>();
  const [onError, emitError] = useCallbacks<[string | null, string]>();
  const [onHello, emitHello] = useCallbacks<[]>();

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

  const handleMessage = useCallback(
    (msg: WsMessage) => {
      if (msg.type === "ping") {
        lastPongRef.current = Date.now();
        return;
      }
      if (msg.type === "hello") {
        views.resetConsoles();
        setHelloDone(true);
        emitHello();
        return;
      }
      const route = routeMessage(msg);
      if (route.scope === "drop") return;
      if (route.scope === "global") {
        if (msg.type === "error") emitError(null, String((msg.payload as { message?: unknown }).message ?? ""));
        return;
      }
      const id = route.serverId;
      views.apply(id, msg);
      emitServerMessage(id, msg);
      if (msg.type === "error") {
        emitError(id, String((msg.payload as { message?: unknown }).message ?? ""));
        return;
      }
      if (id !== selectedRef.current) return;
      const p = msg.payload;
      switch (msg.type) {
        case "output":
          emitOutput(String((p as { raw?: unknown }).raw ?? ""));
          break;
        case "process_output": {
          const { stream, data } = p as { stream: string; data: string };
          emitProcessOutput(data, stream);
          break;
        }
        case "players":
          emitPlayers(p);
          break;
        case "bots":
          emitBots(p);
          break;
        case "botstats":
          emitBotStats(p);
          break;
        case "botmode":
          emitBotMode(p);
          break;
        case "botpopulation":
          emitBotPopulation(p);
          break;
        case "serverinfo":
          emitServerInfo(p);
          break;
        case "level_changed":
          emitLevelChanged((p as { level: string | null }).level);
          break;
        case "playlist_timer":
        case "playlist_rotate":
        case "playlist_status":
        case "playlist_vote_announce":
        case "playlist_vote_result":
          emitPlaylistEvent(msg.type, p);
          break;
      }
    },
    [
      views,
      emitHello,
      emitError,
      emitServerMessage,
      emitOutput,
      emitProcessOutput,
      emitPlayers,
      emitBots,
      emitBotStats,
      emitBotMode,
      emitBotPopulation,
      emitServerInfo,
      emitLevelChanged,
      emitPlaylistEvent,
    ],
  );
  const handleMessageRef = useRef(handleMessage);
  handleMessageRef.current = handleMessage;

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
    setHelloDone(false);

    ws.onopen = () => {
      console.log("[Pyrodeck] WebSocket connected");
      // Every server's messages, tagged with their server, from here on.
      ws.send(JSON.stringify({ type: "hello", payload: { protocol: WS_PROTOCOL } }));
      setWsConnected(true);
      setWsReconnecting(false);
      reconnectDelayRef.current = 1000; // Reset backoff on successful connect
    };

    ws.onmessage = (event) => {
      try {
        handleMessageRef.current(JSON.parse(event.data) as WsMessage);
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
      setHelloDone(false);

      // The login session behind this socket ended: no reconnect, log in again.
      if (event.code === WS_SESSION_ENDED) {
        shouldReconnectRef.current = false;
        setWsReconnecting(false);
        notifySessionEnded();
        return;
      }

      // Auto-reconnect with exponential backoff
      if (shouldReconnectRef.current) {
        const delay = reconnectDelayRef.current;
        console.log(`[Pyrodeck] Reconnecting in ${delay}ms...`);
        setWsReconnecting(true);
        reconnectTimerRef.current = setTimeout(async () => {
          reconnectTimerRef.current = null;
          // A refused handshake (401) looks like any other failed connection
          // to the browser, so ask first: after a Pyrodeck restart, or once
          // the session expired, there is no session to reconnect with.
          if (shouldReconnectRef.current && (await sessionIsGone())) {
            shouldReconnectRef.current = false;
            setWsReconnecting(false);
            notifySessionEnded();
            return;
          }
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

  // HTTP fallback: the selected server's console state, on mount, on a
  // switch of server and after a bfcache restore. iOS Safari can miss the
  // WebSocket's greeting (bfcache restore, message-timing quirks), leaving
  // the UI stuck in "disconnected" while the server has a console session.
  const syncStatus = useCallback(async (id: string | null) => {
    if (!id) return;
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(id)}/status`, { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { console?: ConnectionState; capabilities?: ServerCapabilities | null };
      if (data.console) {
        views.patch(id, {
          connectionState: data.console,
          ...(data.capabilities ? { capabilities: data.capabilities } : {}),
        });
      }
    } catch {
      // Ignore — WS will deliver state when it reconnects
    }
  }, [views]);

  useEffect(() => {
    void syncStatus(serverId);
  }, [serverId, syncStatus]);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        // Restored from bfcache — WS was likely closed, so reconnect and resync
        void syncStatus(selectedRef.current);
        connectWs();
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [connectWs, syncStatus]);

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

  /** Connect mode: log in to a server's console that Pyrodeck did not launch. */
  const connect = useCallback(
    async (host: string, port: number, password: string) => {
      setError(null);
      views.patch(CONNECT_SERVER_ID, { connectionState: "connecting" });

      try {
        const res = await fetch("/api/server/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ host, port, password }),
        });

        const data = await res.json();

        if (!res.ok) {
          views.patch(CONNECT_SERVER_ID, { connectionState: "disconnected" });
          setError(data.error || "Connection failed");
          return false;
        }

        views.patch(CONNECT_SERVER_ID, { connectionState: data.state, capabilities: data.capabilities });
        return true;
      } catch (err) {
        views.patch(CONNECT_SERVER_ID, { connectionState: "disconnected" });
        setError(err instanceof Error ? err.message : "Connection failed");
        return false;
      }
    },
    [views],
  );

  const reconnect = useCallback(() => {
    connectWs();
  }, [connectWs]);

  /** Connect mode: close its console session. */
  const disconnect = useCallback(async () => {
    setWsReconnecting(false);

    try {
      await fetch("/api/server/disconnect", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Server may be unreachable
    }

    views.patch(CONNECT_SERVER_ID, { connectionState: "disconnected", capabilities: null });
  }, [views]);

  /** One console command to a named server; its parsed reply comes back tagged with that server. */
  const sendCommandTo = useCallback((id: string, command: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn(
        "[Pyrodeck] Cannot send command — WebSocket not open. State:",
        ws?.readyState,
      );
      return;
    }
    ws.send(JSON.stringify({ type: "command", payload: { command, serverId: id } }));
  }, []);

  /** One console command to the selected server (never to "the default"). */
  const sendCommand = useCallback(
    (command: string) => {
      const id = selectedRef.current;
      if (!id) {
        console.warn("[Pyrodeck] Cannot send command — no server selected");
        return;
      }
      sendCommandTo(id, command);
    },
    [sendCommandTo],
  );

  const view: ServerView | null = useSyncExternalStore(
    useCallback((cb: () => void) => views.subscribe(cb), [views]),
    () => (serverId ? views.get(serverId) : null),
  );
  const connectionState: ConnectionState = view?.connectionState ?? "disconnected";
  const capabilities = view?.capabilities ?? null;

  const hasFeature = useCallback(
    (feature: string): boolean => {
      return capabilities?.features.includes(feature) ?? false;
    },
    [capabilities],
  );

  return {
    /** The server this connection's state, subscriptions and commands are about. */
    serverId,
    views,
    view,
    helloDone,
    connectionState,
    capabilities,
    error,
    wsConnected,
    wsReconnecting,
    connect,
    reconnect,
    disconnect,
    sendCommand,
    sendCommandTo,
    onOutput,
    onProcessOutput,
    onPlayers,
    onBots,
    onBotStats,
    onBotMode,
    onBotPopulation,
    onServerInfo,
    onLevelChanged,
    onPlaylistEvent,
    onServerMessage,
    onError,
    onHello,
    hasFeature,
  };
}
