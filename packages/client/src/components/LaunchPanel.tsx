import { useState, useEffect } from "react";
import type { useLauncher } from "../hooks/useLauncher.ts";

type LauncherState = ReturnType<typeof useLauncher>;

interface LaunchPanelProps {
  launcher: LauncherState;
}

const STATUS_COLORS: Record<string, string> = {
  stopped: "bg-zinc-600",
  starting: "bg-amber-500 animate-pulse",
  running: "bg-emerald-500",
  stopping: "bg-amber-500",
  crashed: "bg-red-500",
};

export function LaunchPanel({ launcher }: LaunchPanelProps) {
  const {
    config,
    processStatus,
    error,
    loading,
    updateConfig,
    validatePath,
    detect,
    launch,
    stop,
  } = launcher;

  // Setup form state
  const [d3Path, setD3Path] = useState("");
  const [d3Exe, setD3Exe] = useState("Descent3");
  const [validating, setValidating] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  // Launch form state
  const [configFile, setConfigFile] = useState("");
  const [configFiles, setConfigFiles] = useState<string[]>([]);
  const [launching, setLaunching] = useState(false);

  // Sync from saved config
  useEffect(() => {
    if (config) {
      if (config.d3InstallPath) setD3Path(config.d3InstallPath);
      if (config.d3Executable) setD3Exe(config.d3Executable);
      if (config.defaultConfigFile) setConfigFile(config.defaultConfigFile);
    }
  }, [config]);

  // Detect config files when path is configured
  useEffect(() => {
    if (config?.d3InstallPath) {
      detect().then((result) => {
        if (result) {
          setConfigFiles(result.configFiles);
          if (!configFile && result.configFiles.length > 0) {
            const defaultCfg = result.configFiles.find((f) =>
              f.toLowerCase().includes("dedicated"),
            );
            setConfigFile(defaultCfg ?? result.configFiles[0]);
          }
        }
      });
    }
  }, [config?.d3InstallPath, detect, configFile]);

  if (loading) {
    return <p className="text-zinc-600 text-sm">Loading...</p>;
  }

  const needsSetup = !config?.d3InstallPath;
  const state = processStatus?.state ?? "stopped";
  const isActive =
    state === "running" ||
    state === "starting" ||
    state === "stopping";

  const handleValidate = async () => {
    setValidating(true);
    setValidationErrors([]);
    const result = await validatePath(d3Path, d3Exe);
    if (result && result.valid) {
      await updateConfig({
        d3InstallPath: d3Path,
        d3Executable: d3Exe,
      });
      setValidationErrors([]);
    } else if (result) {
      setValidationErrors(result.errors);
    }
    setValidating(false);
  };

  const handleLaunch = async () => {
    setLaunching(true);
    await launch(configFile || undefined);
    setLaunching(false);
  };

  const handleStop = async () => {
    await stop();
  };

  const handleReset = async () => {
    await updateConfig({
      d3InstallPath: null,
      d3Executable: null,
    });
    setConfigFiles([]);
  };

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
        Launch Mode
      </h3>

      {/* Setup or configured view */}
      {needsSetup ? (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500">
            Set your Descent 3 installation path to get started.
          </p>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">
              D3 Install Path
            </label>
            <input
              type="text"
              value={d3Path}
              onChange={(e) => setD3Path(e.target.value)}
              placeholder="/path/to/descent3"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-amber-600"
            />
          </div>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">
              Executable Name
            </label>
            <input
              type="text"
              value={d3Exe}
              onChange={(e) => setD3Exe(e.target.value)}
              placeholder="Descent3"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-amber-600"
            />
          </div>
          {validationErrors.length > 0 && (
            <div className="text-xs text-red-400 space-y-0.5">
              {validationErrors.map((e, i) => (
                <p key={i}>{e}</p>
              ))}
            </div>
          )}
          <button
            onClick={handleValidate}
            disabled={!d3Path || !d3Exe || validating}
            className="w-full bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-zinc-950 font-medium text-sm py-1.5 rounded transition-colors"
          >
            {validating ? "Validating..." : "Validate & Save"}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Configured path display */}
          <div className="bg-zinc-800/50 rounded px-2 py-1.5 text-xs">
            <span className="text-zinc-500">Path: </span>
            <span className="text-zinc-300 break-all">
              {config?.d3InstallPath}
            </span>
          </div>
          <div className="bg-zinc-800/50 rounded px-2 py-1.5 text-xs">
            <span className="text-zinc-500">Exe: </span>
            <span className="text-zinc-300">{config?.d3Executable}</span>
          </div>

          {/* Process status */}
          <div className="flex items-center gap-2 py-1">
            <div
              className={`w-2 h-2 rounded-full ${STATUS_COLORS[state] ?? STATUS_COLORS.stopped}`}
            />
            <span className="text-xs text-zinc-400 capitalize">{state}</span>
            {processStatus?.pid && (
              <span className="text-xs text-zinc-600">
                PID {processStatus.pid}
              </span>
            )}
            {state === "crashed" && processStatus && processStatus.exitCode !== null && (
              <span className="text-xs text-red-400">
                exit {processStatus.exitCode}
              </span>
            )}
          </div>

          {/* Config file selector */}
          {!isActive && (
            <div>
              <label className="text-xs text-zinc-500 block mb-1">
                Config File
              </label>
              <select
                value={configFile}
                onChange={(e) => setConfigFile(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-amber-600"
              >
                {configFiles.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Launch / Stop button */}
          {isActive ? (
            <button
              onClick={handleStop}
              disabled={state === "stopping"}
              className="w-full bg-red-700 hover:bg-red-600 disabled:bg-zinc-700 disabled:text-zinc-500 text-zinc-100 font-medium text-sm py-1.5 rounded transition-colors"
            >
              {state === "stopping" ? "Stopping..." : "Stop Server"}
            </button>
          ) : (
            <button
              onClick={handleLaunch}
              disabled={!configFile || launching}
              className="w-full bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-zinc-950 font-medium text-sm py-1.5 rounded transition-colors"
            >
              {launching ? "Starting..." : "Launch Server"}
            </button>
          )}

          {/* Reset path */}
          {!isActive && (
            <button
              onClick={handleReset}
              className="w-full text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              Change D3 path
            </button>
          )}
        </div>
      )}

      {/* Error display */}
      {error && (
        <p className="text-xs text-red-400 bg-red-950/30 rounded px-2 py-1.5">
          {error}
        </p>
      )}
    </div>
  );
}
