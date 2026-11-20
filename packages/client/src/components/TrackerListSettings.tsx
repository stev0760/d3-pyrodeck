import { useCallback, useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/session/SessionProvider";
import { sendJson } from "@/lib/ops";
import {
  MAX_TRACKERS,
  REGION_MAX,
  regionProblem,
  trackerFormChanged,
  trackerFormFrom,
  trackerNotes,
  trackerPayload,
  trackerSummary,
  type TrackerForm,
  type TrackerListView,
} from "@/lib/trackerList";
import { SettingsSection } from "./ProfileLaunchSettings";

const INPUT_CLASS =
  "w-full mt-0.5 bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * The tracker list the profile's server reads at startup (Launch panel → Edit,
 * below Launch Options): a region and up to five trackers. It is a file in the
 * game directory, not part of the profile, so it loads and saves on its own.
 */
export function TrackerListSettings({
  profileId,
  fileKey,
  profileUnsaved,
}: {
  profileId: string;
  /** The saved profile's game path and GameSpy file: when a profile save changes them, the block reads the new file. */
  fileKey: string;
  /** The profile form has unsaved changes to the game path or GameSpy file: the file named here is about to change. */
  profileUnsaved: boolean;
}) {
  const { toast } = useSession();
  const [view, setView] = useState<TrackerListView | null>(null);
  const [form, setForm] = useState<TrackerForm>({ region: "0", trackers: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const api = `/api/profiles/${encodeURIComponent(profileId)}/tracker-list`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(api, { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError((data as { error?: string }).error ?? `Could not read the tracker list (HTTP ${res.status})`);
        return;
      }
      setView(data as TrackerListView);
      setForm(trackerFormFrom(data as TrackerListView));
      setLoadError(null);
    } catch {
      setLoadError("Could not read the tracker list: network error");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, fileKey]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    const res = await sendJson<TrackerListView & { written: boolean }>("PUT", api, trackerPayload(form));
    setSaving(false);
    if (res.error !== null) {
      setSaveError(res.error);
      return;
    }
    setView(res.data);
    setForm(trackerFormFrom(res.data));
    toast.addToast(
      res.data.written
        ? `Saved ${res.data.file}.${res.data.running ? " The running server reads it when it next starts." : ""}`
        : `Nothing to save: ${res.data.file} does not exist and the list is empty.`,
      "info",
    );
  };

  const setTracker = (i: number, value: string) =>
    setForm((f) => ({ ...f, trackers: f.trackers.map((t, j) => (j === i ? value : t)) }));
  const removeTracker = (i: number) => setForm((f) => ({ ...f, trackers: f.trackers.filter((_, j) => j !== i) }));
  const addTracker = () => setForm((f) => ({ ...f, trackers: [...f.trackers, ""] }));

  const typedTrackers = form.trackers.filter((t) => t.trim() !== "").length;
  const regionError = regionProblem(form.region);
  // A file not in pairs is worth saving as it is: the save rewrites it in the form the game reads.
  const canSave =
    !!view &&
    view.writable &&
    !profileUnsaved &&
    !saving &&
    regionError === null &&
    (trackerFormChanged(form, view) || view.ignored.length > 0);

  return (
    <SettingsSection title="Tracker Listing" summary={trackerSummary(view, loadError)}>
      {loadError && <p className="text-[11px] text-destructive break-words">{loadError}</p>}
      {view && (
        <>
          <p className="text-[10px] text-muted-foreground leading-snug">
            The game trackers the server reports to, at most {MAX_TRACKERS}, and its region. Pyrodeck writes them as the
            game reads them: a region line before each tracker.
          </p>
          {trackerNotes(view, typedTrackers).map((note, i) => (
            <p
              key={i}
              className={`text-[10px] leading-snug break-words ${note.tone === "warn" ? "text-amber-400" : "text-muted-foreground"}`}
            >
              {note.text}
            </p>
          ))}
          {view.ignored.length > 0 && (
            <div className="text-[10px] text-amber-400 leading-snug space-y-0.5">
              <p>
                {view.file} is not in the form the game reads: it takes the lines in pairs, a region and then a tracker.
                It does not use these lines as trackers:
              </p>
              <ul className="font-mono break-all pl-2">
                {view.ignored.map((line, i) => (
                  <li key={i}>{line.trim() === "" ? "(a line of spaces)" : line}</li>
                ))}
              </ul>
              <p>Saving rewrites the file in pairs.</p>
            </div>
          )}
          <label className="block text-[10px] text-muted-foreground">
            Region (0-{REGION_MAX})
            <input
              type="number"
              min={0}
              max={REGION_MAX}
              step={1}
              value={form.region}
              onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))}
              placeholder="0"
              className={INPUT_CLASS}
            />
          </label>
          {regionError ? (
            <p className="text-[10px] text-destructive leading-snug">{regionError}</p>
          ) : (
            <p className="text-[10px] text-muted-foreground leading-snug">
              A number from 0 to {REGION_MAX}; 0 is the game's default.
            </p>
          )}
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground">Trackers: host or host:port (port 27900 when left out)</p>
            {form.trackers.map((tracker, i) => (
              <div key={i} className="flex items-center gap-1">
                <input
                  type="text"
                  value={tracker}
                  onChange={(e) => setTracker(i, e.target.value)}
                  placeholder="tracker.example.org:27900"
                  aria-label={`Tracker ${i + 1}`}
                  className={`${INPUT_CLASS} mt-0`}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => removeTracker(i)}
                  className="shrink-0 px-1.5 text-muted-foreground"
                  aria-label={`Remove tracker ${i + 1}`}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="xs"
              onClick={addTracker}
              disabled={form.trackers.length >= MAX_TRACKERS}
              className="font-score tracking-wide"
            >
              <Plus className="size-3.5" /> Add tracker
            </Button>
          </div>
          {profileUnsaved && (
            <p className="text-[10px] text-amber-400 leading-snug">
              The profile's game path or GameSpy file has unsaved changes. Save the profile first: this block edits the
              file the saved profile names.
            </p>
          )}
          {!view.writable && view.writeError && (
            <p className="text-[11px] text-destructive leading-snug break-words">{view.writeError}</p>
          )}
          {saveError && <p className="text-[11px] text-destructive leading-snug break-words">{saveError}</p>}
          <Button size="xs" onClick={() => void save()} disabled={!canSave} className="w-full font-score tracking-wide">
            {saving ? "Saving..." : "Save Tracker List"}
          </Button>
        </>
      )}
    </SettingsSection>
  );
}
