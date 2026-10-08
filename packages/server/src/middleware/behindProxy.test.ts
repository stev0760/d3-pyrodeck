import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebSocket from "@fastify/websocket";
import { isLocalRequest, parseTrustProxy } from "./requestSource.js";
import { requireAuth } from "./requireAuth.js";
import { authRoutes } from "../routes/auth.js";

/**
 * Pyrodeck behind a reverse proxy (nginx on the same machine), wired as
 * index.ts wires it: trustProxy from PYRODECK_TRUST_PROXY, the cookie and
 * WebSocket plugins, the auth routes, and requireAuth added last. The stored
 * config (the admin password hash) is kept in memory.
 */
const mocks = vi.hoisted(() => ({ config: {} as { adminPasswordHash?: string } }));
vi.mock("../routes/pyrodeck-config.js", () => ({
  pyrodeckConfig: {
    get: () => mocks.config,
    save: async (updates: Record<string, unknown>) => Object.assign(mocks.config, updates),
  },
}));

const PASSWORD = "correct horse battery";
/** Each test's clients get their own addresses: the login rate limiter outlives a test. */
let nextHost = 1;
const freshClient = () => `203.0.113.${nextHost++}`;

async function buildApp(trustProxyEnv: string | undefined): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: parseTrustProxy(trustProxyEnv) });
  await app.register(fastifyCookie, { secret: "test-session-secret" });
  await app.register(fastifyWebSocket);
  await app.register(authRoutes);
  // Not under a protected prefix: reports what Pyrodeck reads from the request.
  app.get("/test/source", async (request) => ({
    ip: request.ip,
    local: isLocalRequest(request),
    protocol: request.protocol,
  }));
  app.get("/api/thing", async () => ({ ok: true }));
  app.get("/ws", { websocket: true }, (socket) => socket.close());
  app.addHook("onRequest", requireAuth);
  await app.ready();
  return app;
}

/** What nginx sends for a browser at `client` (proxy_set_header lines in docs/behind-a-reverse-proxy.md). */
function viaNginx(client: string, extra: Record<string, string> = {}): Pick<InjectOptions, "remoteAddress" | "headers"> {
  return {
    remoteAddress: "127.0.0.1",
    headers: {
      host: "panel.example.com",
      "x-real-ip": client,
      "x-forwarded-for": client,
      "x-forwarded-proto": "https",
      ...extra,
    },
  };
}

function setCookieHeader(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
}

let app: FastifyInstance;

beforeEach(() => {
  mocks.config = {};
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await app?.close();
});

describe("PYRODECK_TRUST_PROXY=1 (nginx on this machine)", () => {
  beforeEach(async () => {
    app = await buildApp("1");
  });

  it("reads the client from the right-most untrusted X-Forwarded-For entry, so a spoofed 127.0.0.1 is ignored", async () => {
    const res = await app.inject({
      url: "/test/source",
      remoteAddress: "127.0.0.1",
      headers: { host: "panel.example.com", "x-forwarded-for": "127.0.0.1, 203.0.113.9" },
    });
    expect(res.json()).toMatchObject({ ip: "203.0.113.9", local: false });
  });

  it("does not let a client that reaches Pyrodeck's port directly speak for the proxy", async () => {
    const res = await app.inject({
      url: "/test/source",
      remoteAddress: "198.51.100.4",
      headers: { host: "localhost", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https" },
    });
    expect(res.json()).toEqual({ ip: "198.51.100.4", local: false, protocol: "http" });
  });

  it("treats a browser on this machine that goes through the proxy as remote", async () => {
    const res = await app.inject({ url: "/test/source", ...viaNginx("127.0.0.1") });
    expect(res.json()).toMatchObject({ ip: "127.0.0.1", local: false, protocol: "https" });
  });

  it("keeps the protected API closed to proxied clients while no password is set", async () => {
    const spoofed = await app.inject({ url: "/api/thing", ...viaNginx("127.0.0.1, 203.0.113.9") });
    expect(spoofed.statusCode).toBe(401);
    const local = await app.inject({ url: "/api/thing", ...viaNginx("127.0.0.1") });
    expect(local.statusCode).toBe(401);
  });

  it("still opens it to a direct local browser (an SSH tunnel) with no password", async () => {
    const res = await app.inject({ url: "/api/thing", remoteAddress: "127.0.0.1", headers: { host: "localhost:3001" } });
    expect(res.statusCode).toBe(200);
  });

  it("refuses first-run setup for a proxied remote client, and for a spoofed local one", async () => {
    for (const xff of ["203.0.113.9", "127.0.0.1, 203.0.113.9", "127.0.0.1"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: { password: PASSWORD },
        ...viaNginx(xff),
      });
      expect(res.statusCode).toBe(403);
    }
    expect(mocks.config.adminPasswordHash).toBeUndefined();
  });

  it("allows setup from a direct local browser", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      remoteAddress: "127.0.0.1",
      headers: { host: "localhost:3001" },
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.config.adminPasswordHash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it("marks the session cookie Secure under X-Forwarded-Proto: https, and it opens the API", async () => {
    vi.stubEnv("PYRODECK_ADMIN_PASSWORD", PASSWORD);
    const client = freshClient();
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD }, ...viaNginx(client) });
    expect(login.statusCode).toBe(200);
    const cookie = setCookieHeader(login);
    expect(cookie).toMatch(/^pyrodeck_session=/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Strict/);

    const session = cookie.split(";")[0];
    const api = await app.inject({ url: "/api/thing", ...viaNginx(client, { cookie: session }) });
    expect(api.statusCode).toBe(200);

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", ...viaNginx(client, { cookie: session }) });
    expect(setCookieHeader(logout)).toMatch(/; Secure/);
  });

  it("keys the login rate limit on the real client, not the proxy", async () => {
    vi.stubEnv("PYRODECK_ADMIN_PASSWORD", PASSWORD);
    const attacker = freshClient();
    const bad = (xff: string) =>
      app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong" }, ...viaNginx(xff) });
    for (let i = 0; i < 5; i++) expect((await bad(attacker)).statusCode).toBe(401);
    expect((await bad(attacker)).statusCode).toBe(429);
    // A forged left-most entry does not give the attacker a new bucket...
    expect((await bad(`198.51.100.77, ${attacker}`)).statusCode).toBe(429);
    // ...and the operator, from another address, is not locked out.
    const operator = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: PASSWORD },
      ...viaNginx(freshClient()),
    });
    expect(operator.statusCode).toBe(200);
  });

  it("counts an IPv6 client's whole /64 as one client", async () => {
    vi.stubEnv("PYRODECK_ADMIN_PASSWORD", PASSWORD);
    const bad = (ip: string) =>
      app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong" }, ...viaNginx(ip) });
    for (let i = 1; i <= 5; i++) expect((await bad(`2001:db8:77:1::${i}`)).statusCode).toBe(401);
    expect((await bad("2001:db8:77:1::ffff")).statusCode).toBe(429);
    expect((await bad("2001:db8:77:2::1")).statusCode).toBe(401);
  });

  it("refuses a cross-site browser request and points at the Host header when the proxy drops it", async () => {
    vi.stubEnv("PYRODECK_ADMIN_PASSWORD", PASSWORD);
    const evil = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: PASSWORD },
      ...viaNginx(freshClient(), { origin: "https://evil.example" }),
    });
    expect(evil.statusCode).toBe(403);
    const sameSite = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: PASSWORD },
      ...viaNginx(freshClient(), { origin: "https://panel.example.com" }),
    });
    expect(sameSite.statusCode).toBe(200);
    const noHost = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: PASSWORD },
      ...viaNginx(freshClient(), { origin: "https://panel.example.com", host: "127.0.0.1:3001" }),
    });
    expect(noHost.statusCode).toBe(403);
    expect(noHost.json().error).toMatch(/proxy_set_header Host \$host/);
  });
});

describe("PYRODECK_TRUST_PROXY unset", () => {
  beforeEach(async () => {
    app = await buildApp(undefined);
  });

  it("never reads a forwarded request as local, whichever header gave the proxy away", async () => {
    for (const headers of [
      { "x-forwarded-for": "203.0.113.9" },
      { "x-forwarded-for": "127.0.0.1" },
      { "x-real-ip": "203.0.113.9" },
      { forwarded: "for=203.0.113.9;proto=https" },
    ]) {
      const source = await app.inject({ url: "/test/source", remoteAddress: "127.0.0.1", headers: { host: "localhost", ...headers } });
      expect(source.json()).toMatchObject({ ip: "127.0.0.1", local: false });
      const api = await app.inject({ url: "/api/thing", remoteAddress: "127.0.0.1", headers: { host: "localhost", ...headers } });
      expect(api.statusCode).toBe(401);
    }
  });

  it("refuses setup through a proxy it does not trust", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { password: PASSWORD },
      ...viaNginx("203.0.113.9"),
    });
    expect(res.statusCode).toBe(403);
  });

  it("ignores X-Forwarded-Proto, so the cookie is not Secure, and plain-http localhost logs in as before", async () => {
    vi.stubEnv("PYRODECK_ADMIN_PASSWORD", PASSWORD);
    const proxied = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD }, ...viaNginx(freshClient()) });
    expect(proxied.statusCode).toBe(200);
    expect(setCookieHeader(proxied)).not.toMatch(/Secure/);

    const local = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      headers: { host: "localhost:3001", origin: "http://localhost:5173" },
      payload: { password: PASSWORD },
    });
    expect(local.statusCode).toBe(200);
    expect(setCookieHeader(local)).not.toMatch(/Secure/);
  });

  it("keeps the no-password local mode closed to a page that rebinds its DNS name to 127.0.0.1", async () => {
    const res = await app.inject({ url: "/api/thing", remoteAddress: "127.0.0.1", headers: { host: "attacker.example:3001" } });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a cross-site request to the no-password local API", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/thing",
      remoteAddress: "127.0.0.1",
      headers: { host: "localhost:3001", origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
  });
});

/** Open a WebSocket handshake to /ws and return the HTTP status (101 = upgraded). */
function wsHandshake(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    // A fresh socket per handshake: after a refused upgrade the server no
    // longer reads that socket as HTTP, so the agent must not reuse it.
    const req = http.request({
      agent: false,
      host: "127.0.0.1",
      port,
      path: "/ws",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("/ws behind the proxy", () => {
  let port: number;

  beforeEach(async () => {
    app = await buildApp("1");
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });

  it("upgrades a direct local browser with no password, as before", async () => {
    expect(await wsHandshake(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).toBe(101);
  });

  it("refuses a proxied handshake with no password, a spoofed X-Forwarded-For included", async () => {
    const headers = { host: "panel.example.com", "x-forwarded-for": "127.0.0.1, 203.0.113.9", "x-forwarded-proto": "https" };
    expect(await wsHandshake(port, headers)).toBe(401);
  });

  it("refuses a handshake from another site's page", async () => {
    expect(await wsHandshake(port, { host: `127.0.0.1:${port}`, origin: "https://evil.example" })).toBe(403);
  });

  it("upgrades a logged-in browser through the proxy", async () => {
    vi.stubEnv("PYRODECK_ADMIN_PASSWORD", PASSWORD);
    const client = freshClient();
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD }, ...viaNginx(client) });
    const session = setCookieHeader(login).split(";")[0];
    const headers = {
      host: "panel.example.com",
      origin: "https://panel.example.com",
      "x-forwarded-for": client,
      "x-forwarded-proto": "https",
    };
    expect(await wsHandshake(port, headers)).toBe(401);
    expect(await wsHandshake(port, { ...headers, cookie: session })).toBe(101);
  });
});
