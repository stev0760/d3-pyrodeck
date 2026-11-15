import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { serializeCaps } from "./server.js";
import { launcherStatus, autostartReport } from "./launcher.js";
import { activatePlaylist, playlistTargetOf, resumePlaylist } from "./playlists.js";
import { playerTracker } from "./players.js";
import { CONNECT_SERVER_ID, LAUNCH_SERVER_ID, serverRegistry } from "../servers/ServerRegistry.js";
import type { ServerInstance } from "../servers/ServerInstance.js";
import { consoleTarget, runConsoleCommand } from "../servers/consoleCommands.js";
import { launchFootprint } from "../servers/launchConflicts.js";
import { getCfgValue, parseDedicatedCfg, extractTelnetConfig } from "../launcher/ConfigGenerator.js";
import { mergeLaunchOptions, sanitizeStoredLaunchOptions, effectivePorts } from "../launcher/launchOptions.js";
import { AUTOEXEC_FILE } from "../launcher/ProcessManager.js";
import type { ServerProfile } from "../config/ServerProfile.js";
import { NO_PROFILE_ID } from "../events/ServerEvents.js";

/**
 * The servers Pyrodeck runs, one at a time or several at once:
 * GET /api/servers lists them, and /api/servers/:serverId/... acts on one.
 * A server's id is its profile's id; "launch" is the server launched from
 * the global dedicated.cfg without a profile; "connect" is Connect mode's
 * console session (status, command and players only).
 */

/** What a server's config file says about its game. */
interface ConfigFacts {
  gameName: string | null;
  mission: string | null;
  gameType: string | null;
  maxPlayers: number | null;
  consolePort: number | null;
}

async function readConfigFacts(gamePath: string | null | undefined, configFile: string): Promise<ConfigFacts> {
  const none: ConfigFacts = { gameName: null, mission: null, gameType: null, maxPlayers: null, consolePort: null };
  if (!gamePath) return none;
  try {
    const entries = parseDedicatedCfg(await fs.readFile(path.join(gamePath, configFile), "utf-8"));
    const max = parseInt(getCfgValue(entries, "MaxPlayers") ?? "", 10);
    const script = getCfgValue(entries, "Scriptname") ?? null;
    return {
      gameName: getCfgValue(entries, "GameName") ?? null,
      mission: getCfgValue(entries, "MissionName") ?? null,
      gameType: script ? script.replace(/\.d3m$/i, "") : null,
      maxPlayers: Number.isFinite(max) ? max : null,
      consolePort: extractTelnetConfig(entries).port,
    };
  } catch {
    return none;
  }
}

/** One row of GET /api/servers. */
async function describe(server: ServerInstance, profiles: Map<string, ServerProfile>): Promise<Record<string, unknown>> {
  const status = server.process.getStatus();
  const held = server.heldLaunch();
  const profile = server.profileId ? profiles.get(server.profileId) : undefined;
  const settings = pyrodeckConfig.get();
  const gamePath = held?.launch.gamePath ?? profile?.gamePath ?? settings.gamePath;
  const configFile = held?.launch.configFile ?? profile?.configFile ?? "dedicated.cfg";
  const facts = await readConfigFacts(gamePath, configFile);

  let ports: Record<string, unknown>;
  if (held) {
    const at = launchFootprint(held.launch);
    ports = {
      bindIp: at.bindIp,
      game: at.gamePort,
      gameSpy: at.gameSpyPort,
      console: at.consolePort,
      tempDir: at.tempDir,
      startupFile: at.startupPath,
    };
  } else {
    const own = server.profileId === null ? null : sanitizeStoredLaunchOptions(profile?.launchOptions);
    const options = mergeLaunchOptions({ tempDir: serverRegistry.defaultTempDir(server.id) }, own);
    const p = effectivePorts(options);
    ports = {
      bindIp: options?.bindIp && options.bindIp !== "0.0.0.0" ? options.bindIp : null,
      game: p.game,
      // A free one is picked at launch when another server holds the default and the profile sets none.
      gameSpy: p.gameSpy,
      console: facts.consolePort,
      tempDir: options?.tempDir ?? null,
      startupFile: gamePath ? path.resolve(gamePath, profile?.startupFile ?? AUTOEXEC_FILE) : null,
    };
  }

  const playlist = server.playlist.getStatus();
  const activePlaylist = server.playlist.getActivePlaylist();
  const supervisor = server.supervisor.snapshot();
  const autostart = server.autostart.snapshot();
  const plan = serverRegistry.plannedAutostart();
  const session = server.consoleSession();
  return {
    id: server.id,
    kind: server.profileId === null ? "launch" : "profile",
    name: serverRegistry.nameOf(server.id),
    profileId: server.profileId ?? null,
    profileExists: server.profileId === null || profile !== undefined,
    default: serverRegistry.defaultServerId() === server.id,
    state: status.state,
    pid: status.pid,
    startedAt: status.startedAt,
    adopted: status.adopted,
    stopReason: status.stopReason,
    console: session?.state ?? "disconnected",
    log: status.log.path,
    gameName: facts.gameName,
    gameType: facts.gameType,
    // MissionName in its config: the mission it runs (a playlist rotation writes it before the restart).
    mission: facts.mission,
    level: playlist.currentLevel,
    humans: supervisor.humans,
    maxPlayers: facts.maxPlayers,
    playlist: activePlaylist
      ? {
          id: activePlaylist.id,
          name: activePlaylist.name,
          status: playlist.status,
          currentEntry: playlist.currentEntry?.label ?? null,
          pausedReason: playlist.pausedReason,
        }
      : null,
    ports,
    held: held ? { why: held.why, pid: held.pid } : null,
    supervisor: {
      enabled: supervisor.enabled,
      relaunchCount: supervisor.relaunchCount,
      pendingRelaunch: supervisor.pendingRelaunch,
      gaveUp: supervisor.gaveUp,
      hang: supervisor.hang.state,
      uptimeMs: supervisor.uptimeMs,
    },
    autostart: {
      listed: plan?.profiles.some((p) => p.id === server.id) ?? false,
      state: autostart.state,
      reason: autostart.reason,
    },
  };
}

/** Connect mode's session as a row, when one is open. */
function describeConnect(): Record<string, unknown> | null {
  const session = serverRegistry.connectSession();
  if (!session) return null;
  const { host, port, connectedAt } = session.connectionInfo;
  return {
    id: CONNECT_SERVER_ID,
    kind: "connect",
    name: `${host}:${port}`,
    profileId: null,
    default: serverRegistry.defaultServerId() === CONNECT_SERVER_ID,
    state: null,
    console: session.state,
    connectedAt,
    capabilities: serializeCaps(session.capabilities),
  };
}

/** The server a route names, or "connect" for Connect mode's session; a 404 sent otherwise. */
async function serverOrConnect(serverId: string, reply: FastifyReply): Promise<ServerInstance | "connect" | null> {
  await serverRegistry.init();
  if (serverId === CONNECT_SERVER_ID) return "connect";
  const server = await serverRegistry.ensure(serverId);
  if (!server) {
    void reply.status(404).send({ error: `No such server: ${serverId}` });
    return null;
  }
  return server;
}

/** The server a route names; a 404 (400 for Connect mode, which has no process) sent otherwise. */
async function serverOf(serverId: string, reply: FastifyReply): Promise<ServerInstance | null> {
  const server = await serverOrConnect(serverId, reply);
  if (server === "connect") {
    void reply.status(400).send({ error: "Connect mode's session has no process, playlist or supervisor" });
    return null;
  }
  return server;
}

type Params = { serverId: string };

export async function serversRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/servers: one row per server (every profile, the server without one when used, Connect mode's session when open). */
  app.get("/api/servers", async () => {
    await serverRegistry.init();
    const profiles = new Map((await serverRegistry.refreshProfiles()).map((p) => [p.id, p] as const));
    const rows: Record<string, unknown>[] = [];
    for (const server of serverRegistry.list()) {
      if (server.id === LAUNCH_SERVER_ID) {
        const status = server.process.getStatus();
        const used = server.heldLaunch() !== null || server.playlist.isActive() || status.startedAt !== null;
        if (!used && profiles.size > 0) continue;
      }
      rows.push(await describe(server, profiles));
    }
    const connect = describeConnect();
    if (connect) rows.push(connect);
    return { defaultServerId: serverRegistry.defaultServerId(), servers: rows };
  });

  /** GET /api/servers/:serverId: the server's row. */
  app.get("/api/servers/:serverId", async (request, reply) => {
    const { serverId } = request.params as Params;
    const server = await serverOrConnect(serverId, reply);
    if (!server) return reply;
    if (server === "connect") return describeConnect() ?? reply.status(404).send({ error: "Connect mode has no session open" });
    const profiles = new Map((await serverRegistry.refreshProfiles()).map((p) => [p.id, p] as const));
    return describe(server, profiles);
  });

  /** POST /api/servers/:serverId/start: launch it, beside any other running server it shares nothing with. */
  app.post("/api/servers/:serverId/start", async (request, reply) => {
    const server = await serverOf((request.params as Params).serverId, reply);
    if (!server) return reply;
    const result = await server.start({ reason: "manual" });
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    return { serverId: server.id, status: result.status, message: "Server starting" };
  });

  /** POST /api/servers/:serverId/stop */
  app.post("/api/servers/:serverId/stop", async (request, reply) => {
    const server = await serverOf((request.params as Params).serverId, reply);
    if (!server) return reply;
    const result = await server.stop("manual");
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    return { ok: true, serverId: server.id, status: result.status };
  });

  /** GET /api/servers/:serverId/status: as GET /api/launcher/status, for this server (Connect mode: its session). */
  app.get("/api/servers/:serverId/status", async (request, reply) => {
    const server = await serverOrConnect((request.params as Params).serverId, reply);
    if (!server) return reply;
    if (server === "connect") {
      const session = serverRegistry.connectSession();
      return session
        ? { serverId: CONNECT_SERVER_ID, console: session.state, capabilities: serializeCaps(session.capabilities) }
        : { serverId: CONNECT_SERVER_ID, console: "disconnected", capabilities: null };
    }
    const session = server.consoleSession();
    return {
      serverId: server.id,
      ...launcherStatus(server),
      console: session?.state ?? "disconnected",
      capabilities: session ? serializeCaps(session.capabilities) : null,
      playlist: server.playlistStatusPayload(),
    };
  });

  /**
   * POST /api/servers/:serverId/command { command }: one console command on
   * this server's console; the reply, and its parsed form for the commands
   * Pyrodeck parses ($scores, $botlist, $netgameinfo, ...).
   */
  app.post("/api/servers/:serverId/command", async (request, reply) => {
    const { serverId } = request.params as Params;
    const server = await serverOrConnect(serverId, reply);
    if (!server) return reply;
    const { command } = (request.body ?? {}) as { command?: unknown };
    if (typeof command !== "string" || !command.trim() || /[\r\n]/.test(command)) {
      return reply.status(400).send({ error: "command is required: one line of console input" });
    }
    const target = consoleTarget(server === "connect" ? CONNECT_SERVER_ID : server.id);
    if (!target?.session || target.session.state !== "ready") {
      return reply.status(409).send({ error: "The server's console is not logged in" });
    }
    try {
      const result = await runConsoleCommand(target, command.trim());
      return { serverId: target.serverId, reply: result.raw, parsed: result.message, problems: result.problems };
    } catch (err) {
      return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** GET /api/servers/:serverId/players: the players in its game as Pyrodeck tracks them, and its human count. */
  app.get("/api/servers/:serverId/players", async (request, reply) => {
    const server = await serverOrConnect((request.params as Params).serverId, reply);
    if (!server) return reply;
    if (server === "connect") {
      const session = serverRegistry.connectSession();
      const profileId = session ? `connect:${session.connectionInfo.host}:${session.connectionInfo.port}` : null;
      return { serverId: CONNECT_SERVER_ID, profileId, humans: null, players: profileId ? playerTracker.present(profileId) : [] };
    }
    const profileId = server.profileId ?? NO_PROFILE_ID;
    return {
      serverId: server.id,
      profileId,
      humans: server.supervisor.humansOnline(),
      players: playerTracker.present(profileId),
    };
  });

  /** GET /api/servers/:serverId/playlist: its playlist status (plus the restart health check). */
  app.get("/api/servers/:serverId/playlist", async (request, reply) => {
    const server = await serverOf((request.params as Params).serverId, reply);
    if (!server) return reply;
    return server.playlistStatusPayload();
  });

  /** POST /api/servers/:serverId/playlist/activate { playlistId } */
  app.post("/api/servers/:serverId/playlist/activate", async (request, reply) => {
    const server = await serverOf((request.params as Params).serverId, reply);
    if (!server) return reply;
    const { playlistId } = (request.body ?? {}) as { playlistId?: unknown };
    if (typeof playlistId !== "string" || !playlistId) return reply.status(400).send({ error: "playlistId is required" });
    const result = await activatePlaylist(playlistTargetOf(server), playlistId);
    return result.ok ? { serverId: server.id, ...result.body } : reply.status(result.code).send(result.body);
  });

  /** POST /api/servers/:serverId/playlist/deactivate */
  app.post("/api/servers/:serverId/playlist/deactivate", async (request, reply) => {
    const server = await serverOf((request.params as Params).serverId, reply);
    if (!server) return reply;
    server.playlist.deactivate();
    return { ok: true, serverId: server.id };
  });

  /** POST /api/servers/:serverId/playlist/resume: a playlist paused after a failed restart rotates again. */
  app.post("/api/servers/:serverId/playlist/resume", async (request, reply) => {
    const server = await serverOf((request.params as Params).serverId, reply);
    if (!server) return reply;
    const result = resumePlaylist(playlistTargetOf(server));
    return result.ok ? { serverId: server.id, ...result.body } : reply.status(result.code).send(result.body);
  });

  /** GET /api/servers/:serverId/supervisor: the settings (Pyrodeck's, every server's) and this server's live state. */
  app.get("/api/servers/:serverId/supervisor", async (request, reply) => {
    const server = await serverOf((request.params as Params).serverId, reply);
    if (!server) return reply;
    return server.supervisor.snapshot();
  });

  /** POST /api/servers/:serverId/supervisor/cancel-relaunch: leave this crashed server down. */
  app.post("/api/servers/:serverId/supervisor/cancel-relaunch", async (request, reply) => {
    const server = await serverOf((request.params as Params).serverId, reply);
    if (!server) return reply;
    if (!server.supervisor.cancelRelaunch()) return reply.status(409).send({ error: "No relaunch is pending" });
    return server.supervisor.snapshot();
  });

  /** GET /api/servers/:serverId/autostart: what this run's autostart did for this server, and the plan. */
  app.get("/api/servers/:serverId/autostart", async (request, reply) => {
    const server = await serverOf((request.params as Params).serverId, reply);
    if (!server) return reply;
    return autostartReport(server);
  });

  /** POST /api/servers/:serverId/autostart/cancel: drop this server's pending autostart retry. */
  app.post("/api/servers/:serverId/autostart/cancel", async (request, reply) => {
    const server = await serverOf((request.params as Params).serverId, reply);
    if (!server) return reply;
    if (!server.autostart.cancelRetry("you cancelled the retry")) {
      return reply.status(409).send({ error: "No autostart retry is pending" });
    }
    return server.autostart.snapshot();
  });
}
