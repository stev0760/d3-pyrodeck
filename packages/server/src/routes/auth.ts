import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

const SESSION_COOKIE = "pyrodeck_session";
const activeSessions = new Set<string>();

export function getSessionPassword(): string {
  const password = process.env.PYRODECK_PASSWORD;
  if (!password) {
    throw new Error(
      "PYRODECK_PASSWORD environment variable must be set. " +
        "This is the password for the web admin UI.",
    );
  }
  return password;
}

/** Check if a request has a valid session cookie. */
export function isAuthenticated(cookieValue: string | undefined): boolean {
  return !!cookieValue && activeSessions.has(cookieValue);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", async (request, reply) => {
    const { password } = request.body as { password?: string };

    if (!password || password !== getSessionPassword()) {
      return reply.status(401).send({ error: "Invalid password" });
    }

    const token = crypto.randomUUID();
    activeSessions.add(token);

    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      // 24 hour expiry
      maxAge: 60 * 60 * 24,
    });

    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      activeSessions.delete(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  // Auth middleware for all /api routes except login
  app.addHook("preHandler", async (request, reply) => {
    // Skip auth for login and health endpoints
    if (
      request.url === "/api/auth/login" ||
      request.url === "/api/health"
    ) {
      return;
    }

    // Only gate /api routes
    if (!request.url.startsWith("/api")) {
      return;
    }

    const token = request.cookies[SESSION_COOKIE];
    if (!isAuthenticated(token)) {
      return reply.status(401).send({ error: "Not authenticated" });
    }
  });
}
