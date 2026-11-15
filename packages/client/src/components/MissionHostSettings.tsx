import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  describeHostStatus,
  fetchMissionHost,
  type MissionHostState,
} from "@/lib/missionHost";
import type { PlaylistDownloads as Downloads } from "@/lib/playlistDownloads";
import { PlaylistDownloads } from "./PlaylistDownloads.tsx";

/**
 * Global mission host settings (Launch panel): a second listener that serves
 * the server's missions to players who join without them. Per-mission links
 * are set from the Config tab's mission panel; turning the host on points the
 * active playlist's missions at it.
 */
export function MissionHostSettings() {
  const [state, setState] = useState<MissionHostState | null>(null);
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [port, setPort] = useState("3002");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [downloads, setDownloads] = useState<Downloads | null>(null);

  const load = (s: MissionHostState) => {
    setState(s);
    setEnabled(s.settings.enabled);
    setPort(String(s.settings.port));
    setBaseUrl(s.settings.publicBaseUrl ?? "");
  };

  useEffect(() => {
    fetchMissionHost().then((s) => s && load(s));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setWarnings([]);
    setDownloads(null);
    try {
      const res = await fetch("/api/mission-host", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled, port: Number(port), publicBaseUrl: baseUrl.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
        return;
      }
      load({ settings: data.settings, status: data.status });
      setWarnings(data.warnings ?? []);
      setDownloads(data.downloads ?? null);
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const status = state?.status;
  const dot = !status?.enabled ? "bg-zinc-500" : status.bound ? "bg-emerald-500" : "bg-red-500";

  return (
    <div className="space-y-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-score tracking-wide text-muted-foreground">Mission Downloads</span>
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
          <span className="text-[11px] text-muted-foreground truncate">
            {status ? (status.enabled && status.bound ? `Port ${status.port}` : status.enabled ? "Error" : "Off") : "…"}
          </span>
        </span>
      </button>

      {status?.enabled && !status.bound && (
        <p className="text-[11px] text-destructive break-words">{describeHostStatus(status)}</p>
      )}

      {open && (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-xs text-foreground/80">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Serve missions to players who join without them
          </label>
          <div className="flex gap-1.5">
            <label className="w-20 shrink-0 text-[10px] text-muted-foreground">
              Port
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full mt-0.5 bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
            <label className="flex-1 min-w-0 text-[10px] text-muted-foreground">
              Public URL
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://example.org:3002"
                className="w-full mt-0.5 bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                onKeyDown={(e) => e.key === "Enter" && void save()}
              />
            </label>
          </div>
          <Button size="xs" onClick={() => void save()} disabled={saving} className="w-full font-score tracking-wide">
            {saving ? "Saving..." : "Save"}
          </Button>
          <p className="text-[10px] text-muted-foreground leading-snug">
            Players' clients download <span className="font-mono">&lt;public URL&gt;/missions/&lt;file&gt;</span>{" "}
            over plain http (the game has no https). Forward TCP port {port || "…"} on your router to this
            machine and give the address players reach it at. Clients built from the original 1999 code accept
            no port in a link: to reach them too, forward public port 80 here and leave the port out of the URL.
            Missions that ship with the game are never served: every player has them. Turning the host on points
            the active playlist's missions at it, and so does activating a playlist; set any other mission's link in
            Config → Mission.
          </p>
          {error && <p className="text-[11px] text-destructive break-words">{error}</p>}
          {warnings.map((w) => (
            <p key={w} className="text-[11px] text-amber-400 break-words">
              {w}
            </p>
          ))}
          {downloads && <PlaylistDownloads downloads={downloads} />}
          {status?.missionsDir && (
            <p className="text-[10px] text-muted-foreground font-mono break-all">Serves: {status.missionsDir}</p>
          )}
        </div>
      )}
    </div>
  );
}
