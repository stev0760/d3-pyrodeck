import { useState, useEffect } from "react";
import type { MissionDetails } from "@/lib/missionCompat";
import { describeHostStatus, type MissionHostState, type MissionHostTestResult } from "@/lib/missionHost";

interface MissionUrlEditorProps {
  profileId: string;
  mission: MissionDetails;
  onUpdated: (info: MissionDetails) => void;
  /** Pyrodeck's mission host (null while loading or unavailable). */
  host: MissionHostState | null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Longest link a client can take: the download screen formats
 * "Downloading: <link>" into a 100-byte buffer (the server's MISSION_URL_MAX).
 */
const URL_MAX = 86;

/**
 * Download link for a mission: the URL line(s) inside the .mn3 that the server
 * hands to clients who join without the mission. Setting a link rewrites the
 * server's copy of the .mn3 (the original is kept once, restorable); the
 * server picks it up the next time it loads the mission.
 */
export function MissionUrlEditor({ profileId, mission, onUpdated, host }: MissionUrlEditorProps) {
  const urls = mission.urls ?? [];
  // A mission that ships with the game takes no link (every player has it); a backup from before can still be
  // restored.
  const fixed = mission.linkError ?? null;
  const hostOn = !!host?.settings.enabled && !fixed;
  const hosted = !!mission.hostUrl && urls.includes(mission.hostUrl);
  const [test, setTest] = useState<MissionHostTestResult | null>(null);
  const [testing, setTesting] = useState(false);
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
    setTest(null);
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

  const hostHere = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setTest(null);
    try {
      const res = await fetch(`${base}/host`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ profileId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to host this mission");
        return;
      }
      onUpdated(data.info);
      const warn = (data.warnings as string[] | undefined)?.join(" ");
      setNotice(
        `${data.backupCreated ? "Original saved as a backup. " : ""}Takes effect the next time the server loads this mission.${warn ? ` ${warn}` : ""}`,
      );
    } catch {
      setError("Failed to host this mission");
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    setError(null);
    try {
      const res = await fetch("/api/mission-host/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ file: mission.file }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Test failed");
        return;
      }
      setTest(data as MissionHostTestResult);
    } catch {
      setError("Test failed");
    } finally {
      setTesting(false);
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
            {!fixed && (
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
            )}
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

      {!editing && fixed && <p className="text-[10px] text-muted-foreground">No link needed: {fixed}</p>}

      {!editing &&
        (!fixed || mission.urlBackup) &&
        (urls.length > 0 ? (
          <ul className="space-y-0.5">
            {urls.map((u) => (
              <li key={u} className="text-[10px] font-mono text-foreground/70 break-all">
                {u}
              </li>
            ))}
          </ul>
        ) : (
          !fixed && (
            <p className="text-[10px] text-muted-foreground italic">
              None. Players who lack this mission cannot download it from the server.
            </p>
          )
        ))}

      {!editing && hostOn && (
        <div className="space-y-0.5">
          {mission.hostUrl ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[10px] ${hosted ? "text-emerald-400" : "text-muted-foreground"}`}>
                  {hosted ? "Hosted by Pyrodeck" : "Not hosted by Pyrodeck"}
                </span>
                <div className="flex gap-2">
                  {!hosted && (
                    <button
                      onClick={hostHere}
                      disabled={busy}
                      className="text-[10px] text-primary hover:underline disabled:opacity-50"
                    >
                      Host this mission
                    </button>
                  )}
                  <button
                    onClick={runTest}
                    disabled={testing || busy}
                    className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {testing ? "Testing..." : "Test"}
                  </button>
                </div>
              </div>
              {!hosted && (
                <p className="text-[10px] font-mono text-foreground/50 break-all">{mission.hostUrl}</p>
              )}
            </>
          ) : (
            <p className="text-[10px] text-muted-foreground">Cannot be hosted: {mission.hostError}</p>
          )}
          {host && host.status.enabled && !host.status.bound && (
            <p className="text-[10px] text-red-400 break-words">Mission host {describeHostStatus(host.status)}</p>
          )}
          {test && (
            <div className="text-[10px] space-y-0.5">
              {test.ok ? (
                <p className="text-emerald-400 break-words">
                  Reached from this machine: HTTP {test.status}, {formatBytes(test.bytes)}, identical to the file
                  on disk ({(test.elapsedMs / 1000).toFixed(1)} s).
                </p>
              ) : (
                <p className="text-red-400 break-words">Test failed: {test.error}</p>
              )}
              <p className="text-muted-foreground">
                This test runs from the Pyrodeck machine through the public URL. Whether players outside your
                network can reach it needs a check from outside the LAN (a phone off Wi-Fi will do). Inside the
                LAN, a failure can also mean your router does not loop back to its own public address.
              </p>
            </div>
          )}
        </div>
      )}

      {!editing && !hostOn && !fixed && host && (
        <p className="text-[10px] text-muted-foreground">
          Not hosted by Pyrodeck. To serve missions from this machine, turn on Mission Downloads in the Launch panel.
        </p>
      )}

      {editing && (
        <div className="space-y-1">
          <input
            type="url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={URL_MAX}
            placeholder="http://example.org/missions/mymission.zip"
            className="w-full px-2 py-1 bg-input border border-border rounded text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => e.key === "Enter" && draft.trim() && save()}
            autoFocus
          />
          <p className="text-[10px] text-muted-foreground">
            One http:// link to a .zip holding the mission or to the .mn3 itself, at most {URL_MAX} characters
            (https only reaches clients built with TLS).
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
