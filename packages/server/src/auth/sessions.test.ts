import { describe, it, expect, afterEach, vi } from "vitest";
import {
  SessionStore,
  WS_SESSION_ENDED,
  bindSocketToSession,
  parseSessionLifetimes,
  sessionTag,
  type SessionEndReason,
} from "./sessions.js";
import type { FastifyRequest } from "fastify";

const HOUR = 3_600_000;
const MINUTE = 60_000;

function store(options: { ttlMs?: number; idleMs?: number; maxSessions?: number } = {}): SessionStore {
  return new SessionStore(
    { ttlMs: options.ttlMs ?? 12 * HOUR, idleMs: options.idleMs ?? 120 * MINUTE },
    { maxSessions: options.maxSessions },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseSessionLifetimes", () => {
  it("defaults to 12 hours and 120 minutes", () => {
    expect(parseSessionLifetimes({})).toEqual({ ttlMs: 12 * HOUR, idleMs: 120 * MINUTE });
    expect(parseSessionLifetimes({ PYRODECK_SESSION_TTL_HOURS: " ", PYRODECK_SESSION_IDLE_MINUTES: "" })).toEqual({
      ttlMs: 12 * HOUR,
      idleMs: 120 * MINUTE,
    });
  });

  it("reads both variables, decimals included", () => {
    expect(parseSessionLifetimes({ PYRODECK_SESSION_TTL_HOURS: "0.5", PYRODECK_SESSION_IDLE_MINUTES: "15" })).toEqual({
      ttlMs: 30 * MINUTE,
      idleMs: 15 * MINUTE,
    });
  });

  it.each(["0", "-1", "abc", "12h", "1e3", "Infinity", "9000"])("refuses PYRODECK_SESSION_TTL_HOURS=%s", (value) => {
    expect(() => parseSessionLifetimes({ PYRODECK_SESSION_TTL_HOURS: value })).toThrow(/PYRODECK_SESSION_TTL_HOURS/);
  });

  it.each(["0", "-5", "two", "50000"])("refuses PYRODECK_SESSION_IDLE_MINUTES=%s", (value) => {
    expect(() => parseSessionLifetimes({ PYRODECK_SESSION_IDLE_MINUTES: value })).toThrow(/PYRODECK_SESSION_IDLE_MINUTES/);
  });
});

describe("SessionStore", () => {
  it("issues a fresh random 32-byte id per session", () => {
    const s = store();
    const ids = new Set(Array.from({ length: 50 }, () => s.create()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
      expect(Buffer.from(id, "base64url")).toHaveLength(32);
    }
    expect(s.touch("1")).toBe(false); // the 0.5.1 constant is not a session
  });

  it("ends a session nothing used for the idle timeout, and use restarts the clock", () => {
    vi.useFakeTimers();
    const s = store({ idleMs: 120 * MINUTE });
    const id = s.create();
    vi.advanceTimersByTime(119 * MINUTE);
    expect(s.touch(id)).toBe(true);
    vi.advanceTimersByTime(119 * MINUTE);
    expect(s.touch(id)).toBe(true);
    vi.advanceTimersByTime(120 * MINUTE);
    expect(s.touch(id)).toBe(false);
    expect(s.size()).toBe(0);
  });

  it("ends a session at its absolute lifetime however busy it is", () => {
    vi.useFakeTimers();
    const s = store({ ttlMs: 12 * HOUR, idleMs: 120 * MINUTE });
    const id = s.create();
    for (let t = 0; t < 11 * 60 + 59; t += 30) {
      expect(s.touch(id)).toBe(true);
      vi.advanceTimersByTime(30 * MINUTE);
    }
    vi.advanceTimersByTime(MINUTE);
    expect(s.touch(id)).toBe(false);
  });

  it("sweeps expired sessions on its own timer and tells their listeners why", () => {
    vi.useFakeTimers();
    const s = store({ ttlMs: 12 * HOUR, idleMs: 30 * MINUTE });
    const idle = s.create();
    const reasons: SessionEndReason[] = [];
    s.onEnd(idle, (r) => reasons.push(r));
    vi.advanceTimersByTime(30 * MINUTE + 60_000);
    expect(reasons).toEqual(["idle"]);
    expect(s.size()).toBe(0);

    const busy = s.create();
    s.onEnd(busy, (r) => reasons.push(r));
    for (let i = 0; i < 12 * 4; i++) {
      vi.advanceTimersByTime(15 * MINUTE);
      s.touch(busy);
    }
    vi.advanceTimersByTime(60_000);
    expect(reasons).toEqual(["idle", "expired"]);
  });

  it("runs the listeners of a destroyed session once, and not after they are removed", () => {
    const s = store();
    const a = s.create();
    const b = s.create();
    const seen: string[] = [];
    s.onEnd(a, (r) => seen.push(`a:${r}`));
    const unbind = s.onEnd(b, (r) => seen.push(`b:${r}`));
    unbind();
    expect(s.destroy(a, "logout")).toBe(true);
    expect(s.destroy(a, "logout")).toBe(false);
    expect(s.destroyAll("revoked")).toBe(1);
    expect(seen).toEqual(["a:logout"]);
  });

  it("calls a listener at once for a session that is already gone", () => {
    const s = store();
    const listener = vi.fn();
    s.onEnd("no-such-session", listener);
    expect(listener).toHaveBeenCalledWith("expired");
  });

  it("revokes every session at once", () => {
    const s = store();
    const ids = [s.create(), s.create(), s.create()];
    expect(s.destroyAll("revoked")).toBe(3);
    for (const id of ids) expect(s.touch(id)).toBe(false);
  });

  it("drops the least recently used session past the cap", () => {
    vi.useFakeTimers();
    const s = store({ maxSessions: 3 });
    const first = s.create();
    vi.advanceTimersByTime(1000);
    const second = s.create();
    vi.advanceTimersByTime(1000);
    const third = s.create();
    vi.advanceTimersByTime(1000);
    s.touch(first);
    const fourth = s.create();
    expect(s.size()).toBe(3);
    expect(s.isLive(second)).toBe(false);
    for (const id of [first, third, fourth]) expect(s.isLive(id)).toBe(true);
  });

  it("lists live sessions without their ids' secrets leaking into the info", () => {
    vi.useFakeTimers();
    const s = store({ ttlMs: 12 * HOUR, idleMs: 120 * MINUTE });
    const id = s.create({ ip: "203.0.113.5", userAgent: "Firefox" });
    const info = s.info(id)!;
    expect(info).toMatchObject({ ip: "203.0.113.5", userAgent: "Firefox" });
    expect(info.expiresAt - info.createdAt).toBe(12 * HOUR);
    expect(info.idleExpiresAt - info.lastSeenAt).toBe(120 * MINUTE);
    expect(JSON.stringify(info)).not.toContain(id);
    expect(s.list().map((x) => x.id)).toEqual([id]);
  });

  it("keeps the cookie's maxAge equal to the absolute lifetime", () => {
    expect(store({ ttlMs: 12 * HOUR }).cookieMaxAgeSeconds()).toBe(43_200);
    expect(store({ ttlMs: 30 * MINUTE }).cookieMaxAgeSeconds()).toBe(1800);
  });

  it("logs a session's end by a short tag, never by its id", () => {
    const s = store();
    const lines: string[] = [];
    s.setLogger((m) => lines.push(m));
    const id = s.create();
    s.destroyAll("revoked");
    expect(lines).toEqual([`Session ${sessionTag(id)} ended (revoked).`]);
    expect(lines.join("")).not.toContain(id);
  });
});

describe("bindSocketToSession", () => {
  function fakeRequest(cookie: string | undefined): FastifyRequest {
    return {
      cookies: cookie === undefined ? {} : { pyrodeck_session: cookie },
      unsignCookie: (raw: string) => (raw.startsWith("signed:") ? { valid: true, renew: false, value: raw.slice(7) } : { valid: false, renew: false, value: null }),
    } as unknown as FastifyRequest;
  }

  function fakeSocket() {
    const closeListeners: Array<() => void> = [];
    return {
      closed: null as { code?: number; reason?: string } | null,
      close(code?: number, reason?: string) {
        this.closed = { code, reason };
        for (const l of closeListeners) l();
      },
      on(_event: "close", listener: () => void) {
        closeListeners.push(listener);
      },
    };
  }

  it("closes the socket with 4401 when its session ends", () => {
    const s = store();
    const id = s.create();
    const socket = fakeSocket();
    expect(bindSocketToSession(socket, fakeRequest(`signed:${id}`), s)).toBe(id);
    s.destroy(id, "logout");
    expect(socket.closed).toEqual({ code: WS_SESSION_ENDED, reason: "Session ended (logout)" });
  });

  it("leaves a socket without a session (no password, a local browser) alone", () => {
    const s = store();
    const socket = fakeSocket();
    expect(bindSocketToSession(socket, fakeRequest(undefined), s)).toBeNull();
    expect(bindSocketToSession(socket, fakeRequest("unsigned-value"), s)).toBeNull();
    s.destroyAll("revoked");
    expect(socket.closed).toBeNull();
  });

  it("forgets a socket that closed by itself", () => {
    const s = store();
    const id = s.create();
    const socket = fakeSocket();
    bindSocketToSession(socket, fakeRequest(`signed:${id}`), s);
    socket.close(1000, "bye");
    socket.closed = null;
    s.destroy(id, "logout");
    expect(socket.closed).toBeNull();
  });
});
