import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useServerConnection } from "../hooks/useServerConnection.ts";
import { useLauncher, type ProcessStatus } from "../hooks/useLauncher.ts";
import { useToast } from "../hooks/useToast.ts";
import { usePlaylist } from "../hooks/usePlaylist.ts";
import { useServerInfo } from "../hooks/useServerInfo.ts";
import { useServers } from "../hooks/useServers.ts";
import { LineBuffer } from "../lib/lineBuffer.ts";
import { parseHash, SERVER_PARAM } from "../lib/hashRoute.ts";
import {
  CONNECT_SERVER_ID,
  LAUNCH_SERVER_ID,
  chooseServer,
  isActiveState,
  namedMessage,
  readStoredServer,
  writeStoredServer,
  type ServerList,
  type ServerRow,
  type ServerState,
} from "../lib/servers.ts";
import type { AppMode } from "../components/ModeToggle.tsx";

const MODE_KEY = "pyrodeck-mode";

export interface Session {
  connection: ReturnType<typeof useServerConnection>;
  launcher: ReturnType<typeof useLauncher>;
  toast: ReturnType<typeof useToast>;
  playlist: ReturnType<typeof usePlaylist>;
  serverInfo: ReturnType<typeof useServerInfo>;
  /** Connect to a running server, or launch one from a profile. Persisted. */
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  /** Every server Pyrodeck runs (GET /api/servers), refreshed while the panel is open. */
  servers: ServerRow[];
  serverList: ServerList | null;
  refreshServers: () => void;
  /** The server Launch mode shows (persisted; the phone's `?s=`); null before there is one. */
  selectedServerId: string | null;
  selectServer: (serverId: string) => void;
  /** The server every screen is about: the selected one, or Connect mode's session. */
  serverId: string | null;
  /** Its row in the server list (null until listed, or Connect mode before a login). */
  server: ServerRow | null;
  /** Its name, for the header and the toasts. */
  serverName: string | null;
  /** A server's name by id (null when unknown). */
  nameOf: (serverId: string) => string | null;
  /** The profile id its events carry: player history, kick, ban and rules use it. */
  eventProfileId: string | null;
  /** The console is ready and the WebSocket is live. */
  isConnected: boolean;
  processState: ProcessStatus["state"] | undefined;
  /** Launch mode with a game process to show output for. */
  hasProcess: boolean;
  /** The server's telnet console text, oldest first; survives screen changes and switches of server. */
  consoleBuffer: LineBuffer;
  /** The server's game process stdout (`out`) and stderr (`err`). */
  processBuffer: LineBuffer;
}

const SessionContext = createContext<Session | null>(null);

/** The mode this browser chose last, or null when it has never chosen. */
function readStoredMode(): AppMode | null {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return stored === "launch" || stored === "connect" ? stored : null;
  } catch {
    return null;
  }
}

/** The server a page load asks for: the phone's `#/...?s=<id>`, else the one this browser chose last. */
function initialServer(): string | null {
  const fromHash = typeof window === "undefined" ? null : parseHash(window.location.hash).params.get(SERVER_PARAM);
  return fromHash || readStoredServer();
}

/** Buffers for a moment with no server selected (nothing writes to them). */
const NO_SERVER_CONSOLE = new LineBuffer(1);
const NO_SERVER_PROCESS = new LineBuffer(1);

/**
 * One instance of every connection, launcher and playlist hook, shared by
 * whichever shell is on screen. Switching between the desktop and the phone
 * layout must not reopen the WebSocket or lose console text, so the state
 * lives here, above both.
 *
 * Pyrodeck runs several servers; the panel shows one at a time, the selected
 * server, and every screen is about it: its console and output, roster,
 * playlist, server info, launcher status. Each server's state and text are
 * kept apart (lib/serverViews.ts), so a switch shows that server's own.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const { addToast } = toast;
  const serversHook = useServers();
  const { list, servers, refresh: refreshList, refreshSoon, setRowState } = serversHook;

  const [mode, setModeState] = useState<AppMode>(() => readStoredMode() ?? "connect");
  // A browser that has never chosen a mode opens on Launch when Pyrodeck is running a server it launched:
  // those servers are what there is to see, and Connect would read "Not connected" beside them.
  const modeChosen = useRef(readStoredMode() !== null);
  useEffect(() => {
    if (modeChosen.current || !list) return;
    modeChosen.current = true;
    if (servers.some((s) => s.id !== CONNECT_SERVER_ID && isActiveState(s.state))) setModeState("launch");
  }, [list, servers]);
  const setMode = useCallback((next: AppMode) => {
    modeChosen.current = true;
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // storage unavailable: the mode still changes for this page
    }
  }, []);

  // Which server: the one asked for while it exists, else the default server.
  const [wanted, setWanted] = useState<string | null>(initialServer);
  const selectedServerId = list ? chooseServer({ wanted: [wanted], list }) : wanted;
  const selectServer = useCallback((id: string) => {
    setWanted(id);
    writeStoredServer(id);
  }, []);
  const serverId = mode === "connect" ? CONNECT_SERVER_ID : selectedServerId;
  const server = servers.find((s) => s.id === serverId) ?? null;

  const namesRef = useRef(new Map<string, string>());
  namesRef.current = new Map(servers.map((s) => [s.id, s.name]));
  const nameOf = useCallback(
    (id: string) => namesRef.current.get(id) ?? (id === CONNECT_SERVER_ID ? "Connect mode" : null),
    [],
  );
  const serverName = serverId ? nameOf(serverId) : null;

  const connection = useServerConnection(serverId);
  const { views, view, sendCommand, onServerMessage, onError, onHello, connectionState, wsConnected, helloDone } =
    connection;

  const launcher = useLauncher({
    serverId: mode === "launch" ? selectedServerId : null,
    selectedProfileId: server?.kind === "profile" && mode === "launch" ? server.id : "",
    onSelect: selectServer,
    onChanged: refreshSoon,
  });
  const { refreshStatus } = launcher;

  const playlist = usePlaylist({
    serverId,
    view,
    views,
    onServerMessage,
    nameOf,
    notify: addToast,
    onChanged: refreshSoon,
  });
  const serverInfo = useServerInfo({ serverId, view, views, sendCommand, canSend: wsConnected && helloDone });

  // Profiles are needed by every shell (the desktop Launch panel used to be
  // the only thing that loaded them). The server list follows them.
  const { fetchProfiles } = launcher;
  useEffect(() => {
    void fetchProfiles();
  }, [fetchProfiles]);
  useEffect(() => {
    refreshSoon();
  }, [launcher.profiles, refreshSoon]);

  // Any server's process or console changing state: the list shows it soon,
  // the selected server's launcher status at once.
  const serverIdRef = useRef(serverId);
  serverIdRef.current = serverId;
  useEffect(
    () =>
      onServerMessage((id, msg) => {
        if (msg.type === "process_state") {
          setRowState(id, ((msg.payload as { state?: ServerState }).state ?? null) as ServerState | null);
          refreshSoon();
          if (id === serverIdRef.current) refreshStatus();
        } else if (msg.type === "connection_state" || msg.type === "level_changed") {
          refreshSoon();
        }
      }),
    [onServerMessage, setRowState, refreshSoon, refreshStatus],
  );
  useEffect(() => onHello(() => void refreshList()), [onHello, refreshList]);

  // Errors as toasts, named by their server.
  useEffect(() => onError((id, message) => addToast(namedMessage(id ? nameOf(id) : null, message))), [onError, addToast, nameOf]);

  const prevErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (connection.error && connection.error !== prevErrorRef.current) {
      addToast(connection.error);
    }
    prevErrorRef.current = connection.error;
  }, [connection.error, addToast]);

  const prevLauncherErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (launcher.error && launcher.error !== prevLauncherErrorRef.current) {
      addToast(launcher.error);
    }
    prevLauncherErrorRef.current = launcher.error;
  }, [launcher.error, addToast]);

  const { actionError } = launcher;
  useEffect(() => {
    if (actionError) addToast(namedMessage(nameOf(actionError.serverId), actionError.message));
  }, [actionError, addToast, nameOf]);

  const isConnected = connectionState === "ready" && wsConnected;
  const processState = mode === "launch" ? (launcher.processStatus?.state ?? server?.state ?? undefined) : undefined;
  const hasProcess =
    mode === "launch" &&
    (processState === "starting" ||
      processState === "running" ||
      processState === "stopping" ||
      processState === "crashed");

  let eventProfileId: string | null = null;
  if (serverId === CONNECT_SERVER_ID) {
    // Connect mode's events carry "connect:<host>:<port>"; its row is named "<host>:<port>".
    eventProfileId = server ? `connect:${server.name}` : null;
  } else if (serverId) {
    eventProfileId = server?.kind === "launch" || serverId === LAUNCH_SERVER_ID ? LAUNCH_SERVER_ID : serverId;
  }

  const consoleBuffer = view?.console ?? NO_SERVER_CONSOLE;
  const processBuffer = view?.process ?? NO_SERVER_PROCESS;

  const value = useMemo<Session>(
    () => ({
      connection,
      launcher,
      toast,
      playlist,
      serverInfo,
      mode,
      setMode,
      servers,
      serverList: list,
      refreshServers: refreshSoon,
      selectedServerId,
      selectServer,
      serverId,
      server,
      serverName,
      nameOf,
      eventProfileId,
      isConnected,
      processState,
      hasProcess,
      consoleBuffer,
      processBuffer,
    }),
    [
      connection,
      launcher,
      toast,
      playlist,
      serverInfo,
      mode,
      setMode,
      servers,
      list,
      refreshSoon,
      selectedServerId,
      selectServer,
      serverId,
      server,
      serverName,
      nameOf,
      eventProfileId,
      isConnected,
      processState,
      hasProcess,
      consoleBuffer,
      processBuffer,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionProvider>");
  return session;
}
