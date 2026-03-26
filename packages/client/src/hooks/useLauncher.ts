import { useState, useEffect, useCallback } from "react";

export interface PyrodeckConfig {
  d3InstallPath: string | null;
  d3Executable: string | null;
  defaultConfigFile: string;
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
}

export interface DetectResult {
  configFiles: string[];
  hogFiles: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  configFiles: string[];
  hogFiles: string[];
}

export function useLauncher() {
  const [config, setConfig] = useState<PyrodeckConfig | null>(null);
  const [processStatus, setProcessStatus] = useState<ProcessStatus | null>(
    null,
  );
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
      path: string,
      executable?: string,
    ): Promise<ValidationResult | null> => {
      setError(null);
      try {
        const res = await fetch("/api/pyrodeck/validate-path", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ path, executable }),
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

  const launch = useCallback(
    async (configFile?: string): Promise<boolean> => {
      setError(null);
      try {
        const res = await fetch("/api/launcher/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ configFile }),
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
    detectResult,
    loading,
    error,
    updateConfig,
    validatePath,
    detect,
    launch,
    stop,
  };
}
