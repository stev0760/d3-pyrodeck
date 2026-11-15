import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { playlistManager, rotationHealth } from "../launcher/playlistInstance.js";
import type {
  Playlist,
  PlaylistEntry,
  PlaylistManager,
  PlaylistMode,
  PlaylistVoting,
} from "../launcher/PlaylistManager.js";
import { MAX_HOLD_SECONDS } from "../launcher/PlaylistManager.js";
import { findIncompatibleEntries } from "../gamefiles/playlistCompat.js";
import { playlistMissionsChanged } from "../gamefiles/missionHosting.js";
import { resolveRotationProfile, serverPlaylistProfile } from "./rotation-profile.js";
import { hostPlaylistDownloads, playlistRunners } from "./mission-host.js";
import { serverRegistry } from "../servers/ServerRegistry.js";
import type { ServerInstance } from "../servers/ServerInstance.js";

/**
 * A server's playlist as the routes use it: the server (null before the
 * servers exist, when there is the one playlist), its manager, and the status
 * payload (the manager's state plus the restart health check).
 */
export interface PlaylistTarget {
  server: ServerInstance | null;
  playlist: PlaylistManager;
  status(): Record<string, unknown>;
}

export function playlistTargetOf(server: ServerInstance): PlaylistTarget {
  return { server, playlist: server.playlist, status: () => server.playlistStatusPayload() };
}

const legacyTarget: PlaylistTarget = {
  server: null,
  playlist: playlistManager,
  status: () => ({ ...playlistManager.getStatus(), rotationCheck: rotationHealth.snapshot() }),
};

/**
 * The playlist a flat /api/playlists route acts on: the server of the
 * `profileId` it names; else, for deactivate and resume, the only server
 * whose playlist is in that state (409 when several are); else the server
 * resolveAlias picks.
 */
async function aliasTarget(
  profileId: string | undefined,
  options: { changing: boolean; route: string; inState?: (p: PlaylistManager) => boolean },
): Promise<PlaylistTarget | { code: number; error: string }> {
  if (!serverRegistry.isReady()) return legacyTarget;
  if (!profileId && options.inState) {
    const matching = serverRegistry.list().filter((s) => options.inState!(s.playlist));
    if (matching.length === 1) return playlistTargetOf(matching[0]);
    if (matching.length > 1) {
      return {
        code: 409,
        error: `${matching.length} servers have a playlist in that state; name one: ${options.route}`,
      };
    }
  }
  const resolved = await serverRegistry.resolveAlias(profileId, options);
  return "server" in resolved ? playlistTargetOf(resolved.server) : resolved;
}

function sendRefusal(reply: FastifyReply, r: { code: number; error: string }): FastifyReply {
  return reply.status(r.code).send({ error: r.error });
}

export type PlaylistActionResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: number; body: Record<string, unknown> };

/**
 * Activate a playlist on one server: its entries are checked against the
 * profile's Scriptname (`profileId` names the profile for the one playlist
 * of a single-server Pyrodeck; a server's own is its profile), and, with the
 * mission host on, every entry's download link is pointed at it; a mission
 * that cannot be rewritten is reported in `downloads`, never fails the
 * activation.
 */
export async function activatePlaylist(target: PlaylistTarget, id: string, profileId?: string): Promise<PlaylistActionResult> {
  try {
    const playlist = await target.playlist.read(id);
    const profile = target.server ? await serverPlaylistProfile(target.server) : await resolveRotationProfile(profileId);
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
        return {
          ok: false,
          code: 400,
          body: {
            error: `Playlist has ${incompatible.length} entr${incompatible.length === 1 ? "y" : "ies"} incompatible with ${scriptName}: ${detail}. Remove them or change the profile's game type.`,
            incompatible,
            scriptName,
          },
        };
      }
    }
    await target.playlist.activate(id);
    const downloads = await hostPlaylistDownloads(playlist, profileId, {
      targets: [target.playlist],
      ...(target.server ? { profile } : {}),
    });
    return { ok: true, body: { ok: true, status: target.status(), downloads } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 400, body: { error: message } };
  }
}

/** Resume a playlist paused after a failed restart: the next mission end rotates again. */
export function resumePlaylist(target: PlaylistTarget): PlaylistActionResult {
  if (!target.playlist.resume()) return { ok: false, code: 409, body: { error: "Playlist is not paused" } };
  return { ok: true, body: { ok: true, status: target.status() } };
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

  // Update a playlist (metadata + entries + voting config). Every server that
  // has it active gets the new copy; saving it with other missions points
  // its missions' links at the mission host again (the result reaches the
  // playlist status of each server that has it active).
  app.put("/api/playlists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const updates = sanitizePlaylistUpdate(body);

    try {
      const runners = await playlistRunners();
      const before = runners.map((r) => {
        const active = r.playlist.getActivePlaylist();
        return active?.id === id ? active.entries : null;
      });
      const playlist = await playlistManager.update(id, updates);
      for (const [i, r] of runners.entries()) {
        r.playlist.playlistSaved(playlist);
        const was = before[i];
        if (was && r.playlist.getActivePlaylist()?.id === id && playlistMissionsChanged(was, playlist.entries)) {
          await hostPlaylistDownloads(playlist, undefined, {
            targets: [r.playlist],
            ...(r.profile !== undefined ? { profile: r.profile } : {}),
          });
        }
      }
      return playlist;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(404).send({ error: message });
    }
  });

  // Delete a playlist; every server that has it active stops it.
  app.delete("/api/playlists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      for (const r of await playlistRunners()) r.playlist.playlistDeleted(id);
      await playlistManager.delete(id);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(404).send({ error: message });
    }
  });

  // Activate a playlist on the server of { profileId } (else the only one
  // running, else the default server); POST /api/servers/:serverId/playlist/activate
  // names the server. The entries are checked against its profile's
  // Scriptname and hosted from its missions directory.
  app.post("/api/playlists/:id/activate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const profileId = typeof body.profileId === "string" && body.profileId ? body.profileId : undefined;
    const target = await aliasTarget(profileId, {
      changing: true,
      route: "POST /api/servers/:serverId/playlist/activate",
    });
    if ("code" in target) return sendRefusal(reply, target);
    const result = await activatePlaylist(target, id, profileId);
    return result.ok ? result.body : reply.status(result.code).send(result.body);
  });

  // Deactivate a server's playlist { profileId? }
  app.post("/api/playlists/deactivate", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const profileId = typeof body.profileId === "string" && body.profileId ? body.profileId : undefined;
    const target = await aliasTarget(profileId, {
      changing: true,
      route: "POST /api/servers/:serverId/playlist/deactivate",
      inState: (p) => p.isActive(),
    });
    if ("code" in target) return sendRefusal(reply, target);
    target.playlist.deactivate();
    return { ok: true };
  });

  // Resume a playlist paused after a failed restart { profileId? }. The next
  // mission end rotates again; Pyrodeck does not relaunch the server here.
  app.post("/api/playlists/resume", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const profileId = typeof body.profileId === "string" && body.profileId ? body.profileId : undefined;
    const target = await aliasTarget(profileId, {
      changing: true,
      route: "POST /api/servers/:serverId/playlist/resume",
      inState: (p) => p.getStatus().status === "paused",
    });
    if ("code" in target) return sendRefusal(reply, target);
    const result = resumePlaylist(target);
    return result.ok ? result.body : reply.status(result.code).send(result.body);
  });

  // A server's playlist status (plus the restart health check) ?profileId=
  app.get("/api/playlists/status", async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const profileId = typeof q.profileId === "string" && q.profileId ? q.profileId : undefined;
    const target = await aliasTarget(profileId, { changing: false, route: "" });
    if ("code" in target) return sendRefusal(reply, target);
    return target.status();
  });
}
