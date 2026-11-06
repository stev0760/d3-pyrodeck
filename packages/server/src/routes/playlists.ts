import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { playlistManager, playlistStatusPayload } from "../launcher/playlistInstance.js";
import type {
  Playlist,
  PlaylistEntry,
  PlaylistMode,
  PlaylistVoting,
} from "../launcher/PlaylistManager.js";
import { MAX_HOLD_SECONDS } from "../launcher/PlaylistManager.js";
import { findIncompatibleEntries } from "../gamefiles/playlistCompat.js";
import { ServerProfileManager } from "../config/ServerProfile.js";
import { pyrodeckConfig } from "./pyrodeck-config.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

/**
 * Resolve the profile a playlist would rotate against: an explicit profileId
 * if given, else the most recently launched (mirrors the rotate handler in
 * launcher.ts). Returns null when nothing is resolvable — validation is then
 * skipped rather than blocking activation.
 */
async function resolveRotationProfile(
  profileId?: string,
): Promise<{ gamePath: string; configFile: string } | null> {
  const globalGamePath = pyrodeckConfig.get().gamePath;
  const metadataManager = new ServerProfileManager(CONFIG_DIR, "");
  try {
    const profiles = await metadataManager.list();
    if (profiles.length === 0) return null;
    const profile =
      (profileId && profiles.find((p) => p.id === profileId)) ||
      profiles
        .filter((p) => p.lastLaunchedAt)
        .sort((a, b) => (b.lastLaunchedAt ?? "").localeCompare(a.lastLaunchedAt ?? ""))[0] ||
      profiles[0];
    const gamePath = profile.gamePath ?? globalGamePath;
    if (!gamePath) return null;
    return { gamePath, configFile: profile.configFile };
  } catch {
    return null;
  }
}

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
): Partial<Pick<Playlist, "name" | "mode" | "entries" | "voting" | "holdSeconds">> {
  const updates: Partial<Pick<Playlist, "name" | "mode" | "entries" | "voting" | "holdSeconds">> = {};
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
  if (typeof body.holdSeconds === "number" && Number.isFinite(body.holdSeconds)) {
    updates.holdSeconds = clamp(Math.round(body.holdSeconds), 0, MAX_HOLD_SECONDS);
  }
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

  // Activate a playlist. Body may carry { profileId } — the profile whose
  // Scriptname the entries are validated against (falls back to the most
  // recently launched profile, which is what rotation itself uses).
  app.post("/api/playlists/:id/activate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const profileId = typeof body.profileId === "string" ? body.profileId : undefined;
    try {
      const playlist = await playlistManager.read(id);
      const profile = await resolveRotationProfile(profileId);
      if (profile) {
        const { scriptName, incompatible } = await findIncompatibleEntries(
          profile.gamePath,
          profile.configFile,
          playlist.entries,
        );
        if (incompatible.length > 0) {
          const detail = incompatible
            .map((e) => `${e.label} (${e.missionName}: ${e.reason})`)
            .join(", ");
          return reply.status(400).send({
            error: `Playlist has ${incompatible.length} entr${incompatible.length === 1 ? "y" : "ies"} incompatible with ${scriptName}: ${detail}. Remove them or change the profile's game type.`,
            incompatible,
            scriptName,
          });
        }
      }
      await playlistManager.activate(id);
      return { ok: true, status: playlistStatusPayload() };
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

  // Resume a playlist paused after a failed restart. The next mission end
  // rotates again; Pyrodeck does not relaunch the server here.
  app.post("/api/playlists/resume", async (_request, reply) => {
    if (!playlistManager.resume()) {
      return reply.status(409).send({ error: "Playlist is not paused" });
    }
    return { ok: true, status: playlistStatusPayload() };
  });

  // Get playlist manager status (plus the restart health check)
  app.get("/api/playlists/status", async () => {
    return playlistStatusPayload();
  });
}
