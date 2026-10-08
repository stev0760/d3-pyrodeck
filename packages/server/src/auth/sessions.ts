import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";

/**
 * Login sessions, kept in memory.
 *
 * Each login gets a random id (32 bytes from crypto.randomBytes), carried in
 * the signed `pyrodeck_session` cookie and looked up here on every request.
 * A session ends when it is logged out, when every session is revoked, when
 * it reaches its absolute lifetime (PYRODECK_SESSION_TTL_HOURS, default 12)
 * or when nothing used it for the idle timeout (PYRODECK_SESSION_IDLE_MINUTES,
 * default 120). Ending one runs its listeners, which close the console
 * WebSockets it opened. Nothing is written to disk, so a restart of Pyrodeck
 * logs everyone out.
 */

export const SESSION_COOKIE = "pyrodeck_session";

export const DEFAULT_SESSION_TTL_HOURS = 12;
export const DEFAULT_SESSION_IDLE_MINUTES = 120;

/** Upper bounds for the environment values: a year and a month. */
const MAX_TTL_HOURS = 24 * 365;
const MAX_IDLE_MINUTES = 60 * 24 * 31;

/** How often expired sessions are removed (and their WebSockets closed). */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * More live sessions than this and the least recently used one ends. Only
 * someone with the password can create sessions; the cap keeps a script that
 * logs in on every run from growing the map without bound.
 */
const MAX_SESSIONS = 1000;

/** Close code for a console WebSocket whose session ended (4000-4999 are the application's). */
export const WS_SESSION_ENDED = 4401;

export interface SessionLifetimes {
  /** Absolute lifetime from login, in ms. */
  ttlMs: number;
  /** A session nothing has used for this long ends, in ms. */
  idleMs: number;
}

/** Why a session ended. */
export type SessionEndReason = "logout" | "revoked" | "password" | "expired" | "idle" | "evicted" | "replaced";

/** What the sessions API shows about a session; never its id. */
export interface SessionInfo {
  createdAt: number;
  lastSeenAt: number;
  /** When it ends at the latest: login + lifetime. */
  expiresAt: number;
  /** When it ends if nothing uses it before then. */
  idleExpiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

interface SessionRecord {
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionStoreOptions {
  /** Clock (ms). Default Date.now, which vitest's fake timers also replace. */
  now?: () => number;
  /** Sweep period in ms (default 60 s). */
  sweepIntervalMs?: number;
  maxSessions?: number;
}

type Logger = (message: string) => void;

/**
 * Lifetimes from PYRODECK_SESSION_TTL_HOURS and PYRODECK_SESSION_IDLE_MINUTES.
 * Unset or blank means the default. Either must be a number above 0 (decimals
 * allowed: 0.5 hours) and at most a year or a month; anything else throws, so
 * a typo stops Pyrodeck at startup instead of leaving sessions open longer
 * than intended.
 */
export function parseSessionLifetimes(env: Record<string, string | undefined>): SessionLifetimes {
  const hours = parsePositive(env.PYRODECK_SESSION_TTL_HOURS, "PYRODECK_SESSION_TTL_HOURS", DEFAULT_SESSION_TTL_HOURS, MAX_TTL_HOURS);
  const minutes = parsePositive(
    env.PYRODECK_SESSION_IDLE_MINUTES,
    "PYRODECK_SESSION_IDLE_MINUTES",
    DEFAULT_SESSION_IDLE_MINUTES,
    MAX_IDLE_MINUTES,
  );
  return { ttlMs: Math.round(hours * 3_600_000), idleMs: Math.round(minutes * 60_000) };
}

function parsePositive(raw: string | undefined, name: string, fallback: number, max: number): number {
  const value = (raw ?? "").trim();
  if (value === "") return fallback;
  const n = /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    throw new Error(`${name}: "${value}" is not a number above 0 and at most ${max}.`);
  }
  return n;
}

/** A short, non-secret tag for a session in Pyrodeck's log: the first 8 hex digits of the id's SHA-256. */
export function sessionTag(id: string): string {
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 8);
}

export class SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly listeners = new Map<string, Set<(reason: SessionEndReason) => void>>();
  private lifetimes: SessionLifetimes;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private readonly maxSessions: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private log: Logger = () => {};

  constructor(lifetimes: SessionLifetimes, options: SessionStoreOptions = {}) {
    this.lifetimes = { ...lifetimes };
    this.now = options.now ?? (() => Date.now());
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
  }

  setLifetimes(lifetimes: SessionLifetimes): void {
    this.lifetimes = { ...lifetimes };
  }

  getLifetimes(): SessionLifetimes {
    return { ...this.lifetimes };
  }

  /** Where session ends and sweeps are reported (Pyrodeck's log at info level). */
  setLogger(log: Logger): void {
    this.log = log;
  }

  /** Cookie maxAge in seconds: the absolute lifetime, which no session outlives. */
  cookieMaxAgeSeconds(): number {
    return Math.max(1, Math.floor(this.lifetimes.ttlMs / 1000));
  }

  /** Start a session and return its new id. */
  create(meta: { ip?: string | null; userAgent?: string | null } = {}): string {
    const id = crypto.randomBytes(32).toString("base64url");
    const now = this.now();
    this.records.set(id, {
      createdAt: now,
      lastSeenAt: now,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 200) : null,
    });
    while (this.records.size > this.maxSessions) {
      let oldest: string | null = null;
      let oldestSeen = Infinity;
      for (const [key, rec] of this.records) {
        if (key !== id && rec.lastSeenAt < oldestSeen) {
          oldest = key;
          oldestSeen = rec.lastSeenAt;
        }
      }
      if (oldest === null) break;
      this.end(oldest, "evicted");
    }
    this.ensureSweep();
    return id;
  }

  /**
   * Whether `id` is a live session. A live one is marked as used now (the
   * idle clock restarts); one past its lifetime or idle timeout ends here.
   */
  touch(id: string): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    const now = this.now();
    const expired = this.expiryReason(rec, now);
    if (expired) {
      this.end(id, expired);
      return false;
    }
    rec.lastSeenAt = now;
    return true;
  }

  /** Whether `id` is a live session, without marking it used. */
  isLive(id: string): boolean {
    const rec = this.records.get(id);
    return !!rec && this.expiryReason(rec, this.now()) === null;
  }

  info(id: string): SessionInfo | null {
    const rec = this.records.get(id);
    return rec ? this.toInfo(rec) : null;
  }

  /** Live sessions, most recently used first. */
  list(): Array<SessionInfo & { id: string }> {
    const now = this.now();
    return [...this.records]
      .filter(([, rec]) => this.expiryReason(rec, now) === null)
      .map(([id, rec]) => ({ id, ...this.toInfo(rec) }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  size(): number {
    return this.records.size;
  }

  /** End one session. False when there was none. */
  destroy(id: string, reason: SessionEndReason): boolean {
    if (!this.records.has(id)) return false;
    this.end(id, reason);
    return true;
  }

  /** End every session; returns how many there were. */
  destroyAll(reason: SessionEndReason): number {
    const ids = [...this.records.keys()];
    for (const id of ids) this.end(id, reason);
    return ids.length;
  }

  /**
   * Run `listener` once when session `id` ends, with the reason. Returns the
   * function that removes it (a WebSocket that closes on its own calls it).
   * For an id that is not live, the listener runs at once with "expired".
   */
  onEnd(id: string, listener: (reason: SessionEndReason) => void): () => void {
    if (!this.isLive(id)) {
      listener("expired");
      return () => {};
    }
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(id);
      current?.delete(listener);
      if (current && current.size === 0) this.listeners.delete(id);
    };
  }

  /** End every session past its lifetime or idle timeout; returns how many. */
  sweep(): number {
    const now = this.now();
    let ended = 0;
    for (const [id, rec] of [...this.records]) {
      const reason = this.expiryReason(rec, now);
      if (reason) {
        this.end(id, reason);
        ended++;
      }
    }
    return ended;
  }

  private expiryReason(rec: SessionRecord, now: number): SessionEndReason | null {
    if (now >= rec.createdAt + this.lifetimes.ttlMs) return "expired";
    if (now >= rec.lastSeenAt + this.lifetimes.idleMs) return "idle";
    return null;
  }

  private toInfo(rec: SessionRecord): SessionInfo {
    return {
      createdAt: rec.createdAt,
      lastSeenAt: rec.lastSeenAt,
      expiresAt: rec.createdAt + this.lifetimes.ttlMs,
      idleExpiresAt: Math.min(rec.lastSeenAt + this.lifetimes.idleMs, rec.createdAt + this.lifetimes.ttlMs),
      ip: rec.ip,
      userAgent: rec.userAgent,
    };
  }

  private end(id: string, reason: SessionEndReason): void {
    this.records.delete(id);
    const set = this.listeners.get(id);
    this.listeners.delete(id);
    if (reason !== "logout" && reason !== "replaced") {
      this.log(`Session ${sessionTag(id)} ended (${reason}).`);
    }
    for (const listener of set ?? []) {
      try {
        listener(reason);
      } catch {
        // A listener that throws must not keep the others from running.
      }
    }
    if (this.records.size === 0) this.stopSweep();
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  private stopSweep(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

/** Pyrodeck's sessions. index.ts sets the lifetimes from the environment at startup. */
export const sessions = new SessionStore({
  ttlMs: DEFAULT_SESSION_TTL_HOURS * 3_600_000,
  idleMs: DEFAULT_SESSION_IDLE_MINUTES * 60_000,
});

/** The session id in the request's cookie when its signature checks out, else null. Does not look it up. */
export function sessionIdFromRequest(request: FastifyRequest): string | null {
  const raw = request.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const result = request.unsignCookie(raw);
  return result.valid && result.value ? result.value : null;
}

/**
 * Close `socket` when the session that opened it ends: logout, revocation,
 * lifetime or idle timeout. A socket opened without a session (no password is
 * set, a local browser) is left alone. Returns the id it is bound to, or null.
 */
export function bindSocketToSession(
  socket: { close(code?: number, reason?: string): void; on(event: "close", listener: () => void): unknown },
  request: FastifyRequest,
  store: SessionStore = sessions,
): string | null {
  const id = sessionIdFromRequest(request);
  if (!id || !store.isLive(id)) return null;
  const unbind = store.onEnd(id, (reason) => {
    socket.close(WS_SESSION_ENDED, `Session ended (${reason})`);
  });
  socket.on("close", unbind);
  return id;
}
