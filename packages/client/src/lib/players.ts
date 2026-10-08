/**
 * Player history, bans and join rules (server: routes/players.ts, routes/bans.ts,
 * routes/playerRules.ts).
 */

export interface HistoryRow {
  id: number;
  time: string;
  event: "join" | "leave";
  name: string;
  slot?: number;
  ip?: string;
  bot?: boolean;
  reason?: string;
}

export interface PlayerSession {
  name: string;
  slot?: number;
  ip?: string;
  bot?: boolean;
  joinedAt: string | null;
  leftAt: string | null;
  reason?: string;
}

export interface NameIpEntry {
  name: string;
  ip: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
}

export interface HistoryProfile {
  profileId: string;
  label: string;
  rows: number;
  lastEventAt: string | null;
}

export interface PresentPlayer {
  name: string;
  slot?: number;
  ip?: string;
  bot: boolean;
}

export interface PlayerSettings {
  ipLookup: boolean;
  ipLookupBudget: number;
  hostsDenyPath: string | null;
  rehashOnLevelStart: boolean;
}

export interface HostsLine {
  line: number;
  text: string;
  entry: string | null;
  error: string | null;
  reason?: string;
  addedAt?: string;
  name?: string;
}

export interface HostsDenyView {
  path: string;
  source: "setting" | "server log" | "default";
  exists: boolean;
  lines: HostsLine[];
  allow: { path: string; exists: boolean; entries: string[] };
  error: string | null;
}

export interface NameBan {
  id: string;
  pattern: string;
  reason: string;
  createdAt: string;
}

export interface BansState {
  hostsDeny: HostsDenyView;
  nameBans: NameBan[];
  settings: { hostsDenyPath: string | null; rehashOnLevelStart: boolean };
  detectedLocalDir: string | null;
  consoleIsLocal: boolean | null;
}

export interface NicknameRules {
  enabled: boolean;
  rejectEmpty: boolean;
  rejectPercent: boolean;
  rejectControl: boolean;
  minLength: number;
}

export interface ProfanityRules {
  enabled: boolean;
  words: string[];
  warnings: number;
  kicks: number;
  ban: boolean;
  cooldownSeconds: number;
}

export interface PlayerRules {
  nickname: NicknameRules;
  profanity: ProfanityRules;
}

export interface RuleAction {
  time: string;
  profileId: string;
  name: string;
  rule: "nickname" | "profanity";
  action: "warn" | "kick" | "ban";
  detail: string;
  ok: boolean;
}

export interface Offender {
  name: string;
  offences: number;
  warnings: number;
  kicks: number;
  lastAction: "warn" | "kick" | "ban" | null;
  lastActionAt: string | null;
}

export interface RulesState {
  rules: PlayerRules;
  defaultWords: string[];
  recent: RuleAction[];
  offenders: Offender[];
}

/** GET a JSON endpoint; throws the server's error message. */
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Send JSON with a method; throws the server's error message. */
export async function sendJson<T>(method: "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export function query(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** "2026-10-07 20:15" in local time. */
export function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A value for <input type="datetime-local"> from a Date. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
