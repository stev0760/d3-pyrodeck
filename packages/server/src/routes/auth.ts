import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

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

function hashPassword(p: string): Buffer {
  return crypto.createHash("sha256").update(p).digest();
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", async (request, reply) => {
    const adminPassword = process.env.PYRODECK_ADMIN_PASSWORD;
    if (!adminPassword) {
      return reply.status(404).send({ error: "Auth not configured" });
    }

    const ip = request.ip;
    if (!checkRateLimit(ip)) {
      return reply.status(429).send({ error: "Too many attempts" });
    }

    const body = request.body as { password?: string };
    const input = body?.password ?? "";
    const valid = crypto.timingSafeEqual(
      hashPassword(input),
      hashPassword(adminPassword),
    );

    if (!valid) {
      return reply.status(401).send({ error: "Invalid password" });
    }

    clearRateLimit(ip);
    reply.setCookie("pyrodeck_session", "1", {
      signed: true,
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 86400,
    });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.clearCookie("pyrodeck_session", { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/check", async (request, reply) => {
    const adminPassword = process.env.PYRODECK_ADMIN_PASSWORD;
    if (!adminPassword) {
      return { authenticated: true, required: false };
    }
    const result = request.unsignCookie(
      request.cookies["pyrodeck_session"] ?? "",
    );
    if (result.valid && result.value === "1") {
      return { authenticated: true, required: true };
    }
    return reply.status(401).send({ authenticated: false, required: true });
  });
}
