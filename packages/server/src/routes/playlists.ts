import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { playlistManager } from "../launcher/playlistInstance.js";
import type {
  Playlist,
  PlaylistEntry,
  PlaylistMode,
  PlaylistVoting,
} from "../launcher/PlaylistManager.js";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function toMode(raw: unknown): PlaylistMode | undefined {
  return raw === "sequential" || raw === "shuffle" || raw === "weighted"
    ? raw
    : undefined;
}

/** Coerce one untrusted entry into a well-formed PlaylistEntry, or drop it. */
function toEntry(raw: unknown): PlaylistEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.label !== "string" || typeof e.missionName !== "string") return null;
  const entry: PlaylistEntry = {
    // Keep the client's id if valid, else mint one — rotation/voting key off it.
    id: typeof e.id === "string" && e.id ? e.id : crypto.randomUUID(),
    label: e.label,
    missionName: e.missionName,
  };
  if (typeof e.startingLevel === "number" && Number.isFinite(e.startingLevel)) {
    entry.startingLevel = e.startingLevel;
  }
  if (typeof e.weight === "number" && Number.isFinite(e.weight)) {
    entry.weight = e.weight;
  }
  return entry;
}

function toVoting(raw: unknown): PlaylistVoting | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const num = (x: unknown, fallback: number) =>
    typeof x === "number" && Number.isFinite(x) ? x : fallback;
  return {
    enabled: !!v.enabled,
    preAnnounceSeconds: clamp(num(v.preAnnounceSeconds, 120), 0, 3600),
    voteOpenSeconds: clamp(num(v.voteOpenSeconds, 60), 5, 3600),
    optionCount: clamp(num(v.optionCount, 3), 1, 9),
  };
}

/**
 * Build a typed, whitelisted update from an untrusted PUT body. Only known
 * fields are accepted (no `id`/`createdAt` injection, no malformed entries).
 */
function sanitizePlaylistUpdate(
  body: Record<string, unknown>,
): Partial<Pick<Playlist, "name" | "mode" | "entries" | "voting">> {
  const updates: Partial<Pick<Playlist, "name" | "mode" | "entries" | "voting">> = {};
  if (typeof body.name === "string" && body.name.trim()) {
    updates.name = body.name.trim();
  }
  const mode = toMode(body.mode);
  if (mode) updates.mode = mode;
  if (Array.isArray(body.entries)) {
    updates.entries = body.entries
      .map(toEntry)
      .filter((e): e is PlaylistEntry => e !== null);
  }
  const voting = toVoting(body.voting);
  if (voting) updates.voting = voting;
  return updates;
}

/** Coerce untrusted create-entry input into the create() entry shape. */
function toCreateEntries(raw: unknown): Omit<PlaylistEntry, "id">[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(toEntry)
    .filter((e): e is PlaylistEntry => e !== null)
    .map(({ id: _id, ...rest }) => rest);
}

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
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (typeof body.name !== "string" || !body.name.trim()) {
      return reply.status(400).send({ error: "name is required" });
    }

    const mode = toMode(body.mode) ?? "sequential";
    return playlistManager.create(body.name.trim(), mode, toCreateEntries(body.entries));
  });

  // Update a playlist (metadata + entries + voting config)
  app.put("/api/playlists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const updates = sanitizePlaylistUpdate(body);

    try {
      return await playlistManager.update(id, updates);
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
