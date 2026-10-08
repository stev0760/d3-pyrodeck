import { useState, useEffect, useCallback } from "react";
import type { useLauncher, ServerProfile, PostStartSettings } from "../hooks/useLauncher.ts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MissionHostSettings } from "./MissionHostSettings";
import { ScheduleFields, EMPTY_SCHEDULE, describeNextAction } from "./ScheduleFields";
import { LaunchScriptImport } from "./LaunchScriptImport";
import { Separator } from "@/components/ui/separator";
import { getJson, type ProfileSchedule, type ScheduleState } from "@/lib/ops";

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

type PanelMode = "listing" | "creating" | "editing" | "importing" | "confirming-delete";

interface PathFormState {
  name: string;
  gamePath: string;
  executablePath: string;
  postStart: PostStartSettings;
  schedule: ProfileSchedule;
}

const SCHEDULE_POLL_MS = 30_000;

type OnOff = "default" | "on" | "off";
const toOnOff = (v: boolean | undefined): OnOff => (v === undefined ? "default" : v ? "on" : "off");
const fromOnOff = (v: OnOff): boolean | undefined => (v === "default" ? undefined : v === "on");

const SELECT_CLASS =
  "w-full bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * DMFC options dedicated.cfg cannot hold. Pyrodeck sends them over the
 * console after each launch and playlist restart of this profile.
 */
function PostStartFields({
  values,
  onChange,
}: {
  values: PostStartSettings;
  onChange: (v: PostStartSettings) => void;
}) {
  const set = (patch: Partial<PostStartSettings>) => {
    const next: PostStartSettings = { ...values, ...patch };
    for (const k of Object.keys(next) as (keyof PostStartSettings)[]) {
      if (next[k] === undefined) delete next[k];
    }
    onChange(next);
  };
  return (
    <div className="space-y-1.5 border-t border-border pt-2">
      <p className="text-sm font-score tracking-wide text-muted-foreground">After Launch</p>
      <p className="text-[10px] text-muted-foreground">
        Sent over the console after every launch and playlist restart. "Server default" sends nothing.
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="text-[11px] text-muted-foreground">
          HUD names
          <select
            value={values.hudNames ?? ""}
            onChange={(e) => set({ hudNames: (e.target.value || undefined) as PostStartSettings["hudNames"] })}
            className={SELECT_CLASS}
          >
            <option value="">Server default</option>
            <option value="full">Full</option>
            <option value="team">Team only</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">
          Kill messages
          <select
            value={values.killMsgFilter ?? ""}
            onChange={(e) =>
              set({ killMsgFilter: (e.target.value || undefined) as PostStartSettings["killMsgFilter"] })
            }
            className={SELECT_CLASS}
          >
            <option value="">Server default</option>
            <option value="full">Full</option>
            <option value="simple">Simple</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">
          Save stats at level end
          <select
            value={toOnOff(values.autoSaveLevel)}
            onChange={(e) => set({ autoSaveLevel: fromOnOff(e.target.value as OnOff) })}
            className={SELECT_CLASS}
          >
            <option value="default">Server default</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground">
          Save stats on disconnect
          <select
            value={toOnOff(values.autoSaveDisconnect)}
            onChange={(e) => set({ autoSaveDisconnect: fromOnOff(e.target.value as OnOff) })}
            className={SELECT_CLASS}
          >
            <option value="default">Server default</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
      </div>
    </div>
  );
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
        <label className="text-sm font-score tracking-wide text-muted-foreground block mb-0.5">
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
        <label className="text-sm font-score tracking-wide text-muted-foreground block mb-0.5">
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
        <label className="text-sm font-score tracking-wide text-muted-foreground block mb-0.5">
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
  const [form, setForm] = useState<PathFormState>({
    name: "",
    gamePath: "",
    executablePath: "",
    postStart: {},
    schedule: EMPTY_SCHEDULE,
  });
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  // What the weekly schedule does next (server-side times, Pyrodeck's zone).
  const [schedule, setSchedule] = useState<ScheduleState | null>(null);
  const refreshSchedule = useCallback(() => {
    void getJson<ScheduleState>("/api/schedule").then((s) => s && setSchedule(s));
  }, []);
  useEffect(() => {
    refreshSchedule();
    const timer = setInterval(refreshSchedule, SCHEDULE_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshSchedule, profiles, processStatus?.state]);

  if (loading) {
    return <p className="text-muted-foreground text-sm">Loading...</p>;
  }

  const state = processStatus?.state ?? "stopped";
  const isActive = state === "running" || state === "starting" || state === "stopping";

  // The profile whose launch produced the running process. Null when nothing is
  // active, or when the live profile is unknown (e.g. a process started before
  // this was tracked) — in that case we fall back to the old whole-panel lock.
  const liveProfileId = isActive ? processStatus?.activeProfileId ?? null : null;
  const selectedIsLive =
    isActive && (liveProfileId === null || liveProfileId === selectedProfileId);
  const otherServerRunning =
    isActive && liveProfileId !== null && liveProfileId !== selectedProfileId;

  const selectedProfile: ServerProfile | undefined = profiles.find(
    (p: ServerProfile) => p.id === selectedProfileId,
  );
  const liveProfile: ServerProfile | undefined = profiles.find(
    (p: ServerProfile) => p.id === liveProfileId,
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
      postStart: { ...(selectedProfile.postStart ?? {}) },
      schedule: selectedProfile.schedule
        ? { ...selectedProfile.schedule, windows: selectedProfile.schedule.windows.map((w) => ({ ...w })) }
        : EMPTY_SCHEDULE,
    });
    setValidationErrors([]);
    setMode("editing");
  };

  const startCreating = () => {
    setForm({ name: "", gamePath: "", executablePath: "", postStart: {}, schedule: EMPTY_SCHEDULE });
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
      postStart: Object.keys(form.postStart).length > 0 ? form.postStart : null,
      schedule: form.schedule.enabled || form.schedule.windows.length > 0 ? form.schedule : null,
    });
    setSaving(false);
    if (updated) {
      setMode("listing");
      refreshSchedule();
    }
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

  // ── Import from a launch script ───────────────────────────────────────────
  if (mode === "importing") {
    return (
      <div className="space-y-3">
        <LaunchScriptImport
          createProfile={createProfile}
          onCreated={(profile) => {
            setSelectedProfileId(profile.id);
            setMode("listing");
          }}
          onCancel={cancel}
        />
        {error && (
          <p className="text-xs text-destructive bg-destructive/10 rounded-md px-2 py-1.5 break-words">{error}</p>
        )}
      </div>
    );
  }

  // ── Delete confirmation ────────────────────────────────────────────────────
  if (mode === "confirming-delete") {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-score tracking-wide text-muted-foreground">
          Delete Profile
        </h3>
        <p className="text-sm text-foreground/80">
          Delete <span className="font-medium">{selectedProfile?.name}</span>? The config files on disk are not removed.
        </p>
        <div className="flex gap-1.5">
          <Button variant="destructive" onClick={handleDelete} className="flex-1 font-score tracking-wide">
            Delete
          </Button>
          <Button variant="ghost" onClick={cancel} className="flex-1 font-score tracking-wide">
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
        <h3 className="text-sm font-score tracking-wide text-muted-foreground">
          {isCreate ? "New Profile" : `Edit: ${selectedProfile?.name}`}
        </h3>

        <PathFormFields
          values={form}
          onChange={(f) => setForm((prev) => ({ ...prev, ...f }))}
        />

        {!isCreate && (
          <PostStartFields
            values={form.postStart}
            onChange={(postStart) => setForm((prev) => ({ ...prev, postStart }))}
          />
        )}

        {!isCreate && (
          <ScheduleFields
            value={form.schedule}
            onChange={(next) => setForm((prev) => ({ ...prev, schedule: next }))}
            timeZone={schedule?.timeZone ?? null}
          />
        )}

        {validationErrors.length > 0 && (
          <div className="text-xs text-destructive space-y-0.5">
            {validationErrors.map((e, i) => <p key={i}>{e}</p>)}
          </div>
        )}

        <div className="flex gap-1.5">
          <Button
            onClick={isCreate ? handleCreate : handleSave}
            disabled={validating || saving || !form.name.trim()}
            className="flex-1 font-score tracking-wide"
          >
            {validating ? "Validating..." : saving ? "Saving..." : isCreate ? "Create" : "Save Changes"}
          </Button>
          <Button variant="ghost" onClick={cancel} className="flex-1 font-score tracking-wide">
            Cancel
          </Button>
        </div>

        {!isCreate && (
          selectedIsLive ? (
            <p className="text-[11px] text-muted-foreground border-t border-border pt-2">
              This profile's server is running. Stop it to delete the profile.
            </p>
          ) : (
            <div className="border-t border-border pt-2">
              <Button
                variant="outline"
                size="xs"
                onClick={() => setMode("confirming-delete")}
                className="w-full font-score tracking-wide text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
              >
                Delete Profile
              </Button>
            </div>
          )
        )}
      </div>
    );
  }

  // ── Listing / main view ────────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-score tracking-wide text-muted-foreground">
        D3 Server Profiles
      </h3>

      {profiles.length === 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            No profiles yet. Create one to get started — each profile links to a specific D3 install and config.
          </p>
          <Button onClick={startCreating} className="w-full font-score tracking-wide">
            + New Profile
          </Button>
          <Button
            variant="link"
            size="xs"
            onClick={() => setMode("importing")}
            className="w-full px-0 text-muted-foreground"
          >
            Import from a launch script
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Profile selector — stays available while a server runs so profiles
              can still be edited/deleted; the live profile is marked and its own
              destructive actions are guarded. */}
          <div className="flex gap-1">
            <select
              value={selectedProfileId}
              onChange={(e) => setSelectedProfileId(e.target.value)}
              className="flex-1 bg-input border border-border rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {profiles.map((p: ServerProfile) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {liveProfileId === p.id ? " ● running" : ""}
                </option>
              ))}
            </select>
            {selectedProfile && (
              <Button variant="outline" size="xs" onClick={startEditing} className="shrink-0 px-2 font-score tracking-wide">
                Edit
              </Button>
            )}
          </div>

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
              {selectedProfile.importedArgs && selectedProfile.importedArgs.length > 0 && (
                <div className="bg-muted rounded-md px-2 py-1 text-[10px] text-muted-foreground">
                  Imported flags, not applied:{" "}
                  <span className="font-mono text-foreground/80 break-all">{selectedProfile.importedArgs.join(" ")}</span>{" "}
                  <button
                    onClick={() => void updateProfile(selectedProfile.id, { importedArgs: null })}
                    className="text-primary hover:underline"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          )}

          <Separator />

          {/* Process status */}
          <div className="flex items-center gap-2 py-0.5">
            <div
              className={`w-2 h-2 rounded-full ${STATUS_COLORS[state] ?? STATUS_COLORS.stopped}`}
            />
            <span className="text-sm font-score tracking-wide text-foreground/70 capitalize">{state}</span>
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

          {(() => {
            const line = describeNextAction(schedule?.entries.find((e) => e.profileId === selectedProfileId));
            return line ? <p className="text-[11px] text-muted-foreground">{line}</p> : null;
          })()}

          {/* Log health: a failed log stays on screen (the toast alone is gone
              in seconds, and a soak that logs nowhere is lost for good). */}
          {processStatus?.log?.state === "failed" && (
            <div className="text-xs text-destructive bg-destructive/10 border border-destructive/40 rounded-md px-2 py-1.5 break-words">
              <span className="font-medium">Log not being written.</span> {processStatus.log.message}
            </div>
          )}
          {isActive && processStatus?.log?.path && processStatus.log.state !== "failed" && (
            <p
              className="text-[10px] text-muted-foreground break-all font-mono"
              title={processStatus.log.path}
            >
              Log: {processStatus.log.path.split(/[\\/]/).pop()}
              {processStatus.log.state === "pending" ? " (checking…)" : ""}
            </p>
          )}

          {/* Launch / Stop — Stop targets the live profile; a different selection
              shows Launch (disabled while another profile's server holds the port). */}
          {selectedIsLive ? (
            <Button
              variant="destructive"
              onClick={stop}
              disabled={state === "stopping"}
              className="w-full font-score tracking-wide"
            >
              {state === "stopping" ? "Stopping..." : "Stop Server"}
            </Button>
          ) : (
            <Button
              onClick={handleLaunch}
              disabled={!selectedProfileId || !profileHasPaths || launching || otherServerRunning}
              className="w-full font-score tracking-wide"
            >
              {launching ? "Starting..." : "Launch Server"}
            </Button>
          )}

          {otherServerRunning && (
            <p className="text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground/70">{liveProfile?.name ?? "Another profile"}</span> is
              running. Stop it before launching this one.
            </p>
          )}

          <div className="flex">
            <Button
              variant="link"
              size="xs"
              onClick={startCreating}
              className="flex-1 px-0 text-muted-foreground"
            >
              + New Profile
            </Button>
            <Button
              variant="link"
              size="xs"
              onClick={() => setMode("importing")}
              className="flex-1 px-0 text-muted-foreground"
            >
              Import script
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-destructive bg-destructive/10 rounded-md px-2 py-1.5">
          {error}
        </p>
      )}

      <Separator />
      <MissionHostSettings />
    </div>
  );
}
