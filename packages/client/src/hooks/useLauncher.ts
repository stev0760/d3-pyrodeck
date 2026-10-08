import { useState, useEffect, useCallback } from "react";
import type { MissionHostStatus } from "@/lib/missionHost";
import type { ProfileSchedule } from "@/lib/ops";

export interface PyrodeckConfig {
  gamePath: string | null;
  executablePath: string | null;
  /** Directory for server logs. Null = auto (next to the executable). */
  logDir: string | null;
  defaultTelnetPort: number;
  preferredMode: "connect" | "launch";
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
}

/** DMFC options sent over the console after each launch (unset = server default). */
export interface PostStartSettings {
  hudNames?: "full" | "team" | "none";
  killMsgFilter?: "full" | "simple" | "none";
  autoSaveLevel?: boolean;
  autoSaveDisconnect?: boolean;
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
  /** Weekly start/stop windows. */
  schedule?: ProfileSchedule;
  /** Launch flags from an imported script that the profile does not apply. */
  importedArgs?: string[];
  createdAt: string;
  lastLaunchedAt?: string;
}

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

export function useLauncher() {
  const [config, setConfig] = useState<PyrodeckConfig | null>(null);
  const [processStatus, setProcessStatus] = useState<ProcessStatus | null>(
    null,
  );
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [detectResult, setDetectResult] = useState<DetectResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // Auto-select the first profile when the list is first populated.
  // Keep the selection if the previously-selected profile is still present.
  useEffect(() => {
    if (profiles.length === 0) return;
    if (selectedProfileId && profiles.some((p) => p.id === selectedProfileId)) return;
    setSelectedProfileId(profiles[0].id);
  }, [profiles, selectedProfileId]);

  // Poll process status when running/starting
  useEffect(() => {
    if (
      !processStatus ||
      processStatus.state === "stopped" ||
      processStatus.state === "crashed"
    ) {
      return;
    }

    const interval = setInterval(() => {
      fetch("/api/launcher/status", { credentials: "include" })
        .then((res) => res.json())
        .then((data) => setProcessStatus(data))
        .catch(() => {});
    }, 2000);

    return () => clearInterval(interval);
  }, [processStatus]);

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
        postStart?: PostStartSettings | null;
        schedule?: ProfileSchedule | null;
        importedArgs?: string[] | null;
      },
    ): Promise<ServerProfile | null> => {
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
        return data as ServerProfile;
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

  const launch = useCallback(
    async (profileId?: string): Promise<boolean> => {
      setError(null);
      try {
        const res = await fetch("/api/launcher/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ profileId }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Failed to launch");
          return false;
        }
        setProcessStatus(data.status);
        return true;
      } catch {
        setError("Failed to launch server");
        return false;
      }
    },
    [],
  );

  const stop = useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch("/api/launcher/stop", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to stop");
        return false;
      }
      setProcessStatus(data.status);
      return true;
    } catch {
      setError("Failed to stop server");
      return false;
    }
  }, []);

  // Fetch initial process status
  useEffect(() => {
    fetch("/api/launcher/status", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => setProcessStatus(data))
      .catch(() => {});
  }, []);

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
  };
}
