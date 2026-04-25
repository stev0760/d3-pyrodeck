import type { FastifyInstance } from "fastify";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { pyrodeckConfig } from "./pyrodeck-config.js";

interface RateBucket {
  count: number;
  resetAt: number;
}

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const rateLimitMap = new Map<string, RateBucket>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitMap) {
    if (now >= bucket.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = rateLimitMap.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count++;
  return true;
}

function clearRateLimit(ip: string): void {
  rateLimitMap.delete(ip);
}

function getPasswordSource(): "env" | "config" | null {
  if (process.env.PYRODECK_ADMIN_PASSWORD) return "env";
  if (pyrodeckConfig.get().adminPasswordHash) return "config";
  return null;
}

function setSessionCookie(reply: import("fastify").FastifyReply): void {
  reply.setCookie("pyrodeck_session", "1", {
    signed: true,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 86400,
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", async (request, reply) => {
    const source = getPasswordSource();
    if (!source) {
      return reply.status(404).send({ error: "Auth not configured" });
    }

    const ip = request.ip;
    if (!checkRateLimit(ip)) {
      return reply.status(429).send({ error: "Too many attempts" });
    }

    const body = request.body as { password?: string };
    const input = body?.password ?? "";

    let valid = false;
    if (source === "env") {
      valid = await verifyPlaintext(input, process.env.PYRODECK_ADMIN_PASSWORD!);
    } else {
      valid = await verifyPassword(input, pyrodeckConfig.get().adminPasswordHash!);
    }

    if (!valid) {
      return reply.status(401).send({ error: "Invalid password" });
    }

    clearRateLimit(ip);
    setSessionCookie(reply);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.clearCookie("pyrodeck_session", { path: "/" });
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

    const ip = request.ip;
    if (!checkRateLimit(ip)) {
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

    clearRateLimit(ip);
    setSessionCookie(reply);
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
