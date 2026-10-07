import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { LaunchOptions } from "../hooks/useLauncher.ts";

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
