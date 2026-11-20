/**
 * A profile's tracker list, as GET /api/profiles/:id/tracker-list sends it
 * (server: routes/config.ts, launcher/trackerList.ts), and the Tracker
 * Listing block's form. The server validates every field.
 */

/** Pairs the game reads. */
export const MAX_TRACKERS = 5;
export const REGION_MAX = 12;

export interface TrackerListView {
  /** The file the profile's server reads at its next start: its -gspyfile, else gamespy.cfg. */
  file: string;
  path: string;
  exists: boolean;
  writable: boolean;
  writeError: string | null;
  region: number;
  trackers: string[];
  /** Lines the game does not use as trackers: the file is not in region/tracker pairs. */
  ignored: string[];
  /** Other profiles reading the same file. */
  sharedWith: string[];
  gameSpyPort: { port: number; source: "running" | "profile" | "default" };
  running: boolean;
}

export interface TrackerForm {
  /** As typed, so the field can be cleared. */
  region: string;
  /** One row each, as typed. */
  trackers: string[];
}

export function trackerFormFrom(view: TrackerListView): TrackerForm {
  return { region: String(view.region), trackers: [...view.trackers] };
}

/** The PUT body: rows trimmed, empty rows dropped, an empty region 0; anything else goes as typed for the server to judge. */
export function trackerPayload(form: TrackerForm): { region: number | string; trackers: string[] } {
  const typed = form.region.trim();
  const n = Number(typed === "" ? "0" : typed);
  return {
    region: Number.isFinite(n) ? n : typed,
    trackers: form.trackers.map((t) => t.trim()).filter((t) => t !== ""),
  };
}

/**
 * Why the typed region cannot be saved, or null (empty reads as 0). A file
 * not in pairs can give the game any number: atoi of a host line.
 */
export function regionProblem(region: string): string | null {
  const typed = region.trim();
  if (typed === "") return null;
  return /^\d+$/.test(typed) && Number(typed) <= REGION_MAX
    ? null
    : `The region must be a whole number from 0 to ${REGION_MAX}.`;
}

/** Whether saving the form would change what the game reads. */
export function trackerFormChanged(form: TrackerForm, view: TrackerListView): boolean {
  const p = trackerPayload(form);
  return p.region !== view.region || p.trackers.join("\n") !== view.trackers.join("\n");
}

/** The closed block's one line. */
export function trackerSummary(view: TrackerListView | null, loadError: string | null): string {
  if (loadError) return "Cannot read";
  if (!view) return "Loading...";
  const n = view.trackers.length;
  if (n === 0) return "Not listed";
  return `${n} tracker${n === 1 ? "" : "s"}`;
}

export interface TrackerNote {
  text: string;
  tone: "info" | "warn";
}

/** What to say beside the controls; `trackerCount` is the form's, so the no-tracker note follows the editing. */
export function trackerNotes(view: TrackerListView, trackerCount: number): TrackerNote[] {
  const notes: TrackerNote[] = [];
  notes.push({
    text:
      `Saved to ${view.path}${view.exists ? "" : " (not there yet)"}, in the game directory, not in the profile: ` +
      "this block has its own Save.",
    tone: "info",
  });
  if (view.sharedWith.length > 0) {
    notes.push({
      text:
        `Also read by ${view.sharedWith.map((n) => `"${n}"`).join(", ")}: servers of one game directory share the ` +
        "list unless a profile names its own GameSpy file (Launch Options).",
      tone: "warn",
    });
  }
  notes.push({
    text: view.running
      ? "The game reads the list when the server starts. This server is running: it keeps the list it started with until it restarts."
      : "The game reads the list when the server starts.",
    tone: "info",
  });
  const port = view.gameSpyPort.port;
  notes.push({
    text:
      `Trackers query the server back on UDP port ${port}, which must be reachable from the internet.` +
      (view.gameSpyPort.source === "default"
        ? ` With no GameSpy port set, Pyrodeck moves it to a free one when another server holds ${port}; set one in Launch Options to keep it fixed.`
        : ""),
    tone: "info",
  });
  if (trackerCount === 0) notes.push({ text: "With no trackers, the server is listed nowhere.", tone: "info" });
  return notes;
}
