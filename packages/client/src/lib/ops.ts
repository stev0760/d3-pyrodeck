/** Operations settings and state, as the server's operations routes send them. */

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface ScheduleWindow {
  /** 0 = Sunday … 6 = Saturday. */
  day: number;
  /** "HH:MM", Pyrodeck machine's local time. */
  start: string;
  /** "HH:MM"; at or before start = the next day. */
  end: string;
}

export interface ProfileSchedule {
  enabled: boolean;
  windows: ScheduleWindow[];
  stopWaitMinutes: number;
}

export interface ScheduleEntry {
  profileId: string;
  name: string;
  enabled: boolean;
  next: { action: "start" | "stop"; at: number; atLocal: string } | null;
  pendingStop: { deadline: number; deadlineLocal: string } | null;
}

export interface ScheduleState {
  timeZone: string;
  now: string;
  entries: ScheduleEntry[];
}

export type MailTlsMode = "none" | "starttls" | "tls";

export const MAIL_EVENTS = [
  { key: "started", label: "Server started" },
  { key: "stopped", label: "Server stopped" },
  { key: "crashed", label: "Server crashed" },
  { key: "hung", label: "Server hung" },
  { key: "relaunched", label: "Server relaunched" },
  { key: "kicked", label: "Player kicked" },
  { key: "banned", label: "Player banned" },
  { key: "profanityBan", label: "Profanity ban" },
  { key: "schedule", label: "Schedule actions" },
] as const;
export type MailEventKey = (typeof MAIL_EVENTS)[number]["key"];

export interface MailSettingsView {
  enabled: boolean;
  host: string;
  port: number;
  tls: MailTlsMode;
  user: string;
  passwordSet: boolean;
  from: string;
  recipients: string[];
  events: Record<MailEventKey, boolean>;
}

export interface MailStatus {
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  pending: number;
}

export interface MailState {
  settings: MailSettingsView;
  status: MailStatus;
}

export interface MailTestResult {
  ok: boolean;
  messageId: string | null;
  accepted: string[];
  rejected: string[];
  error: string | null;
}

export type PriorityClass = "below-normal" | "normal" | "above-normal" | "high";

export interface PriorityState {
  priorityClass: PriorityClass;
  platform: string;
  last: {
    pid: number;
    priorityClass: PriorityClass;
    value: number;
    applied: number;
    warning: string | null;
  } | null;
}

export interface UpdateStatus {
  enabled: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  url: string | null;
  checkedAt: string | null;
}

export interface LaunchScriptPreview {
  script: {
    shell: "cmd" | "sh";
    commandLine: string | null;
    executable: string | null;
    workingDir: string | null;
    args: string[];
    flags: Record<string, string | true>;
    priorityHint: PriorityClass | null;
    warnings: string[];
  };
  profile: {
    name: string;
    gamePath: string | null;
    executablePath: string | null;
    configFile: string | null;
    importedArgs: string[];
    notes: string[];
  };
  checks: Record<"gamePath" | "executable" | "configFile", { valid: boolean; errors: string[] }>;
}

/** GET a JSON resource; null on any failure. */
export async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { credentials: "include" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Send JSON; resolves to the parsed body, or { error } when the request failed. */
export async function sendJson<T>(
  method: "POST" | "PUT",
  url: string,
  body: unknown,
): Promise<{ data: T; error: null } | { data: null; error: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { data: null, error: (data as { error?: string }).error ?? `Request failed (${res.status})` };
    return { data: data as T, error: null };
  } catch {
    return { data: null, error: "Request failed" };
  }
}
