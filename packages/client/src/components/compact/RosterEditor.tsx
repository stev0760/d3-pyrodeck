import { useState, useEffect, useCallback } from "react";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

// ---------------------------------------------------------------------------
// Types (mirror the server's BotRosterData in launcher/botRoster.ts)
// ---------------------------------------------------------------------------

interface BotEntry {
  name: string;
  ship?: string;        // pyro | phoenix | magnum | blackpyro
  difficulty?: string;  // trainee | rookie | hotshot | ace | insane
  team?: number;        // 1-indexed (1–4), undefined = auto-balance
}

interface BotRosterData {
  /** Bots that join when the server starts (BotCount). */
  botCount: number;
  defaultDifficulty?: string;
  /** BotTargetPlayers; 0 = population manager off; undefined = not in the file. */
  targetPlayers?: number;
  /** BotReservedSlots; seats kept free for humans; undefined = not in the file (the engine uses 1). */
  reservedSlots?: number;
  /** Every entry in the file; those above botCount are the population manager's pool. */
  bots: BotEntry[];
}

interface RosterResponse extends BotRosterData {
  filename?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BOTS = 16; // engine hard cap (BotLoadRosterFile clamps to MAX_BOTS)

const SHIP_OPTIONS: { value: string; label: string }[] = [
  { value: "pyro", label: "Pyro-GL" },
  { value: "phoenix", label: "Phoenix" },
  { value: "magnum", label: "Magnum-AHT" },
  { value: "blackpyro", label: "Black Pyro" },
];

const DIFFICULTY_OPTIONS: { value: string; label: string }[] = [
  { value: "trainee", label: "Trainee" },
  { value: "rookie", label: "Rookie" },
  { value: "hotshot", label: "Hotshot" },
  { value: "ace", label: "Ace" },
  { value: "insane", label: "Insane" },
];

const TEXT_INPUT =
  "min-w-0 px-2 py-1 bg-background border border-border rounded text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring";
const SELECT =
  "px-2 py-1 bg-muted border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring";
const LINK_BUTTON = "text-[11px] text-muted-foreground hover:text-foreground/80 disabled:opacity-50";

// ---------------------------------------------------------------------------
// Helper sub-components
// ---------------------------------------------------------------------------

function Select({
  value,
  onChange,
  options,
  placeholder,
  className = "",
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  className?: string;
  title?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${SELECT} ${className}`}
      title={title}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  hint: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5 min-w-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isNaN(n)) return;
          onChange(Math.max(min, max !== undefined ? Math.min(max, n) : n));
        }}
        className={`${TEXT_INPUT} w-full`}
      />
      <span className="text-[10px] text-muted-foreground/80 leading-snug">{hint}</span>
    </label>
  );
}

const TEAM_OPTIONS = [
  { value: "1", label: "Team 1" },
  { value: "2", label: "Team 2" },
  { value: "3", label: "Team 3" },
  { value: "4", label: "Team 4" },
];

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error ?? `${fallback} (HTTP ${res.status})`;
}

// ---------------------------------------------------------------------------
// RosterEditor
// ---------------------------------------------------------------------------

interface RosterEditorProps {
  profileId: string;
  onSaved?: () => void;
}

/**
 * The structured editor for a profile's bots.cfg. Lays itself out from the
 * width of its container (`@container`): one row per bot beside the file nav
 * on a desktop, stacked rows on a phone.
 *
 * Saves edit the file in place on the server (comments and unknown keys
 * survive), the previous version is kept as a backup, and the Matcen sample
 * roster is one confirmation away.
 */
export function RosterEditor({ profileId, onSaved }: RosterEditorProps) {
  const [roster, setRoster] = useState<BotRosterData | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [maxPlayers, setMaxPlayers] = useState<number>(8);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backupExists, setBackupExists] = useState(false);
  const [confirm, setConfirm] = useState<"reset" | "restore" | null>(null);

  // New bot form state
  const [newName, setNewName] = useState("");
  const [newShip, setNewShip] = useState("pyro");
  const [newDifficulty, setNewDifficulty] = useState("");
  const [newTeam, setNewTeam] = useState<string>("");

  const api = `/api/profiles/${encodeURIComponent(profileId)}`;

  const refreshBackup = useCallback(
    async (file: string | null) => {
      if (!file) {
        setBackupExists(false);
        return;
      }
      try {
        const res = await fetch(`${api}/files/${encodeURIComponent(file)}/backup`, { credentials: "include" });
        const body = res.ok ? ((await res.json()) as { exists?: boolean }) : null;
        setBackupExists(Boolean(body?.exists));
      } catch {
        setBackupExists(false);
      }
    },
    [api],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rosterRes, configRes] = await Promise.all([
        fetch(`${api}/bot-roster`, { credentials: "include" }),
        fetch(`${api}/structured-config`, { credentials: "include" }),
      ]);

      if (!rosterRes.ok) {
        setError(await readError(rosterRes, "Failed to load the bot roster"));
        setRoster(null);
        setFilename(null);
      } else {
        const data = (await rosterRes.json()) as RosterResponse;
        const { filename: file, ...rest } = data;
        setRoster(rest);
        setFilename(file ?? null);
        void refreshBackup(file ?? null);
      }

      if (configRes.ok) {
        const cfg = (await configRes.json()) as { maxPlayers?: number };
        setMaxPlayers(cfg.maxPlayers ?? 8);
      }
    } catch {
      setError("Network error loading the bot roster");
    }
    setLoading(false);
    setDirty(false);
  }, [api, refreshBackup]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyResponse = (data: RosterResponse) => {
    const { filename: file, ...rest } = data;
    setRoster(rest);
    if (file) setFilename(file);
    setDirty(false);
    void refreshBackup(file ?? filename);
  };

  const save = async () => {
    if (!roster) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${api}/bot-roster`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(roster),
      });
      if (res.ok) {
        const body = (await res.json()) as { roster?: RosterResponse; filename?: string };
        if (body.roster) applyResponse({ ...body.roster, filename: body.filename });
        setSaved(true);
        setDirty(false);
        onSaved?.();
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError(await readError(res, "Save failed"));
      }
    } catch {
      setError("Save failed: network error");
    }
    setBusy(false);
  };

  const resetToSample = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${api}/bot-roster/reset`, { method: "POST", credentials: "include" });
      if (res.ok) {
        const body = (await res.json()) as { roster?: RosterResponse; filename?: string };
        if (body.roster) applyResponse({ ...body.roster, filename: body.filename });
        else await load();
        onSaved?.();
      } else {
        setError(await readError(res, "Reset failed"));
      }
    } catch {
      setError("Reset failed: network error");
    }
    setBusy(false);
    setConfirm(null);
  };

  const restoreBackup = async () => {
    if (!filename) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${api}/files/${encodeURIComponent(filename)}/restore`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        await load();
        onSaved?.();
      } else {
        setError(await readError(res, "Restore failed"));
      }
    } catch {
      setError("Restore failed: network error");
    }
    setBusy(false);
    setConfirm(null);
  };

  const updateRoster = (updates: Partial<BotRosterData>) => {
    setRoster((prev) => (prev ? { ...prev, ...updates } : prev));
    setDirty(true);
    setSaved(false);
  };

  const updateBot = (index: number, updates: Partial<BotEntry>) => {
    if (!roster) return;
    const bots = roster.bots.map((b, i) => (i === index ? { ...b, ...updates } : b));
    updateRoster({ bots });
  };

  const removeBot = (index: number) => {
    if (!roster) return;
    const bots = roster.bots.filter((_, i) => i !== index);
    updateRoster({ bots, botCount: Math.min(roster.botCount, Math.max(bots.length, 0)) });
  };

  const moveBot = (index: number, direction: -1 | 1) => {
    if (!roster) return;
    const bots = [...roster.bots];
    const target = index + direction;
    if (target < 0 || target >= bots.length) return;
    [bots[index], bots[target]] = [bots[target], bots[index]];
    updateRoster({ bots });
  };

  const addBot = () => {
    if (!roster || !newName.trim()) return;
    const entry: BotEntry = {
      name: newName.trim(),
      ship: newShip || "pyro",
      difficulty: newDifficulty || undefined,
      team: newTeam ? parseInt(newTeam, 10) : undefined,
    };
    const bots = [...roster.bots, entry];
    // A roster that started every bot keeps doing so as it grows.
    const startedAll = roster.botCount >= roster.bots.length;
    updateRoster({ bots, botCount: startedAll ? bots.length : roster.botCount });
    setNewName("");
    setNewDifficulty("");
    setNewTeam("");
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading bot roster...</p>
      </div>
    );
  }

  if (error && !roster) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-sm text-destructive break-words">{error}</p>
        <div className="flex gap-3">
          <button onClick={() => void load()} className="text-xs text-primary hover:underline" disabled={busy}>
            Retry
          </button>
          <button onClick={() => void resetToSample()} className="text-xs text-primary hover:underline" disabled={busy}>
            Create the sample roster
          </button>
        </div>
      </div>
    );
  }

  if (!roster) return null;

  const botCount = roster.botCount;
  const rosterSize = roster.bots.length;
  const target = roster.targetPlayers ?? 0;
  const reserve = roster.reservedSlots ?? 1;
  const seatsForBots = Math.max(0, maxPlayers - 1 - reserve);
  const rosterFull = rosterSize >= MAX_BOTS;
  const warnings: string[] = [];
  if (botCount > seatsForBots) {
    warnings.push(
      `Only ${seatsForBots} can join at start: MaxPlayers ${maxPlayers} keeps ${reserve} seat${reserve === 1 ? "" : "s"} free for players.`,
    );
  }
  if (target > 0 && maxPlayers < target + reserve + 1) {
    warnings.push(
      `MaxPlayers ${maxPlayers} is too small for a target of ${target} with ${reserve} reserved seat${reserve === 1 ? "" : "s"}: set it to at least ${target + reserve + 1} in Server Config.`,
    );
  }
  const unnamed = botCount - rosterSize;

  return (
    <div className="@container flex-1 flex flex-col min-h-0 overflow-y-auto">
      {/* Header: counts + save */}
      <div className="flex items-center justify-between gap-2 mb-3 shrink-0">
        <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
          <span className="text-sm font-medium text-foreground">
            {rosterSize} in roster
          </span>
          <span className="text-xs text-muted-foreground">
            · {botCount} start at launch · {maxPlayers} max players
          </span>
        </div>
        <button
          onClick={() => void save()}
          disabled={!dirty || busy}
          className="px-3 py-1 bg-primary hover:bg-primary/80 disabled:bg-muted disabled:text-muted-foreground text-white text-xs font-medium rounded transition-colors shrink-0"
        >
          {busy ? "Saving..." : saved ? "Saved!" : "Save"}
        </button>
      </div>

      {/* Population */}
      <div className="mb-4 p-3 bg-muted/20 border border-border/40 rounded space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-xs font-score tracking-wide text-muted-foreground">Population</span>
          <span className={`text-[11px] ${target > 0 ? "text-primary" : "text-muted-foreground"}`}>
            {target > 0 ? `manager on, keeps ${target} players` : "manager off"}
          </span>
        </div>
        <div className="grid grid-cols-1 @md:grid-cols-3 gap-2">
          <NumberField
            label="Bots at start"
            value={botCount}
            min={0}
            max={MAX_BOTS}
            hint="Join when the server launches."
            onChange={(v) => updateRoster({ botCount: v })}
          />
          <NumberField
            label="Target players"
            value={target}
            min={0}
            hint="Humans plus bots kept in the game. 0 turns the manager off."
            onChange={(v) => updateRoster({ targetPlayers: v })}
          />
          <NumberField
            label="Reserved seats"
            value={reserve}
            min={1}
            hint="Always left free for humans."
            onChange={(v) => updateRoster({ reservedSlots: v })}
          />
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug">
          The roster beyond the bots at start is the pool the population manager draws from. MaxPlayers must be at
          least target + reserved seats + 1 (the server's own seat).
        </p>
        {warnings.map((w) => (
          <p key={w} className="text-[11px] text-amber-400 leading-snug">
            {w}
          </p>
        ))}
        {unnamed > 0 && (
          <p className="text-[11px] text-muted-foreground leading-snug">
            {unnamed} of the starting bots {unnamed === 1 ? "gets a" : "get"} built-in name{unnamed === 1 ? "" : "s"}: the roster
            has {rosterSize}.
          </p>
        )}
      </div>

      {/* Default difficulty */}
      <div className="flex items-center gap-2 mb-4 shrink-0 flex-wrap">
        <label className="text-xs text-muted-foreground w-28 shrink-0">
          Default difficulty
        </label>
        <Select
          value={roster.defaultDifficulty ?? "hotshot"}
          onChange={(v) => updateRoster({ defaultDifficulty: v })}
          options={DIFFICULTY_OPTIONS}
        />
        <span className="text-[10px] text-muted-foreground">
          Applied to bots without a per-bot override
        </span>
      </div>

      {/* Bot list */}
      {rosterSize > 0 ? (
        <div className="space-y-1 mb-4 shrink-0">
          {roster.bots.map((bot, i) => (
            <div
              key={i}
              className="flex flex-col @md:flex-row @md:items-center gap-2 px-2 py-1.5 bg-muted/40 rounded border border-border/40"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {/* Reorder buttons */}
                <div className="flex flex-col">
                  <button
                    onClick={() => moveBot(i, -1)}
                    disabled={i === 0}
                    className="text-muted-foreground hover:text-foreground/80 disabled:opacity-30 text-[10px] leading-none"
                    title="Move up"
                    aria-label="Move up"
                  >
                    ▲
                  </button>
                  <button
                    onClick={() => moveBot(i, 1)}
                    disabled={i === rosterSize - 1}
                    className="text-muted-foreground hover:text-foreground/80 disabled:opacity-30 text-[10px] leading-none"
                    title="Move down"
                    aria-label="Move down"
                  >
                    ▼
                  </button>
                </div>

                {/* Slot number */}
                <span className="text-[10px] text-muted-foreground w-4 text-right shrink-0">
                  {i + 1}
                </span>

                {/* Name */}
                <input
                  type="text"
                  value={bot.name}
                  onChange={(e) => updateBot(i, { name: e.target.value })}
                  maxLength={19}
                  className={`${TEXT_INPUT} flex-1`}
                  placeholder="Bot name"
                  aria-label={`Bot ${i + 1} name`}
                />

                {i >= botCount && (
                  <span
                    className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border/60 rounded px-1 shrink-0"
                    title="Not started at launch; the population manager adds it when players leave"
                  >
                    pool
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 @md:shrink-0">
                <Select
                  value={bot.ship ?? "pyro"}
                  onChange={(v) => updateBot(i, { ship: v })}
                  options={SHIP_OPTIONS}
                  className="w-28 shrink-0"
                  title="Ship"
                />
                <Select
                  value={bot.difficulty ?? ""}
                  onChange={(v) => updateBot(i, { difficulty: v || undefined })}
                  options={DIFFICULTY_OPTIONS}
                  placeholder="Default"
                  className="w-24 shrink-0"
                  title="Difficulty"
                />
                <Select
                  value={bot.team !== undefined ? String(bot.team) : ""}
                  onChange={(v) => updateBot(i, { team: v ? parseInt(v, 10) : undefined })}
                  options={TEAM_OPTIONS}
                  placeholder="Auto"
                  className="w-20 shrink-0"
                  title="Team assignment (team modes only)"
                />
                <button
                  onClick={() => removeBot(i)}
                  className="text-muted-foreground hover:text-destructive transition-colors text-xs shrink-0 px-1 ml-auto @md:ml-0"
                  title="Remove bot"
                  aria-label={`Remove ${bot.name || `bot ${i + 1}`}`}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-4 px-3 py-4 bg-muted/20 border border-dashed border-border rounded text-center shrink-0">
          <p className="text-xs text-muted-foreground">
            No bots in the roster. Add one below, or reset to the sample roster.
          </p>
        </div>
      )}

      {/* Add bot form */}
      {!rosterFull ? (
        <div className="flex flex-col @md:flex-row @md:items-center gap-2 p-2 bg-muted/20 border border-border/40 rounded shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-xs text-muted-foreground w-16 shrink-0">Add bot</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={19}
              placeholder="Name"
              className={`${TEXT_INPUT} flex-1`}
              aria-label="New bot name"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) addBot();
              }}
            />
          </div>
          <div className="flex items-center gap-2 @md:shrink-0">
            <Select value={newShip} onChange={setNewShip} options={SHIP_OPTIONS} className="w-28 shrink-0" title="Ship" />
            <Select
              value={newDifficulty}
              onChange={setNewDifficulty}
              options={DIFFICULTY_OPTIONS}
              placeholder="Default"
              className="w-24 shrink-0"
              title="Difficulty"
            />
            <Select
              value={newTeam}
              onChange={setNewTeam}
              options={TEAM_OPTIONS}
              placeholder="Auto"
              className="w-20 shrink-0"
              title="Team assignment (team modes only)"
            />
            <button
              onClick={addBot}
              disabled={!newName.trim()}
              className="px-3 py-1 bg-primary hover:bg-primary/80 disabled:bg-muted disabled:text-muted-foreground text-white text-xs font-medium rounded transition-colors shrink-0 ml-auto @md:ml-0"
            >
              Add
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic shrink-0">
          Roster full: the engine holds {MAX_BOTS} entries. Remove one to add another.
        </p>
      )}

      {/* Danger-ish actions and errors */}
      <div className="flex flex-wrap items-center gap-3 mt-3 shrink-0">
        <button onClick={() => setConfirm("reset")} disabled={busy} className={LINK_BUTTON}>
          Reset to the sample roster…
        </button>
        {backupExists && (
          <button onClick={() => setConfirm("restore")} disabled={busy} className={LINK_BUTTON}>
            Restore previous version…
          </button>
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs text-destructive bg-destructive/10 border border-destructive/40 rounded-md px-2 py-1.5 break-words shrink-0">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirm === "reset"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Reset to the sample roster?"
        description={`${filename ?? "The roster"} becomes the Matcen sample: Reaper, Phantom, Viper and Shadow, four starting at launch, the population manager keeping 12 players with one seat free. The current file is kept as the previous version.`}
        confirmLabel="Reset"
        destructive
        busy={busy}
        onConfirm={resetToSample}
      />
      <ConfirmDialog
        open={confirm === "restore"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Restore the previous version?"
        description={`${filename ?? "The roster"} goes back to the version saved before the last change. The current content becomes the previous version, so this can be undone the same way.`}
        confirmLabel="Restore"
        busy={busy}
        onConfirm={restoreBackup}
      />
    </div>
  );
}
