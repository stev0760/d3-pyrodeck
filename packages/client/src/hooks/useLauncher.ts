import { useState, useEffect, useCallback, useRef } from "react";
import { CONNECT_SERVER_ID } from "@/lib/servers";
import type { MissionHostStatus } from "@/lib/missionHost";
import type { SupervisorState } from "@/lib/supervisor";
import type { AutostartRun } from "@/lib/autostart";
import type { ProfileSchedule } from "@/lib/ops";

export interface PyrodeckConfig {
  gamePath: string | null;
  executablePath: string | null;
  /** Directory for server logs. Null = auto (next to the executable). */
  logDir: string | null;
  defaultTelnetPort: number;
  preferredMode: "connect" | "launch";
  /** Host players join at (Launch panel join address); null = unknown. */
  joinHost?: string | null;
  needsSetup: boolean;
}

export interface ProcessStatus {
  state: "stopped" | "starting" | "running" | "stopping" | "crashed";
  pid: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  /** Profile whose launch produced the current/last process, if any. */
  activeProfileId: string | null;
  /** Whether the launch's output reaches its log file (server-side checks). */
  log?: {
    path: string | null;
    state: "none" | "pending" | "ok" | "failed";
    message: string | null;
  };
  /** Mission download listener (GET /api/launcher/status only). */
  missionHost?: MissionHostStatus;
  /** Why the last process stopped ("console" = quit typed at its console); null while running or after a crash. */
  stopReason?: "manual" | "playlist" | "schedule" | "empty-restart" | "hang" | "console" | null;
  /** Re-attached after Pyrodeck restarted: running, but its output is not captured. */
  adopted?: boolean;
  /** Crash relaunch, hang check, restart when empty (GET /api/launcher/status only). */
  supervisor?: SupervisorState;
  /** What autostart did when Pyrodeck started (GET /api/launcher/status only). */
  autostart?: AutostartRun;
}

/** DMFC options sent over the console after each launch (unset = server default). */
export interface PostStartSettings {
  hudNames?: "full" | "team" | "none";
  killMsgFilter?: "full" | "simple" | "none";
  autoSaveLevel?: boolean;
  autoSaveDisconnect?: boolean;
}

/** Engine flags added after -dedicated at each launch (server: launcher/launchOptions.ts). */
export interface LaunchOptions {
  bindIp?: string;
  gamePort?: number;
  frameCap?: number;
  noMultiBmp?: boolean;
  gameSpyPort?: number;
  gameSpyFile?: string;
  /** -tempdir: an absolute path of at most 99 bytes; unset, Pyrodeck gives each server its own. */
  tempDir?: string;
}

export type TeamKey = "red" | "blue" | "green" | "yellow";

/** DMFC team options and the Hoard orb count, applied at launch (server: launcher/teamSettings.ts). */
export interface TeamSettings {
  allowTeamChange?: boolean;
  autoBalance?: boolean;
  teamNames?: Partial<Record<TeamKey, string>>;
  hoardMinOrbs?: number;
}

/** Console lines at start and every N minutes (server: launcher/periodicCommands.ts). */
export interface PeriodicCommandSettings {
  enabled: boolean;
  startLines: string[];
  lines: string[];
  intervalMinutes: number;
  mode: "all" | "sequential" | "random";
}

/** Powerup respawn time scaled by human players (server: launcher/respawnScaling.ts). */
export interface RespawnScaling {
  enabled: boolean;
  minSeconds: number;
  maxSeconds: number;
  playersForMin: number;
}

export interface ServerProfile {
  id: string;
  name: string;
  description?: string;
  configFile: string;
  /** Per-profile game data directory override (inherits global if omitted). */
  gamePath?: string;
  /** Per-profile D3 executable override (inherits global if omitted). */
  executablePath?: string;
  /** Applied over the console after every launch and playlist restart. */
  postStart?: PostStartSettings;
  launchOptions?: LaunchOptions;
  teamSettings?: TeamSettings;
  periodicCommands?: PeriodicCommandSettings;
  respawnScaling?: RespawnScaling;
  /** Weekly start/stop windows. */
  schedule?: ProfileSchedule;
  /** Launch flags from an imported script that the profile does not apply. */
  importedArgs?: string[];
  /** The Startup Commands file in the game directory (-autoexec); unset: autoexec.dmfc. */
  startupFile?: string;
  createdAt: string;
  lastLaunchedAt?: string;
}

/** Profile settings as the edit form sends them: numbers may be strings, the server validates. */
export interface ProfileSettingsPayload {
  postStart?: PostStartSettings | null;
  launchOptions?: Record<string, string | number | boolean> | null;
  teamSettings?: Record<string, unknown> | null;
  periodicCommands?: Record<string, unknown> | null;
  respawnScaling?: Record<string, unknown> | null;
  schedule?: ProfileSchedule | null;
  importedArgs?: string[] | null;
  /** "Start when Pyrodeck starts": true adds this profile to the ones that start with Pyrodeck, false removes it. */
  autostart?: boolean;
  /** The Startup Commands file (a .dmfc name); null or "" goes back to autoexec.dmfc. */
  startupFile?: string | null;
}

/** A saved profile with the save's non-blocking warnings (shared ports and the like). */
export type SavedProfile = ServerProfile & { warnings?: string[] };

export interface DetectResult {
  hogFiles: string[];
  missionFiles: string[];
}

export interface GamePathValidation {
  valid: boolean;
  errors: string[];
  hogFiles: string[];
  missionFiles: string[];
}

/** The Startup Commands file a profile without one of its own uses. */
export const DEFAULT_STARTUP_FILE = "autoexec.dmfc";

interface UseLauncherOptions {
  /** The selected server: its status is polled, and Start and Stop act on it by default. */
  serverId: string | null;
  /** The selected server's profile ("" for the server without one, or Connect mode). */
  selectedProfileId: string;
  /** Select a server (a profile's server has the profile's id). */
  onSelect: (serverId: string) => void;
  /** A server was started or stopped: the server list shows it. */
  onChanged?: () => void;
}

/** A start or stop that was refused, and the server it was for. */
export interface ServerActionError {
  serverId: string;
  message: string;
}

/**
 * Pyrodeck's settings, the profiles, and the selected server's launcher
 * status (GET /api/servers/:serverId/status). Start and Stop name their
 * server (POST /api/servers/:serverId/start, /stop): several servers run at
 * once, and a launch that would clash with another is refused with a message
 * naming it.
 */
export function useLauncher({ serverId, selectedProfileId, onSelect, onChanged }: UseLauncherOptions) {
  const [config, setConfig] = useState<PyrodeckConfig | null>(null);
  /** The last status fetched, and the server it is of: another server's is never shown. */
  const [status, setStatus] = useState<{ serverId: string; status: ProcessStatus } | null>(null);
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [detectResult, setDetectResult] = useState<DetectResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ServerActionError | null>(null);
  /** Servers with a start or stop request in flight. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const processStatus = status && status.serverId === serverId ? status.status : null;

  // Fetch pyrodeck config on mount
  useEffect(() => {
    fetch("/api/pyrodeck/config", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        setConfig(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  const serverIdRef = useRef(serverId);
  serverIdRef.current = serverId;

  const refreshStatus = useCallback(() => {
    const id = serverIdRef.current;
    if (!id || id === CONNECT_SERVER_ID) return;
    fetch(`/api/servers/${encodeURIComponent(id)}/status`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && serverIdRef.current === id) setStatus({ serverId: id, status: data as ProcessStatus });
      })
      .catch(() => {});
  }, []);

  // The selected server's status at once, then every 2 s while it is up and
  // every 5 s while it is down (the supervisor can relaunch it, or a
  // scheduler start it).
  useEffect(() => {
    refreshStatus();
  }, [serverId, refreshStatus]);
  const pollMs =
    processStatus && (processStatus.state === "stopped" || processStatus.state === "crashed") ? 5000 : 2000;
  useEffect(() => {
    if (!serverId || serverId === CONNECT_SERVER_ID) return;
    const interval = setInterval(refreshStatus, pollMs);
    return () => clearInterval(interval);
  }, [serverId, pollMs, refreshStatus]);

  const updateConfig = useCallback(
    async (updates: Partial<PyrodeckConfig>): Promise<boolean> => {
      setError(null);
      try {
        const res = await fetch("/api/pyrodeck/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(updates),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Failed to save config");
          return false;
        }
        setConfig(data);
        return true;
      } catch {
        setError("Failed to save config");
        return false;
      }
    },
    [],
  );

  const validatePath = useCallback(
    async (
      type: "game" | "executable",
      pathValue: string,
      gamePath?: string,
    ): Promise<GamePathValidation | null> => {
      setError(null);
      try {
        const res = await fetch("/api/pyrodeck/validate-path", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ type, path: pathValue, gamePath }),
        });
        return await res.json();
      } catch {
        setError("Validation failed");
        return null;
      }
    },
    [],
  );

  const detect = useCallback(async () => {
    try {
      const res = await fetch("/api/launcher/detect", {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setDetectResult(data);
        return data as DetectResult;
      }
    } catch {
      // ignore
    }
    return null;
  }, []);

  const fetchProfiles = useCallback(async () => {
    try {
      const res = await fetch("/api/profiles", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setProfiles(data.profiles);
        return data.profiles as ServerProfile[];
      }
    } catch {
      // ignore
    }
    return [];
  }, []);

  const createProfile = useCallback(
    async (name: string, opts?: Record<string, unknown>): Promise<ServerProfile | null> => {
      setError(null);
      try {
        const res = await fetch("/api/profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ name, ...opts }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Failed to create profile");
          return null;
        }
        await fetchProfiles();
        return data as ServerProfile;
      } catch {
        setError("Failed to create profile");
        return null;
      }
    },
    [fetchProfiles],
  );

  const updateProfile = useCallback(
    async (
      id: string,
      updates: {
        name?: string;
        gamePath?: string | null;
        executablePath?: string | null;
        description?: string | null;
      } & ProfileSettingsPayload,
    ): Promise<SavedProfile | null> => {
      setError(null);
      try {
        const res = await fetch(`/api/profiles/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(updates),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Failed to update profile");
          return null;
        }
        await fetchProfiles();
        return data as SavedProfile;
      } catch {
        setError("Failed to update profile");
        return null;
      }
    },
    [fetchProfiles],
  );

  const deleteProfile = useCallback(
    async (id: string): Promise<boolean> => {
      setError(null);
      try {
        const res = await fetch(`/api/profiles/${id}`, {
          method: "DELETE",
          credentials: "include",
        });
        if (!res.ok) {
          const data = await res.json();
          setError(data.error || "Failed to delete profile");
          return false;
        }
        await fetchProfiles();
        return true;
      } catch {
        setError("Failed to delete profile");
        return false;
      }
    },
    [fetchProfiles],
  );

  const duplicateProfile = useCallback(
    async (id: string, name?: string): Promise<ServerProfile | null> => {
      setError(null);
      try {
        const res = await fetch(`/api/profiles/${id}/duplicate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Failed to duplicate profile");
          return null;
        }
        await fetchProfiles();
        return data as ServerProfile;
      } catch {
        setError("Failed to duplicate profile");
        return null;
      }
    },
    [fetchProfiles],
  );

  const markBusy = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Start a server (default: the selected one) beside any others it shares nothing with. */
  const launch = useCallback(
    async (id: string | null = serverIdRef.current): Promise<boolean> => {
      if (!id || id === CONNECT_SERVER_ID) return false;
      setActionError(null);
      markBusy(id, true);
      try {
        const res = await fetch(`/api/servers/${encodeURIComponent(id)}/start`, {
          method: "POST",
          credentials: "include",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setActionError({ serverId: id, message: data.error || "Failed to launch" });
          return false;
        }
        if (serverIdRef.current === id && data.status) setStatus({ serverId: id, status: data.status });
        return true;
      } catch {
        setActionError({ serverId: id, message: "Failed to launch server" });
        return false;
      } finally {
        markBusy(id, false);
        onChanged?.();
      }
    },
    [onChanged],
  );

  /** Stop a server (default: the selected one). */
  const stop = useCallback(
    async (id: string | null = serverIdRef.current): Promise<boolean> => {
      if (!id || id === CONNECT_SERVER_ID) return false;
      setActionError(null);
      markBusy(id, true);
      try {
        const res = await fetch(`/api/servers/${encodeURIComponent(id)}/stop`, {
          method: "POST",
          credentials: "include",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setActionError({ serverId: id, message: data.error || "Failed to stop" });
          return false;
        }
        if (serverIdRef.current === id && data.status) setStatus({ serverId: id, status: data.status });
        return true;
      } catch {
        setActionError({ serverId: id, message: "Failed to stop server" });
        return false;
      } finally {
        markBusy(id, false);
        onChanged?.();
      }
    },
    [onChanged],
  );

  const setSelectedProfileId = onSelect;

  return {
    config,
    processStatus,
    profiles,
    selectedProfileId,
    setSelectedProfileId,
    detectResult,
    loading,
    error,
    updateConfig,
    validatePath,
    detect,
    fetchProfiles,
    createProfile,
    updateProfile,
    deleteProfile,
    duplicateProfile,
    launch,
    stop,
    busy,
    actionError,
    clearActionError: () => setActionError(null),
    refreshStatus,
  };
}
