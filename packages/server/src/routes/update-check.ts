import type { FastifyInstance } from "fastify";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { UpdateChecker } from "../ops/updateCheck.js";
import { REPOSITORY_URL, VERSION } from "../version.js";

/** The update notice: is a newer Pyrodeck release out? Never downloads anything. */

const updateChecker = new UpdateChecker({ current: VERSION, repositoryUrl: REPOSITORY_URL });

export async function updateCheckRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/update-check: the latest release when newer (cached 24 h; silent when GitHub cannot be reached). */
  app.get("/api/update-check", async () => updateChecker.status(pyrodeckConfig.get().updateCheck.enabled));

  /** PUT /api/update-check  { enabled } */
  app.put("/api/update-check", async (request, reply) => {
    const { enabled } = (request.body ?? {}) as { enabled?: unknown };
    if (typeof enabled !== "boolean") return reply.status(400).send({ error: "enabled must be true or false." });
    await pyrodeckConfig.save({ updateCheck: { enabled } });
    return updateChecker.status(enabled);
  });
}
