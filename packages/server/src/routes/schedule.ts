import type { FastifyInstance } from "fastify";
import { serverRegistry } from "../servers/ServerRegistry.js";
import { sessionManager } from "./server.js";
import { wsBroadcast } from "./command.js";
import { serverEvents } from "../events/ServerEvents.js";
import { ServerProfileManager } from "../config/ServerProfile.js";
import { countHumanPlayers } from "../parser/parsers/players.js";
import { Scheduler } from "../ops/Scheduler.js";
import { sayToAll } from "../players/playerActions.js";
import { formatLocalWhen } from "../ops/schedule.js";

/**
 * The weekly schedule: each profile's start/stop windows (stored on the
 * profile, set with PATCH /api/profiles/:id { schedule }), run every 30 s
 * through the same start and stop paths as the Launch panel.
 */

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

const listProfiles = () => new ServerProfileManager(CONFIG_DIR, "").list();

/** The server the schedule starts and stops: the only one. */
const server = () => serverRegistry.getDefault();

export const scheduler = new Scheduler({
  now: () => new Date(),
  listProfiles,
  getProcess: () => ({
    running: server().process.isRunning(),
    profileId: server().process.getStatus().activeProfileId,
  }),
  isBusy: () => server().playlist.getStatus().status === "restarting" || server().rotationPending(),
  start: async (profileId) => {
    const result = await server().start({ profileId, reason: "schedule" });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  },
  stop: async () => {
    await server().stop("schedule");
  },
  countHumans: async () => {
    const session = sessionManager.getActive();
    if (!session || session.state !== "ready") return null;
    try {
      return countHumanPlayers(await session.connection.send("$players"));
    } catch {
      return null;
    }
  },
  say: async (text) => {
    const session = sessionManager.getActive();
    if (session?.state === "ready") await session.connection.send(sayToAll(text));
  },
  skipped: (profileId, action, reason) => {
    serverEvents.emitEvent("schedule.skipped", { profileId, action, reason });
    wsBroadcast("error", { message: `Scheduled ${action} skipped: ${reason}` });
  },
  log: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
});

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  scheduler.start();
  app.addHook("onClose", async () => {
    scheduler.stopTimer();
  });

  /** GET /api/schedule: each scheduled profile's next action, with times in Pyrodeck's local zone. */
  app.get("/api/schedule", async () => {
    const profiles = await listProfiles();
    const now = new Date();
    return {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      now: now.toISOString(),
      entries: scheduler.status(profiles, now).map((e) => ({
        ...e,
        next: e.next ? { ...e.next, atLocal: formatLocalWhen(e.next.at) } : null,
        pendingStop: e.pendingStop
          ? { ...e.pendingStop, deadlineLocal: formatLocalWhen(e.pendingStop.deadline) }
          : null,
      })),
    };
  });
}
