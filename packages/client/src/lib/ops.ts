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
