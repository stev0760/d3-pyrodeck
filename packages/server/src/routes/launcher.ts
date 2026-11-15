import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { ServerProfileManager } from "../config/ServerProfile.js";
import { missionHost } from "./mission-host.js";
import { validateSupervisorSettings } from "../launcher/supervisorSettings.js";
import { chooseAutostartProfile } from "../launcher/autostartSettings.js";
import { serverRegistry } from "../servers/ServerRegistry.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

/** The server these routes act on: the only one. */
const server = () => serverRegistry.getDefault();

/** The default server's game process, for the routes that only read it (logs.ts). */
export const processManager = server().process;

/**
 * Run autostart (once). Call after launcherRoutes is registered, so that
 * re-attach has run; index.ts calls it once Pyrodeck listens.
 */
export function startAutostart(): Promise<void> {
  return server().runAutostart();
}

export async function launcherRoutes(app: FastifyInstance): Promise<void> {
  // pyrodeck.json is loaded by now (it was not when the server was created).
  server().supervisor.applySettings(pyrodeckConfig.get().supervisor);
  app.addHook("onClose", async () => {
    server().dispose();
  });
  await server().reattach();

  app.post("/api/launcher/start", async (request, reply) => {
    const body = (request.body ?? {}) as { profileId?: string };
    const result = await server().start({ profileId: body.profileId, reason: "manual" });
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    return {
      status: result.status,
      message: "Server starting",
    };
  });

  app.post("/api/launcher/stop", async (_request, reply) => {
    const result = await server().stop("manual");
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    return { ok: true, status: result.status };
  });

  app.get("/api/launcher/status", async () => {
    const s = server();
    return {
      ...s.process.getStatus(),
      missionHost: missionHost.getStatus(),
      supervisor: s.supervisor.snapshot(),
      autostart: s.autostart.snapshot(),
    };
  });

  /**
   * GET /api/launcher/autostart: which profile Pyrodeck starts with it and
   * where that comes from (PYRODECK_AUTOSTART_PROFILE wins over the profile
   * ticked in the UI), and what this run's autostart did. The UI setting is
   * changed with PATCH /api/profiles/:id { autostart: true | false }.
   */
  app.get("/api/launcher/autostart", async () => {
    const s = server();
    const settingProfileId = pyrodeckConfig.get().autostart.profileId;
    const profiles = await new ServerProfileManager(CONFIG_DIR, "").list().catch(() => []);
    const choice = chooseAutostartProfile(s.autostartEnv, settingProfileId, profiles);
    return {
      env: s.autostartEnv,
      settingProfileId,
      effective: choice
        ? {
            source: choice.source,
            profileId: "profile" in choice ? choice.profile.id : null,
            profileName: "profile" in choice ? choice.profile.name : null,
            error: "error" in choice ? choice.error : null,
          }
        : null,
      run: s.autostart.snapshot(),
    };
  });

  /** POST /api/launcher/autostart/cancel: drop the pending retry of a failed autostart launch. */
  app.post("/api/launcher/autostart/cancel", async (_request, reply) => {
    const { autostart } = server();
    if (!autostart.cancelRetry("you cancelled the retry")) {
      return reply.status(409).send({ error: "No autostart retry is pending" });
    }
    return autostart.snapshot();
  });

  /** GET /api/launcher/supervisor: the saved settings and the live state. */
  app.get("/api/launcher/supervisor", async () => server().supervisor.snapshot());

  /**
   * PUT /api/launcher/supervisor  { relaunchOnCrash, hangCheck, hangProbeAfterSec,
   *   hangRestartAfterSec, emptyRestart, emptyRestartAfterHours, emptyRestartGraceSec }
   * Fields left out keep their saved value. Applies at once.
   */
  app.put("/api/launcher/supervisor", async (request, reply) => {
    const check = validateSupervisorSettings(request.body, pyrodeckConfig.get().supervisor);
    if (check.errors.length > 0) {
      return reply.status(400).send({ error: check.errors.join(" "), errors: check.errors });
    }
    await pyrodeckConfig.save({ supervisor: check.settings });
    const { supervisor } = server();
    supervisor.applySettings(check.settings);
    return supervisor.snapshot();
  });

  /** POST /api/launcher/supervisor/cancel-relaunch: leave a crashed server down. */
  app.post("/api/launcher/supervisor/cancel-relaunch", async (_request, reply) => {
    const { supervisor } = server();
    if (!supervisor.cancelRelaunch()) {
      return reply.status(409).send({ error: "No relaunch is pending" });
    }
    return supervisor.snapshot();
  });

  app.get("/api/launcher/detect", async (_request, reply) => {
    const config = pyrodeckConfig.get();
    if (!config.gamePath) {
      return reply.status(400).send({ error: "Game path not configured" });
    }

    const gamePath = config.gamePath;
    const hogFiles: string[] = [];
    const missionFiles: string[] = [];

    try {
      const entries = await fs.readdir(gamePath);
      for (const entry of entries) {
        const lower = entry.toLowerCase();
        if (lower.endsWith(".hog")) hogFiles.push(entry);
        if (lower.endsWith(".mn3")) missionFiles.push(entry);
      }
    } catch {
      return reply.status(500).send({ error: "Cannot read game directory" });
    }

    return { hogFiles, missionFiles };
  });
}
