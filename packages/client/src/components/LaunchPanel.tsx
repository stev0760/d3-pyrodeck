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

type PanelMode = "listing" | "creating" | "editing" | "confirming-delete";

interface PathFormState {
  name: string;
  gamePath: string;
  executablePath: string;
}

function PathFormFields({
  values,
  onChange,
}: {
  values: PathFormState;
  onChange: (f: Partial<PathFormState>) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div>
        <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-0.5">
          Profile Name
        </label>
        <input
          type="text"
          value={values.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="e.g. Matcen Anarchy"
          className="w-full bg-input border border-border rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          autoFocus
        />
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-0.5">
          Game Path
        </label>
        <input
          type="text"
          value={values.gamePath}
          onChange={(e) => onChange({ gamePath: e.target.value })}
          placeholder="C:\Games\Descent3"
          className="w-full bg-input border border-border rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
        />
        <p className="text-[10px] text-muted-foreground mt-0.5">
          Directory containing d3.hog and the game data
        </p>
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-0.5">
          Executable
        </label>
        <input
          type="text"
          value={values.executablePath}
          onChange={(e) => onChange({ executablePath: e.target.value })}
          placeholder="Descent3.exe or full path"
          className="w-full bg-input border border-border rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
        />
        <p className="text-[10px] text-muted-foreground mt-0.5">
          Filename (resolved in Game Path) or full absolute path
        </p>
      </div>
    </div>
  );
}

export function LaunchPanel({ launcher }: LaunchPanelProps) {
  const {
    config,
    processStatus,
    profiles,
    selectedProfileId,
    setSelectedProfileId,
    error,
    loading,
    validatePath,
    fetchProfiles,
    createProfile,
    updateProfile,
    deleteProfile,
    launch,
    stop,
  } = launcher;

  const [mode, setMode] = useState<PanelMode>("listing");
  const [form, setForm] = useState<PathFormState>({ name: "", gamePath: "", executablePath: "" });
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);

  // Fetch profiles on mount (auto-select is handled inside useLauncher)
  useEffect(() => {
    fetchProfiles();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <p className="text-muted-foreground text-sm">Loading...</p>;
  }

  const state = processStatus?.state ?? "stopped";
  const isActive = state === "running" || state === "starting" || state === "stopping";

  const selectedProfile: ServerProfile | undefined = profiles.find(
    (p: ServerProfile) => p.id === selectedProfileId,
  );

  // Effective paths: profile-specific fields, fall back to global config for old profiles
  const effectiveGamePath = selectedProfile?.gamePath ?? config?.gamePath ?? null;
  const effectiveExePath = selectedProfile?.executablePath ?? config?.executablePath ?? null;
  const profileHasPaths = !!(effectiveGamePath && effectiveExePath);

  const startEditing = () => {
    if (!selectedProfile) return;
    setForm({
      name: selectedProfile.name,
      gamePath: selectedProfile.gamePath ?? config?.gamePath ?? "",
      executablePath: selectedProfile.executablePath ?? config?.executablePath ?? "",
    });
    setValidationErrors([]);
    setMode("editing");
  };

  const startCreating = () => {
    setForm({ name: "", gamePath: "", executablePath: "" });
    setValidationErrors([]);
    setMode("creating");
  };

  const cancel = () => {
    setMode("listing");
    setValidationErrors([]);
  };

  const validateForm = async (): Promise<boolean> => {
    setValidationErrors([]);
    setValidating(true);
    const errors: string[] = [];

    if (!form.name.trim()) errors.push("Profile name is required.");
    if (!form.gamePath.trim()) errors.push("Game path is required.");
    if (!form.executablePath.trim()) errors.push("Executable is required.");

    if (errors.length === 0) {
      const gameResult = await validatePath("game", form.gamePath.trim());
      if (!gameResult?.valid) {
        errors.push(...(gameResult?.errors ?? ["Game path validation failed"]));
      } else {
        const exeResult = await validatePath("executable", form.executablePath.trim(), form.gamePath.trim());
        if (!exeResult?.valid) {
          errors.push(...(exeResult?.errors ?? ["Executable validation failed"]));
        }
      }
    }

    setValidationErrors(errors);
    setValidating(false);
    return errors.length === 0;
  };

  const handleCreate = async () => {
    if (!(await validateForm())) return;
    setSaving(true);
    const profile = await createProfile(form.name.trim(), {
      gamePath: form.gamePath.trim(),
      executablePath: form.executablePath.trim(),
    });
    setSaving(false);
    if (profile) {
      setSelectedProfileId(profile.id);
      setMode("listing");
    }
  };

  const handleSave = async () => {
    if (!selectedProfile) return;
    if (!(await validateForm())) return;
    setSaving(true);
    const updated = await updateProfile(selectedProfile.id, {
      name: form.name.trim(),
      gamePath: form.gamePath.trim() || null,
      executablePath: form.executablePath.trim() || null,
    });
    setSaving(false);
    if (updated) setMode("listing");
  };

  const handleLaunch = async () => {
    setLaunching(true);
    await launch(selectedProfileId || undefined);
    setLaunching(false);
  };

  const handleDelete = async () => {
    if (!selectedProfile) return;
    const ok = await deleteProfile(selectedProfile.id);
    if (ok) setMode("listing");
  };

  // ── Delete confirmation ────────────────────────────────────────────────────
  if (mode === "confirming-delete") {
    return (
      <div className="space-y-3">
        <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          Delete Profile
        </h3>
        <p className="text-sm text-foreground/80">
          Delete <span className="font-medium">{selectedProfile?.name}</span>? The config files on disk are not removed.
        </p>
        <div className="flex gap-1.5">
          <Button variant="destructive" onClick={handleDelete} className="flex-1">
            Delete
          </Button>
          <Button variant="ghost" onClick={cancel} className="flex-1">
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // ── Create / Edit form ─────────────────────────────────────────────────────
  if (mode === "creating" || mode === "editing") {
    const isCreate = mode === "creating";
    return (
      <div className="space-y-3">
        <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          {isCreate ? "New Profile" : `Edit: ${selectedProfile?.name}`}
        </h3>

        <PathFormFields
          values={form}
          onChange={(f) => setForm((prev) => ({ ...prev, ...f }))}
        />

        {validationErrors.length > 0 && (
          <div className="text-xs text-destructive space-y-0.5">
            {validationErrors.map((e, i) => <p key={i}>{e}</p>)}
          </div>
        )}

        <div className="flex gap-1.5">
          <Button
            onClick={isCreate ? handleCreate : handleSave}
            disabled={validating || saving || !form.name.trim()}
            className="flex-1"
          >
            {validating ? "Validating..." : saving ? "Saving..." : isCreate ? "Create" : "Save Changes"}
          </Button>
          <Button variant="ghost" onClick={cancel} className="flex-1">
            Cancel
          </Button>
        </div>

        {!isCreate && (
          <Button
            variant="link"
            size="xs"
            onClick={() => setMode("confirming-delete")}
            className="w-full px-0 text-destructive/60 hover:text-destructive"
          >
            Delete this profile
          </Button>
        )}
      </div>
    );
  }

  // ── Listing / main view ────────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        D3 Server Profiles
      </h3>

      {profiles.length === 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            No profiles yet. Create one to get started — each profile links to a specific D3 install and config.
          </p>
          <Button onClick={startCreating} className="w-full">
            + New Profile
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Profile selector */}
          {!isActive && (
            <div className="flex gap-1">
              <select
                value={selectedProfileId}
                onChange={(e) => setSelectedProfileId(e.target.value)}
                className="flex-1 bg-input border border-border rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {profiles.map((p: ServerProfile) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {selectedProfile && (
                <Button variant="outline" size="xs" onClick={startEditing} className="shrink-0 px-2">
                  Edit
                </Button>
              )}
            </div>
          )}

          {isActive && selectedProfile && (
            <p className="text-xs text-foreground/70 font-medium">{selectedProfile.name}</p>
          )}

          {/* Selected profile paths */}
          {selectedProfile && (
            <div className="space-y-0.5">
              {effectiveGamePath ? (
                <div className="bg-muted rounded-md px-2 py-1 text-xs">
                  <span className="text-muted-foreground">Game: </span>
                  <span className="text-foreground/80 break-all font-mono text-[11px]">
                    {effectiveGamePath}
                  </span>
                </div>
              ) : (
                <p className="text-xs text-destructive">No game path — click Edit to configure.</p>
              )}
              {effectiveExePath ? (
                <div className="bg-muted rounded-md px-2 py-1 text-xs">
                  <span className="text-muted-foreground">Exe: </span>
                  <span className="text-foreground/80 break-all font-mono text-[11px]">
                    {effectiveExePath}
                  </span>
                </div>
              ) : (
                <p className="text-xs text-destructive">No executable — click Edit to configure.</p>
              )}
            </div>
          )}

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
            {state === "crashed" && processStatus?.exitCode !== null && processStatus?.exitCode !== undefined && (
              <Badge variant="destructive" className="text-[10px] py-0 px-1.5">
                exit {processStatus.exitCode}
              </Badge>
            )}
          </div>

          {/* Launch / Stop */}
          {isActive ? (
            <Button
              variant="destructive"
              onClick={stop}
              disabled={state === "stopping"}
              className="w-full"
            >
              {state === "stopping" ? "Stopping..." : "Stop Server"}
            </Button>
          ) : (
            <Button
              onClick={handleLaunch}
              disabled={!selectedProfileId || !profileHasPaths || launching}
              className="w-full"
            >
              {launching ? "Starting..." : "Launch Server"}
            </Button>
          )}

          {!isActive && (
            <Button
              variant="link"
              size="xs"
              onClick={startCreating}
              className="w-full px-0 text-muted-foreground"
            >
              + New Profile
            </Button>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs text-destructive bg-destructive/10 rounded-md px-2 py-1.5">
          {error}
        </p>
      )}
    </div>
  );
}
