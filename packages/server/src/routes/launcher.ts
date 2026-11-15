import type { FastifyInstance, FastifyReply } from "fastify";
import fs from "node:fs/promises";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { missionHost } from "./mission-host.js";
import { validateSupervisorSettings } from "../launcher/supervisorSettings.js";
import { AUTOSTART_LIST_ENV, readAutostartEnv } from "../launcher/autostartSettings.js";
import { sessionManager } from "../session/sessionStore.js";
import { CONNECT_OWNER } from "../session/SessionManager.js";
import { LAUNCH_SERVER_ID, serverRegistry, type AliasResult } from "../servers/ServerRegistry.js";
import type { ServerInstance } from "../servers/ServerInstance.js";

/**
 * The launcher's URLs from when Pyrodeck ran one server. Each is an alias
 * for a route under /api/servers/:serverId (routes/servers.ts): the server
 * of the `profileId` a request names, else the only one running, else (for
 * a route that only reads) the default server. A route that changes
 * something answers 409 when several servers run and none is named.
 */

/** Every server's game process, for the log routes (logs.ts): every live log is protected. */
export const processManager = {
  /** The default server's live log, or null. */
  getActiveLogPath: (): string | null => serverRegistry.defaultServer()?.process.getActiveLogPath() ?? null,
  /** The default server's last launch. */
  getLaunchConfig: () => serverRegistry.defaultServer()?.process.getLaunchConfig() ?? null,
  /** Every server's live log. */
  getActiveLogPaths: (): string[] =>
    serverRegistry
      .list()
      .map((s) => s.process.getActiveLogPath())
      .filter((p): p is string => p !== null),
  /** Every server's last launch's log, for the directories retention looks in. */
  getLastLogPaths: (): string[] =>
    serverRegistry
      .list()
      .map((s) => s.process.getLaunchConfig()?.logPath)
      .filter((p): p is string => !!p),
};

/**
 * Run autostart (once). Call after launcherRoutes is registered, so that
 * re-attach has run; index.ts calls it once Pyrodeck listens.
 */
export function startAutostart(): Promise<void> {
  return serverRegistry.runAutostart();
}

/** Send an alias's refusal; the server otherwise. */
function aliasServer(result: AliasResult, reply: FastifyReply): ServerInstance | null {
  if ("server" in result) return result.server;
  void reply.status(result.code).send({ error: result.error });
  return null;
}

function profileIdOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** The launcher status of one server, as GET /api/launcher/status has always answered it. */
export function launcherStatus(server: ServerInstance): Record<string, unknown> {
  return {
    ...server.process.getStatus(),
    missionHost: missionHost.getStatus(),
    supervisor: server.supervisor.snapshot(),
    autostart: server.autostart.snapshot(),
  };
}

/** GET /api/launcher/autostart's answer: the autostart settings, the plan, and what this run's autostart did. */
export async function autostartReport(server: ServerInstance | undefined): Promise<Record<string, unknown>> {
  const plan = await serverRegistry.autostartPlan();
  const env = readAutostartEnv(process.env);
  const first = plan.profiles[0];
  const firstError = plan.errors[0];
  return {
    env,
    envList: process.env[AUTOSTART_LIST_ENV] ?? null,
    settingProfileId: plan.settingProfileIds[0] ?? null,
    settingProfileIds: plan.settingProfileIds,
    effective: plan.source
      ? {
          source: plan.source,
          profileId: first?.id ?? null,
          profileName: first?.name ?? null,
          error: first ? null : (firstError ?? null),
        }
      : null,
    profiles: plan.profiles.map((p) => ({
      profileId: p.id,
      profileName: p.name,
      source: plan.source,
      run: serverRegistry.get(p.id)?.autostart.snapshot() ?? null,
    })),
    errors: plan.errors,
    run: server?.autostart.snapshot() ?? null,
  };
}

export async function launcherRoutes(app: FastifyInstance): Promise<void> {
  // pyrodeck.json is loaded by now: create the servers, give them its
  // supervisor settings, and re-attach to the games still running.
  await serverRegistry.init();
  serverRegistry.applySupervisorSettings(pyrodeckConfig.get().supervisor);
  app.addHook("onClose", async () => {
    serverRegistry.dispose();
  });
  await serverRegistry.reattachAll();

  /**
   * POST /api/launcher/start { profileId? }: start the profile's server (no
   * profileId: the global dedicated.cfg). Refused while any server runs, as
   * when Pyrodeck ran one; POST /api/servers/:serverId/start starts one
   * beside the others.
   */
  app.post("/api/launcher/start", async (request, reply) => {
    const body = (request.body ?? {}) as { profileId?: unknown };
    const profileId = profileIdOf(body.profileId);
    await serverRegistry.init();
    const server = profileId ? await serverRegistry.ensure(profileId) : serverRegistry.get(LAUNCH_SERVER_ID);
    if (!server) return reply.status(404).send({ error: `Profile not found: ${profileId}` });
    const others = serverRegistry.running().filter((s) => s.id !== server.id);
    if (others.length > 0 && !server.process.isRunning()) {
      return reply.status(409).send({
        error:
          `Server is already running ("${serverRegistry.nameOf(others[0].id)}"). To run another beside it, ` +
          `use POST /api/servers/${server.id}/start`,
      });
    }
    // As with one server: a launch here replaces Connect mode's session.
    const connect = sessionManager.getOwned(CONNECT_OWNER);
    if (connect && !server.process.isRunning()) sessionManager.remove(connect.id);
    const result = await server.start({ profileId, reason: "manual" });
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    serverRegistry.prefer(server.id);
    return {
      status: result.status,
      message: "Server starting",
    };
  });

  /** POST /api/launcher/stop { profileId? } */
  app.post("/api/launcher/stop", async (request, reply) => {
    const body = (request.body ?? {}) as { profileId?: unknown };
    const server = aliasServer(
      await serverRegistry.resolveAlias(profileIdOf(body.profileId), {
        changing: true,
        route: "POST /api/servers/:serverId/stop",
      }),
      reply,
    );
    if (!server) return reply;
    const result = await server.stop("manual");
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    return { ok: true, status: result.status };
  });

  /** GET /api/launcher/status?profileId= */
  app.get("/api/launcher/status", async (request, reply) => {
    const q = request.query as { profileId?: unknown };
    const server = aliasServer(
      await serverRegistry.resolveAlias(profileIdOf(q.profileId), { changing: false, route: "" }),
      reply,
    );
    if (!server) return reply;
    return launcherStatus(server);
  });

  /**
   * GET /api/launcher/autostart: which profiles Pyrodeck starts with it and
   * where that comes from (PYRODECK_AUTOSTART_PROFILE and
   * PYRODECK_AUTOSTART_PROFILES win over the profiles ticked in the UI), and
   * what this run's autostart did (`run`: the default server's; `profiles`:
   * each). The UI setting is changed with PATCH /api/profiles/:id
   * { autostart: true | false }.
   */
  app.get("/api/launcher/autostart", async () => autostartReport(serverRegistry.defaultServer()));

  /** POST /api/launcher/autostart/cancel { profileId? }: drop the pending retry of a failed autostart launch. */
  app.post("/api/launcher/autostart/cancel", async (request, reply) => {
    const body = (request.body ?? {}) as { profileId?: unknown };
    let server: ServerInstance | null;
    const named = profileIdOf(body.profileId);
    if (named) {
      server = aliasServer(await serverRegistry.resolveAlias(named, { changing: true, route: "" }), reply);
      if (!server) return reply;
    } else {
      const retrying = serverRegistry.list().filter((s) => s.autostart.snapshot().state === "retrying");
      if (retrying.length > 1) {
        return reply.status(409).send({
          error: `${retrying.length} autostart retries are pending; name one: POST /api/servers/:serverId/autostart/cancel`,
        });
      }
      server = retrying[0] ?? serverRegistry.defaultServer() ?? null;
    }
    if (!server || !server.autostart.cancelRetry("you cancelled the retry")) {
      return reply.status(409).send({ error: "No autostart retry is pending" });
    }
    return server.autostart.snapshot();
  });

  /** GET /api/launcher/supervisor: the saved settings and the default server's live state. */
  app.get("/api/launcher/supervisor", async () => {
    const server = serverRegistry.defaultServer();
    return server ? server.supervisor.snapshot() : { settings: pyrodeckConfig.get().supervisor };
  });

  /**
   * PUT /api/launcher/supervisor  { relaunchOnCrash, hangCheck, hangProbeAfterSec,
   *   hangRestartAfterSec, emptyRestart, emptyRestartAfterHours, emptyRestartGraceSec }
   * Fields left out keep their saved value. Applies at once, to every server.
   */
  app.put("/api/launcher/supervisor", async (request, reply) => {
    const check = validateSupervisorSettings(request.body, pyrodeckConfig.get().supervisor);
    if (check.errors.length > 0) {
      return reply.status(400).send({ error: check.errors.join(" "), errors: check.errors });
    }
    await pyrodeckConfig.save({ supervisor: check.settings });
    serverRegistry.applySupervisorSettings(check.settings);
    const server = serverRegistry.defaultServer();
    return server ? server.supervisor.snapshot() : { settings: check.settings };
  });

  /** POST /api/launcher/supervisor/cancel-relaunch { profileId? }: leave a crashed server down. */
  app.post("/api/launcher/supervisor/cancel-relaunch", async (request, reply) => {
    const body = (request.body ?? {}) as { profileId?: unknown };
    let server: ServerInstance | null;
    const named = profileIdOf(body.profileId);
    if (named) {
      server = aliasServer(await serverRegistry.resolveAlias(named, { changing: true, route: "" }), reply);
      if (!server) return reply;
    } else {
      const pending = serverRegistry.list().filter((s) => s.supervisor.snapshot().pendingRelaunch !== null);
      if (pending.length > 1) {
        return reply.status(409).send({
          error: `${pending.length} relaunches are pending; name one: POST /api/servers/:serverId/supervisor/cancel-relaunch`,
        });
      }
      server = pending[0] ?? serverRegistry.defaultServer() ?? null;
    }
    if (!server || !server.supervisor.cancelRelaunch()) {
      return reply.status(409).send({ error: "No relaunch is pending" });
    }
    return server.supervisor.snapshot();
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
