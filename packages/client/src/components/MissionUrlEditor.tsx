import { useState, useEffect } from "react";
import type { MissionDetails } from "@/lib/missionCompat";

interface MissionUrlEditorProps {
  profileId: string;
  mission: MissionDetails;
  onUpdated: (info: MissionDetails) => void;
}

/** Longest link the engine reads back from a .msn URL line (char operand[96]). */
const URL_MAX = 95;

/**
 * Download link for a mission: the URL line(s) inside the .mn3 that the server
 * hands to clients who join without the mission. Setting a link rewrites the
 * server's copy of the .mn3 (the original is kept once, restorable); the
 * server picks it up the next time it loads the mission.
 */
export function MissionUrlEditor({ profileId, mission, onUpdated }: MissionUrlEditorProps) {
  const urls = mission.urls ?? [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Different mission picked: close the editor and clear messages.
  useEffect(() => {
    setEditing(false);
    setError(null);
    setNotice(null);
  }, [mission.file]);

  const base = `/api/game-files/missions/${encodeURIComponent(mission.file)}/download-url`;

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(base, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url: draft.trim(), profileId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to set the link");
        return;
      }
      onUpdated(data.info);
      setEditing(false);
      const warn = (data.warnings as string[] | undefined)?.join(" ");
      setNotice(
        `${data.backupCreated ? "Original saved as a backup. " : ""}Takes effect the next time the server loads this mission.${warn ? ` ${warn}` : ""}`,
      );
    } catch {
      setError("Failed to set the link");
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${base}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ profileId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to restore the original");
        return;
      }
      onUpdated(data.info);
      setNotice("Original mission file restored.");
    } catch {
      setError("Failed to restore the original");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-1 border-t border-border/60 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground">
          Download link{urls.length > 1 ? "s" : ""}
          {mission.urlBackup && <span className="ml-1 text-amber-400">(set by Pyrodeck)</span>}
        </span>
        {!editing && (
          <div className="flex gap-2">
            <button
              onClick={() => {
                setDraft(urls[0] ?? "");
                setEditing(true);
                setNotice(null);
              }}
              disabled={busy}
              className="text-[10px] text-primary hover:underline disabled:opacity-50"
            >
              {urls.length > 0 ? "Change" : "Set link"}
            </button>
            {mission.urlBackup && (
              <button
                onClick={restore}
                disabled={busy}
                className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Restore original
              </button>
            )}
          </div>
        )}
      </div>

      {!editing &&
        (urls.length > 0 ? (
          <ul className="space-y-0.5">
            {urls.map((u) => (
              <li key={u} className="text-[10px] font-mono text-foreground/70 break-all">
                {u}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[10px] text-muted-foreground italic">
            None. Players who lack this mission cannot download it from the server.
          </p>
        ))}

      {editing && (
        <div className="space-y-1">
          <input
            type="url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={URL_MAX}
            placeholder="https://example.org/missions/mymission.zip"
            className="w-full px-2 py-1 bg-input border border-border rounded text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => e.key === "Enter" && draft.trim() && save()}
            autoFocus
          />
          <p className="text-[10px] text-muted-foreground">
            One http(s) link to a .zip holding the mission or to the .mn3 itself, at most {URL_MAX} characters.
            Replaces {urls.length > 1 ? `all ${urls.length} links` : "the link"} in the server's copy of the
            mission; the original file is kept and can be restored.
          </p>
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={busy || !draft.trim()}
              className="px-2 py-0.5 bg-primary hover:bg-primary/80 disabled:bg-muted disabled:text-muted-foreground text-white text-[10px] font-score tracking-wide rounded"
            >
              {busy ? "Saving..." : "Save link"}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={busy}
              className="px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-[10px] text-red-400">{error}</p>}
      {notice && <p className="text-[10px] text-emerald-400">{notice}</p>}
    </div>
  );
}
