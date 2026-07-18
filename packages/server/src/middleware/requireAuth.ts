import type { FastifyRequest, FastifyReply } from "fastify";
import { pyrodeckConfig } from "../routes/pyrodeck-config.js";

// Routes that bypass auth even when a password is configured
const SKIP_PREFIXES = ["/api/auth/", "/api/health", "/api/version"];
// Routes that require auth (everything else is public — SPA assets, etc.)
const PROTECTED_PREFIXES = ["/api/", "/ws"];

/**
 * Boundary-aware prefix match. A bare prefix like "/api/health" matches only
 * "/api/health" itself or a "/api/health/..." child — never "/api/healthz" — so
 * a new sibling route can't accidentally inherit another's auth treatment. A
 * prefix that already ends in "/" is used as a literal startsWith.
 */
function pathMatches(path: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return path.startsWith(prefix);
  return path === prefix || path.startsWith(prefix + "/");
}

/** True for loopback peers. NOTE: behind the Vite dev proxy every request
 * arrives from 127.0.0.1, so in dev a remote browser reads as local — the
 * fail-closed guard below is only a real boundary in production (Fastify serves
 * the SPA same-origin, so request.ip is the actual peer). */
function isLocalRequest(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const path = request.url.split("?")[0];

  // Never gate non-protected paths (SPA assets, etc.) or the always-open
  // auth/health/version endpoints — this holds whether or not a password exists.
  if (!PROTECTED_PREFIXES.some((p) => pathMatches(path, p))) return;
  if (SKIP_PREFIXES.some((p) => pathMatches(path, p))) return;

  const hasEnvPassword = !!process.env.PYRODECK_ADMIN_PASSWORD;
  const hasConfigPassword = !!pyrodeckConfig.get().adminPasswordHash;

  if (!hasEnvPassword && !hasConfigPassword) {
    // No password configured. Localhost stays open (the zero-config dev
    // workflow), but remote peers are refused rather than handed an open API —
    // so an instance exposed with `--host` and no password isn't wide open.
    if (isLocalRequest(request.ip)) return;
    reply.status(401).send({
      error:
        "This server has no admin password set. Remote access is blocked. " +
        "Set PYRODECK_ADMIN_PASSWORD (or configure one from a local browser) to enable remote login.",
    });
    return;
  }

  const result = request.unsignCookie(
    request.cookies["pyrodeck_session"] ?? "",
  );
  if (result.valid && result.value === "1") return;

  reply.status(401).send({ error: "Unauthorized" });
}
