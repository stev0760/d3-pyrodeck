import { useState, useEffect } from "react";
import type { useLauncher, ServerProfile } from "../hooks/useLauncher.ts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

type LauncherState = ReturnType<typeof useLauncher>;

interface LaunchPanelProps {
  launcher: LauncherState;
}

const STATUS_COLORS: Record<string, string> = {
  stopped: "bg-muted-foreground",
  starting: "bg-primary animate-pulse",
  running: "bg-emerald-500",
  stopping: "bg-primary",
  crashed: "bg-destructive",
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
    return <p className="text-muted-foreground text-sm">Loading...</p>;
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

    const gameResult = await validatePath("game", gamePath);
    if (!gameResult || !gameResult.valid) {
      setValidationErrors(gameResult?.errors ?? ["Validation failed"]);
      setValidating(false);
      return;
    }

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
      <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        Pyrodeck Settings
      </h3>

      {needsSetup ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Point Pyrodeck to your Descent 3 installation to get started.
          </p>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Game Data Path
            </label>
            <input
              type="text"
              value={gamePath}
              onChange={(e) => setGamePath(e.target.value)}
              placeholder="/path/to/descent3"
              className="w-full bg-input border border-border rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Executable
            </label>
            <input
              type="text"
              value={executablePath}
              onChange={(e) => setExecutablePath(e.target.value)}
              placeholder="Descent3 or /path/to/Descent3"
              className="w-full bg-input border border-border rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Filename (looked up in game path) or full path
            </p>
          </div>
          {validationErrors.length > 0 && (
            <div className="text-xs text-destructive space-y-0.5">
              {validationErrors.map((e, i) => (
                <p key={i}>{e}</p>
              ))}
            </div>
          )}
          <Button
            onClick={handleValidate}
            disabled={!gamePath || !executablePath || validating}
            className="w-full"
          >
            {validating ? "Validating..." : "Validate & Save"}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">
            D3 game directory and executable for this Pyrodeck instance.
          </p>
          <div className="bg-muted rounded-md px-2 py-1.5 text-xs">
            <span className="text-muted-foreground">Game: </span>
            <span className="text-foreground/80 break-all font-mono text-[11px]">
              {config?.gamePath}
            </span>
          </div>
          <div className="bg-muted rounded-md px-2 py-1.5 text-xs">
            <span className="text-muted-foreground">Exe: </span>
            <span className="text-foreground/80 break-all font-mono text-[11px]">
              {config?.executablePath}
            </span>
          </div>

          <Separator />

          {/* Process status */}
          <div className="flex items-center gap-2 py-0.5">
            <div
              className={`w-2 h-2 rounded-full ${STATUS_COLORS[state] ?? STATUS_COLORS.stopped}`}
            />
            <span className="text-xs text-foreground/70 capitalize">{state}</span>
            {processStatus?.pid && (
              <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
                PID {processStatus.pid}
              </Badge>
            )}
            {state === "crashed" && processStatus && processStatus.exitCode !== null && (
              <Badge variant="destructive" className="text-[10px] py-0 px-1.5">
                exit {processStatus.exitCode}
              </Badge>
            )}
          </div>

          {/* Profile selector */}
          {!isActive && (
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                D3 Server Profile
              </label>
              {profiles.length > 0 ? (
                <select
                  value={selectedProfile}
                  onChange={(e) => setSelectedProfile(e.target.value)}
                  className="w-full bg-input border border-border rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {profiles.map((p: ServerProfile) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No profiles yet. Create one to get started.
                </p>
              )}

              {showCreateForm ? (
                <div className="flex flex-col gap-1 mt-1">
                  <input
                    type="text"
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateProfile()}
                    placeholder="Profile name"
                    className="w-full bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    autoFocus
                  />
                  <div className="flex gap-1">
                    <Button size="xs" onClick={handleCreateProfile} disabled={!newProfileName.trim()} className="flex-1">
                      Create
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => { setShowCreateForm(false); setNewProfileName(""); }}
                      className="flex-1"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="link"
                  size="xs"
                  onClick={() => setShowCreateForm(true)}
                  className="mt-1 px-0 text-primary"
                >
                  + New Profile
                </Button>
              )}
            </div>
          )}

          {/* Launch / Stop button */}
          {isActive ? (
            <Button
              variant="destructive"
              onClick={handleStop}
              disabled={state === "stopping"}
              className="w-full"
            >
              {state === "stopping" ? "Stopping..." : "Stop Server"}
            </Button>
          ) : (
            <Button
              onClick={handleLaunch}
              disabled={!selectedProfile || launching}
              className="w-full"
            >
              {launching ? "Starting..." : "Launch Server"}
            </Button>
          )}

          {/* Reset path */}
          {!isActive && (
            <Button
              variant="ghost"
              size="xs"
              onClick={handleReset}
              className="w-full text-muted-foreground"
            >
              Change D3 path
            </Button>
          )}
        </div>
      )}

      {/* Error display */}
      {error && (
        <p className="text-xs text-destructive bg-destructive/10 rounded-md px-2 py-1.5">
          {error}
        </p>
      )}
    </div>
  );
}
