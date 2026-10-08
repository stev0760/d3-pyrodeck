import os from "node:os";
import nodemailer, { type SendMailOptions } from "nodemailer";
import type { ServerEventMap, ServerEventName } from "../events/ServerEvents.js";
import type { MailEventKey, MailSettings } from "./mailSettings.js";

/**
 * Email alerts on server events. Events are described (describeEvent),
 * filtered by the operator's checklist, and batched: one mail lists every
 * event of a burst (a crash and its relaunch arrive together), and no more
 * than one mail goes out per minute.
 */

/** Events the notifier listens to (a subset of the server event bus). */
export const MAILABLE_EVENTS = [
  "server.started",
  "server.stopped",
  "server.crashed",
  "server.hung",
  "player.kicked",
  "player.banned",
  "schedule.skipped",
] as const satisfies readonly ServerEventName[];
export type MailableEventName = (typeof MAILABLE_EVENTS)[number];

export interface DescribedEvent {
  /** Epoch milliseconds. */
  at: number;
  profileId: string | null;
  /** One line, without the time or the profile. */
  text: string;
  /** Checklist entries that select this event; empty means it is never mailed. */
  categories: MailEventKey[];
  /** Identical events (one emitted twice) are listed once per mail. */
  key: string;
}

/** A ban made by the profanity rule rather than an operator or another rule. */
function isProfanityBan(reason: string): boolean {
  return /profan/i.test(reason);
}

function who(name: string | undefined, ip: string | undefined): string {
  if (name && ip) return `${name} (${ip})`;
  return name || ip || "a player";
}

/** Turn a bus event into a mail line and the checklist entries that select it. */
export function describeEvent<K extends MailableEventName>(
  name: K,
  payload: ServerEventMap[K],
  at = Date.now(),
): DescribedEvent {
  const base = { at, profileId: payload.profileId || null, key: `${name}:${JSON.stringify(payload)}` };
  switch (name) {
    case "server.started": {
      const p = payload as ServerEventMap["server.started"];
      if (p.reason === "relaunch") return { ...base, text: `Server relaunched by Pyrodeck (PID ${p.pid})`, categories: ["relaunched"] };
      if (p.reason === "schedule") return { ...base, text: `Server started by the schedule (PID ${p.pid})`, categories: ["started", "schedule"] };
      // Playlist rotations restart the server at every mission change: not mailed.
      if (p.reason === "playlist") return { ...base, text: `Server restarted by the playlist (PID ${p.pid})`, categories: [] };
      return { ...base, text: `Server started (PID ${p.pid})`, categories: ["started"] };
    }
    case "server.stopped": {
      const p = payload as ServerEventMap["server.stopped"];
      if (p.reason === "schedule") return { ...base, text: "Server stopped by the schedule", categories: ["stopped", "schedule"] };
      if (p.reason === "playlist") return { ...base, text: "Server stopped for a playlist restart", categories: [] };
      if (p.reason === "empty-restart") return { ...base, text: "Server stopped for its restart while empty", categories: ["stopped"] };
      return { ...base, text: "Server stopped", categories: ["stopped"] };
    }
    case "server.crashed": {
      const p = payload as ServerEventMap["server.crashed"];
      const how = p.signal ? `signal ${p.signal}` : p.code !== null ? `exit code ${p.code}` : "no exit status";
      return { ...base, text: `Server crashed (${how})`, categories: ["crashed"] };
    }
    case "server.hung": {
      const p = payload as ServerEventMap["server.hung"];
      return { ...base, text: `Server stopped answering its console (${Math.round(p.silentForMs / 1000)} s)`, categories: ["hung"] };
    }
    case "player.kicked": {
      const p = payload as ServerEventMap["player.kicked"];
      return { ...base, text: `Kicked ${who(p.name, p.ip)}: ${p.reason}`, categories: ["kicked"] };
    }
    case "player.banned": {
      const p = payload as ServerEventMap["player.banned"];
      const until = p.until ? ` until ${p.until}` : "";
      const profane = isProfanityBan(p.reason);
      return {
        ...base,
        text: `${profane ? "Profanity ban" : "Banned"}: ${who(p.name, p.ip)}${until}: ${p.reason}`,
        categories: [profane ? "profanityBan" : "banned"],
      };
    }
    case "schedule.skipped": {
      const p = payload as ServerEventMap["schedule.skipped"];
      return { ...base, text: `Scheduled ${p.action} skipped: ${p.reason}`, categories: ["schedule"] };
    }
  }
  return { ...base, text: name, categories: [] };
}

/** Whether the checklist selects this event. */
export function isSelected(event: DescribedEvent, events: Record<MailEventKey, boolean>): boolean {
  return event.categories.some((c) => events[c]);
}

function localStamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface ComposedMail {
  subject: string;
  text: string;
}

/**
 * Subject and body for one batch. `profileNames` maps profile IDs to names;
 * `dropped` counts events past MAX_BATCH_EVENTS.
 */
export function composeMail(
  events: readonly DescribedEvent[],
  profileNames: ReadonlyMap<string, string>,
  opts: { host?: string; dropped?: number } = {},
): ComposedMail {
  const host = opts.host ?? os.hostname();
  const dropped = opts.dropped ?? 0;
  const label = (e: DescribedEvent) => (e.profileId ? profileNames.get(e.profileId) ?? e.profileId : null);
  const first = events[0];
  const firstLabel = first ? label(first) : null;
  const more = events.length + dropped > 1 ? ` (+${events.length + dropped - 1} more)` : "";
  const subject = `[Pyrodeck ${host}] ${firstLabel ? `${firstLabel}: ` : ""}${first?.text ?? "No events"}${more}`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = events.map((e) => {
    const l = label(e);
    return `${localStamp(e.at)}  ${l ? `[${l}] ` : ""}${e.text}`;
  });
  const text = [
    `Pyrodeck on ${host} reports:`,
    "",
    ...lines,
    ...(dropped > 0 ? [`… and ${dropped} more event${dropped === 1 ? "" : "s"}.`] : []),
    "",
    `Times are ${tz} (the Pyrodeck machine's clock).`,
    "Choose which events are mailed under Settings > Email alerts.",
    "",
  ].join("\n");
  return { subject, text };
}

/** Max events kept in one batch; more are counted, not listed. */
export const MAX_BATCH_EVENTS = 50;

export interface MailBatcherOptions {
  /** At most one mail per this many ms (default 60 s). */
  minIntervalMs?: number;
  /** Wait this long after the first event of a burst for the rest of it (default 10 s). */
  gatherMs?: number;
  send(events: DescribedEvent[], dropped: number): Promise<void>;
}

/**
 * Collects events and sends them in batches: a burst goes out `gatherMs`
 * after its first event, and never sooner than `minIntervalMs` after the
 * previous mail.
 */
export class MailBatcher {
  private queue: DescribedEvent[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = -Infinity;
  private readonly minIntervalMs: number;
  private readonly gatherMs: number;

  constructor(private opts: MailBatcherOptions) {
    this.minIntervalMs = opts.minIntervalMs ?? 60_000;
    this.gatherMs = opts.gatherMs ?? 10_000;
  }

  push(event: DescribedEvent): void {
    if (this.queue.some((e) => e.key === event.key)) return;
    if (this.queue.length >= MAX_BATCH_EVENTS) {
      this.dropped++;
    } else {
      this.queue.push(event);
    }
    this.schedule();
  }

  pending(): number {
    return this.queue.length + this.dropped;
  }

  /** Drop anything queued (alerts turned off). */
  clear(): void {
    this.queue = [];
    this.dropped = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer) return;
    const delay = Math.max(this.gatherMs, this.lastSentAt + this.minIntervalMs - Date.now());
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.queue.length === 0) return;
    const batch = this.queue;
    const dropped = this.dropped;
    this.queue = [];
    this.dropped = 0;
    this.lastSentAt = Date.now();
    try {
      await this.opts.send(batch, dropped);
    } finally {
      if (this.queue.length > 0) this.schedule();
    }
  }
}

/** nodemailer transport options for the settings. Timeouts keep a dead SMTP host from hanging a send. */
export function smtpTransportOptions(s: MailSettings) {
  return {
    host: s.host,
    port: s.port,
    secure: s.tls === "tls",
    requireTLS: s.tls === "starttls",
    ignoreTLS: s.tls === "none",
    auth: s.user ? { user: s.user, pass: s.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

export interface SendResult {
  ok: boolean;
  messageId: string | null;
  accepted: string[];
  rejected: string[];
  error: string | null;
}

/** The part of a nodemailer transport sendMail needs (tests pass a jsonTransport). */
export interface MailTransport {
  sendMail(data: SendMailOptions): Promise<{ messageId?: unknown; accepted?: unknown; rejected?: unknown }>;
}

/** Send one mail. Errors come back in the result; the message never includes the password. */
export async function sendMail(
  settings: MailSettings,
  mail: ComposedMail,
  transport: MailTransport = nodemailer.createTransport(smtpTransportOptions(settings)),
): Promise<SendResult> {
  try {
    const info = await transport.sendMail({
      from: settings.from,
      to: settings.recipients,
      subject: mail.subject,
      text: mail.text,
    });
    const addr = (list: unknown) =>
      Array.isArray(list) ? list.map((a) => (typeof a === "string" ? a : String((a as { address?: string }).address))) : [];
    return {
      ok: true,
      messageId: typeof info.messageId === "string" ? info.messageId : null,
      accepted: addr(info.accepted),
      rejected: addr(info.rejected),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, messageId: null, accepted: [], rejected: [], error: message };
  }
}
