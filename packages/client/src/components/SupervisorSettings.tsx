import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  describeHang,
  fetchSupervisor,
  formatDuration,
  formatTime,
  supervisorSummary,
  TONE_DOT,
  type SupervisorSettings as Settings,
  type SupervisorState,
} from "@/lib/supervisor";

const NUMBER_CLASS =
  "w-full mt-0.5 bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring";

type Form = Record<keyof Settings, string | boolean>;

const toForm = (s: Settings): Form => ({
  relaunchOnCrash: s.relaunchOnCrash,
  hangCheck: s.hangCheck,
  hangProbeAfterSec: String(s.hangProbeAfterSec),
  hangRestartAfterSec: String(s.hangRestartAfterSec),
  emptyRestart: s.emptyRestart,
  emptyRestartAfterHours: String(s.emptyRestartAfterHours),
  emptyRestartGraceSec: String(s.emptyRestartGraceSec),
});

/**
 * Launch panel: the supervisor's three rules (relaunch after a crash, restart
 * a hung server, restart when empty), which apply to every server, and what
 * it has done on the selected server. `state` comes with that server's status
 * poll; `onChanged` asks for a fresh one.
 */
export function SupervisorSettings({
  state,
  serverId,
  onChanged,
}: {
  state: SupervisorState | null;
  /** The selected server: its counters are shown, and Cancel drops its relaunch. */
  serverId: string | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallback, setFallback] = useState<SupervisorState | null>(null);

  // The status poll carries the state; fetch it once in case the poll has not run yet.
  useEffect(() => {
    if (!state) fetchSupervisor(serverId).then(setFallback);
  }, [state, serverId]);

  const s = state ?? fallback;

  // Load the saved settings into the form when it opens.
  useEffect(() => {
    if (open && s && !form) setForm(toForm(s.settings));
    if (!open) setForm(null);
  }, [open, s, form]);

  if (!s) return null;

  const summary = supervisorSummary(s);
  const hangLine = describeHang(s);
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const body = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, typeof v === "string" ? Number(v) : v]),
      );
      const res = await fetch("/api/launcher/supervisor", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
        return;
      }
      setFallback(data as SupervisorState);
      setForm(toForm((data as SupervisorState).settings));
      onChanged();
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const cancelRelaunch = async () => {
    setError(null);
    if (!serverId) return;
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/supervisor/cancel-relaunch`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "Failed to cancel");
    onChanged();
  };

  const crash = s.lastCrash;
  const crashWhat = crash ? (crash.signal ? `signal ${crash.signal}` : crash.code !== null ? `exit ${crash.code}` : "exit unknown") : "";

  return (
    <div className="space-y-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-score tracking-wide text-muted-foreground">Supervisor</span>
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${TONE_DOT[summary.tone]}`} />
          <span className="text-[11px] text-muted-foreground truncate">{summary.text}</span>
        </span>
      </button>

      {/* Counters: always on screen, they are the point of the block. */}
      <div className="text-[11px] text-muted-foreground space-y-0.5">
        {s.gaveUp && (
          <p className="text-destructive break-words">
            Gave up at {formatTime(s.gaveUp.at)}: {s.gaveUp.reason}. Launch the server to start again.
          </p>
        )}
        {s.pendingRelaunch && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-amber-400">
              {s.pendingRelaunch.cause === "empty-restart" ? "Restarting" : "Relaunching"} at{" "}
              {formatTime(s.pendingRelaunch.at)}
            </span>
            <Button variant="outline" size="xs" onClick={() => void cancelRelaunch()} className="font-score tracking-wide">
              Cancel
            </Button>
          </div>
        )}
        <p>
          Relaunches: {s.relaunchCount}
          {crash && (
            <>
              {" "}· last crash {formatTime(crash.at)} ({crashWhat})
            </>
          )}
          {s.lastHang && <> · last hang {formatTime(s.lastHang.at)}</>}
        </p>
        {s.uptimeMs !== null && (
          <p>
            Up {formatDuration(s.uptimeMs)} ·{" "}
            {s.humans === null ? "players not read yet" : `${s.humans} player${s.humans === 1 ? "" : "s"}`}
            {s.emptySince && s.humans === 0 && <> · empty since {formatTime(s.emptySince)}</>}
          </p>
        )}
        {hangLine && <p>{hangLine}</p>}
        {s.emptyRestart && <p>Empty restart: {s.emptyRestart}</p>}
      </div>

      {open && form && (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-xs text-foreground/80">
            <input
              type="checkbox"
              checked={form.relaunchOnCrash as boolean}
              onChange={(e) => set({ relaunchOnCrash: e.target.checked })}
            />
            Relaunch the server when it crashes
          </label>

          <label className="flex items-center gap-2 text-xs text-foreground/80">
            <input type="checkbox" checked={form.hangCheck as boolean} onChange={(e) => set({ hangCheck: e.target.checked })} />
            Restart the server when its console stops answering
          </label>
          <div className="flex gap-1.5 pl-5">
            <label className="flex-1 text-[10px] text-muted-foreground">
              Probe after (s)
              <input
                type="number"
                min={10}
                value={form.hangProbeAfterSec as string}
                onChange={(e) => set({ hangProbeAfterSec: e.target.value })}
                className={NUMBER_CLASS}
              />
            </label>
            <label className="flex-1 text-[10px] text-muted-foreground">
              Restart after (s)
              <input
                type="number"
                min={20}
                value={form.hangRestartAfterSec as string}
                onChange={(e) => set({ hangRestartAfterSec: e.target.value })}
                className={NUMBER_CLASS}
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-xs text-foreground/80">
            <input
              type="checkbox"
              checked={form.emptyRestart as boolean}
              onChange={(e) => set({ emptyRestart: e.target.checked })}
            />
            Restart the server when empty after an uptime limit
          </label>
          <div className="flex gap-1.5 pl-5">
            <label className="flex-1 text-[10px] text-muted-foreground">
              Uptime limit (h)
              <input
                type="number"
                min={0.1}
                step={0.5}
                value={form.emptyRestartAfterHours as string}
                onChange={(e) => set({ emptyRestartAfterHours: e.target.value })}
                className={NUMBER_CLASS}
              />
            </label>
            <label className="flex-1 text-[10px] text-muted-foreground">
              Wait after last player (s)
              <input
                type="number"
                min={0}
                value={form.emptyRestartGraceSec as string}
                onChange={(e) => set({ emptyRestartGraceSec: e.target.value })}
                className={NUMBER_CLASS}
              />
            </label>
          </div>

          <Button size="xs" onClick={() => void save()} disabled={saving} className="w-full font-score tracking-wide">
            {saving ? "Saving..." : "Save for all servers"}
          </Button>
          <p className="text-[10px] text-muted-foreground leading-snug">
            These rules apply to every server; each server's supervisor keeps its own counters. A quiet console gets{" "}
            <span className="font-mono">$players</span>; no answer at all by the restart time
            means the server is hung. Level loads get 2 minutes. Bots never count as players, and Pyrodeck asks the
            server who is on before an empty restart. A server you stop stays down; a crash during a playlist restart
            is left to the playlist's retry.
          </p>
        </div>
      )}
      {error && <p className="text-[11px] text-destructive break-words">{error}</p>}
    </div>
  );
}
