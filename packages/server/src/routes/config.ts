import type { FastifyInstance } from "fastify";
import { ServerProfileManager } from "../config/ServerProfile.js";
import { parseDedicatedCfg, getCfgValue } from "../launcher/ConfigGenerator.js";
import { pyrodeckConfig } from "./pyrodeck-config.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

function getProfileManager(): ServerProfileManager {
  const config = pyrodeckConfig.get();
  if (!config.gamePath) {
    throw new Error("Game path not configured");
  }
  return new ServerProfileManager(CONFIG_DIR, config.gamePath);
}

export async function configRoutes(app: FastifyInstance): Promise<void> {
  // --- Profile CRUD ---

  /** List all server profiles. */
  app.get("/api/profiles", async (_request, reply) => {
    try {
      const profiles = await getProfileManager().list();
      return { profiles };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list profiles";
      return reply.status(400).send({ error: message });
    }
  });

  /** Get a single profile. */
  app.get("/api/profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const profile = await getProfileManager().read(id);
      return profile;
    } catch {
      return reply.status(404).send({ error: "Profile not found" });
    }
  });

  /** Create a new profile. If existingConfigFile is provided, link to it instead of generating a new one. */
  app.post("/api/profiles", async (request, reply) => {
    const body = request.body as {
      name: string;
      existingConfigFile?: string;
      gameName?: string;
      missionName?: string;
      scriptName?: string;
      maxPlayers?: number;
      pps?: number;
      consolePassword?: string;
    };

    try {
      const manager = getProfileManager();
      let profile;
      if (body.existingConfigFile) {
        profile = await manager.importExisting(body.name, body.existingConfigFile);
      } else {
        profile = await manager.create(body.name, {
          gameName: body.gameName,
          missionName: body.missionName,
          scriptName: body.scriptName,
          maxPlayers: body.maxPlayers,
          pps: body.pps,
          consolePassword: body.consolePassword,
        });
      }
      return profile;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create profile";
      return reply.status(400).send({ error: message });
    }
  });

  /** Update profile metadata. */
  app.patch("/api/profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as { name?: string; description?: string };

    try {
      const profile = await getProfileManager().update(id, updates);
      return profile;
    } catch {
      return reply.status(404).send({ error: "Profile not found" });
    }
  });

  /** Delete a profile (metadata only — config files in gamePath are preserved). */
  app.delete("/api/profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await getProfileManager().delete(id);
      return { ok: true };
    } catch {
      return reply.status(404).send({ error: "Profile not found" });
    }
  });

  /** Duplicate a profile. */
  app.post("/api/profiles/:id/duplicate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string } | undefined;

    try {
      const profile = await getProfileManager().duplicate(id, body?.name);
      return profile;
    } catch {
      return reply.status(404).send({ error: "Profile not found" });
    }
  });

  // --- Companion file discovery ---

  /**
   * Get companion file references from a profile's server config.
   * Parses the cfg to find BotConfig=, MultiSettingsFile=, and checks for autoexec.dmfc.
   */
  app.get("/api/profiles/:id/companions", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const manager = getProfileManager();
      const profile = await manager.read(id);

      // Parse the server config
      let cfgContent: string;
      try {
        cfgContent = await manager.readFile(profile.configFile);
      } catch {
        return reply.status(400).send({ error: "Cannot read server config" });
      }

      const entries = parseDedicatedCfg(cfgContent);
      const botConfig = getCfgValue(entries, "BotConfig") || null;
      const multiSettingsFile = getCfgValue(entries, "MultiSettingsFile") || null;

      // Check if autoexec.dmfc exists
      let autoexecExists = false;
      try {
        await manager.readFile("autoexec.dmfc");
        autoexecExists = true;
      } catch {
        // doesn't exist
      }

      // Check if referenced files actually exist
      let botConfigExists = false;
      if (botConfig) {
        try {
          await manager.readFile(botConfig);
          botConfigExists = true;
        } catch { /* missing */ }
      }

      let mpsExists = false;
      if (multiSettingsFile) {
        try {
          await manager.readFile(multiSettingsFile);
          mpsExists = true;
        } catch { /* missing */ }
      }

      return {
        botConfig: botConfig ? { filename: botConfig, exists: botConfigExists } : null,
        multiSettingsFile: multiSettingsFile ? { filename: multiSettingsFile, exists: mpsExists } : null,
        autoexec: { filename: "autoexec.dmfc", exists: autoexecExists },
      };
    } catch {
      return reply.status(404).send({ error: "Profile not found" });
    }
  });

  // --- File access (files live in gamePath) ---

  /** List and classify config-related files in gamePath. */
  app.get("/api/game-files", async (_request, reply) => {
    try {
      const files = await getProfileManager().classifyGameFiles();
      return { files };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list files";
      return reply.status(400).send({ error: message });
    }
  });

  /** Read a file from gamePath (no profile context needed). */
  app.get("/api/game-files/:filename", async (request, reply) => {
    const { filename } = request.params as { filename: string };
    try {
      const content = await getProfileManager().readFile(filename);
      return { filename, content };
    } catch (err) {
      const message = err instanceof Error ? err.message : "File not found";
      return reply.status(404).send({ error: message });
    }
  });

  /** Write a file to gamePath (no profile context needed). */
  app.put("/api/game-files/:filename", async (request, reply) => {
    const { filename } = request.params as { filename: string };
    const { content } = request.body as { content: string };

    if (typeof content !== "string") {
      return reply.status(400).send({ error: "content must be a string" });
    }

    try {
      await getProfileManager().writeFile(filename, content);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Write failed";
      return reply.status(400).send({ error: message });
    }
  });

  /** Read a file from gamePath (profile-scoped, same underlying operation). */
  app.get("/api/profiles/:id/files/:filename", async (request, reply) => {
    const { filename } = request.params as { id: string; filename: string };

    try {
      const content = await getProfileManager().readFile(filename);
      return { filename, content };
    } catch (err) {
      const message = err instanceof Error ? err.message : "File not found";
      return reply.status(404).send({ error: message });
    }
  });

  /**
   * Write a file to gamePath.
   * If `cvar` is provided in the body, auto-adds the CVar reference in the profile's server config.
   * e.g., cvar: "BotConfig" → adds BotConfig=<filename> to the server config.
   */
  app.put("/api/profiles/:id/files/:filename", async (request, reply) => {
    const { id, filename } = request.params as { id: string; filename: string };
    const { content, cvar } = request.body as { content: string; cvar?: string };

    if (typeof content !== "string") {
      return reply.status(400).send({ error: "content must be a string" });
    }

    try {
      const manager = getProfileManager();
      await manager.writeFile(filename, content);

      // Auto-add CVar reference if specified
      if (cvar) {
        try {
          const profile = await manager.read(id);
          await manager.ensureConfigReference(profile.configFile, cvar, filename);
        } catch {
          // Non-fatal: companion file was saved, config ref is advisory
        }
      }

      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Write failed";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * Delete a file from gamePath.
   * If `cvar` is provided in the query, auto-removes the CVar reference from the profile's server config.
   */
  app.delete("/api/profiles/:id/files/:filename", async (request, reply) => {
    const { id, filename } = request.params as { id: string; filename: string };
    const { cvar } = request.query as { cvar?: string };

    try {
      const manager = getProfileManager();
      await manager.deleteFile(filename);

      // Auto-remove CVar reference if specified
      if (cvar) {
        try {
          const profile = await manager.read(id);
          await manager.removeConfigReference(profile.configFile, cvar);
        } catch {
          // Non-fatal
        }
      }

      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed";
      return reply.status(400).send({ error: message });
    }
  });
}
