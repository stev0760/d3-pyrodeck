import type { FastifyRequest, FastifyReply } from "fastify";
import { pyrodeckConfig } from "../routes/pyrodeck-config.js";

// Routes that bypass auth even when a password is configured
const SKIP_PREFIXES = ["/api/auth/", "/api/health", "/api/version"];
// Routes that require auth (everything else is public — SPA assets, etc.)
const PROTECTED_PREFIXES = ["/api/", "/ws"];

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const hasEnvPassword = !!process.env.PYRODECK_ADMIN_PASSWORD;
  const hasConfigPassword = !!pyrodeckConfig.get().adminPasswordHash;
  if (!hasEnvPassword && !hasConfigPassword) return;

  const path = request.url.split("?")[0];

  if (!PROTECTED_PREFIXES.some((p) => path.startsWith(p))) return;
  if (SKIP_PREFIXES.some((p) => path.startsWith(p))) return;

  const result = request.unsignCookie(
    request.cookies["pyrodeck_session"] ?? "",
  );
  if (result.valid && result.value === "1") return;

  reply.status(401).send({ error: "Unauthorized" });
}
