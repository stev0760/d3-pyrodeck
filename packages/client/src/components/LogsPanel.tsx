import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
interface LogFile {
  name: string;
  size: number;
  mtimeMs: number;
  /** A .log.gz that log retention compressed: viewed decompressed, downloaded as is. */
  compressed?: boolean;
}

interface LogsResponse {
  logDir: string | null;
  files: LogFile[];
}

interface RetentionSettings {
  days: number;
  maxMb: number;
  compress: boolean;
}

interface RetentionState {
  settings: RetentionSettings;
  stored: RetentionSettings;
  /** PYRODECK_LOG_RETENTION_DAYS / _MAX_MB / _COMPRESS when set; they win over the stored values. */
  env: { days: number | null; maxMb: number | null; compress: boolean | null };
  dirs: string[];
  lastRun: {
    at: string;
    compressed: number;
    deleted: number;
    freedBytes: number;
    files: number;
    totalBytes: number;
    errors: string[];
    /** Retention is off and Pyrodeck's logs take more than 1 GB. */
    warning: string | null;
  } | null;
}

const RETENTION_INPUT =
  "w-full bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60";

/** Logs tab: how long Pyrodeck keeps its logs, how much space they may take, and whether closed ones are gzipped. */
function LogRetention({ onSaved }: { onSaved: () => void }) {
  const [state, setState] = useState<RetentionState | null>(null);
  const [days, setDays] = useState("");
  const [maxMb, setMaxMb] = useState("");
  const [compress, setCompress] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (s: RetentionState) => {
    setState(s);
    setDays(String(s.settings.days));
    setMaxMb(String(s.settings.maxMb));
    setCompress(s.settings.compress);
  };

  useEffect(() => {
    fetch("/api/logs/retention", { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<RetentionState>) : null))
      .then((s) => s && load(s))
      .catch(() => {});
  }, []);

  const save = async () => {
    if (!state) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/logs/retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        // A value the environment sets is sent as stored, unchanged.
        body: JSON.stringify({
          days: state.env.days !== null ? state.stored.days : Number(days),
          maxMb: state.env.maxMb !== null ? state.stored.maxMb : Number(maxMb),
          compress: state.env.compress !== null ? state.stored.compress : compress,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string }).error ?? "Failed to save the retention settings");
        return;
      }
      load(body as RetentionState);
      // Retention runs right after a save; list the files again once it is done.
      setTimeout(onSaved, 1500);
    } catch {
      setError("Failed to save the retention settings");
    } finally {
      setSaving(false);
    }
  };

  if (!state) return null;
  const last = state.lastRun;
  return (
    <div className="space-y-2 border border-border rounded-md p-3 bg-card">
      <h3 className="text-sm font-score tracking-wide text-muted-foreground">Retention</h3>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="text-[10px] text-muted-foreground">
          Delete after (days, 0 = never)
          <input
            type="number"
            min={0}
            max={3650}
            value={days}
            disabled={state.env.days !== null}
            onChange={(e) => setDays(e.target.value)}
            className={`${RETENTION_INPUT} mt-0.5`}
          />
          {state.env.days !== null && <span className="block mt-0.5">Set by PYRODECK_LOG_RETENTION_DAYS</span>}
        </label>
        <label className="text-[10px] text-muted-foreground">
          Total size cap (MB, 0 = none)
          <input
            type="number"
            min={0}
            value={maxMb}
            disabled={state.env.maxMb !== null}
            onChange={(e) => setMaxMb(e.target.value)}
            className={`${RETENTION_INPUT} mt-0.5`}
          />
          {state.env.maxMb !== null && <span className="block mt-0.5">Set by PYRODECK_LOG_MAX_MB</span>}
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs text-foreground/80">
        <input
          type="checkbox"
          checked={compress}
          disabled={state.env.compress !== null}
          onChange={(e) => setCompress(e.target.checked)}
        />
        Compress closed logs (gzip, renamed to .log.gz)
        {state.env.compress !== null && <span className="text-[10px] text-muted-foreground">Set by PYRODECK_LOG_COMPRESS</span>}
      </label>
      <Button size="xs" onClick={() => void save()} disabled={saving} className="font-score tracking-wide">
        {saving ? "Saving..." : "Save"}
      </Button>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      {last?.warning && <p className="text-[11px] text-amber-400 leading-snug break-words">{last.warning}</p>}
      <p className="text-[10px] text-muted-foreground leading-snug">
        Off by default: Pyrodeck keeps every log as written until you set a limit here or in the environment. For a public
        server, 30 days, 2048 MB and compression on are a good start. Applies to the logs Pyrodeck writes (named{" "}
        <span className="font-mono">profile-YYYY-MM-DDTHH-MM-SS.log</span>) and to nothing else in the directory. The running server's log, and any log written in the last ten minutes, is never
        compressed or deleted. Old logs go first by age, then the oldest until the total fits the cap. Pyrodeck applies
        this at startup, every hour and when you save.
      </p>
      {last && (
        <p className={`text-[10px] leading-snug ${last.errors.length ? "text-amber-400" : "text-muted-foreground"}`}>
          Last run {new Date(last.at).toLocaleString()}: {last.compressed} compressed, {last.deleted} deleted,{" "}
          {formatBytes(last.freedBytes)} freed; {last.files} logs take {formatBytes(last.totalBytes)}.
          {last.errors.length > 0 && ` ${last.errors.join(" ")}`}
        </p>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function LogsPanel() {
  const [data, setData] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirEdit, setDirEdit] = useState("");
  const [dirSaving, setDirSaving] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  // Viewer state
  const [viewing, setViewing] = useState<string | null>(null);
  const [viewText, setViewText] = useState("");
  const [viewLoading, setViewLoading] = useState(false);

  // Two-step delete: first click arms (button shows "Confirm?"), second deletes.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/logs", { credentials: "include" });
      const json = (await res.json()) as LogsResponse;
      setData(json);
      setDirEdit(json.logDir ?? "");
    } catch {
      setData({ logDir: null, files: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveDir = async () => {
    setDirSaving(true);
    setDirError(null);
    try {
      const res = await fetch("/api/pyrodeck/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ logDir: dirEdit.trim() || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDirError(body.error ?? "Failed to save log directory");
      } else {
        await refresh();
      }
    } catch {
      setDirError("Failed to save log directory");
    } finally {
      setDirSaving(false);
    }
  };

  const view = async (name: string) => {
    setViewing(name);
    setViewLoading(true);
    setViewText("");
    try {
      // ?tail=1 — the server sends only the last chunk of huge soak logs, so
      // we never download (or hold in memory) hundreds of MB just to peek.
      const res = await fetch(`/api/logs/${encodeURIComponent(name)}?tail=1`, {
        credentials: "include",
      });
      const text = await res.text();
      if (res.headers.get("X-Log-Truncated") === "1") {
        const total = Number(res.headers.get("X-Log-Total-Size") ?? 0);
        const totalLabel = total ? ` of ${formatBytes(total)}` : "";
        // Drop the first (likely partial) line of the tail chunk.
        const firstNewline = text.indexOf("\n");
        const clean = firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
        // Blob measures bytes; string length would undercount multi-byte UTF-8.
        const shownBytes = new Blob([clean]).size;
        setViewText(
          `… showing last ${formatBytes(shownBytes)}${totalLabel} — Download for the full log …\n\n${clean}`,
        );
      } else {
        setViewText(text);
      }
    } catch {
      setViewText("Failed to load log.");
    } finally {
      setViewLoading(false);
    }
  };

  // Scroll the viewer to the top of the panel when it finishes loading so the
  // user actually sees the result (otherwise it sits at the bottom of a long
  // file list and the click feels like a no-op).
  const viewerRef = useCallback((node: HTMLDivElement | null) => {
    if (node && !viewLoading) {
      node.scrollIntoView({ block: "start" });
    }
  }, [viewLoading]);

  const remove = async (name: string) => {
    if (confirmDelete !== name) {
      setConfirmDelete(name);
      return;
    }
    setConfirmDelete(null);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/logs/${encodeURIComponent(name)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDeleteError(body.error ?? `Failed to delete ${name}`);
      } else if (viewing === name) {
        setViewing(null);
        setViewText("");
      }
    } catch {
      setDeleteError(`Failed to delete ${name}`);
    }
    await refresh();
  };

  if (loading) {
    return <p className="text-muted-foreground text-sm">Loading logs…</p>;
  }

  return (
    <div className="space-y-4">
      {/* Log directory control */}
      <div>
        <label className="text-sm font-score tracking-wide text-muted-foreground block mb-1">
          Log Directory
        </label>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={dirEdit}
            onChange={(e) => setDirEdit(e.target.value)}
            placeholder="Auto (next to the executable)"
            className="flex-1 min-w-0 bg-input border border-border rounded-md px-2 py-1.5 text-sm text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveDir();
            }}
          />
          <Button
            onClick={() => void saveDir()}
            disabled={dirSaving}
            className="font-score tracking-wide shrink-0"
          >
            {dirSaving ? "…" : "Save"}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          Leave blank to auto-place logs next to the D3 executable. Each launch
          writes a timestamped file here.
        </p>
        {dirError && (
          <p className="text-[11px] text-destructive mt-1">{dirError}</p>
        )}
        {data?.logDir && (
          <p className="text-[11px] text-muted-foreground mt-1 font-mono break-all">
            Current: {data.logDir}
          </p>
        )}
      </div>

      <LogRetention onSaved={() => void refresh()} />

      {/* Inline viewer — rendered above the file list so the user sees the
          result of clicking View without scrolling past 100+ rows. The ref
          scrolls it to the top of the panel once the fetch resolves. */}
      {viewing && (
        <div ref={viewerRef} className="border border-border rounded-md overflow-hidden">
          <div className="flex items-center justify-between bg-muted px-2.5 py-1.5">
            <p className="text-xs font-mono text-foreground truncate">{viewing}</p>
            <button
              onClick={() => {
                setViewing(null);
                setViewText("");
              }}
              className="text-xs font-score tracking-wide text-muted-foreground hover:text-foreground px-2"
            >
              Close
            </button>
          </div>
          <pre className="text-[11px] leading-snug text-foreground/90 font-mono whitespace-pre-wrap break-words max-h-[50vh] overflow-auto p-2.5 bg-background">
            {viewLoading ? "Loading…" : viewText}
          </pre>
        </div>
      )}

      {/* File list */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-score tracking-wide text-muted-foreground">
          Log Files{data ? ` (${data.files.length})` : ""}
        </h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          className="font-score tracking-wide"
        >
          Refresh
        </Button>
      </div>

      {!data || data.files.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No logs yet. Launch a server and its log will appear here.
        </p>
      ) : (
        <ul className="space-y-1">
          {data.files.map((f) => (
            <li
              key={f.name}
              className="flex items-center gap-2 bg-muted/50 border border-border rounded-md px-2.5 py-1.5"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground font-mono truncate">
                  {f.name}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {formatBytes(f.size)}
                  {f.compressed ? " compressed" : ""} · {formatTime(f.mtimeMs)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void view(f.name)}
                className="font-score tracking-wide shrink-0"
              >
                View
              </Button>
              <a
                href={`/api/logs/${encodeURIComponent(f.name)}?download=1`}
                download={f.name}
                className="text-xs font-score tracking-wide text-primary hover:underline shrink-0 px-2"
              >
                Download
              </a>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void remove(f.name)}
                onBlur={() => setConfirmDelete((prev) => (prev === f.name ? null : prev))}
                className={`font-score tracking-wide shrink-0 ${
                  confirmDelete === f.name
                    ? "text-destructive hover:text-destructive"
                    : "text-muted-foreground"
                }`}
              >
                {confirmDelete === f.name ? "Confirm?" : "Delete"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {deleteError && (
        <p className="text-[11px] text-destructive">{deleteError}</p>
      )}
    </div>
  );
}
