import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { isLocalRequest, rateLimitKey } from "../middleware/requestSource.js";

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

function setSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.setCookie("pyrodeck_session", "1", {
    ...sessionCookieOptions(request),
    signed: true,
    maxAge: 86400,
  });
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
    setSessionCookie(request, reply);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    reply.clearCookie("pyrodeck_session", sessionCookieOptions(request));
    return { ok: true };
  });

  app.get("/api/auth/check", async (request, reply) => {
    const source = getPasswordSource();
    if (!source) {
      return { authenticated: true, required: false, needsSetup: true };
    }
    const result = request.unsignCookie(
      request.cookies["pyrodeck_session"] ?? "",
    );
    if (result.valid && result.value === "1") {
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

    clearRateLimit(key);
    setSessionCookie(request, reply);
    return { ok: true };
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
