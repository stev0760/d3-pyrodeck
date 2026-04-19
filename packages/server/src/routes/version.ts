import type { FastifyInstance } from "fastify";
import { VERSION } from "../version.js";

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/version", async () => {
    return { version: VERSION };
  });
}
