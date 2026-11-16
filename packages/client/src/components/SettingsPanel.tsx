import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  MAIL_EVENTS,
  getJson,
  sendJson,
  type MailEventKey,
  type MailState,
  type MailTestResult,
  type MailTlsMode,
  type PriorityClass,
  type PriorityState,
  type UpdateStatus,
} from "@/lib/ops";
import { notifySessionEnded, type SessionsState } from "@/lib/session";
import { setLayoutOverride, useIsNarrow, useLayoutOverride } from "@/hooks/useIsMobile";

const INPUT_CLASS =
  "w-full bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring";
const SECTION_CLASS = "space-y-2 border border-border rounded-md p-3 bg-card";
const DEFAULT_PORT: Record<MailTlsMode, number> = { none: 25, starttls: 587, tls: 465 };

type Notify = (message: string, type?: "error" | "info") => void;

function EmailAlerts({ notify }: { notify: Notify }) {
  const [state, setState] = useState<MailState | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [tls, setTls] = useState<MailTlsMode>("starttls");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [from, setFrom] = useState("");
  const [recipients, setRecipients] = useState("");
  const [events, setEvents] = useState<Record<MailEventKey, boolean> | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const load = (s: MailState) => {
    setState(s);
    setEnabled(s.settings.enabled);
    setHost(s.settings.host);
    setPort(String(s.settings.port));
    setTls(s.settings.tls);
    setUser(s.settings.user);
    setPassword("");
    setClearPassword(false);
    setFrom(s.settings.from);
    setRecipients(s.settings.recipients.join(", "));
    setEvents(s.settings.events);
  };

  useEffect(() => {
    void getJson<MailState>("/api/alerts/mail").then((s) => s && load(s));
  }, []);

  // The password field is write-only: empty keeps the stored one.
  const body = () => ({
    enabled,
    host,
    port: Number(port),
    tls,
    user,
    ...(clearPassword ? { password: "" } : password ? { password } : {}),
    from,
    recipients,
    events,
  });

  const save = async () => {
    setBusy("save");
    setError(null);
    const res = await sendJson<MailState & { warnings: string[] }>("PUT", "/api/alerts/mail", body());
    setBusy(null);
    if (res.error !== null) {
      setError(res.error);
      return;
    }
    load(res.data);
    setWarnings(res.data.warnings ?? []);
    notify("Email alert settings saved.", "info");
  };

  const test = async () => {
    setBusy("test");
    setError(null);
    const res = await sendJson<MailTestResult>("POST", "/api/alerts/mail/test", body());
    setBusy(null);
    if (res.error !== null) {
      setError(res.error);
      return;
    }
    if (res.data.ok) notify(`Test mail sent${res.data.accepted.length ? ` to ${res.data.accepted.join(", ")}` : ""}.`, "info");
    else setError(`Test mail failed: ${res.data.error}`);
    void getJson<MailState>("/api/alerts/mail").then((s) => s && setState(s));
  };

  if (!state || !events) return <p className="text-xs text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs text-foreground/80">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Send email alerts
      </label>
      <div className="grid grid-cols-[1fr_5rem] gap-1.5">
        <label className="text-[10px] text-muted-foreground">
          SMTP host
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.org" className={`${INPUT_CLASS} font-mono mt-0.5`} />
        </label>
        <label className="text-[10px] text-muted-foreground">
          Port
          <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} className={`${INPUT_CLASS} font-mono mt-0.5`} />
        </label>
      </div>
      <label className="block text-[10px] text-muted-foreground">
        Security
        <select
          value={tls}
          onChange={(e) => {
            const next = e.target.value as MailTlsMode;
            if (Number(port) === DEFAULT_PORT[tls]) setPort(String(DEFAULT_PORT[next]));
            setTls(next);
          }}
          className={`${INPUT_CLASS} mt-0.5`}
        >
          <option value="starttls">STARTTLS (usually port 587)</option>
          <option value="tls">TLS (usually port 465)</option>
          <option value="none">None (plain SMTP, LAN relays only)</option>
        </select>
      </label>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="text-[10px] text-muted-foreground">
          User
          <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" className={`${INPUT_CLASS} font-mono mt-0.5`} />
        </label>
        <label className="text-[10px] text-muted-foreground">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setClearPassword(false);
            }}
            autoComplete="new-password"
            placeholder={state.settings.passwordSet && !clearPassword ? "•••••• (stored)" : ""}
            className={`${INPUT_CLASS} font-mono mt-0.5`}
          />
        </label>
      </div>
      {state.settings.passwordSet && !password && (
        <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} />
          Remove the stored password
        </label>
      )}
      <label className="block text-[10px] text-muted-foreground">
        From
        <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="pyrodeck@example.org" className={`${INPUT_CLASS} font-mono mt-0.5`} />
      </label>
      <label className="block text-[10px] text-muted-foreground">
        Recipients (comma-separated, up to 10)
        <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="you@example.org" className={`${INPUT_CLASS} font-mono mt-0.5`} />
      </label>
      <div>
        <p className="text-[10px] text-muted-foreground mb-0.5">Mail me when</p>
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
          {MAIL_EVENTS.map((e) => (
            <label key={e.key} className="flex items-center gap-1.5 text-[11px] text-foreground/80">
              <input
                type="checkbox"
                checked={events[e.key]}
                onChange={(ev) => setEvents({ ...events, [e.key]: ev.target.checked })}
              />
              {e.label}
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-1.5">
        <Button size="xs" onClick={() => void save()} disabled={busy !== null} className="flex-1 font-score tracking-wide">
          {busy === "save" ? "Saving..." : "Save"}
        </Button>
        <Button size="xs" variant="outline" onClick={() => void test()} disabled={busy !== null} className="flex-1 font-score tracking-wide">
          {busy === "test" ? "Sending..." : "Send test mail"}
        </Button>
      </div>
      {error && <p className="text-[11px] text-destructive break-words">{error}</p>}
      {warnings.map((w) => (
        <p key={w} className="text-[11px] text-amber-400 break-words">
          {w}
        </p>
      ))}
      <p className="text-[10px] text-muted-foreground leading-snug">
        Events that arrive together go out in one mail (a crash and its relaunch, say), and Pyrodeck sends at most one
        mail a minute. Playlist rotations are never mailed. The test mail uses the settings above, saved or not. The
        password is stored in Pyrodeck's config file (readable by its owner only) and is never shown again.
      </p>
      {state.status.lastError ? (
        <p className="text-[10px] text-destructive break-words">
          Last send failed{state.status.lastErrorAt ? ` (${new Date(state.status.lastErrorAt).toLocaleString()})` : ""}:{" "}
          {state.status.lastError}
        </p>
      ) : state.status.lastSentAt ? (
        <p className="text-[10px] text-muted-foreground">Last mail sent {new Date(state.status.lastSentAt).toLocaleString()}.</p>
      ) : null}
    </div>
  );
}

const PRIORITY_OPTIONS: { value: PriorityClass; label: string }[] = [
  { value: "below-normal", label: "Below normal" },
  { value: "normal", label: "Normal" },
  { value: "above-normal", label: "Above normal" },
  { value: "high", label: "High" },
];

function ProcessPriority({ notify }: { notify: Notify }) {
  const [state, setState] = useState<PriorityState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getJson<PriorityState>("/api/process-priority").then((s) => s && setState(s));
  }, []);

  const save = async (priorityClass: PriorityClass) => {
    setSaving(true);
    const res = await sendJson<PriorityState>("PUT", "/api/process-priority", { priorityClass });
    setSaving(false);
    if (res.error !== null) {
      notify(res.error);
      return;
    }
    setState(res.data);
    if (!res.data.last?.warning) notify(`Process priority set to ${priorityClass}.`, "info");
  };

  if (!state) return <p className="text-xs text-muted-foreground">Loading…</p>;
  const windows = state.platform === "win32";
  return (
    <div className="space-y-2">
      <select
        value={state.priorityClass}
        disabled={saving}
        onChange={(e) => void save(e.target.value as PriorityClass)}
        className={INPUT_CLASS}
      >
        {PRIORITY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {state.last?.warning && <p className="text-[11px] text-amber-400 break-words">{state.last.warning}</p>}
      {state.last && !state.last.warning && (
        <p className="text-[10px] text-muted-foreground">
          Applied to PID {state.last.pid} ({windows ? "priority class" : `nice ${state.last.value}`}).
        </p>
      )}
      <p className="text-[10px] text-muted-foreground leading-snug">
        Applied to the game server after every launch, playlist restart, scheduled start and relaunch, and to a
        running server when you change it. Normal leaves a new server at the priority Pyrodeck itself runs at.{" "}
        {windows
          ? "On Windows these are the process priority classes of the same names; High may need an administrator account."
          : "On Linux and macOS: Below normal (nice 10) needs no privilege; Above normal (−7) and High (−14), and going back to Normal from Below normal on a running server, need root or CAP_SYS_NICE."}{" "}
        If the system refuses, Pyrodeck shows a warning and the server keeps running at its current priority.
      </p>
    </div>
  );
}

function UpdateCheckSetting() {
  const [state, setState] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    void getJson<UpdateStatus>("/api/update-check").then((s) => s && setState(s));
  }, []);

  const toggle = async (enabled: boolean) => {
    const res = await sendJson<UpdateStatus>("PUT", "/api/update-check", { enabled });
    if (res.error === null) setState(res.data);
  };

  if (!state) return <p className="text-xs text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-xs text-foreground/80">
        <input type="checkbox" checked={state.enabled} onChange={(e) => void toggle(e.target.checked)} />
        Tell me when a new Pyrodeck release is out
      </label>
      <p className="text-[10px] text-muted-foreground leading-snug">
        Pyrodeck {state.current} asks GitHub for the latest release at most once a day. It never downloads or installs
        anything; a banner links to the release page.
        {state.enabled && state.latest ? ` Latest release: ${state.latest}.` : ""}
        {state.enabled && !state.latest && state.checkedAt ? " No release information yet." : ""}
      </p>
    </div>
  );
}

/** A browser's user agent cut down to "Firefox on Linux"-style text. */
function describeAgent(ua: string | null): string {
  if (!ua) return "unknown browser";
  const browser =
    /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  const os =
    /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}

function Sessions({ notify }: { notify: Notify }) {
  const [state, setState] = useState<SessionsState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getJson<SessionsState>("/api/sessions").then((s) => s && setState(s));
  }, []);

  // Two clicks: the first arms the button, the second logs every session out,
  // this browser's included (it goes back to the login page).
  const logOutAll = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setBusy(true);
    try {
      const res = await fetch("/api/sessions", { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        notify(body.error ?? `Could not log out the sessions (${res.status}).`);
        return;
      }
      notifySessionEnded();
    } catch {
      notify("Could not log out the sessions.");
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <p className="text-xs text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-2">
      <ul className="space-y-1">
        {state.sessions.map((s, i) => (
          <li key={i} className="text-[11px] text-foreground/80 leading-snug">
            <span className="font-mono">{s.ip ?? "unknown address"}</span> · {describeAgent(s.userAgent)}
            {s.current && <span className="text-primary"> · this browser</span>}
            <br />
            <span className="text-[10px] text-muted-foreground">
              Logged in {new Date(s.createdAt).toLocaleString()}, last used {new Date(s.lastSeenAt).toLocaleString()}
            </span>
          </li>
        ))}
        {state.sessions.length === 0 && <li className="text-[11px] text-muted-foreground">No sessions.</li>}
      </ul>
      <Button
        size="xs"
        variant="outline"
        onClick={() => void logOutAll()}
        onBlur={() => setConfirming(false)}
        disabled={busy}
        className={`font-score tracking-wide ${confirming ? "text-destructive hover:text-destructive" : ""}`}
      >
        {busy ? "Logging out..." : confirming ? "Confirm: log out every session" : "Log out all sessions"}
      </Button>
      <p className="text-[10px] text-muted-foreground leading-snug">
        A session ends {state.ttlHours} h after login, or after {state.idleMinutes} min without use (an open panel keeps
        its session in use). Logging out all sessions ends this one too, and closes every open console. Sessions are kept
        in memory, so restarting Pyrodeck also logs everyone out.
      </p>
    </div>
  );
}

/**
 * The way back to the phone shell for a phone that chose the desktop layout.
 * Renders nothing at desktop widths, where there is no choice to make, and
 * nothing inside the phone shell, which has its own switch.
 */
function LayoutSetting() {
  const narrow = useIsNarrow();
  const override = useLayoutOverride();
  if (!narrow || override !== "desktop") return null;
  return (
    <section className={SECTION_CLASS}>
      <h3 className="text-sm font-score tracking-wide text-muted-foreground">Layout</h3>
      <label className="flex items-center gap-2 text-xs text-foreground/90">
        <input
          type="checkbox"
          checked={override === "desktop"}
          onChange={(e) => setLayoutOverride(e.target.checked ? "desktop" : "auto")}
          className="accent-primary"
        />
        Use the desktop layout on this phone
      </label>
      <p className="text-[10px] text-muted-foreground leading-snug">
        Off, the panel shows its phone layout on screens this narrow.
      </p>
    </section>
  );
}

/** Settings tab: email alerts, process priority, update notice, login sessions. */
export function SettingsPanel({ notify, showSessions = true }: { notify: Notify; showSessions?: boolean }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-xl space-y-3">
        <p className="text-[11px] text-muted-foreground">These settings are Pyrodeck's and apply to all servers.</p>
        <LayoutSetting />
        <section className={SECTION_CLASS}>
          <h3 className="text-sm font-score tracking-wide text-muted-foreground">Email Alerts</h3>
          <EmailAlerts notify={notify} />
        </section>
        <section className={SECTION_CLASS}>
          <h3 className="text-sm font-score tracking-wide text-muted-foreground">Process Priority</h3>
          <ProcessPriority notify={notify} />
        </section>
        <section className={SECTION_CLASS}>
          <h3 className="text-sm font-score tracking-wide text-muted-foreground">Updates</h3>
          <UpdateCheckSetting />
        </section>
        {showSessions && (
          <section className={SECTION_CLASS}>
            <h3 className="text-sm font-score tracking-wide text-muted-foreground">Sessions</h3>
            <Sessions notify={notify} />
          </section>
        )}
      </div>
    </div>
  );
}
