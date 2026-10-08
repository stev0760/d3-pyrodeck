/** Autostart: the profile Pyrodeck launches when it starts (server: launcher/Autostart.ts, routes/launcher.ts). */

export type AutostartState =
  | "off"
  | "error"
  | "skipped"
  | "launching"
  | "retrying"
  | "watching"
  | "relaunching"
  | "started"
  | "failed"
  | "cancelled";

/** What this Pyrodeck run's autostart did (GET /api/launcher/status `autostart`). */
export interface AutostartRun {
  state: AutostartState;
  profileId: string | null;
  profileName: string | null;
  source: "env" | "setting" | null;
  reason: string | null;
  failures: number;
  maxFailures: number;
  quickExitSec: number;
  at: string | null;
  nextAttemptAt: string | null;
  watchUntil: string | null;
  relaunchPending: boolean | null;
}

/** GET /api/launcher/autostart: which profile starts with Pyrodeck, and from where. */
export interface AutostartInfo {
  /** PYRODECK_AUTOSTART_PROFILE, when set: it wins, and the UI setting is locked. */
  env: string | null;
  /** The profile ticked "Start when Pyrodeck starts". */
  settingProfileId: string | null;
  effective: {
    source: "env" | "setting";
    profileId: string | null;
    profileName: string | null;
    error: string | null;
  } | null;
  run: AutostartRun;
}

export async function fetchAutostart(): Promise<AutostartInfo | null> {
  try {
    const res = await fetch("/api/launcher/autostart", { credentials: "include" });
    return res.ok ? ((await res.json()) as AutostartInfo) : null;
  } catch {
    return null;
  }
}

/** A server-side reason ("the server exited ...") as the start of a sentence. */
export function sentence(text: string | null): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

/** The short state shown next to the block's title. */
export function autostartSummary(run: AutostartRun): { text: string; tone: "ok" | "warn" | "error" | "off" } {
  switch (run.state) {
    case "off":
      return { text: "Off", tone: "off" };
    case "error":
      return { text: "Not started", tone: "error" };
    case "skipped":
      return { text: "Server was running", tone: "ok" };
    case "launching":
      return { text: "Launching", tone: "warn" };
    case "retrying":
      return { text: `Retrying (${run.failures}/${run.maxFailures})`, tone: "warn" };
    case "watching":
      return { text: "Checking", tone: "warn" };
    case "relaunching":
      return { text: `Relaunching (${run.failures}/${run.maxFailures})`, tone: "warn" };
    case "started":
      return { text: "Started", tone: "ok" };
    case "failed":
      return { text: "Gave up", tone: "error" };
    case "cancelled":
      return { text: "Handed over", tone: "off" };
  }
}
