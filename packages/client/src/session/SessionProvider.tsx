import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useServerConnection } from "../hooks/useServerConnection.ts";
import { useLauncher, type ProcessStatus } from "../hooks/useLauncher.ts";
import { useToast } from "../hooks/useToast.ts";
import { usePlaylist } from "../hooks/usePlaylist.ts";
import { useServerInfo } from "../hooks/useServerInfo.ts";
import { LineBuffer } from "../lib/lineBuffer.ts";
import type { AppMode } from "../components/ModeToggle.tsx";

const MODE_KEY = "pyrodeck-mode";

/** Console lines kept for the telnet console (replies and typed commands). */
const CONSOLE_LINES = 2000;
/** Lines kept of the game process's stdout and stderr. */
const PROCESS_LINES = 5000;

export interface Session {
  connection: ReturnType<typeof useServerConnection>;
  launcher: ReturnType<typeof useLauncher>;
  toast: ReturnType<typeof useToast>;
  playlist: ReturnType<typeof usePlaylist>;
  serverInfo: ReturnType<typeof useServerInfo>;
  /** Connect to a running server, or launch one from a profile. Persisted. */
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  /** The console is ready and the WebSocket is live. */
  isConnected: boolean;
  processState: ProcessStatus["state"] | undefined;
  /** Launch mode with a game process to show output for. */
  hasProcess: boolean;
  /** Telnet console text, oldest first; survives screen changes. */
  consoleBuffer: LineBuffer;
  /** Game process stdout (`out`) and stderr (`err`). */
  processBuffer: LineBuffer;
}

const SessionContext = createContext<Session | null>(null);

function readMode(): AppMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return stored === "launch" || stored === "connect" ? stored : "connect";
  } catch {
    return "connect";
  }
}

/**
 * One instance of every connection, launcher and playlist hook, shared by
 * whichever shell is on screen. Switching between the desktop and the phone
 * layout must not reopen the WebSocket or lose console text, so the state
 * lives here, above both.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const connection = useServerConnection();
  const launcher = useLauncher();
  const toast = useToast();
  const { onPlaylistEvent, onServerInfo, onLevelChanged, onOutput, onProcessOutput, sendCommand, connectionState, wsConnected } =
    connection;
  const { addToast } = toast;
  const playlist = usePlaylist({ onPlaylistEvent, notify: addToast });
  const serverInfo = useServerInfo({
    sendCommand,
    onServerInfo,
    onLevelChanged,
    connected: connectionState === "ready",
  });

  const buffersRef = useRef<{ console: LineBuffer; process: LineBuffer } | null>(null);
  if (!buffersRef.current) {
    buffersRef.current = { console: new LineBuffer(CONSOLE_LINES), process: new LineBuffer(PROCESS_LINES) };
  }
  const consoleBuffer = buffersRef.current.console;
  const processBuffer = buffersRef.current.process;

  // Profiles are needed by every shell (the desktop Launch panel used to be
  // the only thing that loaded them).
  const { fetchProfiles } = launcher;
  useEffect(() => {
    void fetchProfiles();
  }, [fetchProfiles]);

  useEffect(() => onOutput((data) => consoleBuffer.push(data, "out")), [onOutput, consoleBuffer]);
  useEffect(
    () => onProcessOutput((data, stream) => processBuffer.push(data, stream === "stderr" ? "err" : "out")),
    [onProcessOutput, processBuffer],
  );

  // Surface server and launcher errors as toasts
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

  const [mode, setModeState] = useState<AppMode>(readMode);
  const setMode = useCallback((next: AppMode) => {
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // storage unavailable: the mode still changes for this page
    }
  }, []);

  const isConnected = connectionState === "ready" && wsConnected;
  const processState = launcher.processStatus?.state;
  const hasProcess =
    mode === "launch" &&
    (processState === "starting" ||
      processState === "running" ||
      processState === "stopping" ||
      processState === "crashed");

  const value = useMemo<Session>(
    () => ({
      connection,
      launcher,
      toast,
      playlist,
      serverInfo,
      mode,
      setMode,
      isConnected,
      processState,
      hasProcess,
      consoleBuffer,
      processBuffer,
    }),
    [connection, launcher, toast, playlist, serverInfo, mode, setMode, isConnected, processState, hasProcess, consoleBuffer, processBuffer],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionProvider>");
  return session;
}
