import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  LaunchOptions,
  PeriodicCommandSettings,
  RespawnScaling,
  TeamKey,
  TeamSettings,
} from "../hooks/useLauncher.ts";

/**
 * Profile settings that shape a launch (Launch panel → Edit). The server
 * validates every field; these forms keep numbers as typed text so a field
 * can be cleared, and send empty fields as "not set".
 */

const INPUT_CLASS =
  "w-full mt-0.5 bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring";

/** A collapsible block of the profile form with a one-line summary when closed. */
export function SettingsSection({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1.5 border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1 text-sm font-score tracking-wide text-muted-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {title}
        </span>
        <span className="text-[11px] text-muted-foreground truncate">{summary}</span>
      </button>
      {open && <div className="space-y-1.5">{children}</div>}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={`text-[10px] text-muted-foreground ${className ?? ""}`}>
      {label}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={INPUT_CLASS}
      />
    </label>
  );
}

// ── Launch options ───────────────────────────────────────────────────────────

export interface LaunchOptionsForm {
  bindIp: string;
  gamePort: string;
  frameCap: string;
  noMultiBmp: boolean;
  gameSpyPort: string;
  gameSpyFile: string;
}

export function launchOptionsToForm(o: LaunchOptions | undefined): LaunchOptionsForm {
  return {
    bindIp: o?.bindIp ?? "",
    gamePort: o?.gamePort !== undefined ? String(o.gamePort) : "",
    frameCap: o?.frameCap !== undefined ? String(o.frameCap) : "",
    noMultiBmp: o?.noMultiBmp ?? false,
    gameSpyPort: o?.gameSpyPort !== undefined ? String(o.gameSpyPort) : "",
    gameSpyFile: o?.gameSpyFile ?? "",
  };
}

/** The PATCH value: null when nothing is set. */
export function launchOptionsPayload(f: LaunchOptionsForm): Record<string, string | boolean> | null {
  const out: Record<string, string | boolean> = {};
  for (const key of ["bindIp", "gamePort", "frameCap", "gameSpyPort", "gameSpyFile"] as const) {
    if (f[key].trim()) out[key] = f[key].trim();
  }
  if (f.noMultiBmp) out.noMultiBmp = true;
  return Object.keys(out).length > 0 ? out : null;
}

function launchSummary(f: LaunchOptionsForm): string {
  const parts: string[] = [];
  if (f.bindIp.trim()) parts.push(f.bindIp.trim());
  if (f.gamePort.trim()) parts.push(`port ${f.gamePort.trim()}`);
  if (f.frameCap.trim()) parts.push(`${f.frameCap.trim()} fps`);
  if (f.noMultiBmp) parts.push("no logos");
  if (f.gameSpyPort.trim() || f.gameSpyFile.trim()) parts.push("GameSpy");
  return parts.length > 0 ? parts.join(", ") : "Engine defaults";
}

/** -useip, -useport, -framecap, -nomultibmp, -gamespyport, -gspyfile. */
export function LaunchOptionsFields({
  values,
  onChange,
}: {
  values: LaunchOptionsForm;
  onChange: (v: LaunchOptionsForm) => void;
}) {
  const set = (patch: Partial<LaunchOptionsForm>) => onChange({ ...values, ...patch });
  return (
    <SettingsSection title="Launch Options" summary={launchSummary(values)}>
      <p className="text-[10px] text-muted-foreground leading-snug">
        Command-line flags for the server. Empty means the engine default. Saving checks the ports against your
        other profiles.
      </p>
      <TextField
        label="Bind address (-useip)"
        value={values.bindIp}
        onChange={(bindIp) => set({ bindIp })}
        placeholder="all addresses"
      />
      <div className="grid grid-cols-2 gap-1.5">
        <TextField
          label="Game port, UDP (-useport)"
          value={values.gamePort}
          onChange={(gamePort) => set({ gamePort })}
          placeholder="2092"
        />
        <TextField
          label="Frame cap (-framecap)"
          value={values.frameCap}
          onChange={(frameCap) => set({ frameCap })}
          placeholder="60"
        />
        <TextField
          label="GameSpy port (-gamespyport)"
          value={values.gameSpyPort}
          onChange={(gameSpyPort) => set({ gameSpyPort })}
          placeholder="20142"
        />
        <TextField
          label="GameSpy file (-gspyfile)"
          value={values.gameSpyFile}
          onChange={(gameSpyFile) => set({ gameSpyFile })}
          placeholder="gamespy.cfg"
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-foreground/80">
        <input type="checkbox" checked={values.noMultiBmp} onChange={(e) => set({ noMultiBmp: e.target.checked })} />
        No pilot logos (-nomultibmp)
      </label>
      <p className="text-[10px] text-muted-foreground leading-snug">
        The bind address must be an IPv4 address of this machine; the server binds its game, console and GameSpy
        sockets there only, and Pyrodeck connects to the console at that address. The frame cap is the server's
        frames per second (1-999). Without logos the server neither collects nor relays pilot logos.
      </p>
    </SettingsSection>
  );
}

// ── Teams and Hoard ──────────────────────────────────────────────────────────

type OnOff = "default" | "on" | "off";
const toOnOff = (v: boolean | undefined): OnOff => (v === undefined ? "default" : v ? "on" : "off");

const TEAMS: { key: TeamKey; label: string }[] = [
  { key: "red", label: "Red" },
  { key: "blue", label: "Blue" },
  { key: "green", label: "Green" },
  { key: "yellow", label: "Yellow" },
];

const SELECT_CLASS =
  "w-full mt-0.5 bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

export interface TeamSettingsForm {
  allowTeamChange: OnOff;
  autoBalance: OnOff;
  teamNames: Record<TeamKey, string>;
  hoardMinOrbs: string;
}

export function teamSettingsToForm(t: TeamSettings | undefined): TeamSettingsForm {
  return {
    allowTeamChange: toOnOff(t?.allowTeamChange),
    autoBalance: toOnOff(t?.autoBalance),
    teamNames: {
      red: t?.teamNames?.red ?? "",
      blue: t?.teamNames?.blue ?? "",
      green: t?.teamNames?.green ?? "",
      yellow: t?.teamNames?.yellow ?? "",
    },
    hoardMinOrbs: t?.hoardMinOrbs !== undefined ? String(t.hoardMinOrbs) : "",
  };
}

/** The PATCH value: null when nothing is set. */
export function teamSettingsPayload(f: TeamSettingsForm): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (f.allowTeamChange !== "default") out.allowTeamChange = f.allowTeamChange === "on";
  if (f.autoBalance !== "default") out.autoBalance = f.autoBalance === "on";
  const names: Partial<Record<TeamKey, string>> = {};
  for (const { key } of TEAMS) if (f.teamNames[key].trim()) names[key] = f.teamNames[key].trim();
  if (Object.keys(names).length > 0) out.teamNames = names;
  if (f.hoardMinOrbs.trim()) out.hoardMinOrbs = f.hoardMinOrbs.trim();
  return Object.keys(out).length > 0 ? out : null;
}

function teamSummary(f: TeamSettingsForm): string {
  const set = [
    f.allowTeamChange !== "default",
    f.autoBalance !== "default",
    TEAMS.some(({ key }) => f.teamNames[key].trim()),
    !!f.hoardMinOrbs.trim(),
  ].filter(Boolean).length;
  return set > 0 ? `${set} set` : "Server defaults";
}

/** $allowteamchange, $autobalance, $setteamname, Hoard's $mincount: written into the Startup Commands at launch. */
export function TeamSettingsFields({
  values,
  onChange,
}: {
  values: TeamSettingsForm;
  onChange: (v: TeamSettingsForm) => void;
}) {
  const set = (patch: Partial<TeamSettingsForm>) => onChange({ ...values, ...patch });
  return (
    <SettingsSection title="Teams and Hoard" summary={teamSummary(values)}>
      <p className="text-[10px] text-muted-foreground leading-snug">
        Written into the Startup Commands file (between <code>#&nbsp;pyrodeck:</code> markers) at every launch, so
        they hold from the first second. Game types without teams or Hoard ignore them.
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="text-[10px] text-muted-foreground">
          Team changes
          <select
            value={values.allowTeamChange}
            onChange={(e) => set({ allowTeamChange: e.target.value as OnOff })}
            className={SELECT_CLASS}
          >
            <option value="default">Server default</option>
            <option value="on">Allowed</option>
            <option value="off">Not allowed</option>
          </select>
        </label>
        <label className="text-[10px] text-muted-foreground">
          Auto balance
          <select
            value={values.autoBalance}
            onChange={(e) => set({ autoBalance: e.target.value as OnOff })}
            className={SELECT_CLASS}
          >
            <option value="default">Server default</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        {TEAMS.map(({ key, label }) => (
          <TextField
            key={key}
            label={`${label} team name`}
            value={values.teamNames[key]}
            onChange={(v) => set({ teamNames: { ...values.teamNames, [key]: v } })}
            placeholder={label}
          />
        ))}
        <TextField
          label="Hoard orbs to score (1-12)"
          value={values.hoardMinOrbs}
          onChange={(hoardMinOrbs) => set({ hoardMinOrbs })}
          placeholder="1"
        />
      </div>
      <p className="text-[10px] text-muted-foreground leading-snug">
        Team names are one word of up to 15 characters. DMFC remembers team changes and auto balance between runs, so
        "Server default" means whatever the last server on this machine left.
      </p>
    </SettingsSection>
  );
}

// ── Periodic commands ────────────────────────────────────────────────────────

const TEXTAREA_CLASS =
  "w-full mt-0.5 bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground font-mono resize-y focus:outline-none focus:ring-1 focus:ring-ring";

export interface PeriodicForm {
  enabled: boolean;
  startLines: string;
  lines: string;
  intervalMinutes: string;
  mode: PeriodicCommandSettings["mode"];
}

export function periodicToForm(p: PeriodicCommandSettings | undefined): PeriodicForm {
  return {
    enabled: p?.enabled ?? true,
    startLines: (p?.startLines ?? []).join("\n"),
    lines: (p?.lines ?? []).join("\n"),
    intervalMinutes: String(p?.intervalMinutes ?? 10),
    mode: p?.mode ?? "sequential",
  };
}

const splitLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

/** The PATCH value: null when there are no lines. */
export function periodicPayload(f: PeriodicForm): Record<string, unknown> | null {
  const startLines = splitLines(f.startLines);
  const lines = splitLines(f.lines);
  if (startLines.length === 0 && lines.length === 0) return null;
  return { enabled: f.enabled, startLines, lines, intervalMinutes: f.intervalMinutes.trim(), mode: f.mode };
}

function periodicSummary(f: PeriodicForm): string {
  const n = splitLines(f.lines).length;
  const s = splitLines(f.startLines).length;
  if (n === 0 && s === 0) return "None";
  if (!f.enabled) return "Paused";
  const parts: string[] = [];
  if (s > 0) parts.push(`${s} at start`);
  if (n > 0) parts.push(`${n} every ${f.intervalMinutes || "?"} min`);
  return parts.join(", ");
}

/** Lines sent once when the console connects, and every N minutes while the server runs. */
export function PeriodicFields({ values, onChange }: { values: PeriodicForm; onChange: (v: PeriodicForm) => void }) {
  const set = (patch: Partial<PeriodicForm>) => onChange({ ...values, ...patch });
  return (
    <SettingsSection title="Periodic Commands" summary={periodicSummary(values)}>
      <p className="text-[10px] text-muted-foreground leading-snug">
        One line each: a <code>$</code> command or <code>say</code> and a message (200 characters at most). Sent only
        while Pyrodeck is connected to this profile's launched server.
      </p>
      <label className="flex items-center gap-2 text-xs text-foreground/80">
        <input type="checkbox" checked={values.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Send them
      </label>
      <label className="block text-[10px] text-muted-foreground">
        At start (once per launch, up to 5)
        <textarea
          value={values.startLines}
          onChange={(e) => set({ startLines: e.target.value })}
          rows={2}
          placeholder="say Welcome to the server"
          className={TEXTAREA_CLASS}
          spellCheck={false}
        />
      </label>
      <label className="block text-[10px] text-muted-foreground">
        Every interval (up to 20; all-each-time up to 5)
        <textarea
          value={values.lines}
          onChange={(e) => set({ lines: e.target.value })}
          rows={3}
          placeholder={"say Rules: no spawn camping\nsay Join us on Discord: example.org/d3"}
          className={TEXTAREA_CLASS}
          spellCheck={false}
        />
      </label>
      <div className="grid grid-cols-2 gap-1.5">
        <TextField
          label="Interval (minutes)"
          value={values.intervalMinutes}
          onChange={(intervalMinutes) => set({ intervalMinutes })}
          placeholder="10"
        />
        <label className="text-[10px] text-muted-foreground">
          Each interval
          <select
            value={values.mode}
            onChange={(e) => set({ mode: e.target.value as PeriodicForm["mode"] })}
            className={SELECT_CLASS}
          >
            <option value="sequential">Next line, in order</option>
            <option value="random">One random line</option>
            <option value="all">All lines</option>
          </select>
        </label>
      </div>
    </SettingsSection>
  );
}

// ── Respawn scaling ──────────────────────────────────────────────────────────

export interface RespawnForm {
  enabled: boolean;
  minSeconds: string;
  maxSeconds: string;
  playersForMin: string;
}

export function respawnToForm(r: RespawnScaling | undefined): RespawnForm {
  return {
    enabled: r?.enabled ?? false,
    minSeconds: r ? String(r.minSeconds) : "",
    maxSeconds: r ? String(r.maxSeconds) : "",
    playersForMin: r ? String(r.playersForMin) : "",
  };
}

/** The PATCH value: null for an untouched, disabled form. */
export function respawnPayload(f: RespawnForm): Record<string, unknown> | null {
  if (!f.enabled && !f.minSeconds.trim() && !f.maxSeconds.trim()) return null;
  return {
    enabled: f.enabled,
    minSeconds: f.minSeconds.trim(),
    maxSeconds: f.maxSeconds.trim(),
    playersForMin: f.playersForMin.trim(),
  };
}

/** $setrespawntime between a longest and a shortest time as human players come and go. */
export function RespawnFields({ values, onChange }: { values: RespawnForm; onChange: (v: RespawnForm) => void }) {
  const set = (patch: Partial<RespawnForm>) => onChange({ ...values, ...patch });
  const summary = values.enabled
    ? `${values.maxSeconds || "?"}s → ${values.minSeconds || "?"}s`
    : "Off";
  return (
    <SettingsSection title="Respawn by Players" summary={summary}>
      <p className="text-[10px] text-muted-foreground leading-snug">
        Powerup respawn time follows the number of human players (bots don't count): the longest with two players or
        fewer, falling evenly to the shortest at "Shortest at". Pyrodeck sends <code>$setrespawntime</code> when the
        console connects and 15 s after the player count settles, only when the value changes; it applies to the
        next powerups picked up.
      </p>
      <label className="flex items-center gap-2 text-xs text-foreground/80">
        <input type="checkbox" checked={values.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Scale respawn time by players
      </label>
      <div className="grid grid-cols-3 gap-1.5">
        <TextField
          label="Longest (s)"
          value={values.maxSeconds}
          onChange={(maxSeconds) => set({ maxSeconds })}
          placeholder="60"
        />
        <TextField
          label="Shortest (s)"
          value={values.minSeconds}
          onChange={(minSeconds) => set({ minSeconds })}
          placeholder="20"
        />
        <TextField
          label="Shortest at"
          value={values.playersForMin}
          onChange={(playersForMin) => set({ playersForMin })}
          placeholder="8"
        />
      </div>
      <p className="text-[10px] text-muted-foreground leading-snug">
        Joins and leaves come from the server's player events; without them the time stays at the longest.
      </p>
    </SettingsSection>
  );
}
