import type { FastifyRequest, FastifyReply } from "fastify";
import { pyrodeckConfig } from "../routes/pyrodeck-config.js";
import { crossSiteRefusal, isLocalRequest, parseOriginList } from "./requestSource.js";
import { sessionIdFromRequest, sessions } from "../auth/sessions.js";

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

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const path = request.url.split("?")[0];

  // Never gate non-protected paths (SPA assets, etc.), whether or not a
  // password exists.
  if (!PROTECTED_PREFIXES.some((p) => pathMatches(path, p))) return;

  // A browser request from another site is refused before anything else, the
  // auth routes included. This is the WebSocket's only origin check (a
  // handshake has no CORS), and the CSRF guard for the no-password local mode,
  // where no cookie is needed; with a password the SameSite=Strict cookie
  // already stays home.
  const refusal = crossSiteRefusal(
    request.headers.origin,
    request.hostname,
    parseOriginList(process.env.PYRODECK_CORS_ORIGIN),
  );
  if (refusal) {
    request.log.warn(refusal);
    reply.status(403).send({ error: refusal });
    return;
  }

  // The auth, health and version endpoints are open to every same-site caller.
  if (SKIP_PREFIXES.some((p) => pathMatches(path, p))) return;

  const hasEnvPassword = !!process.env.PYRODECK_ADMIN_PASSWORD;
  const hasConfigPassword = !!pyrodeckConfig.get().adminPasswordHash;

  if (!hasEnvPassword && !hasConfigPassword) {
    // No password configured. Localhost stays open (the zero-config dev
    // workflow), but remote peers are refused rather than handed an open API —
    // so an instance exposed with `--host` and no password isn't wide open.
    // A request relayed by a reverse proxy is never local (requestSource.ts).
    if (isLocalRequest(request)) return;
    reply.status(401).send({
      error:
        "This server has no admin password set. Remote access is blocked. " +
        "Set PYRODECK_ADMIN_PASSWORD (or configure one from a local browser) to enable remote login.",
    });
    return;
  }

  // A password is set: the request needs a live session (auth/sessions.ts).
  // Using it restarts the session's idle clock.
  const sessionId = sessionIdFromRequest(request);
  if (sessionId && sessions.touch(sessionId)) return;

  reply.status(401).send({ error: "Unauthorized" });
}
