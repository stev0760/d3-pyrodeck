import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { ServerProfileManager } from "../config/ServerProfile.js";
import { PlayerTracker } from "../players/PlayerTracker.js";
import { activeConsoleLink } from "../players/activeConsole.js";
import { activeConsoleProfileId, consoleProfileId, openConsoleProfileIds } from "../events/consoleEventHub.js";
import { engineClearsTextBuffer } from "../players/consoleLink.js";
import { validatePlayerSettings } from "../players/playerSettings.js";
import { sessionManager } from "../session/sessionStore.js";
import { NO_PROFILE_ID } from "../events/ServerEvents.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";
export const HISTORY_DIR = path.join(CONFIG_DIR, "players");

export const playerTracker = new PlayerTracker({
  historyDir: HISTORY_DIR,
  console: activeConsoleLink,
  ipLookup: () => {
    const s = pyrodeckConfig.get().players;
    return { enabled: s.ipLookup, budget: s.ipLookupBudget };
  },
});

/** A label for a history's profile id: the profile's name, or host:port for Connect mode. */
async function profileLabels(): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  try {
    for (const p of await new ServerProfileManager(CONFIG_DIR, "").list()) labels.set(p.id, p.name);
  } catch {
    // no profiles yet
  }
  return labels;
}

function labelFor(profileId: string, labels: Map<string, string>): string {
  if (profileId.startsWith("connect:")) return profileId.slice("connect:".length);
  if (profileId === NO_PROFILE_ID) return "Launched without a profile";
  return labels.get(profileId) ?? profileId;
}

/** Profile ids that have a history file. */
async function historyProfileIds(): Promise<string[]> {
  let files: string[];
  try {
    files = (await fs.readdir(HISTORY_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const f of files) {
    try {
      const head = JSON.parse(await fs.readFile(path.join(HISTORY_DIR, f), "utf-8")) as { profileId?: unknown };
      if (typeof head.profileId === "string") ids.push(head.profileId);
    } catch {
      // unreadable file: skip
    }
  }
  return ids;
}

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** The profile a query is about: the one asked for, else the default server's console's. */
function queryProfile(q: Record<string, unknown>): string | null {
  return typeof q.profileId === "string" && q.profileId ? q.profileId : activeConsoleProfileId();
}

/** The open console session whose events carry `profileId`. */
function sessionOf(profileId: string | null) {
  if (!profileId) return undefined;
  return sessionManager.list().find((s) => consoleProfileId(s) === profileId);
}

export async function playersRoutes(app: FastifyInstance): Promise<void> {
  playerTracker.start();
  app.addHook("onClose", async () => {
    playerTracker.stop();
    await playerTracker.flush();
  });

  /** GET /api/players/profiles: profiles with a history, every one whose console is open, and the default server's (`active`). */
  app.get("/api/players/profiles", async () => {
    const active = activeConsoleProfileId();
    const ids = new Set(await historyProfileIds());
    if (active) ids.add(active);
    for (const id of openConsoleProfileIds()) ids.add(id);
    const labels = await profileLabels();
    const profiles = await Promise.all(
      [...ids].map(async (profileId) => {
        const h = await playerTracker.history(profileId);
        return { profileId, label: labelFor(profileId, labels), rows: h.rowCount, lastEventAt: h.lastEventAt };
      }),
    );
    profiles.sort((a, b) => (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""));
    return { active, profiles };
  });

  /** GET /api/players/history?profileId=&q=&limit=&before=: join and leave rows, newest first. */
  app.get("/api/players/history", async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const profileId = queryProfile(q);
    if (!profileId) return reply.status(400).send({ error: "profileId is required when no server is connected" });
    const before = typeof q.before === "string" ? Number(q.before) : undefined;
    const limit = typeof q.limit === "string" ? Number(q.limit) : undefined;
    const result = (await playerTracker.history(profileId)).search({
      q: typeof q.q === "string" ? q.q : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      beforeId: Number.isFinite(before) ? before : undefined,
    });
    return { profileId, ...result };
  });

  /** GET /api/players/sessions?profileId=&from=&to=&q=: who was on between two times (default: the last 24 h). */
  app.get("/api/players/sessions", async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const profileId = queryProfile(q);
    if (!profileId) return reply.status(400).send({ error: "profileId is required when no server is connected" });
    const to = parseDate(q.to) ?? new Date();
    const from = parseDate(q.from) ?? new Date(to.getTime() - 24 * 3600_000);
    const sessions = (await playerTracker.history(profileId)).sessions({
      from,
      to,
      q: typeof q.q === "string" ? q.q : undefined,
    });
    return { profileId, from: from.toISOString(), to: to.toISOString(), sessions };
  });

  /** GET /api/players/addresses?profileId=&q=: the name/address index. */
  app.get("/api/players/addresses", async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const profileId = queryProfile(q);
    if (!profileId) return reply.status(400).send({ error: "profileId is required when no server is connected" });
    const entries = (await playerTracker.history(profileId)).addresses(typeof q.q === "string" ? q.q : undefined);
    return { profileId, entries };
  });

  /** GET /api/players/present?profileId=: players in a server's game as Pyrodeck tracks them (slot, address); default: the default server. */
  app.get("/api/players/present", async (request) => {
    const profileId = queryProfile(request.query as Record<string, unknown>);
    return { profileId, players: profileId ? playerTracker.present(profileId) : [] };
  });

  /** GET /api/players/settings?profileId= */
  app.get("/api/players/settings", async (request) => {
    const profileId = queryProfile(request.query as Record<string, unknown>);
    const session = sessionOf(profileId);
    return {
      settings: pyrodeckConfig.get().players,
      lookup: {
        profileId,
        used: profileId ? playerTracker.lookupsUsed(profileId) : 0,
        unlimited: session ? engineClearsTextBuffer(session.capabilities) : null,
      },
    };
  });

  /** PUT /api/players/settings  { ipLookup?, ipLookupBudget? } */
  app.put("/api/players/settings", async (request, reply) => {
    const check = validatePlayerSettings(request.body, pyrodeckConfig.get().players);
    if (check.errors.length > 0) {
      return reply.status(400).send({ error: check.errors.join(" "), errors: check.errors });
    }
    await pyrodeckConfig.save({ players: check.settings });
    return { settings: check.settings };
  });
}
