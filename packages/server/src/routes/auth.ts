import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { isLocalRequest, rateLimitKey } from "../middleware/requestSource.js";
import { SESSION_COOKIE, sessionIdFromRequest, sessions, sessionTag } from "../auth/sessions.js";

interface RateBucket {
  count: number;
  resetAt: number;
}

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
/**
 * Login and setup attempts per client, keyed by rateLimitKey(request.ip):
 * the browser's address when PYRODECK_TRUST_PROXY names the proxy in front,
 * the proxy's own address (one bucket for everyone) when it does not.
 */
const rateLimitMap = new Map<string, RateBucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitMap) {
    if (now >= bucket.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000).unref();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = rateLimitMap.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count++;
  return true;
}

function clearRateLimit(key: string): void {
  rateLimitMap.delete(key);
}

function getPasswordSource(): "env" | "config" | null {
  if (process.env.PYRODECK_ADMIN_PASSWORD) return "env";
  if (pyrodeckConfig.get().adminPasswordHash) return "config";
  return null;
}

/**
 * Session cookie attributes. `secure` when the browser reached Pyrodeck over
 * HTTPS: request.protocol is "https" on a TLS socket, or from X-Forwarded-Proto
 * when PYRODECK_TRUST_PROXY trusts the proxy that sent it. Plain-http
 * localhost keeps a cookie the browser will send back.
 */
function sessionCookieOptions(request: FastifyRequest) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: request.protocol === "https",
    path: "/",
  };
}

/**
 * Start a new session for this browser and set its cookie. A session id the
 * browser already carried ends first, so an id planted before login (session
 * fixation) is never the one that gets logged in. The cookie lasts as long as
 * the session's absolute lifetime; the idle timeout is enforced here, on the
 * server.
 */
function startSession(request: FastifyRequest, reply: FastifyReply): string {
  const previous = sessionIdFromRequest(request);
  if (previous) sessions.destroy(previous, "replaced");
  const id = sessions.create({ ip: request.ip, userAgent: request.headers["user-agent"] ?? null });
  reply.setCookie(SESSION_COOKIE, id, {
    ...sessionCookieOptions(request),
    signed: true,
    maxAge: sessions.cookieMaxAgeSeconds(),
  });
  return id;
}

function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(request));
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", async (request, reply) => {
    const source = getPasswordSource();
    if (!source) {
      return reply.status(404).send({ error: "Auth not configured" });
    }

    const key = rateLimitKey(request.ip);
    if (!checkRateLimit(key)) {
      return reply.status(429).send({ error: "Too many attempts" });
    }

    const body = request.body as { password?: string };
    const input = body?.password ?? "";

    const valid =
      source === "env"
        ? await verifyPlaintext(input, process.env.PYRODECK_ADMIN_PASSWORD!)
        : await verifyPassword(input, pyrodeckConfig.get().adminPasswordHash!);

    if (!valid) {
      return reply.status(401).send({ error: "Invalid password" });
    }

    clearRateLimit(key);
    const id = startSession(request, reply);
    request.log.info(`Login from ${request.ip}: session ${sessionTag(id)} started.`);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const id = sessionIdFromRequest(request);
    if (id && sessions.destroy(id, "logout")) {
      request.log.info(`Logout from ${request.ip}: session ${sessionTag(id)} ended.`);
    }
    clearSessionCookie(request, reply);
    return { ok: true };
  });

  app.get("/api/auth/check", async (request, reply) => {
    const source = getPasswordSource();
    if (!source) {
      return { authenticated: true, required: false, needsSetup: true };
    }
    const id = sessionIdFromRequest(request);
    if (id && sessions.touch(id)) {
      return { authenticated: true, required: true, needsSetup: false };
    }
    return reply
      .status(401)
      .send({ authenticated: false, required: true, needsSetup: false });
  });

  app.post("/api/auth/setup", async (request, reply) => {
    // Only allowed when no password is configured anywhere
    if (getPasswordSource() !== null) {
      return reply.status(403).send({ error: "Password already configured" });
    }

    // Block drive-by remote setup: whoever reaches an unconfigured public
    // instance first could otherwise claim the admin password. Allow setup
    // only from localhost, unless an operator explicitly opts in. A request
    // relayed by a reverse proxy is never local (requestSource.ts).
    const allowRemoteSetup = process.env.PYRODECK_ALLOW_REMOTE_SETUP === "1";
    if (!allowRemoteSetup && !isLocalRequest(request)) {
      return reply.status(403).send({
        error:
          "Remote setup is disabled. Configure the password via PYRODECK_ADMIN_PASSWORD, " +
          "or set PYRODECK_ALLOW_REMOTE_SETUP=1 to allow setup from a non-local browser.",
      });
    }

    const key = rateLimitKey(request.ip);
    if (!checkRateLimit(key)) {
      return reply.status(429).send({ error: "Too many attempts" });
    }

    const body = request.body as { password?: string };
    const password = body?.password ?? "";

    if (password.length < 8) {
      return reply
        .status(400)
        .send({ error: "Password must be at least 8 characters" });
    }

    const hashed = await hashPassword(password);
    await pyrodeckConfig.save({ adminPasswordHash: hashed });

    // Pyrodeck has no password change: first-run setup is the only place it
    // writes one. Any session that exists ends, and this browser gets a new one.
    const ended = sessions.destroyAll("password");
    if (ended > 0) request.log.info(`Admin password set: ${ended} session(s) ended.`);
    clearRateLimit(key);
    startSession(request, reply);
    return { ok: true };
  });

  // Sessions. These are under /api/ but not /api/auth/, so requireAuth guards
  // them: a live session, or a local browser while no password is set.

  /** The live sessions, most recently used first, without their ids. */
  app.get("/api/sessions", async (request) => {
    const current = sessionIdFromRequest(request);
    const { ttlMs, idleMs } = sessions.getLifetimes();
    return {
      ttlHours: ttlMs / 3_600_000,
      idleMinutes: idleMs / 60_000,
      sessions: sessions.list().map(({ id, ...info }) => ({ ...info, current: id === current })),
    };
  });

  /**
   * Log out every session, this one included. Their console WebSockets
   * close, and every browser (this one too) is back at the login page.
   */
  app.delete("/api/sessions", async (request, reply) => {
    const revoked = sessions.destroyAll("revoked");
    request.log.info(`All sessions logged out from ${request.ip}: ${revoked} ended.`);
    clearSessionCookie(request, reply);
    return { ok: true, revoked };
  });
}

// For env-var passwords: hash the env value on the fly and compare with scrypt
// so we don't do a plaintext comparison. We cache the hash to avoid re-hashing
// the env value on every login attempt.
let envPasswordCache: { raw: string; hash: string } | null = null;

async function verifyPlaintext(
  input: string,
  envValue: string,
): Promise<boolean> {
  if (!envPasswordCache || envPasswordCache.raw !== envValue) {
    envPasswordCache = { raw: envValue, hash: await hashPassword(envValue) };
  }
  return verifyPassword(input, envPasswordCache.hash);
}
