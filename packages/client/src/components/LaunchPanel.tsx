import { useState, useEffect } from "react";
import type { useLauncher, ServerProfile } from "../hooks/useLauncher.ts";

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
    profiles,
    error,
    loading,
    updateConfig,
    validatePath,
    fetchProfiles,
    createProfile,
    launch,
    stop,
  } = launcher;

  // Setup form state
  const [gamePath, setGamePath] = useState("");
  const [executablePath, setExecutablePath] = useState("Descent3");
  const [validating, setValidating] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  // Profile state
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [newProfileName, setNewProfileName] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [launching, setLaunching] = useState(false);

  // Sync from saved config
  useEffect(() => {
    if (config) {
      if (config.gamePath) setGamePath(config.gamePath);
      if (config.executablePath) setExecutablePath(config.executablePath);
    }
  }, [config]);

  // Fetch profiles when path is configured
  useEffect(() => {
    if (config?.gamePath) {
      fetchProfiles().then((result) => {
        if (result.length > 0 && !selectedProfile) {
          setSelectedProfile(result[0].id);
        }
      });
    }
  }, [config?.gamePath, fetchProfiles, selectedProfile]);

  if (loading) {
    return <p className="text-zinc-600 text-sm">Loading...</p>;
  }

  const needsSetup = !config?.gamePath;
  const state = processStatus?.state ?? "stopped";
  const isActive =
    state === "running" ||
    state === "starting" ||
    state === "stopping";

  const handleValidate = async () => {
    setValidating(true);
    setValidationErrors([]);

    // Validate game path
    const gameResult = await validatePath("game", gamePath);
    if (!gameResult || !gameResult.valid) {
      setValidationErrors(gameResult?.errors ?? ["Validation failed"]);
      setValidating(false);
      return;
    }

    // Validate executable
    const exeResult = await validatePath("executable", executablePath, gamePath);
    if (!exeResult || !exeResult.valid) {
      setValidationErrors(exeResult?.errors ?? ["Executable validation failed"]);
      setValidating(false);
      return;
    }

    await updateConfig({
      gamePath,
      executablePath,
    });
    setValidationErrors([]);
    setValidating(false);
  };

  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) return;
    const profile = await createProfile(newProfileName.trim());
    if (profile) {
      setSelectedProfile(profile.id);
      setNewProfileName("");
      setShowCreateForm(false);
    }
  };

  const handleLaunch = async () => {
    setLaunching(true);
    await launch(selectedProfile || undefined);
    setLaunching(false);
  };

  const handleStop = async () => {
    await stop();
  };

  const handleReset = async () => {
    await updateConfig({
      gamePath: null,
      executablePath: null,
    });
  };

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
        Pyrodeck Settings
      </h3>

      {/* Setup or configured view */}
      {needsSetup ? (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500">
            Point Pyrodeck to your Descent 3 installation to get started.
          </p>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">
              Game Data Path
            </label>
            <input
              type="text"
              value={gamePath}
              onChange={(e) => setGamePath(e.target.value)}
              placeholder="/path/to/descent3"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-amber-600"
            />
          </div>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">
              Executable
            </label>
            <input
              type="text"
              value={executablePath}
              onChange={(e) => setExecutablePath(e.target.value)}
              placeholder="Descent3 or /path/to/Descent3"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-amber-600"
            />
            <p className="text-xs text-zinc-600 mt-0.5">
              Filename (looked up in game path) or full path
            </p>
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
            disabled={!gamePath || !executablePath || validating}
            className="w-full bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-zinc-950 font-medium text-sm py-1.5 rounded transition-colors"
          >
            {validating ? "Validating..." : "Validate & Save"}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Configured path display */}
          <p className="text-xs text-zinc-600">
            D3 game directory and executable for this Pyrodeck instance.
          </p>
          <div className="bg-zinc-800/50 rounded px-2 py-1.5 text-xs">
            <span className="text-zinc-500">Game: </span>
            <span className="text-zinc-300 break-all">
              {config?.gamePath}
            </span>
          </div>
          <div className="bg-zinc-800/50 rounded px-2 py-1.5 text-xs">
            <span className="text-zinc-500">Exe: </span>
            <span className="text-zinc-300 break-all">{config?.executablePath}</span>
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

          {/* Profile selector */}
          {!isActive && (
            <div>
              <label className="text-xs text-zinc-500 block mb-1">
                D3 Server Profile
              </label>
              {profiles.length > 0 ? (
                <select
                  value={selectedProfile}
                  onChange={(e) => setSelectedProfile(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-amber-600"
                >
                  {profiles.map((p: ServerProfile) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-zinc-500 italic">
                  No profiles yet. Create one to get started.
                </p>
              )}

              {/* Create profile inline */}
              {showCreateForm ? (
                <div className="flex gap-1 mt-1">
                  <input
                    type="text"
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateProfile()}
                    placeholder="Profile name"
                    className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-amber-600"
                    autoFocus
                  />
                  <button
                    onClick={handleCreateProfile}
                    disabled={!newProfileName.trim()}
                    className="bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-zinc-950 font-medium text-xs px-2 py-1 rounded transition-colors"
                  >
                    Create
                  </button>
                  <button
                    onClick={() => { setShowCreateForm(false); setNewProfileName(""); }}
                    className="text-xs text-zinc-500 hover:text-zinc-300 px-1"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowCreateForm(true)}
                  className="text-xs text-amber-500 hover:text-amber-400 mt-1 transition-colors"
                >
                  + New Profile
                </button>
              )}
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
              disabled={!selectedProfile || launching}
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
