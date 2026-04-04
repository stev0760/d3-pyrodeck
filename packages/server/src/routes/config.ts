import type { FastifyInstance } from "fastify";
import { ServerProfileManager } from "../config/ServerProfile.js";
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

  // --- File access (files live in gamePath) ---

  /** List config-related files in gamePath. */
  app.get("/api/game-files", async (_request, reply) => {
    try {
      const files = await getProfileManager().listGameFiles();
      return { files };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list files";
      return reply.status(400).send({ error: message });
    }
  });

  /** Read a file from gamePath. */
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

  /** Write a file to gamePath. */
  app.put("/api/profiles/:id/files/:filename", async (request, reply) => {
    const { filename } = request.params as { id: string; filename: string };
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

  /** Delete a file from gamePath. */
  app.delete("/api/profiles/:id/files/:filename", async (request, reply) => {
    const { filename } = request.params as { id: string; filename: string };

    try {
      await getProfileManager().deleteFile(filename);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed";
      return reply.status(400).send({ error: message });
    }
  });
}
