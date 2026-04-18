import type { FastifyInstance } from "fastify";
import { playlistManager } from "../launcher/playlistInstance.js";

export async function playlistRoutes(app: FastifyInstance): Promise<void> {
  // List all playlists
  app.get("/api/playlists", async () => {
    return playlistManager.list();
  });

  // Get a single playlist
  app.get("/api/playlists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await playlistManager.read(id);
    } catch {
      return reply.status(404).send({ error: `Playlist not found: ${id}` });
    }
  });

  // Create a playlist
  app.post("/api/playlists", async (request, reply) => {
    const body = request.body as {
      name?: string;
      mode?: string;
      entries?: { label: string; missionName: string; startingLevel?: number; weight?: number }[];
    };

    if (!body.name?.trim()) {
      return reply.status(400).send({ error: "name is required" });
    }

    const mode = body.mode === "shuffle" || body.mode === "weighted"
      ? body.mode
      : "sequential";

    return playlistManager.create(body.name.trim(), mode, body.entries ?? []);
  });

  // Update a playlist (metadata + entries + voting config)
  app.put("/api/playlists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;

    try {
      return await playlistManager.update(id, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(404).send({ error: message });
    }
  });

  // Delete a playlist
  app.delete("/api/playlists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await playlistManager.delete(id);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(404).send({ error: message });
    }
  });

  // Activate a playlist
  app.post("/api/playlists/:id/activate", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await playlistManager.activate(id);
      return { ok: true, status: playlistManager.getStatus() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  // Deactivate the current playlist
  app.post("/api/playlists/deactivate", async () => {
    playlistManager.deactivate();
    return { ok: true };
  });

  // Get playlist manager status
  app.get("/api/playlists/status", async () => {
    return playlistManager.getStatus();
  });
}
