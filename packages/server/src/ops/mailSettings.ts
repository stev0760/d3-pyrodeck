/**
 * Email alert settings (SMTP account, recipients, which events to mail).
 * MailNotifier.ts sends; this file validates and shapes what is stored.
 *
 * The SMTP password is kept in pyrodeck.json as entered, the way a server
 * config keeps its ConsolePassword: SMTP AUTH needs the plain value, so it
 * cannot be hashed. It never leaves the server (the API reports only whether
 * one is set) and is never logged.
 */

export type MailTlsMode = "none" | "starttls" | "tls";

/** The events an operator can choose to be mailed about. */
export const MAIL_EVENT_KEYS = [
  "started",
  "stopped",
  "crashed",
  "hung",
  "relaunched",
  "kicked",
  "banned",
  "profanityBan",
  "schedule",
] as const;
export type MailEventKey = (typeof MAIL_EVENT_KEYS)[number];

export interface MailSettings {
  /** Send alerts. Off by default. */
  enabled: boolean;
  host: string;
  port: number;
  /** none: plain SMTP; starttls: upgrade or fail; tls: TLS from the first byte (usually port 465). */
  tls: MailTlsMode;
  /** SMTP login; empty sends without authentication. */
  user: string;
  password: string;
  from: string;
  recipients: string[];
  events: Record<MailEventKey, boolean>;
}

/** What the API returns: everything but the password. */
export type MailSettingsView = Omit<MailSettings, "password"> & { passwordSet: boolean };

export const MAX_RECIPIENTS = 10;
const TLS_MODES: readonly MailTlsMode[] = ["none", "starttls", "tls"];
export const DEFAULT_SMTP_PORT: Record<MailTlsMode, number> = { none: 25, starttls: 587, tls: 465 };

export const DEFAULT_MAIL_EVENTS: Record<MailEventKey, boolean> = {
  started: false,
  stopped: false,
  crashed: true,
  hung: true,
  relaunched: true,
  kicked: false,
  banned: true,
  profanityBan: true,
  schedule: true,
};

export const DEFAULT_MAIL_SETTINGS: MailSettings = {
  enabled: false,
  host: "",
  port: DEFAULT_SMTP_PORT.starttls,
  tls: "starttls",
  user: "",
  password: "",
  from: "",
  recipients: [],
  events: { ...DEFAULT_MAIL_EVENTS },
};

// One address, no display name: a mailbox@domain with no spaces, commas,
// angle brackets or line breaks (which would let a value add mail headers).
const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export function isMailAddress(value: string): boolean {
  return ADDRESS.test(value);
}

export function toMailView(s: MailSettings): MailSettingsView {
  const { password, ...rest } = s;
  return { ...rest, recipients: [...s.recipients], events: { ...s.events }, passwordSet: password.length > 0 };
}

export interface MailSettingsCheck {
  settings: MailSettings;
  errors: string[];
  warnings: string[];
}

/**
 * Validate untrusted settings input over `current`. A missing `password`
 * keeps the stored one; an empty string clears it. On errors, `settings` is
 * not to be saved.
 */
export function validateMailSettings(raw: unknown, current: MailSettings = DEFAULT_MAIL_SETTINGS): MailSettingsCheck {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const warnings: string[] = [];
  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v.trim() : fallback);

  const enabled = r.enabled === undefined ? current.enabled : r.enabled === true;
  const host = str(r.host, current.host);
  const tls = (TLS_MODES as readonly unknown[]).includes(r.tls) ? (r.tls as MailTlsMode) : current.tls;
  if (r.tls !== undefined && !(TLS_MODES as readonly unknown[]).includes(r.tls)) {
    errors.push("The security setting must be none, starttls or tls.");
  }

  let port = r.tls !== undefined && r.port === undefined ? DEFAULT_SMTP_PORT[tls] : current.port;
  if (r.port !== undefined && r.port !== "" && r.port !== null) {
    const n = typeof r.port === "string" ? Number(r.port) : r.port;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535) port = n;
    else errors.push("The SMTP port must be a whole number from 1 to 65535.");
  }

  const user = str(r.user, current.user);
  const password = typeof r.password === "string" ? r.password : current.password;
  let from = str(r.from, current.from);
  if (!from && isMailAddress(user)) from = user;

  let recipients = current.recipients;
  if (r.recipients !== undefined) {
    const list = Array.isArray(r.recipients)
      ? r.recipients.filter((x): x is string => typeof x === "string")
      : typeof r.recipients === "string"
        ? r.recipients.split(/[\s,;]+/)
        : [];
    recipients = [...new Set(list.map((x) => x.trim()).filter(Boolean))];
  }

  const events = { ...current.events };
  if (r.events && typeof r.events === "object") {
    for (const key of MAIL_EVENT_KEYS) {
      const v = (r.events as Record<string, unknown>)[key];
      if (typeof v === "boolean") events[key] = v;
    }
  }

  for (const [label, value] of [
    ["host", host],
    ["user", user],
    ["password", password],
  ] as const) {
    if (/[\r\n]/.test(value)) errors.push(`The SMTP ${label} cannot contain a line break.`);
  }
  if (host && !/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/.test(host)) {
    errors.push("The SMTP host must be a host name or an IP address.");
  }
  if (from && !isMailAddress(from)) errors.push(`"${from}" is not an email address (the From address).`);
  const bad = recipients.filter((x) => !isMailAddress(x));
  if (bad.length > 0) errors.push(`Not an email address: ${bad.join(", ")}.`);
  if (recipients.length > MAX_RECIPIENTS) errors.push(`At most ${MAX_RECIPIENTS} recipients.`);

  if (enabled) {
    if (!host) errors.push("Set the SMTP host before turning email alerts on.");
    if (!from) errors.push("Set the From address before turning email alerts on.");
    if (recipients.length === 0) errors.push("Add at least one recipient before turning email alerts on.");
  }
  if (user && tls === "none") {
    warnings.push("With security set to none, the SMTP password crosses the network unencrypted.");
  }

  return { settings: { enabled, host, port, tls, user, password, from, recipients, events }, errors, warnings };
}

/** Settings as stored in pyrodeck.json, made safe for use (bad values fall back, never enabled). */
export function sanitizeStoredMail(raw: unknown): MailSettings {
  const check = validateMailSettings(raw, DEFAULT_MAIL_SETTINGS);
  if (check.errors.length === 0) return check.settings;
  return { ...check.settings, enabled: false };
}
