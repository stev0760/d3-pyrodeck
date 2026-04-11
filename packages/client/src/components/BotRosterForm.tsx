import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types (mirrors backend BotRosterData / BotEntry)
// ---------------------------------------------------------------------------

interface BotEntry {
  name: string;
  ship?: string;        // pyro | phoenix | magnum | blackpyro
  difficulty?: string;  // trainee | rookie | hotshot | ace | insane
}

interface BotRosterData {
  botCount: number;
  defaultDifficulty?: string;
  bots: BotEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper sub-components
// ---------------------------------------------------------------------------

function Select({
  value,
  onChange,
  options,
  placeholder,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`px-2 py-1 bg-muted border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring ${className}`}
    >
      {placeholder && (
        <option value="">{placeholder}</option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// BotRosterForm
// ---------------------------------------------------------------------------

interface BotRosterFormProps {
  profileId: string;
  onSaved?: () => void;
}

export function BotRosterForm({ profileId, onSaved }: BotRosterFormProps) {
  const [roster, setRoster] = useState<BotRosterData | null>(null);
  const [maxPlayers, setMaxPlayers] = useState<number>(8);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New bot form state
  const [newName, setNewName] = useState("");
  const [newShip, setNewShip] = useState("pyro");
  const [newDifficulty, setNewDifficulty] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rosterRes, configRes] = await Promise.all([
        fetch(`/api/profiles/${encodeURIComponent(profileId)}/bot-roster`, { credentials: "include" }),
        fetch(`/api/profiles/${encodeURIComponent(profileId)}/structured-config`, { credentials: "include" }),
      ]);

      if (!rosterRes.ok) {
        const body = await rosterRes.json().catch(() => ({}));
        setError(body.error ?? "Failed to load bot roster");
        setRoster(null);
      } else {
        setRoster(await rosterRes.json());
      }

      if (configRes.ok) {
        const cfg = await configRes.json();
        setMaxPlayers(cfg.maxPlayers ?? 8);
      }
    } catch {
      setError("Network error loading bot roster");
    }
    setLoading(false);
    setDirty(false);
  }, [profileId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!roster) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/profiles/${encodeURIComponent(profileId)}/bot-roster`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(roster),
        },
      );
      if (res.ok) {
        setSaved(true);
        setDirty(false);
        onSaved?.();
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      // ignore
    }
    setSaving(false);
  };

  const updateRoster = (updates: Partial<BotRosterData>) => {
    setRoster((prev) => prev ? { ...prev, ...updates } : prev);
    setDirty(true);
    setSaved(false);
  };

  const updateBot = (index: number, updates: Partial<BotEntry>) => {
    if (!roster) return;
    const bots = roster.bots.map((b, i) => i === index ? { ...b, ...updates } : b);
    updateRoster({ bots });
  };

  const removeBot = (index: number) => {
    if (!roster) return;
    const bots = roster.bots.filter((_, i) => i !== index);
    updateRoster({ bots, botCount: bots.length });
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
    };
    const bots = [...roster.bots, entry];
    updateRoster({ bots, botCount: bots.length });
    setNewName("");
    setNewDifficulty("");
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading bot roster...</p>
      </div>
    );
  }

  if (error || !roster) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        <p className="text-sm text-destructive">{error ?? "No bot roster loaded"}</p>
        <button
          onClick={load}
          className="text-xs text-primary hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const botCount = roster.bots.length;
  const atOrOverLimit = botCount >= maxPlayers;
  const nearLimit = botCount >= maxPlayers - 1 && !atOrOverLimit;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      {/* Header: bot count + save */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-foreground">
            {botCount} {botCount === 1 ? "bot" : "bots"}
          </span>
          <span className="text-xs text-muted-foreground">
            / {maxPlayers} max players
          </span>
          {atOrOverLimit && (
            <span className="text-xs font-medium text-destructive">
              Bot count fills all slots — no room for human players
            </span>
          )}
          {nearLimit && (
            <span className="text-xs text-amber-400">
              Only 1 slot left for human players
            </span>
          )}
        </div>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="px-3 py-1 bg-primary hover:bg-primary/80 disabled:bg-muted disabled:text-muted-foreground text-white text-xs font-medium rounded transition-colors"
        >
          {saving ? "Saving..." : saved ? "Saved!" : "Save"}
        </button>
      </div>

      {/* Default difficulty */}
      <div className="flex items-center gap-2 mb-4 shrink-0">
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
      {roster.bots.length > 0 ? (
        <div className="space-y-1 mb-4 shrink-0">
          {roster.bots.map((bot, i) => (
            <div
              key={i}
              className="flex items-center gap-2 px-2 py-1.5 bg-muted/40 rounded border border-border/40"
            >
              {/* Reorder buttons */}
              <div className="flex flex-col">
                <button
                  onClick={() => moveBot(i, -1)}
                  disabled={i === 0}
                  className="text-muted-foreground hover:text-foreground/80 disabled:opacity-30 text-[10px] leading-none"
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  onClick={() => moveBot(i, 1)}
                  disabled={i === roster.bots.length - 1}
                  className="text-muted-foreground hover:text-foreground/80 disabled:opacity-30 text-[10px] leading-none"
                  title="Move down"
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
                className="flex-1 min-w-0 px-2 py-1 bg-background border border-border rounded text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="Bot name"
              />

              {/* Ship */}
              <Select
                value={bot.ship ?? "pyro"}
                onChange={(v) => updateBot(i, { ship: v })}
                options={SHIP_OPTIONS}
                className="w-28 shrink-0"
              />

              {/* Per-bot difficulty */}
              <select
                value={bot.difficulty ?? ""}
                onChange={(e) => updateBot(i, { difficulty: e.target.value || undefined })}
                className="w-24 shrink-0 px-2 py-1 bg-muted border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">Default</option>
                {DIFFICULTY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>

              {/* Remove */}
              <button
                onClick={() => removeBot(i)}
                className="text-muted-foreground hover:text-destructive transition-colors text-xs shrink-0 px-1"
                title="Remove bot"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-4 px-3 py-4 bg-muted/20 border border-dashed border-border rounded text-center shrink-0">
          <p className="text-xs text-muted-foreground">
            No bots configured. Add one below.
          </p>
        </div>
      )}

      {/* Add bot form */}
      {!atOrOverLimit && (
        <div className="flex items-center gap-2 p-2 bg-muted/20 border border-border/40 rounded shrink-0">
          <span className="text-xs text-muted-foreground w-16 shrink-0">Add bot</span>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={19}
            placeholder="Name"
            className="flex-1 min-w-0 px-2 py-1 bg-background border border-border rounded text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) addBot();
            }}
          />
          <Select
            value={newShip}
            onChange={setNewShip}
            options={SHIP_OPTIONS}
            className="w-28 shrink-0"
          />
          <select
            value={newDifficulty}
            onChange={(e) => setNewDifficulty(e.target.value)}
            className="w-24 shrink-0 px-2 py-1 bg-muted border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">Default</option>
            {DIFFICULTY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={addBot}
            disabled={!newName.trim()}
            className="px-3 py-1 bg-primary hover:bg-primary/80 disabled:bg-muted disabled:text-muted-foreground text-white text-xs font-medium rounded transition-colors shrink-0"
          >
            Add
          </button>
        </div>
      )}

      {atOrOverLimit && (
        <p className="text-xs text-muted-foreground italic">
          Remove bots to make room before adding more, or increase Max Players in Server Config.
        </p>
      )}
    </div>
  );
}
