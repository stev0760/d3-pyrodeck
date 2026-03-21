import type { FastifyInstance } from "fastify";

// TODO: Web admin authentication is disabled for early development.
// The D3 server's console password is the only auth gate for now.
// This will be re-enabled in a later phase.

export function getSessionPassword(): string {
  return process.env.PYRODECK_PASSWORD ?? "";
}

export async function authRoutes(_app: FastifyInstance): Promise<void> {
  // Auth routes disabled for now — no login gate needed during dev.
}
