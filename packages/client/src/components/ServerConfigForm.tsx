import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types (mirrors backend DedicatedCfgData)
// ---------------------------------------------------------------------------

type NetworkModel = "client-server" | "peer2peer" | "permissable";

interface DedicatedCfgData {
  gameName: string;
  missionName: string;
  scriptName: string;
  motd: string;
  startingLevel: number;
  maxPlayers: number;
  pps: number;
  networkModel: NetworkModel;
  sendRotVel: boolean;
  useSmoothing: boolean;
  timeLimit: number;
  killGoal: number;
  respawnTime: number;
  randomizeRespawn: boolean;
  difficulty: number;
  numTeams: number;
  audioTauntDelay: number;
  accurateCollisions: boolean;
  brightPlayers: boolean;
  allowMouselook: boolean;
  allowRemoteConsole: boolean;
  remoteConsolePort: number;
  consolePassword: string;
  allowedPowerups: string[];
  disallowedPowerups: string[];
  bannedShips: string[];
  botConfigFile: string | null;
  multiSettingsFile: string | null;
}

const DIFFICULTY_LABELS = ["Trainee", "Rookie", "Hotshot", "Ace", "Insane"];

const TEAM_SCRIPTS = ["team anarchy", "ctf", "entropy", "monsterball"];

// ---------------------------------------------------------------------------
// Ships & powerups constants
// ---------------------------------------------------------------------------

const ALL_SHIPS = ["Pyro-GL", "Phoenix", "Magnum-AHT", "Black Pyro"] as const;

const POWERUP_CATEGORIES: { label: string; powerups: string[] }[] = [
  {
    label: "Primary Weapons",
    powerups: ["SuperLaser", "Fusioncannon", "MassDriver", "Microwave", "Plasmacannon", "EMDlauncher", "Omegacannon", "Vauss", "Napalm"],
  },
  {
    label: "Ammo",
    powerups: ["Vauss clip", "MassDriverAmmo", "NapalmTank"],
  },
  {
    label: "Secondary Weapons",
    powerups: ["Concussion", "Homing", "Smart", "Mega", "Frag", "Guided", "ImpactMortar", "NapalmRocket", "Cyclone", "BlackShark"],
  },
  {
    label: "4-Packs",
    powerups: ["4PackHoming", "4PackConc", "4PackFrag", "4PackGuided"],
  },
  {
    label: "Utility",
    powerups: ["Energy", "Shield", "QuadLaser", "Cloak", "Invulnerability", "RapidFire", "Afterburner", "Converter", "FullMap", "HeadlightPowerup", "ThiefAutoMap"],
  },
  {
    label: "Countermeasures",
    powerups: ["Chaff", "Betty4Pack", "Seeker3Pack", "GunboyPowerup", "ProxMinePowerup"],
  },
];

const ALL_POWERUPS = POWERUP_CATEGORIES.flatMap((c) => c.powerups);

/** Powerups that generate significant network traffic — warn the server admin. */
const BANDWIDTH_HEAVY = new Set(["ProxMinePowerup", "Betty4Pack", "BlackShark", "Seeker3Pack"]);

/**
 * Normalize: if the cfg used AllowPowerup= lines, convert to equivalent
 * DisallowPowerup= list so the UI always works in "disallow" mode.
 */
function normalizeToDisallowList(data: DedicatedCfgData): string[] {
  if (data.allowedPowerups.length === 0) return data.disallowedPowerups;
  // allowedPowerups is an explicit allow-list → everything NOT in it is disallowed
  const allowed = new Set(data.allowedPowerups.map((p) => p.toLowerCase()));
  return ALL_POWERUPS.filter((p) => !allowed.has(p.toLowerCase()));
}

function isPowerupDisallowed(disallowed: string[], name: string): boolean {
  const lk = name.toLowerCase();
  return disallowed.some((d) => d.toLowerCase() === lk);
}

function togglePowerup(disallowed: string[], name: string, allow: boolean): string[] {
  const lk = name.toLowerCase();
  if (allow) {
    return disallowed.filter((d) => d.toLowerCase() !== lk);
  } else {
    if (disallowed.some((d) => d.toLowerCase() === lk)) return disallowed;
    return [...disallowed, name];
  }
}

function isTeamMode(scriptName: string): boolean {
  const base = scriptName.replace(/\.d3m$/i, "").toLowerCase();
  return TEAM_SCRIPTS.includes(base);
}

function scriptLabel(name: string): string {
  return name
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function randomPassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 8 }, () =>
    chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ServerConfigFormProps {
  profileId: string;
  onSaved?: () => void;
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 pb-1 border-b border-border">
        {title}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field wrappers
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-foreground/80 mb-1">
        {label}
        {hint && (
          <span className="ml-1 font-normal text-muted-foreground">{hint}</span>
        )}
      </label>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

// ---------------------------------------------------------------------------
// Input primitives
// ---------------------------------------------------------------------------

function TextInput({
  value,
  onChange,
  maxLength,
  placeholder,
  monospace,
}: {
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  placeholder?: string;
  monospace?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      maxLength={maxLength}
      placeholder={placeholder}
      className={`w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground/90 focus:outline-none focus:ring-1 focus:ring-ring ${monospace ? "font-mono" : ""}`}
    />
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const [raw, setRaw] = useState(String(value));

  // Sync display when parent value changes (e.g. increment/decrement)
  useEffect(() => {
    setRaw(String(value));
  }, [value]);

  return (
    <input
      type="number"
      value={raw}
      min={min}
      max={max}
      onChange={(e) => {
        setRaw(e.target.value);
        const n = parseInt(e.target.value, 10);
        if (!isNaN(n)) onChange(n);
      }}
      onBlur={() => {
        // If left blank or invalid, snap back to last committed value
        const n = parseInt(raw, 10);
        if (isNaN(n)) setRaw(String(value));
      }}
      className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground/90 focus:outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-primary w-3.5 h-3.5"
      />
      <span className="text-xs text-foreground/80">{label}</span>
    </label>
  );
}

function SelectInput({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground/90 focus:outline-none focus:ring-1 focus:ring-ring"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Main form
// ---------------------------------------------------------------------------

export function ServerConfigForm({ profileId, onSaved }: ServerConfigFormProps) {
  const [data, setData] = useState<DedicatedCfgData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const [missions, setMissions] = useState<string[]>([]);
  const [scripts, setScripts] = useState<string[]>([]);

  // Load config + missions + scripts in parallel
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfgRes, missionsRes, scriptsRes] = await Promise.all([
        fetch(`/api/profiles/${encodeURIComponent(profileId)}/structured-config`, {
          credentials: "include",
        }),
        fetch("/api/game-files/missions", { credentials: "include" }),
        fetch("/api/game-files/netgames", { credentials: "include" }),
      ]);

      if (!cfgRes.ok) {
        setError("Failed to load config");
        return;
      }

      const [cfg, missionsData, scriptsData] = await Promise.all([
        cfgRes.json(),
        missionsRes.ok ? missionsRes.json() : { missions: [] },
        scriptsRes.ok ? scriptsRes.json() : { scripts: [] },
      ]);

      // Normalize: convert allowedPowerups allow-list → disallow-list for the UI
      const normalized: DedicatedCfgData = {
        ...cfg,
        disallowedPowerups: normalizeToDisallowList(cfg),
        allowedPowerups: [],
      };
      setData(normalized);
      setMissions(missionsData.missions ?? []);
      setScripts(scriptsData.scripts ?? []);
      setDirty(false);
    } catch {
      setError("Failed to load config");
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    load();
  }, [load]);

  const update = useCallback(
    (patch: Partial<DedicatedCfgData>) => {
      setData((prev) => (prev ? { ...prev, ...patch } : prev));
      setDirty(true);
      setSaved(false);
    },
    [],
  );

  const save = async () => {
    if (!data) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/profiles/${encodeURIComponent(profileId)}/structured-config`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(data),
        },
      );
      if (res.ok) {
        setSaved(true);
        setDirty(false);
        setTimeout(() => setSaved(false), 2000);
        onSaved?.();
      } else {
        setError("Save failed");
      }
    } catch {
      setError("Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Build script dropdown: use scanned scripts, but always include the
  // current value if it isn't in the list (custom / unknown script).
  const scriptOptions = (() => {
    const base = scripts.map((s) => ({ value: `${s}.d3m`, label: scriptLabel(s) }));
    const currentBase = data?.scriptName.replace(/\.d3m$/i, "").toLowerCase() ?? "";
    if (currentBase && !scripts.includes(currentBase)) {
      base.unshift({ value: data!.scriptName, label: data!.scriptName });
    }
    return base;
  })();

  const missionOptions = (() => {
    const base = missions.map((m) => ({ value: m, label: m }));
    if (data?.missionName && !missions.includes(data.missionName)) {
      base.unshift({ value: data.missionName, label: data.missionName });
    }
    return base;
  })();

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-xs text-muted-foreground">Loading config...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2">
        <p className="text-xs text-red-400">{error ?? "Unknown error"}</p>
        <button
          onClick={load}
          className="text-xs text-primary hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const teamMode = isTeamMode(data.scriptName);

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Sticky toolbar */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="flex items-center gap-2">
          {dirty && (
            <span className="text-[10px] text-amber-400">Unsaved changes</span>
          )}
          {saved && (
            <span className="text-[10px] text-emerald-400">Saved!</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={saving}
            className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground/80 transition-colors"
          >
            Reset
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="px-3 py-1 bg-primary hover:bg-primary/80 disabled:bg-muted disabled:text-muted-foreground text-white text-xs font-medium rounded transition-colors"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* Scrollable form body */}
      <div className="flex-1 overflow-y-auto pr-1 space-y-1">

        {/* Identity */}
        <Section title="Identity">
          <Field label="Server Name" hint="(max 32)">
            <TextInput
              value={data.gameName}
              onChange={(v) => update({ gameName: v.slice(0, 32) })}
              maxLength={32}
              placeholder="Pyrodeck Server"
            />
          </Field>
          <Row>
            <Field label="Game Type">
              {scriptOptions.length > 0 ? (
                <SelectInput
                  value={data.scriptName}
                  onChange={(v) => update({ scriptName: v })}
                  options={scriptOptions}
                />
              ) : (
                <TextInput
                  value={data.scriptName}
                  onChange={(v) => update({ scriptName: v })}
                  placeholder="Anarchy.d3m"
                  monospace
                />
              )}
            </Field>
            <Field label="Mission">
              {missionOptions.length > 0 ? (
                <SelectInput
                  value={data.missionName}
                  onChange={(v) => update({ missionName: v })}
                  options={missionOptions}
                />
              ) : (
                <TextInput
                  value={data.missionName}
                  onChange={(v) => update({ missionName: v })}
                  placeholder="fury.mn3"
                  monospace
                />
              )}
            </Field>
          </Row>
          <Field label="Starting Level" hint="(1 = first level in mission)">
            <NumberInput
              value={data.startingLevel}
              onChange={(v) => update({ startingLevel: Math.max(1, v) })}
              min={1}
            />
          </Field>
          <Field label="Message of the Day" hint="(max 400)">
            <textarea
              value={data.motd}
              onChange={(e) => update({ motd: e.target.value.slice(0, 400) })}
              maxLength={400}
              rows={2}
              placeholder="Welcome to the server!"
              className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground/90 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </Field>
        </Section>

        {/* Network */}
        <Section title="Network">
          <Row>
            <Field label="Max Players" hint="(2–32)">
              <NumberInput
                value={data.maxPlayers}
                onChange={(v) => update({ maxPlayers: Math.min(32, Math.max(2, v)) })}
                min={2}
                max={32}
              />
            </Field>
            <Field label="PPS" hint="(2–40, rec. 20)">
              <NumberInput
                value={data.pps}
                onChange={(v) => update({ pps: Math.min(40, Math.max(2, v)) })}
                min={2}
                max={40}
              />
            </Field>
          </Row>
          <Field label="Network Model">
            <div className="flex gap-4">
              {(
                [
                  ["client-server", "Client/Server"],
                  ["peer2peer", "Peer-to-Peer"],
                  ["permissable", "Permissable"],
                ] as [NetworkModel, string][]
              ).map(([val, label]) => (
                <label key={val} className="flex items-center gap-1.5 cursor-pointer text-xs text-foreground/80">
                  <input
                    type="radio"
                    name="networkModel"
                    checked={data.networkModel === val}
                    onChange={() => update({ networkModel: val })}
                    className="accent-primary"
                  />
                  {label}
                </label>
              ))}
            </div>
          </Field>
          <div className="flex gap-5">
            <Toggle
              checked={data.sendRotVel}
              onChange={(v) => update({ sendRotVel: v })}
              label="Send rotation velocity"
            />
            <Toggle
              checked={data.useSmoothing}
              onChange={(v) => update({ useSmoothing: v })}
              label="Use smoothing"
            />
          </div>
        </Section>

        {/* Rules */}
        <Section title="Rules">
          <Row>
            <Field label="Time Limit" hint="(minutes, 0 = off)">
              <NumberInput
                value={data.timeLimit}
                onChange={(v) => update({ timeLimit: Math.max(0, v) })}
                min={0}
              />
            </Field>
            <Field label="Kill Goal" hint="(0=off)">
              <NumberInput
                value={data.killGoal}
                onChange={(v) => update({ killGoal: Math.max(0, v) })}
                min={0}
              />
            </Field>
          </Row>
          <Row>
            <Field label="Respawn Time" hint="(sec)">
              <NumberInput
                value={data.respawnTime}
                onChange={(v) => update({ respawnTime: Math.max(0, v) })}
                min={0}
              />
            </Field>
            <Field label="Difficulty">
              <SelectInput
                value={String(data.difficulty)}
                onChange={(v) => update({ difficulty: parseInt(v, 10) })}
                options={DIFFICULTY_LABELS.map((l, i) => ({
                  value: String(i),
                  label: l,
                }))}
              />
            </Field>
          </Row>
          {teamMode && (
            <Field label="Number of Teams" hint="(2–4, team modes only)">
              <NumberInput
                value={data.numTeams}
                onChange={(v) => update({ numTeams: Math.min(4, Math.max(2, v)) })}
                min={2}
                max={4}
              />
            </Field>
          )}
          <Toggle
            checked={data.randomizeRespawn}
            onChange={(v) => update({ randomizeRespawn: v })}
            label="Randomize powerup respawn locations"
          />
        </Section>

        {/* Gameplay */}
        <Section title="Gameplay">
          <div className="space-y-2">
            <Toggle
              checked={data.accurateCollisions}
              onChange={(v) => update({ accurateCollisions: v })}
              label="Accurate weapon collisions"
            />
            <Toggle
              checked={data.brightPlayers}
              onChange={(v) => update({ brightPlayers: v })}
              label="Bright players (improve visibility)"
            />
            <Toggle
              checked={data.allowMouselook}
              onChange={(v) => update({ allowMouselook: v })}
              label="Allow mouselook"
            />
          </div>
        </Section>

        {/* Remote Console */}
        <Section title="Remote Console">
          <Toggle
            checked={data.allowRemoteConsole}
            onChange={(v) => update({ allowRemoteConsole: v })}
            label="Allow remote console (required for Pyrodeck)"
          />
          {data.allowRemoteConsole && (
            <Row>
              <Field label="Port">
                <NumberInput
                  value={data.remoteConsolePort}
                  onChange={(v) =>
                    update({ remoteConsolePort: Math.min(65535, Math.max(1, v)) })
                  }
                  min={1}
                  max={65535}
                />
              </Field>
              <Field label="Password">
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={data.consolePassword}
                    onChange={(e) => update({ consolePassword: e.target.value })}
                    className="flex-1 px-2 py-1.5 bg-background border border-border rounded text-sm font-mono text-foreground/90 focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <button
                    onClick={() => update({ consolePassword: randomPassword() })}
                    className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground/80 border border-border rounded hover:bg-muted transition-colors"
                    title="Generate random password"
                  >
                    Gen
                  </button>
                </div>
              </Field>
            </Row>
          )}
        </Section>

        {/* Ships */}
        <Section title="Ships">
          {(() => {
            const allBanned = ALL_SHIPS.filter((s) => data.bannedShips.includes(s));
            const allowedCount = ALL_SHIPS.length - allBanned.length;
            const pyroGLBanned = data.bannedShips.includes("Pyro-GL");
            return (
              <>
                {allowedCount === 0 && (
                  <p className="text-xs text-red-400 mb-2">
                    At least one ship must be allowed.
                  </p>
                )}
                {pyroGLBanned && (
                  <p className="text-xs text-amber-400 mb-2">
                    Warning: Pyro-GL is the default ship. Banning it may cause issues for connecting players.
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {ALL_SHIPS.map((ship) => {
                    const banned = data.bannedShips.includes(ship);
                    const wouldLeaveNone = !banned && allowedCount === 1;
                    return (
                      <label
                        key={ship}
                        className={`flex items-center gap-2 cursor-pointer select-none ${wouldLeaveNone ? "opacity-50 cursor-not-allowed" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={!banned}
                          disabled={wouldLeaveNone}
                          onChange={(e) => {
                            const nowBanned = !e.target.checked;
                            update({
                              bannedShips: nowBanned
                                ? [...data.bannedShips, ship]
                                : data.bannedShips.filter((s) => s !== ship),
                            });
                          }}
                          className="accent-primary w-3.5 h-3.5"
                        />
                        <span className="text-xs text-foreground/80">{ship}</span>
                      </label>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Ship bans require a .mps file — saved automatically when ships are restricted.
                </p>
              </>
            );
          })()}
        </Section>

        {/* Powerups */}
        <Section title="Powerups">
          {(() => {
            const disallowed = data.disallowedPowerups;
            const allDisallowed = ALL_POWERUPS.every((p) => isPowerupDisallowed(disallowed, p));
            const allAllowed = disallowed.length === 0 || ALL_POWERUPS.every((p) => !isPowerupDisallowed(disallowed, p));
            return (
              <>
                <div className="flex gap-2 mb-3">
                  <button
                    onClick={() => update({ disallowedPowerups: [] })}
                    disabled={allAllowed}
                    className="px-2 py-1 text-[10px] font-medium border border-border rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Allow All
                  </button>
                  <button
                    onClick={() => update({ disallowedPowerups: [...ALL_POWERUPS] })}
                    disabled={allDisallowed}
                    className="px-2 py-1 text-[10px] font-medium border border-border rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Disallow All
                  </button>
                  <span className="ml-auto text-[10px] text-muted-foreground self-center">
                    {ALL_POWERUPS.length - disallowed.length}/{ALL_POWERUPS.length} allowed
                  </span>
                </div>
                <div className="space-y-4">
                  {POWERUP_CATEGORIES.map((cat) => {
                    const catAllowed = cat.powerups.every((p) => !isPowerupDisallowed(disallowed, p));
                    const catDisallowed = cat.powerups.every((p) => isPowerupDisallowed(disallowed, p));
                    return (
                      <div key={cat.label}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[10px] font-medium text-foreground/60 uppercase tracking-wide">
                            {cat.label}
                          </span>
                          <button
                            onClick={() => {
                              let next = disallowed;
                              for (const p of cat.powerups) next = togglePowerup(next, p, true);
                              update({ disallowedPowerups: next });
                            }}
                            disabled={catAllowed}
                            className="text-[10px] text-muted-foreground hover:text-foreground/60 disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            Allow all
                          </button>
                          <span className="text-muted-foreground/40 text-[10px]">·</span>
                          <button
                            onClick={() => {
                              let next = disallowed;
                              for (const p of cat.powerups) next = togglePowerup(next, p, false);
                              update({ disallowedPowerups: next });
                            }}
                            disabled={catDisallowed}
                            className="text-[10px] text-muted-foreground hover:text-foreground/60 disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            Disallow all
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                          {cat.powerups.map((p) => {
                            const allowed = !isPowerupDisallowed(disallowed, p);
                            const heavy = BANDWIDTH_HEAVY.has(p);
                            return (
                              <label key={p} className="flex items-center gap-1.5 cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={allowed}
                                  onChange={(e) =>
                                    update({
                                      disallowedPowerups: togglePowerup(disallowed, p, e.target.checked),
                                    })
                                  }
                                  className="accent-primary w-3.5 h-3.5 shrink-0"
                                />
                                <span className={`text-xs ${allowed ? "text-foreground/80" : "text-muted-foreground line-through"}`}>
                                  {p}
                                </span>
                                {heavy && (
                                  <span className="text-[9px] text-amber-500/80 ml-0.5" title="High bandwidth usage">
                                    BW
                                  </span>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}
        </Section>

      </div>
    </div>
  );
}
