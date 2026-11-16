/** Supervisor settings and state (server: launcher/Supervisor.ts, routes/launcher.ts). */

export interface SupervisorSettings {
  relaunchOnCrash: boolean;
  hangCheck: boolean;
  hangProbeAfterSec: number;
  hangRestartAfterSec: number;
  emptyRestart: boolean;
  emptyRestartAfterHours: number;
  emptyRestartGraceSec: number;
}

export interface SupervisorState {
  settings: SupervisorSettings;
  enabled: boolean;
  relaunchCount: number;
  recentFailures: number;
  pendingRelaunch: { at: string; cause: "crash" | "hang" | "empty-restart" } | null;
  gaveUp: { at: string; reason: string } | null;
  lastCrash: { at: string; code: number | null; signal: string | null } | null;
  lastHang: { at: string; silentForMs: number } | null;
  hang: {
    state: "off" | "listening" | "probing" | "loading";
    silentForMs: number | null;
    probeAt: number | null;
    restartAt: number | null;
  };
  uptimeMs: number | null;
  humans: number | null;
  emptySince: string | null;
  emptyRestart: string | null;
  adopted: boolean;
}

/** Status dot colours of the Launch panel's Supervisor and Autostart blocks. */
export const TONE_DOT: Record<"ok" | "warn" | "error" | "off", string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-400 animate-pulse",
  error: "bg-red-500",
  off: "bg-zinc-500",
};

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 300) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** The short state shown next to the block's title. */
export function supervisorSummary(s: SupervisorState): { text: string; tone: "ok" | "warn" | "error" | "off" } {
  if (s.gaveUp) return { text: "Gave up", tone: "error" };
  if (s.pendingRelaunch) {
    const left = Math.max(0, Date.parse(s.pendingRelaunch.at) - Date.now());
    return { text: `Relaunch in ${formatDuration(left)}`, tone: "warn" };
  }
  if (!s.enabled) return { text: "Off", tone: "off" };
  if (s.hang.state === "probing") return { text: "Probing", tone: "warn" };
  return { text: "Watching", tone: "ok" };
}

/** The console-silence line, or null when the hang check is not watching. */
export function describeHang(s: SupervisorState): string | null {
  const h = s.hang;
  if (h.state === "off" || h.silentForMs === null) return null;
  if (h.state === "loading") return "Level loading: hang check paused";
  const quiet = `Console quiet ${formatDuration(h.silentForMs)}`;
  if (h.state === "probing") {
    const left = h.restartAt !== null ? Math.max(0, h.restartAt - Date.now()) : 0;
    return `${quiet}: $players sent, restart in ${formatDuration(left)} without an answer`;
  }
  if (h.silentForMs < 5000) return "Console answering";
  return `${quiet} (probe at ${s.settings.hangProbeAfterSec} s)`;
}

export async function fetchSupervisor(serverId?: string | null): Promise<SupervisorState | null> {
  try {
    const url = serverId ? `/api/servers/${encodeURIComponent(serverId)}/supervisor` : "/api/launcher/supervisor";
    const res = await fetch(url, { credentials: "include" });
    return res.ok ? ((await res.json()) as SupervisorState) : null;
  } catch {
    return null;
  }
}
