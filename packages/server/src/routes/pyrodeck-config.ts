import type { FastifyInstance } from "fastify";
import {
  PyrodeckConfigManager,
  validateGamePath,
  validateExecutable,
  type PyrodeckConfig,
} from "../config/PyrodeckConfig.js";
import { validateLogDir } from "../launcher/logPaths.js";
import { checkJoinHost } from "../launcher/joinAddress.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";
export const pyrodeckConfig = new PyrodeckConfigManager(CONFIG_DIR);

export async function pyrodeckConfigRoutes(
  app: FastifyInstance,
): Promise<void> {
  // Load config at startup (auto-migrates legacy format)
  await pyrodeckConfig.load();

  app.get("/api/pyrodeck/config", async () => {
    // The SMTP settings (and their password) are served by /api/alerts/mail only.
    const { adminPasswordHash: _, mail: _mail, ...config } = pyrodeckConfig.get();
    return {
      ...config,
      needsSetup: pyrodeckConfig.needsSetup(),
    };
  });

  app.put("/api/pyrodeck/config", async (request, reply) => {
    // The mission host, the supervisor, autostart, the operations settings,
    // the player settings, the player rules and log retention have their own
    // routes (validation, applying the change to what runs, the SMTP password).
    const {
      adminPasswordHash: _,
      logRetention: _retention,
      missionHost: _host,
      supervisor: _supervisor,
      autostart: _autostart,
      mail: _mail,
      processPriority: _priority,
      updateCheck: _update,
      players: _players,
      playerRules: _rules,
      ...updates
    } = request.body as Partial<PyrodeckConfig>;

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

    // Validate logDir when one is set (blank/null means "next to the executable")
    if (typeof updates.logDir === "string" && updates.logDir.trim()) {
      const result = await validateLogDir(updates.logDir);
      if (!result.valid) {
        return reply.status(400).send({
          error: result.errors.join(" "),
          details: result.errors,
        });
      }
      updates.logDir = updates.logDir.trim();
    } else if (updates.logDir !== undefined) {
      updates.logDir = null;
    }

    // Join Host: a host name or IPv4 address; blank/null clears it
    if (typeof updates.joinHost === "string" && updates.joinHost.trim()) {
      const check = checkJoinHost(updates.joinHost);
      if ("error" in check) {
        return reply.status(400).send({ error: check.error, details: [check.error] });
      }
      updates.joinHost = check.host;
    } else if (updates.joinHost !== undefined) {
      updates.joinHost = null;
    }

    const saved = await pyrodeckConfig.save(updates);
    const { adminPasswordHash: _hash, mail: _savedMail, ...config } = saved;
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
