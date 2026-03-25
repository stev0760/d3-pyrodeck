import type { FastifyInstance } from "fastify";
import {
  PyrodeckConfigManager,
  validateD3Path,
  type PyrodeckConfig,
} from "../config/PyrodeckConfig.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";
export const pyrodeckConfig = new PyrodeckConfigManager(CONFIG_DIR);

export async function pyrodeckConfigRoutes(
  app: FastifyInstance,
): Promise<void> {
  // Load config at startup
  await pyrodeckConfig.load();

  app.get("/api/pyrodeck/config", async () => {
    const config = pyrodeckConfig.get();
    return {
      ...config,
      needsSetup: pyrodeckConfig.needsSetup(),
    };
  });

  app.put("/api/pyrodeck/config", async (request, reply) => {
    const updates = request.body as Partial<PyrodeckConfig>;

    // Validate d3InstallPath if being changed
    if (updates.d3InstallPath !== undefined) {
      if (updates.d3InstallPath === null) {
        // Clearing the path is always valid
      } else {
        const executable = updates.d3Executable ?? pyrodeckConfig.get().d3Executable;
        const result = await validateD3Path(updates.d3InstallPath, executable);
        if (!result.valid) {
          return reply.status(400).send({
            error: "Invalid D3 installation path",
            details: result.errors,
          });
        }
      }
    }

    const config = await pyrodeckConfig.save(updates);
    return {
      ...config,
      needsSetup: pyrodeckConfig.needsSetup(),
    };
  });

  app.post("/api/pyrodeck/validate-path", async (request) => {
    const { path: installPath, executable } = request.body as {
      path: string;
      executable?: string;
    };

    return validateD3Path(installPath, executable ?? null);
  });
}
