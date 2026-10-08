import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebSocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { requireAuth } from "./requireAuth.js";
import { authRoutes } from "../routes/auth.js";
import { WS_SESSION_ENDED, bindSocketToSession, parseSessionLifetimes, sessions } from "../auth/sessions.js";

/**
 * Real sessions (0.5.2): a random id per login kept on the server, ended by
 * logout, by "log out all sessions", by setting the password, by its absolute
 * lifetime and by its idle timeout, with the console WebSockets it opened
 * closed when it ends. Wired as index.ts wires it; the stored config is kept
 * in memory.
 */
const mocks = vi.hoisted(() => ({ config: {} as { adminPasswordHash?: string } }));
vi.mock("../routes/pyrodeck-config.js", () => ({
  pyrodeckConfig: {
    get: () => mocks.config,
    save: async (updates: Record<string, unknown>) => Object.assign(mocks.config, updates),
  },
}));

const PASSWORD = "correct horse battery";
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Each login gets its own address: the login rate limiter outlives a test. */
let nextHost = 1;
const freshClient = () => `198.51.100.${nextHost++}`;

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(fastifyCookie, { secret: "test-session-secret" });
  await instance.register(fastifyWebSocket);
  await instance.register(authRoutes);
  instance.get("/api/thing", async () => ({ ok: true }));
  // As routes/command.ts binds the console socket.
  instance.get("/ws", { websocket: true }, (socket, request) => {
    bindSocketToSession(socket, request);
  });
  instance.addHook("onRequest", requireAuth);
  await instance.ready();
  return instance;
}

function setCookie(res: LightMyRequestResponse): string {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
}

/** Log in from a fresh address; returns the `pyrodeck_session=...` pair and the full Set-Cookie. */
async function login(extraCookie?: string): Promise<{ cookie: string; header: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: freshClient(),
    headers: { host: "panel.example.com", ...(extraCookie ? { cookie: extraCookie } : {}) },
    payload: { password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  const header = setCookie(res);
  return { cookie: header.split(";")[0], header };
}

function get(url: string, cookie?: string) {
  return app.inject({ url, headers: { host: "panel.example.com", ...(cookie ? { cookie } : {}) } });
}

/** Resolve with the close code of a WebSocket. */
function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

beforeEach(async () => {
  mocks.config = {};
  vi.stubEnv("PYRODECK_ADMIN_PASSWORD", PASSWORD);
  sessions.setLifetimes({ ttlMs: 12 * HOUR, idleMs: 120 * MINUTE });
  app = await buildApp();
});

afterEach(async () => {
  sessions.destroyAll("revoked");
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await app.close();
});

describe("login", () => {
  it("issues a random session id, not the constant 1, with a cookie that lasts the absolute lifetime", async () => {
    const a = await login();
    const b = await login();
    expect(a.cookie).not.toEqual(b.cookie);
    const id = app.unsignCookie(decodeURIComponent(a.cookie.split("=")[1]));
    expect(id.valid).toBe(true);
    expect(id.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.header).toMatch(/Max-Age=43200/);
    expect(a.header).toMatch(/HttpOnly/);
    expect(a.header).toMatch(/SameSite=Strict/);
    expect((await get("/api/thing", a.cookie)).statusCode).toBe(200);
  });

  it("refuses the 0.5.1 cookie, a correctly signed constant 1", async () => {
    const forged = `pyrodeck_session=${encodeURIComponent(app.signCookie("1"))}`;
    expect((await get("/api/thing", forged)).statusCode).toBe(401);
    expect((await get("/api/auth/check", forged)).statusCode).toBe(401);
  });

  it("sets the cookie's Max-Age from PYRODECK_SESSION_TTL_HOURS", async () => {
    sessions.setLifetimes({ ttlMs: 2 * HOUR, idleMs: 30 * MINUTE });
    expect((await login()).header).toMatch(/Max-Age=7200/);
  });

  it("issues a new id when the browser already carries one (session fixation), and ends the old one", async () => {
    const planted = await login(); // e.g. an id an attacker obtained and planted in the victim's browser
    const fresh = await login(planted.cookie);
    expect(fresh.cookie).not.toEqual(planted.cookie);
    expect((await get("/api/thing", planted.cookie)).statusCode).toBe(401);
    expect((await get("/api/thing", fresh.cookie)).statusCode).toBe(200);
    expect(sessions.size()).toBe(1);
  });

  it("does not adopt a made-up id offered before login", async () => {
    const madeUp = `pyrodeck_session=${encodeURIComponent(app.signCookie("attacker-chosen-id"))}`;
    const fresh = await login(madeUp);
    expect(fresh.cookie).not.toEqual(madeUp);
    expect((await get("/api/thing", madeUp)).statusCode).toBe(401);
  });
});

describe("logout and revocation", () => {
  it("logout ends the session on the server, so a copy of the cookie stops working", async () => {
    const { cookie } = await login();
    const res = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { host: "panel.example.com", cookie } });
    expect(res.statusCode).toBe(200);
    expect(setCookie(res)).toMatch(/pyrodeck_session=;/);
    expect((await get("/api/thing", cookie)).statusCode).toBe(401);
    expect((await get("/api/auth/check", cookie)).json()).toMatchObject({ authenticated: false, required: true });
  });

  it("DELETE /api/sessions logs out every session, the caller's included", async () => {
    const laptop = await login();
    const phone = await login();
    const res = await app.inject({ method: "DELETE", url: "/api/sessions", headers: { host: "panel.example.com", cookie: phone.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, revoked: 2 });
    expect(setCookie(res)).toMatch(/pyrodeck_session=;/);
    expect((await get("/api/thing", laptop.cookie)).statusCode).toBe(401);
    expect((await get("/api/thing", phone.cookie)).statusCode).toBe(401);
  });

  it("DELETE /api/sessions needs a session itself", async () => {
    await login();
    const res = await app.inject({ method: "DELETE", url: "/api/sessions", headers: { host: "panel.example.com" } });
    expect(res.statusCode).toBe(401);
    expect(sessions.size()).toBe(1);
  });

  it("GET /api/sessions lists the live sessions without their ids and marks the caller's", async () => {
    const mine = await login();
    await login();
    const res = await get("/api/sessions", mine.cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ttlHours: 12, idleMinutes: 120 });
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const id = app.unsignCookie(decodeURIComponent(mine.cookie.split("=")[1])).value!;
    expect(res.body).not.toContain(id);
  });

  it("setting the admin password ends every session that exists", async () => {
    vi.unstubAllEnvs(); // no password yet: first-run setup
    const leftover = sessions.create();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      remoteAddress: "127.0.0.1",
      headers: { host: "localhost:3001" },
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(sessions.isLive(leftover)).toBe(false);
    expect(sessions.size()).toBe(1);
    const cookie = setCookie(res).split(";")[0];
    expect((await get("/api/thing", cookie)).statusCode).toBe(200);
  });
});

describe("expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  it("ends a session after PYRODECK_SESSION_IDLE_MINUTES without a request", async () => {
    const { cookie } = await login();
    vi.advanceTimersByTime(119 * MINUTE);
    expect((await get("/api/thing", cookie)).statusCode).toBe(200);
    vi.advanceTimersByTime(119 * MINUTE); // the request above restarted the idle clock
    expect((await get("/api/thing", cookie)).statusCode).toBe(200);
    vi.advanceTimersByTime(120 * MINUTE);
    expect((await get("/api/thing", cookie)).statusCode).toBe(401);
  });

  it("ends a busy session at PYRODECK_SESSION_TTL_HOURS", async () => {
    const { cookie } = await login();
    for (let i = 0; i < 11; i++) {
      vi.advanceTimersByTime(HOUR);
      expect((await get("/api/thing", cookie)).statusCode).toBe(200);
    }
    vi.advanceTimersByTime(HOUR);
    expect((await get("/api/thing", cookie)).statusCode).toBe(401);
    expect((await get("/api/auth/check", cookie)).statusCode).toBe(401);
  });

  it("honours short lifetimes from the environment", async () => {
    sessions.setLifetimes(parseSessionLifetimes({ PYRODECK_SESSION_TTL_HOURS: "1", PYRODECK_SESSION_IDLE_MINUTES: "5" }));
    const { cookie } = await login();
    vi.advanceTimersByTime(5 * MINUTE);
    expect((await get("/api/thing", cookie)).statusCode).toBe(401);
  });
});

describe("/ws and the session that opened it", () => {
  async function openWs(cookie: string): Promise<WebSocket> {
    return app.injectWS("/ws", { headers: { host: "panel.example.com", cookie } });
  }

  it("refuses a handshake whose session has ended", async () => {
    const { cookie } = await login();
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { host: "panel.example.com", cookie } });
    await expect(openWs(cookie)).rejects.toThrow(/401/);
  });

  it("closes the socket with 4401 on logout", async () => {
    const { cookie } = await login();
    const ws = await openWs(cookie);
    const closed = closeCode(ws);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { host: "panel.example.com", cookie } });
    expect(await closed).toBe(WS_SESSION_ENDED);
  });

  it("closes every session's sockets on log out all sessions", async () => {
    const a = await login();
    const b = await login();
    const wsA = await openWs(a.cookie);
    const wsB = await openWs(b.cookie);
    const closed = Promise.all([closeCode(wsA), closeCode(wsB)]);
    await app.inject({ method: "DELETE", url: "/api/sessions", headers: { host: "panel.example.com", cookie: a.cookie } });
    expect(await closed).toEqual([WS_SESSION_ENDED, WS_SESSION_ENDED]);
  });

  it("closes the socket when its session times out, and leaves other sessions' sockets open", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stale = await login();
    const ws = await openWs(stale.cookie);
    const closed = closeCode(ws);
    vi.advanceTimersByTime(100 * MINUTE);
    const active = await login();
    const other = await openWs(active.cookie);
    vi.advanceTimersByTime(30 * MINUTE); // stale: 130 min unused; active: 30
    expect(sessions.sweep()).toBe(1); // what the store's 60 s timer runs
    expect(await closed).toBe(WS_SESSION_ENDED);
    expect(other.readyState).toBe(other.OPEN);
    other.terminate();
  });
});
