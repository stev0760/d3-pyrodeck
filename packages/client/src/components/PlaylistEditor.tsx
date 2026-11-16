import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import type {
  Playlist,
  PlaylistEntry,
  PlaylistMode,
  PlaylistStatus,
  PlaylistVoting,
} from "../hooks/usePlaylist.ts";
import { DEFAULT_HOLD_SECONDS, MAX_HOLD_SECONDS } from "../hooks/usePlaylist.ts";
import { PlaylistDownloads } from "./PlaylistDownloads.tsx";
import { launchRows, type ServerRow } from "@/lib/servers";
import {
  missionSupports,
  scriptModeLabel,
  type MissionDetails,
} from "@/lib/missionCompat";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlaylistEditorProps {
  playlists: Playlist[];
  status: PlaylistStatus;
  loading: boolean;
  error: string | null;
  onCreatePlaylist: (name: string, mode: PlaylistMode, entries: Omit<PlaylistEntry, "id">[]) => Promise<Playlist | null>;
  onUpdatePlaylist: (id: string, updates: Partial<Omit<Playlist, "id" | "createdAt">>) => Promise<Playlist | null>;
  onDeletePlaylist: (id: string) => Promise<boolean>;
  onActivate: (id: string) => void;
  onDeactivate: () => void;
  /** Profile whose Scriptname entries are compat-checked against (the selected server's). */
  selectedProfileId?: string;
  /** Every server, to show where each playlist is active (the library is shared; each server has one active). */
  servers?: readonly ServerRow[];
  /** The selected server: Activate and Deactivate act on it. */
  selectedServerId?: string | null;
  serverName?: string | null;
}

/** The servers a playlist is active on, by name. */
function activeOn(servers: readonly ServerRow[], playlistId: string): ServerRow[] {
  return launchRows(servers).filter((s) => s.playlist?.id === playlistId);
}

function ActiveOnBadges({ rows, selectedServerId }: { rows: ServerRow[]; selectedServerId?: string | null }) {
  if (rows.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {rows.map((r) => (
        <span
          key={r.id}
          className={`text-[10px] rounded px-1.5 py-0.5 font-medium border ${
            r.id === selectedServerId
              ? "bg-green-500/20 text-green-400 border-green-500/30"
              : "bg-muted/40 text-muted-foreground border-border"
          }`}
        >
          Active on {r.name}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ModeLabel({ mode }: { mode: PlaylistMode }) {
  const labels: Record<PlaylistMode, string> = {
    sequential: "Sequential",
    shuffle: "Shuffle",
    weighted: "Weighted",
  };
  return <span>{labels[mode]}</span>;
}

// ---------------------------------------------------------------------------
// Entry editor row
// ---------------------------------------------------------------------------

function EntryRow({
  entry,
  index,
  total,
  missionListId,
  warning,
  onUpdate,
  onRemove,
  onMove,
}: {
  entry: PlaylistEntry;
  index: number;
  total: number;
  missionListId: string;
  warning?: string | null;
  onUpdate: (updates: Partial<PlaylistEntry>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1.5 bg-muted/40 rounded border ${
        warning ? "border-red-500/40" : "border-border/40"
      }`}
    >
      {/* Reorder */}
      <div className="flex flex-col shrink-0">
        <button
          onClick={() => onMove(-1)}
          disabled={index === 0}
          className="text-muted-foreground hover:text-foreground/80 disabled:opacity-30 text-[10px] leading-none"
          title="Move up"
        >
          ▲
        </button>
        <button
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          className="text-muted-foreground hover:text-foreground/80 disabled:opacity-30 text-[10px] leading-none"
          title="Move down"
        >
          ▼
        </button>
      </div>

      <span className="text-[10px] text-muted-foreground w-4 text-right shrink-0">{index + 1}</span>

      {/* Label */}
      <input
        type="text"
        value={entry.label}
        onChange={(e) => onUpdate({ label: e.target.value })}
        placeholder="Display name"
        className="w-32 px-2 py-1 bg-background border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />

      {/* Mission file */}
      <input
        type="text"
        value={entry.missionName}
        onChange={(e) => onUpdate({ missionName: e.target.value })}
        placeholder="mission.mn3"
        list={missionListId}
        className="flex-1 min-w-0 px-2 py-1 bg-background border border-border rounded text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
      />

      {warning && (
        <span className="text-red-400 text-xs shrink-0" title={warning}>
          ⚠
        </span>
      )}

      {/* Starting level */}
      <input
        type="number"
        value={entry.startingLevel ?? ""}
        onChange={(e) =>
          onUpdate({ startingLevel: e.target.value ? parseInt(e.target.value, 10) : undefined })
        }
        placeholder="Lvl"
        min={1}
        title="Starting level (optional)"
        className="w-12 px-1.5 py-1 bg-background border border-border rounded text-xs text-center text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />

      <button
        onClick={onRemove}
        className="text-muted-foreground hover:text-destructive transition-colors text-xs shrink-0 px-1"
        title="Remove"
      >
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single playlist editor
// ---------------------------------------------------------------------------

function PlaylistDetail({
  playlist,
  isActive,
  onSave,
  onDelete,
  onActivate,
  onDeactivate,
  onBack,
  selectedProfileId,
  hookError,
  downloads,
  activeRows,
  selectedServerId,
  serverName,
  otherActiveName,
}: {
  playlist: Playlist;
  isActive: boolean;
  onSave: (updates: Partial<Omit<Playlist, "id" | "createdAt">>) => Promise<void>;
  onDelete: () => Promise<void>;
  onActivate: () => void;
  onDeactivate: () => void;
  onBack: () => void;
  selectedProfileId?: string;
  /** Hook-level error (e.g. activation rejected) — shown above the form. */
  hookError?: string | null;
  /** While active: the result of pointing the missions at the mission host. */
  downloads?: PlaylistStatus["downloads"];
  /** The servers it is active on. */
  activeRows: ServerRow[];
  selectedServerId?: string | null;
  serverName?: string | null;
  /** Another playlist active on the selected server, which activating this one replaces. */
  otherActiveName?: string | null;
}) {
  const [name, setName] = useState(playlist.name);
  const [mode, setMode] = useState<PlaylistMode>(playlist.mode);
  const [entries, setEntries] = useState<PlaylistEntry[]>(playlist.entries);
  const [voting, setVoting] = useState<PlaylistVoting>(playlist.voting);
  const [holdSeconds, setHoldSeconds] = useState<number>(playlist.holdSeconds ?? DEFAULT_HOLD_SECONDS);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // New entry form
  const [newLabel, setNewLabel] = useState("");
  const [newMission, setNewMission] = useState("");
  const [newLevel, setNewLevel] = useState("");

  // Available mission files from gamePath/missions/ (+ mode-compat details)
  const [missions, setMissions] = useState<string[]>([]);
  const [missionsError, setMissionsError] = useState<string | null>(null);
  const [missionDetails, setMissionDetails] = useState<Record<string, MissionDetails>>({});
  // Scriptname of the selected profile — what rotation will run these missions under
  const [profileScript, setProfileScript] = useState<string>("");
  const missionListId = `playlist-missions-${playlist.id}`;

  useEffect(() => {
    let cancelled = false;
    const profileQs = selectedProfileId
      ? `profileId=${encodeURIComponent(selectedProfileId)}&`
      : "";
    fetch(`/api/game-files/missions?${profileQs}details=1`, { credentials: "include" })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (r.ok && Array.isArray(data.missions)) {
          setMissions(data.missions);
          const map: Record<string, MissionDetails> = {};
          for (const d of (data.details ?? []) as MissionDetails[]) map[d.file] = d;
          setMissionDetails(map);
          setMissionsError(null);
        } else {
          setMissionsError(data.error ?? "Could not list missions");
        }
      })
      .catch(() => { if (!cancelled) setMissionsError("Could not list missions"); });
    if (selectedProfileId) {
      fetch(`/api/profiles/${encodeURIComponent(selectedProfileId)}/structured-config`, {
        credentials: "include",
      })
        .then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!cancelled && r.ok && typeof data.scriptName === "string") {
            setProfileScript(data.scriptName);
          }
        })
        .catch(() => { /* compat check degrades to "no warnings" */ });
    }
    return () => { cancelled = true; };
  }, [selectedProfileId]);

  const entryWarning = (missionName: string): string | null => {
    if (!profileScript) return null;
    if (!missions.includes(missionName)) {
      return missions.length > 0 ? "Mission file not found in missions/" : null;
    }
    return missionSupports(missionDetails[missionName], profileScript)
      ? null
      : `No ${scriptModeLabel(profileScript)} support — rotation will skip this entry`;
  };

  const incompatibleCount = entries.filter((e) => entryWarning(e.missionName) !== null).length;

  const mark = () => { setDirty(true); setSaved(false); };

  const updateEntry = (index: number, updates: Partial<PlaylistEntry>) => {
    setEntries((prev) => prev.map((e, i) => i === index ? { ...e, ...updates } : e));
    mark();
  };

  const removeEntry = (index: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== index));
    mark();
  };

  const moveEntry = (index: number, dir: -1 | 1) => {
    const arr = [...entries];
    const target = index + dir;
    if (target < 0 || target >= arr.length) return;
    [arr[index], arr[target]] = [arr[target], arr[index]];
    setEntries(arr);
    mark();
  };

  const addEntry = () => {
    if (!newLabel.trim() || !newMission.trim()) return;
    const entry: PlaylistEntry = {
      id: crypto.randomUUID(),
      label: newLabel.trim(),
      missionName: newMission.trim(),
      startingLevel: newLevel ? parseInt(newLevel, 10) : undefined,
    };
    setEntries((prev) => [...prev, entry]);
    setNewLabel("");
    setNewMission("");
    setNewLevel("");
    mark();
  };

  const save = async () => {
    setSaving(true);
    await onSave({ name, mode, entries, voting, holdSeconds });
    setSaving(false);
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            ← Back
          </button>
          <span className="text-muted-foreground text-xs">/</span>
          <span className="text-sm font-medium text-foreground">{playlist.name}</span>
          <ActiveOnBadges rows={activeRows} selectedServerId={selectedServerId} />
        </div>
        <div className="flex items-center gap-1.5">
          {isActive ? (
            <Button variant="secondary" size="xs" onClick={onDeactivate}>
              {serverName ? `Deactivate on ${serverName}` : "Deactivate"}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="xs"
              onClick={onActivate}
              disabled={entries.length === 0 || !selectedServerId}
              title={
                entries.length === 0
                  ? "Add missions first"
                  : otherActiveName
                    ? `Replaces "${otherActiveName}" on ${serverName ?? "this server"}`
                    : undefined
              }
            >
              {serverName ? `Activate on ${serverName}` : "Activate"}
            </Button>
          )}
          <Button
            size="xs"
            onClick={save}
            disabled={!dirty || saving}
          >
            {saving ? "Saving..." : saved ? "Saved!" : "Save"}
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
        {hookError && (
          <p className="text-xs text-destructive">{hookError}</p>
        )}

        {/* Name + mode */}
        <div className="grid @md:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold block mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); mark(); }}
              className="w-full px-2 py-1.5 bg-muted border border-border rounded text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold block mb-1">
              Mode
            </label>
            <select
              value={mode}
              onChange={(e) => { setMode(e.target.value as PlaylistMode); mark(); }}
              className="w-full px-2 py-1.5 bg-muted border border-border rounded text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="sequential">Sequential — in order, looping</option>
              <option value="shuffle">Shuffle — randomized, re-shuffle on loop</option>
              <option value="weighted">Weighted — random draw by weight</option>
            </select>
          </div>
        </div>

        {/* Mission list */}
        <div>
          <datalist id={missionListId}>
            {missions.map((m) => <option key={m} value={m} />)}
          </datalist>
          <div className="flex items-center justify-between mb-2">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
              Missions ({entries.length})
              {missions.length > 0 && (
                <span className="ml-2 normal-case font-normal text-muted-foreground">
                  · {missions.length} available
                </span>
              )}
            </label>
            <div className="text-[10px] text-muted-foreground">
              {missionsError ?? "Label | Mission file (.mn3) | Start level"}
            </div>
          </div>

          {entries.length === 0 ? (
            <div className="px-3 py-4 bg-muted/20 border border-dashed border-border rounded text-center">
              <p className="text-xs text-muted-foreground">No missions. Add one below.</p>
            </div>
          ) : (
            <div className="space-y-1 mb-2">
              {entries.map((entry, i) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  index={i}
                  total={entries.length}
                  missionListId={missionListId}
                  warning={entryWarning(entry.missionName)}
                  onUpdate={(updates) => updateEntry(i, updates)}
                  onRemove={() => removeEntry(i)}
                  onMove={(dir) => moveEntry(i, dir)}
                />
              ))}
            </div>
          )}

          {isActive && downloads && (
            <div className="mb-2">
              <PlaylistDownloads downloads={downloads} />
            </div>
          )}

          {incompatibleCount > 0 && (
            <p className="text-[10px] text-red-400 mb-2">
              {incompatibleCount} entr{incompatibleCount === 1 ? "y is" : "ies are"} incompatible
              with the selected profile's game type ({scriptModeLabel(profileScript)}) — activation
              will be rejected until they are removed or the game type changes. Hover ⚠ for details.
            </p>
          )}

          {/* Add entry */}
          <div className="flex items-center gap-2 p-2 bg-muted/20 border border-border/40 rounded">
            <span className="text-xs text-muted-foreground shrink-0">Add</span>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Display name"
              className="w-32 px-2 py-1 bg-background border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => { if (e.key === "Enter") addEntry(); }}
            />
            <input
              type="text"
              value={newMission}
              onChange={(e) => setNewMission(e.target.value)}
              placeholder="mission.mn3"
              list={missionListId}
              className="flex-1 min-w-0 px-2 py-1 bg-background border border-border rounded text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => { if (e.key === "Enter") addEntry(); }}
            />
            <input
              type="number"
              value={newLevel}
              onChange={(e) => setNewLevel(e.target.value)}
              placeholder="Lvl"
              min={1}
              title="Starting level (optional)"
              className="w-12 px-1.5 py-1 bg-background border border-border rounded text-xs text-center text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <Button
              size="xs"
              onClick={addEntry}
              disabled={!newLabel.trim() || !newMission.trim()}
            >
              Add
            </Button>
          </div>
        </div>

        {/* The hold before a restart into the next mission */}
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold block mb-2">
            Mission Change
          </label>
          <div className="flex items-center gap-2 p-2 bg-muted/20 border border-border/40 rounded">
            <label htmlFor={`playlist-hold-${playlist.id}`} className="text-[10px] text-muted-foreground">
              Hold before the restart (sec)
            </label>
            <input
              id={`playlist-hold-${playlist.id}`}
              type="number"
              value={holdSeconds}
              min={0}
              max={MAX_HOLD_SECONDS}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setHoldSeconds(Number.isFinite(n) ? Math.min(MAX_HOLD_SECONDS, Math.max(0, n)) : 0);
                mark();
              }}
              className="w-20 px-2 py-1 bg-background border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            A new mission needs a server restart. When a mission ends, the players are held in place with a countdown
            in chat, so they see the scores and can quit before the server goes; anyone still on is told the server
            has quit. 0 restarts at once. Skipped when no human is on.
          </p>
        </div>

        {/* Voting settings */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
              Mission Voting
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={voting.enabled}
                onChange={(e) => { setVoting((v) => ({ ...v, enabled: e.target.checked })); mark(); }}
                className="rounded"
              />
              <span className="text-xs text-foreground">Enabled</span>
            </label>
          </div>

          {voting.enabled && (
            <div className="grid @md:grid-cols-3 gap-2 p-2 bg-muted/20 border border-border/40 rounded">
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">
                  Announce before end (sec)
                </label>
                <input
                  type="number"
                  value={voting.preAnnounceSeconds}
                  min={30}
                  max={600}
                  onChange={(e) => { setVoting((v) => ({ ...v, preAnnounceSeconds: parseInt(e.target.value, 10) || 120 })); mark(); }}
                  className="w-full px-2 py-1 bg-background border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">
                  Vote window (sec)
                </label>
                <input
                  type="number"
                  value={voting.voteOpenSeconds}
                  min={15}
                  max={300}
                  onChange={(e) => { setVoting((v) => ({ ...v, voteOpenSeconds: parseInt(e.target.value, 10) || 60 })); mark(); }}
                  className="w-full px-2 py-1 bg-background border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">
                  Options offered (1–9)
                </label>
                <input
                  type="number"
                  value={voting.optionCount}
                  min={1}
                  max={9}
                  onChange={(e) => { setVoting((v) => ({ ...v, optionCount: Math.min(9, Math.max(1, parseInt(e.target.value, 10) || 3)) })); mark(); }}
                  className="w-full px-2 py-1 bg-background border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <div className="col-span-3 text-[10px] text-muted-foreground">
                Voting only triggers when the server has a time limit and no kill goal.
                Players vote by typing a single digit (1–{voting.optionCount}) in chat.
              </div>
            </div>
          )}
        </div>

        {/* Danger zone */}
        <div className="border-t border-border pt-3">
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-xs text-destructive hover:text-destructive/80 transition-colors"
            >
              Delete playlist
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-destructive">Are you sure?</span>
              <Button variant="destructive" size="xs" onClick={onDelete}>
                Delete
              </Button>
              <Button variant="secondary" size="xs" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playlist list view
// ---------------------------------------------------------------------------

export function PlaylistEditor({
  playlists,
  status,
  loading,
  error,
  onCreatePlaylist,
  onUpdatePlaylist,
  onDeletePlaylist,
  onActivate,
  onDeactivate,
  selectedProfileId,
  servers = [],
  selectedServerId,
  serverName,
}: PlaylistEditorProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMode, setNewMode] = useState<PlaylistMode>("sequential");

  const selected = playlists.find((p) => p.id === selectedId);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    const pl = await onCreatePlaylist(newName.trim(), newMode, []);
    if (pl) {
      setNewName("");
      setCreating(false);
      setSelectedId(pl.id);
    }
  }, [newName, newMode, onCreatePlaylist]);

  const handleSave = useCallback(async (id: string, updates: Partial<Omit<Playlist, "id" | "createdAt">>) => {
    await onUpdatePlaylist(id, updates);
  }, [onUpdatePlaylist]);

  const handleDelete = useCallback(async (id: string) => {
    const ok = await onDeletePlaylist(id);
    if (ok && selectedId === id) {
      setSelectedId(null);
    }
  }, [onDeletePlaylist, selectedId]);

  if (selected) {
    return (
      <PlaylistDetail
        playlist={selected}
        isActive={status.activePlaylistId === selected.id}
        onSave={(updates) => handleSave(selected.id, updates)}
        onDelete={() => handleDelete(selected.id)}
        onActivate={() => onActivate(selected.id)}
        onDeactivate={onDeactivate}
        onBack={() => setSelectedId(null)}
        selectedProfileId={selectedProfileId}
        hookError={error}
        downloads={status.activePlaylistId === selected.id ? status.downloads : null}
        activeRows={activeOn(servers, selected.id)}
        selectedServerId={selectedServerId}
        serverName={serverName}
        otherActiveName={
          status.activePlaylistId && status.activePlaylistId !== selected.id
            ? (playlists.find((p) => p.id === status.activePlaylistId)?.name ?? null)
            : null
        }
      />
    );
  }

  return (
    <div className="@container flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Playlists</h2>
          <p className="text-[10px] text-muted-foreground">
            Shared by all servers; each server rotates one. Activate and Deactivate act on{" "}
            {serverName ? <span className="text-foreground/80">{serverName}</span> : "the selected server"}.
          </p>
        </div>
        <Button size="xs" onClick={() => setCreating(true)} disabled={creating}>
          New Playlist
        </Button>
      </div>

      {error && (
        <p className="text-xs text-destructive mb-2">{error}</p>
      )}

      {/* New playlist form */}
      {creating && (
        <div className="flex items-center gap-2 mb-3 p-2 bg-muted/20 border border-border/40 rounded shrink-0">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Playlist name"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setCreating(false); }}
            className="flex-1 px-2 py-1 bg-background border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <select
            value={newMode}
            onChange={(e) => setNewMode(e.target.value as PlaylistMode)}
            className="px-2 py-1 bg-muted border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="sequential">Sequential</option>
            <option value="shuffle">Shuffle</option>
            <option value="weighted">Weighted</option>
          </select>
          <Button size="xs" onClick={handleCreate} disabled={!newName.trim()}>Create</Button>
          <button
            onClick={() => setCreating(false)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
          >
            ✕
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : playlists.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-2">
            <p className="text-sm text-muted-foreground">No playlists yet.</p>
            <p className="text-xs text-muted-foreground">
              Create a playlist to automatically cycle through missions on level end.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
          {playlists.map((pl) => {
            const isActive = status.activePlaylistId === pl.id;
            const rows = activeOn(servers, pl.id);
            return (
              <button
                key={pl.id}
                onClick={() => setSelectedId(pl.id)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded border text-left transition-colors hover:bg-muted/50 ${
                  isActive
                    ? "border-green-500/40 bg-green-500/10"
                    : "border-border bg-muted/20"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isActive && (
                    <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{pl.name}</p>
                    <p className="text-[10px] text-muted-foreground">
                      <ModeLabel mode={pl.mode} /> · {pl.entries.length} mission{pl.entries.length !== 1 ? "s" : ""}
                      {pl.voting.enabled && " · voting on"}
                    </p>
                    {rows.length > 0 && (
                      <div className="mt-0.5">
                        <ActiveOnBadges rows={rows} selectedServerId={selectedServerId} />
                      </div>
                    )}
                  </div>
                </div>
                <span className="text-muted-foreground text-xs shrink-0 ml-2">›</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
