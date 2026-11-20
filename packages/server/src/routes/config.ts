import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  ServerProfileManager,
  WRITABLE_GAME_FILE_EXTENSIONS,
  checkStartupFileName,
  gameFileWriteError,
  type ServerProfile,
} from "../config/ServerProfile.js";
import {
  parseDedicatedCfg,
  extractTelnetConfig,
  getCfgValue,
  entriesToStructured,
  structuredToString,
  parseMpsFile,
  generateMpsFile,
  parseBotRoster,
  generateBotRoster,
  updateBotRoster,
  type DedicatedCfgData,
  type BotRosterData,
} from "../launcher/ConfigGenerator.js";
import { SAMPLE_BOT_ROSTER } from "../launcher/sampleBotRoster.js";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { sanitizePostStart } from "../launcher/postStartSettings.js";
import {
  consoleWarnings,
  effectivePorts,
  findPortConflicts,
  localConsoleUseipNote,
  sanitizeStoredLaunchOptions,
  validateLaunchOptions,
  type ProfilePorts,
} from "../launcher/launchOptions.js";
import {
  DEFAULT_GAMESPY_FILE,
  formatTrackerList,
  parseTrackerList,
  validateTrackerList,
} from "../launcher/trackerList.js";
import { launchFootprint } from "../servers/launchConflicts.js";
import { validateTeamSettings } from "../launcher/teamSettings.js";
import { validatePeriodicSettings } from "../launcher/periodicCommands.js";
import { validateRespawnScaling } from "../launcher/respawnScaling.js";
import { resolveJoinAddress } from "../launcher/joinAddress.js";
import { validateSchedule } from "../ops/schedule.js";
import { sanitizeImportedArgs } from "../ops/launchScript.js";
import { parseMn3Cached, scanMissionsDir } from "../gamefiles/Mn3Scanner.js";
import {
  BACKUP_SUFFIX,
  Mn3Error,
  checkLinkableMission,
  checkMissionFilename,
  restoreMissionUrl,
  setMissionUrl,
  validateMissionUrl,
} from "../gamefiles/Mn3UrlRewriter.js";
import { hostDirError, hostMission } from "../gamefiles/missionHosting.js";
import { hostedLinkFor, missionHost, missionHostMissionsDir } from "./mission-host.js";
import { AUTOSTART_ENV, AUTOSTART_LIST_ENV, readAutostartEnv } from "../launcher/autostartSettings.js";
import { serverRegistry } from "../servers/ServerRegistry.js";
import { AUTOEXEC_FILE } from "../launcher/ProcessManager.js";

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

/**
 * A new profile's own Startup Commands file when another profile runs from
 * the same game directory: `<config file's name>.dmfc` (ctf.cfg: ctf.dmfc),
 * so the two servers can run at once (a launch sharing one is refused). A
 * profile alone in its directory keeps autoexec.dmfc. For a duplicate, the
 * source's Startup Commands are copied into the new file. Returns the
 * profile as saved.
 */
async function ownStartupFileIfShared(
  profile: ServerProfile,
  copyFrom?: ServerProfile,
): Promise<ServerProfile> {
  if (profile.startupFile) return profile;
  const globalGamePath = pyrodeckConfig.get().gamePath;
  const dirOf = (p: ServerProfile) => {
    const dir = p.gamePath ?? globalGamePath;
    return dir ? path.resolve(dir) : null;
  };
  const dir = dirOf(profile);
  if (!dir) return profile;
  const others = (await getMetadataManager().list()).filter((p) => p.id !== profile.id && dirOf(p) === dir);
  if (others.length === 0) return profile;
  const stem = profile.configFile.replace(/\.[^.]*$/, "");
  const taken = new Set(others.map((p) => (p.startupFile ?? AUTOEXEC_FILE).toLowerCase()));
  let name: string | null = null;
  const exists = (file: string) =>
    fs.access(path.join(dir, file)).then(
      () => true,
      () => false,
    );
  // A name no other profile uses and no file in the directory has (never an operator's file).
  for (let n = 1; n < 100 && name === null; n++) {
    const candidate = n === 1 ? `${stem}.dmfc` : `${stem}-${n}.dmfc`;
    const check = checkStartupFileName(candidate);
    if ("name" in check && !taken.has(check.name.toLowerCase()) && !(await exists(check.name))) name = check.name;
  }
  if (name === null) return profile;
  if (copyFrom) {
    const source = path.join(dir, copyFrom.startupFile ?? AUTOEXEC_FILE);
    await fs.copyFile(source, path.join(dir, name), fs.constants.COPYFILE_EXCL).catch(() => {});
  }
  return getMetadataManager().update(profile.id, { startupFile: name });
}

/** The ports a profile's server holds: launch options plus RemoteConsolePort from its config file. */
async function profilePorts(profile: ServerProfile): Promise<ProfilePorts> {
  const ports = effectivePorts(sanitizeStoredLaunchOptions(profile.launchOptions));
  let consolePort: number | null = null;
  const gamePath = profile.gamePath ?? pyrodeckConfig.get().gamePath;
  if (gamePath) {
    try {
      const cfg = await new ServerProfileManager(CONFIG_DIR, gamePath).readFile(profile.configFile);
      consolePort = extractTelnetConfig(parseDedicatedCfg(cfg)).port;
    } catch {
      // unreadable config: its console port is unknown
    }
  }
  return { name: profile.name, game: ports.game, gameSpy: ports.gameSpy, console: consolePort };
}

/** The console settings in a profile's config file, or null when it can't be read. */
async function profileConsole(profile: ServerProfile): Promise<{ allowRemote: boolean; port: number } | null> {
  const gamePath = profile.gamePath ?? pyrodeckConfig.get().gamePath;
  if (!gamePath) return null;
  try {
    const cfg = await new ServerProfileManager(CONFIG_DIR, gamePath).readFile(profile.configFile);
    const { allowRemote, port } = extractTelnetConfig(parseDedicatedCfg(cfg));
    return { allowRemote, port };
  } catch {
    return null;
  }
}

/** Ports `profile` shares with other profiles or with Pyrodeck's own listeners. */
async function portConflictWarnings(profile: ServerProfile): Promise<string[]> {
  const all = await getMetadataManager().list();
  const self = await profilePorts(profile);
  const others = await Promise.all(all.filter((p) => p.id !== profile.id).map(profilePorts));
  const services = [{ name: "Pyrodeck web", port: Number(process.env.PYRODECK_PORT ?? 3001) }];
  const host = pyrodeckConfig.get().missionHost;
  if (host.enabled) services.push({ name: "mission host", port: host.port });
  return findPortConflicts(self, others, services);
}

/**
 * A mission's details plus the link fields of the Game Files list: linkError
 * (why it takes no new link: retail, stock) and hostUrl/hostError (what the
 * mission host would serve it at, while the host is on).
 */
function withLinkFields<T extends object>(
  file: string,
  info: T,
  missionsDir: string,
): T & { linkError?: string; hostUrl?: string; hostError?: string } {
  const linkError = checkLinkableMission(file);
  return { ...info, ...(linkError ? { linkError } : {}), ...hostedLinkFor(file, missionsDir) };
}

/** GET /api/profiles/:id/tracker-list, and the reply to a save (launcher/trackerList.ts). */
interface TrackerListView {
  /** The file the profile's server reads at its next start: its -gspyfile, else gamespy.cfg. */
  file: string;
  /** Its path in the profile's game directory. */
  path: string;
  exists: boolean;
  /** Whether the panel may write it, and why not. */
  writable: boolean;
  writeError: string | null;
  /** What the game takes from the file (region 0 and no trackers when there is none). */
  region: number;
  trackers: string[];
  /** Lines of the file the game does not use as trackers (a file not in region/tracker pairs). */
  ignored: string[];
  /** Other profiles whose servers read the same file: same game directory, same file name. */
  sharedWith: string[];
  /**
   * The UDP port trackers query the server on. "running": the port of the
   * launch the server holds (an automatic move to a free port included);
   * "profile": the profile's -gamespyport; "default": 20142, which a launch
   * moves to a free port when another server holds it.
   */
  gameSpyPort: { port: number; source: "running" | "profile" | "default" };
  /** The profile's server is running: it keeps the list it read at its start. */
  running: boolean;
}

/** The tracker list file a profile's server reads: the saved -gspyfile, else gamespy.cfg. */
function trackerFileName(profile: ServerProfile): string {
  return sanitizeStoredLaunchOptions(profile.launchOptions)?.gameSpyFile ?? DEFAULT_GAMESPY_FILE;
}

/**
 * Why the panel does not write the tracker list to `file`: a file type it
 * never writes in the game directory (ServerProfile.ts, gameFileWriteError),
 * or a file another part of a server's setup lives in. Null when it may.
 */
function trackerFileWriteError(file: string, dir: string, profilesInDir: readonly ServerProfile[]): string | null {
  if (gameFileWriteError(file)) {
    return (
      `Pyrodeck writes only ${WRITABLE_GAME_FILE_EXTENSIONS.join(", ")} files in the game directory, and ${file} is ` +
      "none of them. Choose a GameSpy file name that ends in .cfg (Launch Options)."
    );
  }
  const lower = file.toLowerCase();
  const own = `Choose a GameSpy file of its own, such as ${DEFAULT_GAMESPY_FILE} (Launch Options).`;
  for (const p of profilesInDir) {
    if (p.configFile.toLowerCase() === lower) return `${file} is the server config of "${p.name}". ${own}`;
    if ((p.startupFile ?? AUTOEXEC_FILE).toLowerCase() === lower) {
      return `${file} is the Startup Commands file of "${p.name}". ${own}`;
    }
  }
  const globalGamePath = pyrodeckConfig.get().gamePath;
  if (lower === "dedicated.cfg" && globalGamePath && path.resolve(globalGamePath) === dir) {
    return `${file} is the server config Pyrodeck launches without a profile. ${own}`;
  }
  return null;
}

/** The tracker list a profile's server reads, with what the panel needs around it. */
async function trackerListView(profile: ServerProfile): Promise<TrackerListView> {
  const globalGamePath = pyrodeckConfig.get().gamePath;
  const gamePath = profile.gamePath ?? globalGamePath;
  if (!gamePath) {
    throw new Error(`Profile "${profile.name}" has no game path configured. Edit the profile and set a Game Path.`);
  }
  const dir = path.resolve(gamePath);
  const file = trackerFileName(profile);
  const dirOf = (p: ServerProfile) => {
    const d = p.gamePath ?? globalGamePath;
    return d ? path.resolve(d) : null;
  };
  const inDir = (await getMetadataManager().list()).filter((p) => dirOf(p) === dir);
  const others = inDir.filter((p) => p.id !== profile.id);

  let content: string | null = null;
  try {
    content = await new ServerProfileManager(CONFIG_DIR, gamePath).readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  const read = parseTrackerList(content ?? "");
  const writeError = trackerFileWriteError(file, dir, inDir);

  // The launch the server holds: running, or restarting for its playlist (no PID then: the next game reads the file anew).
  const held = serverRegistry.get(profile.id)?.heldLaunch() ?? null;
  const ownPort = sanitizeStoredLaunchOptions(profile.launchOptions)?.gameSpyPort;
  const gameSpyPort: TrackerListView["gameSpyPort"] = held
    ? { port: launchFootprint(held.launch).gameSpyPort, source: "running" }
    : ownPort !== undefined
      ? { port: ownPort, source: "profile" }
      : { port: effectivePorts(null).gameSpy, source: "default" };

  return {
    file,
    path: path.join(dir, file),
    exists: content !== null,
    writable: writeError === null,
    writeError,
    region: read.region,
    trackers: read.trackers,
    ignored: read.ignored,
    sharedWith: others.filter((p) => trackerFileName(p).toLowerCase() === file.toLowerCase()).map((p) => p.name),
    gameSpyPort,
    running: held !== null && held.pid !== null,
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
      /** RemoteConsolePort of a new config file (default 2092): each server running at once needs its own. */
      remoteConsolePort?: unknown;
      /** Override the global game data directory for this profile. */
      gamePath?: string;
      /** Override the global D3 executable for this profile. */
      executablePath?: string;
      /** Launch flags from an imported script that the profile does not apply (shown to the operator). */
      importedArgs?: unknown;
      /** Launch options (launcher/launchOptions.ts): from an imported script, or for a new profile; invalid ones are dropped. */
      launchOptions?: unknown;
    };

    const consolePort = body.remoteConsolePort;
    if (consolePort !== undefined && !(Number.isInteger(consolePort) && (consolePort as number) >= 1 && (consolePort as number) <= 65535)) {
      return reply.status(400).send({ error: "remoteConsolePort must be a whole number from 1 to 65535." });
    }
    // A new profile's launch options are checked as on a save; an imported script's are taken as far as they are valid.
    if (!body.existingConfigFile && body.launchOptions !== undefined) {
      const check = validateLaunchOptions(body.launchOptions);
      if (check.errors.length > 0) return reply.status(400).send({ error: check.errors.join(" "), details: check.errors });
    }

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
        const importedArgs = sanitizeImportedArgs(body.importedArgs);
        const launchOptions = sanitizeStoredLaunchOptions(body.launchOptions);
        if (importedArgs || launchOptions) {
          profile = await manager.update(profile.id, {
            ...(importedArgs ? { importedArgs } : {}),
            ...(launchOptions ? { launchOptions } : {}),
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
            ...(consolePort !== undefined ? { remoteConsolePort: consolePort as number } : {}),
          },
          {
            gamePath: body.gamePath,
            executablePath: body.executablePath,
          },
        );
        const launchOptions = sanitizeStoredLaunchOptions(body.launchOptions);
        if (launchOptions) profile = await manager.update(profile.id, { launchOptions });
      }
      return await ownStartupFileIfShared(profile);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create profile";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * Update profile metadata and settings. The response is the profile plus
   * `warnings` (problems that do not block the save, such as a port another
   * profile also uses). Invalid settings are refused with 400 and `details`.
   */
  app.patch("/api/profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      name?: string;
      description?: string;
      logPath?: string | null;
      gamePath?: string | null;
      executablePath?: string | null;
      postStart?: unknown;
      launchOptions?: unknown;
      teamSettings?: unknown;
      periodicCommands?: unknown;
      respawnScaling?: unknown;
      schedule?: unknown;
      importedArgs?: unknown;
      /** "Start when Pyrodeck starts": true adds this profile to the ones that start with Pyrodeck, false removes it. */
      autostart?: unknown;
      /** The profile's Startup Commands file in the game directory (a .dmfc name); null or "" for autoexec.dmfc. */
      startupFile?: unknown;
    };
    const {
      postStart,
      launchOptions,
      teamSettings,
      periodicCommands,
      respawnScaling,
      schedule,
      importedArgs,
      autostart,
      startupFile,
      ...rest
    } = body;
    const updates: Parameters<ServerProfileManager["update"]>[1] = { ...rest };
    // Whitelisted values only; null or nothing valid clears the settings.
    if (postStart !== undefined) updates.postStart = sanitizePostStart(postStart);
    if (importedArgs !== undefined) updates.importedArgs = sanitizeImportedArgs(importedArgs);

    const errors: string[] = [];
    const warnings: string[] = [];
    if (startupFile !== undefined) {
      if (startupFile === null || startupFile === "") {
        updates.startupFile = null;
      } else {
        const check = checkStartupFileName(startupFile);
        if ("error" in check) errors.push(check.error);
        else updates.startupFile = check.name;
      }
    }
    if (launchOptions !== undefined) {
      const check = validateLaunchOptions(launchOptions);
      errors.push(...check.errors);
      warnings.push(...check.warnings);
      updates.launchOptions = check.options;
    }
    if (teamSettings !== undefined) {
      const check = validateTeamSettings(teamSettings);
      errors.push(...check.errors);
      updates.teamSettings = check.settings;
    }
    if (periodicCommands !== undefined) {
      const check = validatePeriodicSettings(periodicCommands);
      errors.push(...check.errors);
      updates.periodicCommands = check.settings;
    }
    if (respawnScaling !== undefined) {
      const check = validateRespawnScaling(respawnScaling);
      errors.push(...check.errors);
      updates.respawnScaling = check.settings;
    }
    if (schedule !== undefined) {
      if (schedule === null) {
        updates.schedule = null;
      } else {
        const check = validateSchedule(schedule);
        errors.push(...check.errors);
        updates.schedule = check.schedule ?? null;
      }
    }
    if (autostart !== undefined && typeof autostart !== "boolean") {
      errors.push("autostart must be true or false.");
    }
    if (errors.length > 0) {
      return reply.status(400).send({ error: errors.join(" "), details: errors });
    }

    let profile: ServerProfile;
    try {
      profile = await getMetadataManager().update(id, updates);
    } catch {
      return reply.status(404).send({ error: "Profile not found" });
    }
    if (typeof autostart === "boolean") {
      // Several profiles may start with Pyrodeck; pyrodeck.json keeps the first, for an older Pyrodeck.
      await serverRegistry.setAutostart(id, autostart);
      const envName = readAutostartEnv(process.env);
      const envList = process.env[AUTOSTART_LIST_ENV]?.trim();
      if (envName !== null) {
        warnings.push(
          `${AUTOSTART_ENV} is set and wins over "Start when Pyrodeck starts": Pyrodeck starts the profile it names ("${envName}").`,
        );
      } else if (envList) {
        warnings.push(
          `${AUTOSTART_LIST_ENV} is set and wins over "Start when Pyrodeck starts": Pyrodeck starts the profiles it names ("${envList}").`,
        );
      }
    }
    if (launchOptions !== undefined) {
      warnings.push(...(await portConflictWarnings(profile)));
      // -useip decides where an AllowRemoteConsole=1 console listens, and
      // older engines cannot be logged in to with -useip and 0.
      const consoleCfg = await profileConsole(profile);
      if (consoleCfg) {
        warnings.push(
          ...consoleWarnings(sanitizeStoredLaunchOptions(profile.launchOptions), consoleCfg.allowRemote, consoleCfg.port),
        );
      }
    }
    return { ...profile, warnings };
  });

  /**
   * The address players join this profile's server at: host (Join Host
   * setting, -useip, or the mission host's public URL) and game port.
   */
  app.get("/api/profiles/:id/join-address", async (request, reply) => {
    const { id } = request.params as { id: string };
    let profile: ServerProfile;
    try {
      profile = await getMetadataManager().read(id);
    } catch {
      return reply.status(404).send({ error: "Profile not found" });
    }
    const config = pyrodeckConfig.get();
    return resolveJoinAddress(
      sanitizeStoredLaunchOptions(profile.launchOptions),
      config.joinHost,
      config.missionHost.publicBaseUrl,
    );
  });

  /**
   * GET /api/profiles/:id/tracker-list
   * The tracker list the profile's server reads when it starts: the file
   * (-gspyfile, else gamespy.cfg, in its game directory), what the game takes
   * from it, the lines it does not use, the other profiles that read the same
   * file, and the GameSpy port trackers query it on (TrackerListView).
   */
  app.get("/api/profiles/:id/tracker-list", async (request, reply) => {
    const { id } = request.params as { id: string };
    let profile: ServerProfile;
    try {
      profile = await getMetadataManager().read(id);
    } catch {
      return reply.status(404).send({ error: "Profile not found" });
    }
    try {
      return await trackerListView(profile);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to read the tracker list";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * PUT /api/profiles/:id/tracker-list  { region, trackers }
   * Write the list in the form the game reads (region/tracker pairs), keeping
   * the previous file as its backup. Refused with 400 when the file is not one
   * the panel writes (`writable: false`), or with `details` when the list is
   * invalid. Region 0 and no trackers with no file writes nothing. The reply
   * is the list as read back, plus `written`.
   */
  app.put("/api/profiles/:id/tracker-list", async (request, reply) => {
    const { id } = request.params as { id: string };
    let profile: ServerProfile;
    try {
      profile = await getMetadataManager().read(id);
    } catch {
      return reply.status(404).send({ error: "Profile not found" });
    }
    try {
      const view = await trackerListView(profile);
      if (!view.writable) {
        return reply.status(400).send({
          error: `The tracker list cannot be saved to ${view.file}. ${view.writeError}`,
          writable: false,
          writeError: view.writeError,
        });
      }
      const check = validateTrackerList(request.body);
      if (!check.list) {
        return reply.status(400).send({ error: check.errors.join(" "), details: check.errors });
      }
      const content = formatTrackerList(check.list, view.exists);
      if (content !== null) {
        const { manager } = await getProfileManagerForId(id);
        await manager.writeFile(view.file, content);
      }
      return { ok: true, written: content !== null, ...(await trackerListView(profile)) };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to write the tracker list";
      return reply.status(400).send({ error: message });
    }
  });

  /** Delete a profile (metadata only — config files in gamePath are preserved). */
  app.delete("/api/profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await getMetadataManager().delete(id);
    } catch {
      return reply.status(404).send({ error: "Profile not found" });
    }
    // A deleted profile cannot start with Pyrodeck.
    await serverRegistry.setAutostart(id, false);
    return { ok: true };
  });

  /** Duplicate a profile. */
  app.post("/api/profiles/:id/duplicate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string } | undefined;

    try {
      // duplicate() uses the source profile's effective gamePath internally
      const { manager, profile: source } = await getProfileManagerForId(id);
      const profile = await manager.duplicate(id, body?.name);
      // The copy runs from the source's game directory: it gets its own Startup Commands, the source's copied in.
      return await ownStartupFileIfShared(profile, source);
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

      // Check if the profile's Startup Commands file exists
      const startupFile = profile.startupFile ?? AUTOEXEC_FILE;
      let autoexecExists = false;
      try {
        await manager.readFile(startupFile);
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
        autoexec: { filename: startupFile, exists: autoexecExists },
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

  /**
   * GET /api/profiles/:id/files/:filename/backup
   * The previous version of a file, kept by every write that changed it.
   */
  app.get("/api/profiles/:id/files/:filename/backup", async (request, reply) => {
    const { id, filename } = request.params as { id: string; filename: string };
    try {
      const { manager } = await getProfileManagerForId(id);
      const backup = await manager.readBackup(filename);
      return backup ? { exists: true, ...backup } : { exists: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Backup not found";
      return reply.status(404).send({ error: message });
    }
  });

  /**
   * POST /api/profiles/:id/files/:filename/restore
   * Put the previous version back; the version it replaces becomes the backup.
   */
  app.post("/api/profiles/:id/files/:filename/restore", async (request, reply) => {
    const { id, filename } = request.params as { id: string; filename: string };
    try {
      const { manager } = await getProfileManagerForId(id);
      const restored = await manager.restoreBackup(filename);
      if (!restored) {
        return reply.status(404).send({ error: `No previous version of ${filename}` });
      }
      return { ok: true, content: await manager.readFile(filename) };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Restore failed";
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

      // RemoteConsolePort lives here: check it against the other profiles.
      // The form itself warns about AllowRemoteConsole=1; the -useip case
      // needs the profile's launch options, which only the server has here.
      const warnings = await portConflictWarnings(profile);
      const note = localConsoleUseipNote(sanitizeStoredLaunchOptions(profile.launchOptions), data.allowRemoteConsole === true);
      if (note) warnings.push(note);
      return { ok: true, warnings };
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

      return { filename: botConfigFile, ...parseBotRoster(rosterContent) };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to read bot roster";
      return reply.status(404).send({ error: message });
    }
  });

  /** The roster file a profile's config names, creating the reference when there is none. */
  async function rosterFileFor(manager: ServerProfileManager, profile: ServerProfile): Promise<string> {
    const cfgContent = await manager.readFile(profile.configFile);
    const entries = parseDedicatedCfg(cfgContent);
    let botConfigFile = getCfgValue(entries, "BotConfig");
    if (!botConfigFile) {
      // Auto-create a roster filename alongside the config
      botConfigFile = profile.configFile.replace(/\.cfg$/i, "-bots.cfg");
      await manager.ensureConfigReference(profile.configFile, "BotConfig", botConfigFile);
    }
    return botConfigFile;
  }

  /**
   * PUT /api/profiles/:id/bot-roster
   * Write structured bot roster data into the profile's roster file. An
   * existing file is edited in place: the population keys, comments and
   * anything else the form does not manage stay as they were.
   */
  app.put("/api/profiles/:id/bot-roster", async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = request.body as BotRosterData;

    if (!data || typeof data !== "object" || !Array.isArray(data.bots)) {
      return reply.status(400).send({ error: "Invalid roster data" });
    }

    try {
      const { manager, profile } = await getProfileManagerForId(id);
      const botConfigFile = await rosterFileFor(manager, profile);

      let existing: string | null = null;
      try {
        existing = await manager.readFile(botConfigFile);
      } catch {
        existing = null;
      }
      const rosterContent = existing === null ? generateBotRoster(data) : updateBotRoster(existing, data);
      await manager.writeFile(botConfigFile, rosterContent);

      return { ok: true, filename: botConfigFile, roster: parseBotRoster(rosterContent) };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to write bot roster";
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /api/profiles/:id/bot-roster/reset
   * Replace the profile's roster with the Matcen sample (four bots, the
   * population manager keeping 12 players). The old file stays as the backup.
   */
  app.post("/api/profiles/:id/bot-roster/reset", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { filename } = (request.body ?? {}) as { filename?: string };
    try {
      const { manager, profile } = await getProfileManagerForId(id);
      let botConfigFile: string;
      if (typeof filename === "string" && filename.trim()) {
        // A new roster under the operator's name: point the config at it first.
        botConfigFile = filename.trim();
        await manager.ensureConfigReference(profile.configFile, "BotConfig", botConfigFile);
      } else {
        botConfigFile = await rosterFileFor(manager, profile);
      }
      await manager.writeFile(botConfigFile, SAMPLE_BOT_ROSTER);
      return { ok: true, filename: botConfigFile, roster: parseBotRoster(SAMPLE_BOT_ROSTER) };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reset bot roster";
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
        // linkError: why the mission takes no new link (retail, stock).
        // hostUrl/hostError: what the mission host would serve it at (host on).
        const backups = new Set(entries.filter((f) => f.endsWith(BACKUP_SUFFIX)));
        const scanned = await scanMissionsDir(missionsDir);
        return {
          missions,
          details: scanned.map((d) =>
            withLinkFields(d.file, { ...d, urlBackup: backups.has(d.file + BACKUP_SUFFIX) }, missionsDir),
          ),
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
    const linkError = checkLinkableMission(file);
    if (linkError) return reply.status(400).send({ error: linkError });
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
        info: withLinkFields(file, { ...info, urlBackup: true }, path.dirname(resolved.filePath)),
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
        info: withLinkFields(file, { ...info, urlBackup: false }, path.dirname(resolved.filePath)),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to restore mission";
      return reply.status(err instanceof Mn3Error ? 400 : 500).send({ error: message });
    }
  });

  /**
   * POST /api/game-files/missions/:file/download-url/host  { profileId? }
   * Point the mission's download link at Pyrodeck's own mission host:
   * <publicBaseUrl>/missions/<file>, through the same rewrite as a typed link
   * (hostMission, shared with playlists). Replaces a link set by hand. Stock
   * missions are refused; a link that already points there is not rewritten.
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
      const dirError = hostDirError(missionHostMissionsDir(), missionsDir);
      if (dirError) return reply.status(400).send({ error: dirError });

      const result = await hostMission(missionsDir, file, settings.publicBaseUrl, { keepCustom: false });
      if (result.outcome === "missing") return reply.status(404).send({ error: result.message });
      if (!result.url) return reply.status(400).send({ error: result.message ?? "This mission cannot be hosted." });
      const info = await parseMn3Cached(resolved.filePath);
      const status = missionHost.getStatus();
      const warnings = validateMissionUrl(result.url).warnings;
      if (!status.bound) {
        warnings.push(`The mission host is not listening${status.error ? ` (${status.error})` : ""}; downloads fail until it is.`);
      }
      return {
        ok: true,
        url: result.url,
        urls: result.urls,
        backupCreated: result.backupCreated ?? false,
        warnings,
        info: { ...info, urlBackup: result.urlBackup ?? false, hostUrl: result.url },
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
