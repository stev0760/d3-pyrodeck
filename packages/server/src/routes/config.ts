import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { ServerProfileManager } from "../config/ServerProfile.js";
import {
  parseDedicatedCfg,
  getCfgValue,
  entriesToStructured,
  structuredToString,
  parseMpsFile,
  generateMpsFile,
  parseBotRoster,
  generateBotRoster,
  type DedicatedCfgData,
  type BotRosterData,
} from "../launcher/ConfigGenerator.js";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { sanitizePostStart } from "../launcher/postStartSettings.js";
import { validateSchedule } from "../ops/schedule.js";
import { parseMn3Cached, scanMissionsDir } from "../gamefiles/Mn3Scanner.js";
import {
  BACKUP_SUFFIX,
  Mn3Error,
  checkMissionFilename,
  restoreMissionUrl,
  setMissionUrl,
  validateMissionUrl,
} from "../gamefiles/Mn3UrlRewriter.js";
import { buildHostedMissionUrl } from "../gamefiles/missionHostSettings.js";
import { hostedLinkFor, missionHost, missionHostMissionsDir } from "./mission-host.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

/**
 * Manager for profile *metadata* operations (list, read, delete, update fields).
 * Profile records live in CONFIG_DIR/profiles.json — gamePath is irrelevant here.
 * Only file operations (readFile, writeFile, etc.) need the right gamePath.
 */
function getMetadataManager(): ServerProfileManager {
  return new ServerProfileManager(CONFIG_DIR, "");
}

/**
 * Resolve an effective gamePath. If `profileId` is given, use that profile's
 * gamePath override when set; otherwise fall back to the global gamePath.
 */
async function resolveGamePath(profileId?: string): Promise<string> {
  const globalConfig = pyrodeckConfig.get();
  if (profileId) {
    const baseManager = new ServerProfileManager(CONFIG_DIR, globalConfig.gamePath ?? "");
    try {
      const profile = await baseManager.read(profileId);
      const effective = profile.gamePath ?? globalConfig.gamePath;
      if (!effective) {
        throw new Error(`Profile "${profile.name}" has no game path configured.`);
      }
      return effective;
    } catch (err) {
      if (err instanceof Error && err.message.includes("game path")) throw err;
      // Profile not found — fall through to global
    }
  }
  if (!globalConfig.gamePath) {
    throw new Error("Game path not configured");
  }
  return globalConfig.gamePath;
}

/** Build a ServerProfileManager for bare file ops, scoped by optional profileId. */
async function getFileManager(profileId?: string): Promise<ServerProfileManager> {
  const gamePath = await resolveGamePath(profileId);
  return new ServerProfileManager(CONFIG_DIR, gamePath);
}

/**
 * Load a profile and return a ServerProfileManager bound to that profile's
 * effective gamePath (profile.gamePath ?? global gamePath).
 *
 * All profile-scoped file operations (read/write config, bot roster, etc.)
 * should go through this helper so that profiles with a custom gamePath
 * (e.g. a PiccuEngine install in a different directory) work correctly.
 */
async function getProfileManagerForId(id: string): Promise<{ manager: ServerProfileManager; profile: import("../config/ServerProfile.js").ServerProfile }> {
  const globalConfig = pyrodeckConfig.get();
  // profiles.json lives in CONFIG_DIR — we can read it with any gamePath
  const baseManager = new ServerProfileManager(CONFIG_DIR, globalConfig.gamePath ?? "");
  const profile = await baseManager.read(id);

  const effectiveGamePath = profile.gamePath ?? globalConfig.gamePath;
  if (!effectiveGamePath) {
    throw new Error(`Profile "${profile.name}" has no game path configured. Edit the profile and set a Game Path.`);
  }

  return {
    manager: new ServerProfileManager(CONFIG_DIR, effectiveGamePath),
    profile,
  };
}

export async function configRoutes(app: FastifyInstance): Promise<void> {
  // --- Profile CRUD ---

  /** List all server profiles. */
  app.get("/api/profiles", async (_request, reply) => {
    try {
      const profiles = await getMetadataManager().list();
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
      const profile = await getMetadataManager().read(id);
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
      /** Override the global game data directory for this profile. */
      gamePath?: string;
      /** Override the global D3 executable for this profile. */
      executablePath?: string;
    };

    try {
      // Use a profile-specific gamePath if provided; otherwise fall back to global.
      const globalConfig = pyrodeckConfig.get();
      const effectiveGamePath = body.gamePath ?? globalConfig.gamePath;
      if (!effectiveGamePath) {
        return reply.status(400).send({ error: "Game path not configured" });
      }
      const manager = new ServerProfileManager(CONFIG_DIR, effectiveGamePath);

      let profile;
      if (body.existingConfigFile) {
        profile = await manager.importExisting(body.name, body.existingConfigFile);
        // Store overrides on the imported profile
        if (body.gamePath || body.executablePath) {
          profile = await manager.update(profile.id, {
            gamePath: body.gamePath ?? null,
            executablePath: body.executablePath ?? null,
          });
        }
      } else {
        profile = await manager.create(
          body.name,
          {
            gameName: body.gameName,
            missionName: body.missionName,
            scriptName: body.scriptName,
            maxPlayers: body.maxPlayers,
            pps: body.pps,
            consolePassword: body.consolePassword,
          },
          {
            gamePath: body.gamePath,
            executablePath: body.executablePath,
          },
        );
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
    const body = (request.body ?? {}) as {
      name?: string;
      description?: string;
      logPath?: string | null;
      gamePath?: string | null;
      executablePath?: string | null;
      postStart?: unknown;
      schedule?: unknown;
    };
    const { postStart, schedule, ...rest } = body;
    let validSchedule;
    if (schedule !== undefined && schedule !== null) {
      const check = validateSchedule(schedule);
      if (check.errors.length > 0) {
        return reply.status(400).send({ error: check.errors.join(" "), errors: check.errors });
      }
      validSchedule = check.schedule;
    }
    const updates = {
      ...rest,
      // Whitelisted values only; null or nothing valid clears the settings.
      ...(postStart !== undefined ? { postStart: sanitizePostStart(postStart) } : {}),
      ...(schedule !== undefined ? { schedule: validSchedule ?? null } : {}),
    };

    try {
      const profile = await getMetadataManager().update(id, updates);
      return profile;
    } catch {
      return reply.status(404).send({ error: "Profile not found" });
    }
  });

  /** Delete a profile (metadata only — config files in gamePath are preserved). */
  app.delete("/api/profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await getMetadataManager().delete(id);
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
      // duplicate() uses the source profile's effective gamePath internally
      const { manager } = await getProfileManagerForId(id);
      const profile = await manager.duplicate(id, body?.name);
      return profile;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Profile not found";
      return reply.status(404).send({ error: message });
    }
  });

  // --- Companion file discovery ---

  /**
   * Get companion file references from a profile's server config.
   * Parses the cfg to find BotConfig=, MultiSettingsFile=, and checks for autoexec.dmfc.
   */
  app.get("/api/profiles/:id/companions", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const { manager, profile } = await getProfileManagerForId(id);

      // Parse the server config
      let cfgContent: string;
      try {
        cfgContent = await manager.readFile(profile.configFile);
      } catch {
        return reply.status(400).send({ error: "Cannot read server config" });
      }

      const entries = parseDedicatedCfg(cfgContent);
      const botConfig = getCfgValue(entries, "BotConfig") || null;
      const multiSettingsFile = getCfgValue(entries, "MultiSettingsFile") || null;

      // Check if autoexec.dmfc exists
      let autoexecExists = false;
      try {
        await manager.readFile("autoexec.dmfc");
        autoexecExists = true;
      } catch {
        // doesn't exist
      }

      // Check if referenced files actually exist
      let botConfigExists = false;
      if (botConfig) {
        try {
          await manager.readFile(botConfig);
          botConfigExists = true;
        } catch { /* missing */ }
      }

      let mpsExists = false;
      if (multiSettingsFile) {
        try {
          await manager.readFile(multiSettingsFile);
          mpsExists = true;
        } catch { /* missing */ }
      }

      return {
        botConfig: botConfig ? { filename: botConfig, exists: botConfigExists } : null,
        multiSettingsFile: multiSettingsFile ? { filename: multiSettingsFile, exists: mpsExists } : null,
        autoexec: { filename: "autoexec.dmfc", exists: autoexecExists },
      };
    } catch {
      return reply.status(404).send({ error: "Profile not found" });
    }
  });

  // --- File access (files live in gamePath) ---

  /**
   * List and classify config-related files in gamePath.
   * If `?profileId=xxx` is provided, uses that profile's gamePath override.
   */
  app.get("/api/game-files", async (request, reply) => {
    const { profileId } = request.query as { profileId?: string };
    try {
      const manager = await getFileManager(profileId);
      const files = await manager.classifyGameFiles();
      return { files };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list files";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * Read a file from gamePath.
   * If `?profileId=xxx` is provided, reads from that profile's gamePath override.
   */
  app.get("/api/game-files/:filename", async (request, reply) => {
    const { filename } = request.params as { filename: string };
    const { profileId } = request.query as { profileId?: string };
    try {
      const manager = await getFileManager(profileId);
      const content = await manager.readFile(filename);
      return { filename, content };
    } catch (err) {
      const message = err instanceof Error ? err.message : "File not found";
      return reply.status(404).send({ error: message });
    }
  });

  /**
   * Write a file to gamePath.
   * If `?profileId=xxx` is provided, writes to that profile's gamePath override.
   */
  app.put("/api/game-files/:filename", async (request, reply) => {
    const { filename } = request.params as { filename: string };
    const { profileId } = request.query as { profileId?: string };
    const { content } = request.body as { content: string };

    if (typeof content !== "string") {
      return reply.status(400).send({ error: "content must be a string" });
    }

    try {
      const manager = await getFileManager(profileId);
      await manager.writeFile(filename, content);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Write failed";
      return reply.status(400).send({ error: message });
    }
  });

  /** Read a file from the profile's gamePath. */
  app.get("/api/profiles/:id/files/:filename", async (request, reply) => {
    const { id, filename } = request.params as { id: string; filename: string };

    try {
      const { manager } = await getProfileManagerForId(id);
      const content = await manager.readFile(filename);
      return { filename, content };
    } catch (err) {
      const message = err instanceof Error ? err.message : "File not found";
      return reply.status(404).send({ error: message });
    }
  });

  /**
   * Write a file to gamePath.
   * If `cvar` is provided in the body, auto-adds the CVar reference in the profile's server config.
   * e.g., cvar: "BotConfig" → adds BotConfig=<filename> to the server config.
   */
  app.put("/api/profiles/:id/files/:filename", async (request, reply) => {
    const { id, filename } = request.params as { id: string; filename: string };
    const { content, cvar } = request.body as { content: string; cvar?: string };

    if (typeof content !== "string") {
      return reply.status(400).send({ error: "content must be a string" });
    }

    try {
      const { manager, profile } = await getProfileManagerForId(id);
      await manager.writeFile(filename, content);

      // Auto-add CVar reference if specified
      if (cvar) {
        try {
          await manager.ensureConfigReference(profile.configFile, cvar, filename);
        } catch {
          // Non-fatal: companion file was saved, config ref is advisory
        }
      }

      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Write failed";
      return reply.status(400).send({ error: message });
    }
  });

  // --- Structured config (bidirectional parse/generate) ---

  /**
   * GET /api/profiles/:id/structured-config
   * Returns the profile's server config as a fully typed DedicatedCfgData object.
   * Ship bans are merged in from the .mps file if one is referenced.
   */
  app.get("/api/profiles/:id/structured-config", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const { manager, profile } = await getProfileManagerForId(id);

      let cfgContent: string;
      try {
        cfgContent = await manager.readFile(profile.configFile);
      } catch {
        return reply.status(400).send({ error: "Cannot read server config" });
      }

      const entries = parseDedicatedCfg(cfgContent);
      const data = entriesToStructured(entries);

      // Merge ship bans from .mps file if one is referenced
      if (data.multiSettingsFile) {
        try {
          const mpsContent = await manager.readFile(data.multiSettingsFile);
          const mpsData = parseMpsFile(mpsContent);
          data.bannedShips = mpsData.bannedShips;
        } catch {
          // .mps file missing — not fatal, bannedShips stays []
        }
      }

      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to read config";
      return reply.status(404).send({ error: message });
    }
  });

  /**
   * PUT /api/profiles/:id/structured-config
   * Write the profile's server config from a DedicatedCfgData object.
   * Generates .mps file for ship bans and updates MultiSettingsFile= CVar accordingly.
   */
  app.put("/api/profiles/:id/structured-config", async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = request.body as DedicatedCfgData;

    if (!data || typeof data !== "object") {
      return reply.status(400).send({ error: "Invalid config data" });
    }

    try {
      const { manager, profile } = await getProfileManagerForId(id);

      // Handle .mps file for ship bans
      if (data.bannedShips && data.bannedShips.length > 0) {
        // Determine .mps filename — use existing reference or derive from config filename
        const mpsFilename = data.multiSettingsFile
          ?? profile.configFile.replace(/\.cfg$/i, ".mps");
        const mpsContent = generateMpsFile({ bannedShips: data.bannedShips });
        await manager.writeFile(mpsFilename, mpsContent);
        data.multiSettingsFile = mpsFilename;
      } else {
        // No ships banned — remove the MultiSettingsFile= reference so D3 doesn't
        // load the .mps. The file stays on disk in case the user manages it manually.
        data.multiSettingsFile = null;
      }

      const cfgContent = structuredToString(data);
      await manager.writeFile(profile.configFile, cfgContent);

      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to write config";
      return reply.status(400).send({ error: message });
    }
  });

  // --- Bot roster structured access ---

  /**
   * GET /api/profiles/:id/bot-roster
   * Parse the profile's bot roster file (BotConfig=) into structured data.
   */
  app.get("/api/profiles/:id/bot-roster", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const { manager, profile } = await getProfileManagerForId(id);

      const cfgContent = await manager.readFile(profile.configFile);
      const entries = parseDedicatedCfg(cfgContent);
      const botConfigFile = getCfgValue(entries, "BotConfig");

      if (!botConfigFile) {
        return reply.status(404).send({ error: "No bot roster file configured" });
      }

      let rosterContent: string;
      try {
        rosterContent = await manager.readFile(botConfigFile);
      } catch {
        return reply.status(404).send({ error: `Bot roster file not found: ${botConfigFile}` });
      }

      return parseBotRoster(rosterContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to read bot roster";
      return reply.status(404).send({ error: message });
    }
  });

  /**
   * PUT /api/profiles/:id/bot-roster
   * Write structured bot roster data to the profile's roster file.
   */
  app.put("/api/profiles/:id/bot-roster", async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = request.body as BotRosterData;

    if (!data || typeof data !== "object") {
      return reply.status(400).send({ error: "Invalid roster data" });
    }

    try {
      const { manager, profile } = await getProfileManagerForId(id);

      const cfgContent = await manager.readFile(profile.configFile);
      const entries = parseDedicatedCfg(cfgContent);
      let botConfigFile = getCfgValue(entries, "BotConfig");

      if (!botConfigFile) {
        // Auto-create a roster filename alongside the config
        botConfigFile = profile.configFile.replace(/\.cfg$/i, "-bots.cfg");
        await manager.ensureConfigReference(profile.configFile, "BotConfig", botConfigFile);
      }

      const rosterContent = generateBotRoster(data);
      await manager.writeFile(botConfigFile, rosterContent);

      return { ok: true, filename: botConfigFile };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to write bot roster";
      return reply.status(400).send({ error: message });
    }
  });

  // --- Mission scanner ---

  /**
   * GET /api/game-files/missions
   * List available .mn3 mission files from gamePath/missions/.
   * If `?profileId=xxx` is provided, uses that profile's gamePath override.
   * With `?details=1`, also returns per-mission metadata and game-mode
   * compatibility parsed from each .mn3's embedded .msn (spec Addendum A).
   */
  app.get("/api/game-files/missions", async (request, reply) => {
    const { profileId, details } = request.query as { profileId?: string; details?: string };
    try {
      const gamePath = await resolveGamePath(profileId);
      const missionsDir = path.join(gamePath, "missions");
      const entries = await fs.readdir(missionsDir);
      const missions = entries.filter((f) => f.toLowerCase().endsWith(".mn3")).sort();
      if (details === "1") {
        // urlBackup: Pyrodeck has rewritten this mission's download link and
        // holds the original (restorable). Not cached: it changes on rewrite.
        // hostUrl/hostError: what the mission host would serve it at (host on).
        const backups = new Set(entries.filter((f) => f.endsWith(BACKUP_SUFFIX)));
        const scanned = await scanMissionsDir(missionsDir);
        return {
          missions,
          details: scanned.map((d) => ({
            ...d,
            urlBackup: backups.has(d.file + BACKUP_SUFFIX),
            ...hostedLinkFor(d.file, missionsDir),
          })),
        };
      }
      return { missions };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list missions";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * Resolve a mission named in a URL param to its path in gamePath/missions,
   * accepting only a file that is listed there (no traversal, exact name).
   */
  async function resolveMissionFile(
    file: string,
    profileId?: string,
  ): Promise<{ filePath: string } | { status: number; error: string }> {
    const nameError = checkMissionFilename(file);
    if (nameError) return { status: 400, error: nameError };
    const missionsDir = path.join(await resolveGamePath(profileId), "missions");
    const entries = await fs.readdir(missionsDir);
    if (!entries.includes(file)) return { status: 404, error: `Mission not found: ${file}` };
    return { filePath: path.join(missionsDir, file) };
  }

  /**
   * PUT /api/game-files/missions/:file/download-url  { url, profileId? }
   * Rewrite the mission's URL lines (the download links the server offers
   * clients that lack the mission) to one link. The untouched .mn3 is kept as
   * <file>.pyrodeck-orig on the first rewrite. Takes effect the next time the
   * server loads the mission.
   */
  app.put("/api/game-files/missions/:file/download-url", async (request, reply) => {
    const { file } = request.params as { file: string };
    const body = (request.body ?? {}) as { url?: unknown; profileId?: unknown };
    const profileId = typeof body.profileId === "string" ? body.profileId : undefined;
    if (typeof body.url !== "string") {
      return reply.status(400).send({ error: "url is required" });
    }
    const validation = validateMissionUrl(body.url);
    if (!validation.valid) {
      return reply.status(400).send({ error: validation.errors.join(" "), errors: validation.errors });
    }
    try {
      const resolved = await resolveMissionFile(file, profileId);
      if ("error" in resolved) return reply.status(resolved.status).send({ error: resolved.error });
      const result = await setMissionUrl(resolved.filePath, body.url);
      const info = await parseMn3Cached(resolved.filePath);
      return {
        ok: true,
        urls: result.urls,
        backupCreated: result.backupCreated,
        warnings: validation.warnings,
        info: { ...info, urlBackup: true, ...hostedLinkFor(file, path.dirname(resolved.filePath)) },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rewrite mission";
      return reply.status(err instanceof Mn3Error ? 400 : 500).send({ error: message });
    }
  });

  /**
   * POST /api/game-files/missions/:file/download-url/restore  { profileId? }
   * Put the original .mn3 back from its .pyrodeck-orig backup and delete the
   * backup. Refused when the mission was replaced since the backup was made.
   */
  app.post("/api/game-files/missions/:file/download-url/restore", async (request, reply) => {
    const { file } = request.params as { file: string };
    const body = (request.body ?? {}) as { profileId?: unknown };
    const profileId = typeof body.profileId === "string" ? body.profileId : undefined;
    try {
      const resolved = await resolveMissionFile(file, profileId);
      if ("error" in resolved) return reply.status(resolved.status).send({ error: resolved.error });
      const result = await restoreMissionUrl(resolved.filePath);
      const info = await parseMn3Cached(resolved.filePath);
      return {
        ok: true,
        urls: result.urls,
        info: { ...info, urlBackup: false, ...hostedLinkFor(file, path.dirname(resolved.filePath)) },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to restore mission";
      return reply.status(err instanceof Mn3Error ? 400 : 500).send({ error: message });
    }
  });

  /**
   * POST /api/game-files/missions/:file/download-url/host  { profileId? }
   * Point the mission's download link at Pyrodeck's own mission host:
   * <publicBaseUrl>/missions/<file>, through the same rewrite as a typed link.
   */
  app.post("/api/game-files/missions/:file/download-url/host", async (request, reply) => {
    const { file } = request.params as { file: string };
    const body = (request.body ?? {}) as { profileId?: unknown };
    const profileId = typeof body.profileId === "string" ? body.profileId : undefined;
    const settings = pyrodeckConfig.get().missionHost;
    if (!settings.enabled || !settings.publicBaseUrl) {
      return reply.status(409).send({ error: "Turn the mission host on (with a public base URL) first." });
    }
    try {
      const resolved = await resolveMissionFile(file, profileId);
      if ("error" in resolved) return reply.status(resolved.status).send({ error: resolved.error });
      const missionsDir = path.dirname(resolved.filePath);
      const hostDir = missionHostMissionsDir();
      if (!hostDir || path.resolve(hostDir) !== path.resolve(missionsDir)) {
        return reply.status(400).send({
          error: `The mission host serves ${hostDir ?? "nothing (no game path set)"}, not this profile's missions directory (${missionsDir}).`,
        });
      }
      const built = buildHostedMissionUrl(settings.publicBaseUrl, file);
      if (!("url" in built)) return reply.status(400).send({ error: built.error });

      const result = await setMissionUrl(resolved.filePath, built.url);
      const info = await parseMn3Cached(resolved.filePath);
      const status = missionHost.getStatus();
      const warnings = validateMissionUrl(built.url).warnings;
      if (!status.bound) {
        warnings.push(`The mission host is not listening${status.error ? ` (${status.error})` : ""}; downloads fail until it is.`);
      }
      return {
        ok: true,
        url: built.url,
        urls: result.urls,
        backupCreated: result.backupCreated,
        warnings,
        info: { ...info, urlBackup: true, hostUrl: built.url },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rewrite mission";
      return reply.status(err instanceof Mn3Error ? 400 : 500).send({ error: message });
    }
  });

  /**
   * GET /api/game-files/netgames
   * List available .d3m game type scripts from gamePath/netgames/.
   * Returns filenames without the .d3m extension for use as Scriptname= values.
   * If `?profileId=xxx` is provided, uses that profile's gamePath override.
   */
  app.get("/api/game-files/netgames", async (request, reply) => {
    const { profileId } = request.query as { profileId?: string };
    try {
      const gamePath = await resolveGamePath(profileId);
      const netgamesDir = path.join(gamePath, "netgames");
      const entries = await fs.readdir(netgamesDir);
      const scripts = entries
        .filter((f) => f.toLowerCase().endsWith(".d3m"))
        .map((f) => f.slice(0, -4))  // strip .d3m
        .sort();
      return { scripts };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list netgames";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * Delete a file from gamePath.
   * If `cvar` is provided in the query, auto-removes the CVar reference from the profile's server config.
   */
  app.delete("/api/profiles/:id/files/:filename", async (request, reply) => {
    const { id, filename } = request.params as { id: string; filename: string };
    const { cvar } = request.query as { cvar?: string };

    try {
      const { manager, profile } = await getProfileManagerForId(id);
      await manager.deleteFile(filename);

      // Auto-remove CVar reference if specified
      if (cvar) {
        try {
          await manager.removeConfigReference(profile.configFile, cvar);
        } catch {
          // Non-fatal
        }
      }

      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed";
      return reply.status(400).send({ error: message });
    }
  });
}
