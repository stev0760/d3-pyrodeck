import type { FastifyInstance } from "fastify";
import {
  PyrodeckConfigManager,
  validateGamePath,
  validateExecutable,
  type PyrodeckConfig,
} from "../config/PyrodeckConfig.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";
export const pyrodeckConfig = new PyrodeckConfigManager(CONFIG_DIR);

export async function pyrodeckConfigRoutes(
  app: FastifyInstance,
): Promise<void> {
  // Load config at startup (auto-migrates legacy format)
  await pyrodeckConfig.load();

  app.get("/api/pyrodeck/config", async () => {
    const { adminPasswordHash: _, ...config } = pyrodeckConfig.get();
    return {
      ...config,
      needsSetup: pyrodeckConfig.needsSetup(),
    };
  });

  app.put("/api/pyrodeck/config", async (request, reply) => {
    const { adminPasswordHash: _, ...updates } =
      request.body as Partial<PyrodeckConfig>;

    // Validate gamePath if being changed
    if (updates.gamePath !== undefined && updates.gamePath !== null) {
      const result = await validateGamePath(updates.gamePath);
      if (!result.valid) {
        return reply.status(400).send({
          error: "Invalid game data path",
          details: result.errors,
        });
      }
    }

    // Validate executablePath if being changed
    if (updates.executablePath !== undefined && updates.executablePath !== null) {
      const gamePath = updates.gamePath ?? pyrodeckConfig.get().gamePath;
      const result = await validateExecutable(updates.executablePath, gamePath);
      if (!result.valid) {
        return reply.status(400).send({
          error: "Invalid executable path",
          details: result.errors,
        });
      }
    }

    const saved = await pyrodeckConfig.save(updates);
    const { adminPasswordHash: _hash, ...config } = saved;
    return {
      ...config,
      needsSetup: pyrodeckConfig.needsSetup(),
    };
  });

  app.post("/api/pyrodeck/validate-path", async (request) => {
    const body = request.body as {
      type: "game" | "executable";
      path: string;
      gamePath?: string;
    };

    switch (body.type) {
      case "game":
        return validateGamePath(body.path);
      case "executable":
        return validateExecutable(body.path, body.gamePath ?? null);
      default:
        return { valid: false, errors: ["Unknown validation type"] };
    }
  });
}
