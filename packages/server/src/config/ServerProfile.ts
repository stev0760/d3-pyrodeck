import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { generateDedicatedCfg, type DedicatedCfgDefaults } from "../launcher/ConfigGenerator.js";

/**
 * A server profile is lightweight metadata stored in Pyrodeck's config dir.
 * The actual config files (dedicated.cfg, .mps, bots.cfg) live in gamePath.
 */
export interface ServerProfile {
  /** UUID identifier. */
  id: string;
  /** Display name for the profile. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Config filename in gamePath (e.g., "my-server.cfg"). */
  configFile: string;
  /** Optional absolute path for the server log file. Defaults to server.log in Pyrodeck config dir. */
  logPath?: string;
  /**
   * Override the global game data directory for this profile.
   * Use this when a profile belongs to a different D3 install
   * (e.g. Matcen at one path, PiccuEngine at another).
   * If omitted, inherits the global gamePath from pyrodeck.json.
   */
  gamePath?: string;
  /**
   * Override the global D3 executable for this profile.
   * May be an absolute path or a filename relative to the profile's effective gamePath.
   * If omitted, inherits executablePath from pyrodeck.json.
   */
  executablePath?: string;
  createdAt: string;
  lastLaunchedAt?: string;
}

const PROFILES_FILE = "profiles.json";

export type GameFileType =
  | "server-config"
  | "bot-roster"
  | "ship-settings"
  | "startup-commands"
  | "unknown";

export interface ClassifiedGameFile {
  filename: string;
  type: GameFileType;
  /** Key metadata extracted from file content. */
  meta: Record<string, string>;
  /** Profile ID if this file is linked to a profile, null otherwise. */
  linkedProfileId: string | null;
}

/**
 * Classify a file by reading its content header and extracting metadata.
 */
function classifyFile(filename: string, content: string): ClassifiedGameFile {
  const lower = filename.toLowerCase();
  const lines = content.split("\n").map((l) => l.trim());
  const meta: Record<string, string> = {};

  // .mps files → ship settings
  if (lower.endsWith(".mps")) {
    return { filename, type: "ship-settings", meta, linkedProfileId: null };
  }

  // .dmfc files → startup commands
  if (lower.endsWith(".dmfc")) {
    const cmdCount = lines.filter((l) => l && !l.startsWith("#") && !l.startsWith(";")).length;
    meta.commands = String(cmdCount);
    return { filename, type: "startup-commands", meta, linkedProfileId: null };
  }

  // .cfg files — need to inspect content to distinguish server config from bot roster
  if (lower.endsWith(".cfg")) {
    // Server config: first non-empty line is "[server config file]"
    const firstNonEmpty = lines.find((l) => l.length > 0);
    if (firstNonEmpty === "[server config file]") {
      // Extract key settings
      for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1);
        switch (key) {
          case "GameName": meta.gameName = val; break;
          case "Scriptname": meta.scriptName = val; break;
          case "MissionName": meta.missionName = val; break;
          case "MaxPlayers": meta.maxPlayers = val; break;
          case "Timelimit": meta.timeLimit = val; break;
          case "Killgoal": meta.killGoal = val; break;
        }
      }
      return { filename, type: "server-config", meta, linkedProfileId: null };
    }

    // Bot roster: contains BotCount= or BotName[
    const hasBotCount = lines.some((l) => l.startsWith("BotCount="));
    const hasBotName = lines.some((l) => l.startsWith("BotName["));
    if (hasBotCount || hasBotName) {
      for (const line of lines) {
        if (line.startsWith("BotCount=")) meta.botCount = line.slice(9);
        if (line.startsWith("BotDifficulty=")) meta.difficulty = line.slice(14);
      }
      return { filename, type: "bot-roster", meta, linkedProfileId: null };
    }
  }

  return { filename, type: "unknown", meta, linkedProfileId: null };
}

/**
 * Generate a unique config filename from a profile name.
 * Avoids collisions with existing files in gamePath.
 */
function configFilename(name: string, existingFiles: string[]): string {
  const existing = new Set(existingFiles.map((f) => f.toLowerCase()));
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "server";
  let filename = `${base}.cfg`;
  let counter = 1;
  while (existing.has(filename.toLowerCase())) {
    counter++;
    filename = `${base}-${counter}.cfg`;
  }
  return filename;
}

/**
 * Manages server profiles — lightweight metadata records pointing at
 * config files that live in the D3 game directory (gamePath).
 */
export class ServerProfileManager {
  constructor(
    private configDir: string,
    private gamePath: string,
  ) {}

  private get profilesPath(): string {
    return path.join(this.configDir, PROFILES_FILE);
  }

  /** Read the profiles array from disk. */
  private async loadProfiles(): Promise<ServerProfile[]> {
    try {
      const raw = await fs.readFile(this.profilesPath, "utf-8");
      return JSON.parse(raw) as ServerProfile[];
    } catch {
      return [];
    }
  }

  /** Write the profiles array to disk. */
  private async saveProfiles(profiles: ServerProfile[]): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    await fs.writeFile(this.profilesPath, JSON.stringify(profiles, null, 2));
  }

  /** List all server profiles. */
  async list(): Promise<ServerProfile[]> {
    return this.loadProfiles();
  }

  /** Read a single profile by ID. */
  async read(id: string): Promise<ServerProfile> {
    const profiles = await this.loadProfiles();
    const profile = profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`Profile not found: ${id}`);
    return profile;
  }

  /** Create a new server profile and generate its config file in gamePath. */
  async create(
    name: string,
    cfgDefaults?: DedicatedCfgDefaults,
    overrides?: { gamePath?: string; executablePath?: string },
  ): Promise<ServerProfile> {
    const profiles = await this.loadProfiles();

    // Use the profile-specific gamePath if provided, otherwise fall back to
    // this manager's gamePath (which comes from the global Pyrodeck config).
    const effectiveGamePath = overrides?.gamePath ?? this.gamePath;

    // Generate a unique config filename in the effective gamePath
    let existingFiles: string[] = [];
    try {
      existingFiles = await fs.readdir(effectiveGamePath);
    } catch {
      // gamePath may not exist yet
    }
    const cfgFile = configFilename(name, existingFiles);

    // Write the config file to the effective gamePath
    const cfgContent = generateDedicatedCfg(cfgDefaults);
    await fs.writeFile(path.join(effectiveGamePath, cfgFile), cfgContent);

    const profile: ServerProfile = {
      id: crypto.randomUUID(),
      name,
      configFile: cfgFile,
      createdAt: new Date().toISOString(),
    };
    if (overrides?.gamePath) profile.gamePath = overrides.gamePath;
    if (overrides?.executablePath) profile.executablePath = overrides.executablePath;

    profiles.push(profile);
    await this.saveProfiles(profiles);
    return profile;
  }

  /** Create a profile that links to an existing config file in gamePath (no new file generated). */
  async importExisting(name: string, configFile: string): Promise<ServerProfile> {
    const safe = this.safeName(configFile);
    if (!safe) throw new Error("Invalid config filename");

    // Verify the file exists
    try {
      await fs.access(path.join(this.gamePath, safe));
    } catch {
      throw new Error(`Config file not found in game directory: ${configFile}`);
    }

    const profiles = await this.loadProfiles();
    const profile: ServerProfile = {
      id: crypto.randomUUID(),
      name,
      configFile,
      createdAt: new Date().toISOString(),
    };

    profiles.push(profile);
    await this.saveProfiles(profiles);
    return profile;
  }

  /** Update profile metadata (name, description, logPath, gamePath, executablePath). */
  async update(
    id: string,
    updates: {
      name?: string;
      description?: string;
      logPath?: string | null;
      gamePath?: string | null;
      executablePath?: string | null;
    },
  ): Promise<ServerProfile> {
    const profiles = await this.loadProfiles();
    const profile = profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`Profile not found: ${id}`);

    if (updates.name !== undefined) profile.name = updates.name;
    if (updates.description !== undefined) profile.description = updates.description;
    if (updates.logPath !== undefined) {
      if (updates.logPath === null || updates.logPath === "") {
        delete profile.logPath;
      } else {
        profile.logPath = updates.logPath;
      }
    }
    if (updates.gamePath !== undefined) {
      if (updates.gamePath === null || updates.gamePath === "") {
        delete profile.gamePath;
      } else {
        profile.gamePath = updates.gamePath;
      }
    }
    if (updates.executablePath !== undefined) {
      if (updates.executablePath === null || updates.executablePath === "") {
        delete profile.executablePath;
      } else {
        profile.executablePath = updates.executablePath;
      }
    }

    await this.saveProfiles(profiles);
    return profile;
  }

  /** Record that a profile was launched. */
  async markLaunched(id: string): Promise<void> {
    const profiles = await this.loadProfiles();
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;
    profile.lastLaunchedAt = new Date().toISOString();
    await this.saveProfiles(profiles);
  }

  /** Delete a profile (metadata only — does not delete the config file from gamePath). */
  async delete(id: string): Promise<void> {
    const profiles = await this.loadProfiles();
    const filtered = profiles.filter((p) => p.id !== id);
    if (filtered.length === profiles.length) {
      throw new Error(`Profile not found: ${id}`);
    }
    await this.saveProfiles(filtered);
  }

  /** Duplicate a profile — copies the config file under a new name. */
  async duplicate(id: string, newName?: string): Promise<ServerProfile> {
    const source = await this.read(id);
    const name = newName ?? `${source.name} (copy)`;

    // The duplicate lives in the same effective gamePath as the source
    const effectiveGamePath = source.gamePath ?? this.gamePath;

    // Copy the config file to a new unique filename
    let existingFiles: string[] = [];
    try {
      existingFiles = await fs.readdir(effectiveGamePath);
    } catch {
      // gamePath may not exist
    }
    const newCfgFile = configFilename(name, existingFiles);

    try {
      await fs.copyFile(
        path.join(effectiveGamePath, source.configFile),
        path.join(effectiveGamePath, newCfgFile),
      );
    } catch {
      throw new Error(`Cannot copy config file: ${source.configFile}`);
    }

    const profiles = await this.loadProfiles();
    const profile: ServerProfile = {
      id: crypto.randomUUID(),
      name,
      configFile: newCfgFile,
      createdAt: new Date().toISOString(),
    };
    // Inherit the source profile's path overrides
    if (source.gamePath) profile.gamePath = source.gamePath;
    if (source.executablePath) profile.executablePath = source.executablePath;

    profiles.push(profile);
    await this.saveProfiles(profiles);
    return profile;
  }

  /**
   * Ensure a CVar reference (e.g., BotConfig=bots.cfg) exists in a server config file.
   * Adds the line if missing, updates the value if it already exists with a different value.
   * Returns true if the config was modified.
   */
  async ensureConfigReference(
    configFile: string,
    cvarName: string,
    cvarValue: string,
  ): Promise<boolean> {
    const safe = this.safeName(configFile);
    if (!safe) throw new Error("Invalid config filename");
    const cfgPath = path.join(this.gamePath, safe);
    let content: string;
    try {
      content = await fs.readFile(cfgPath, "utf-8");
    } catch {
      throw new Error(`Cannot read config file: ${configFile}`);
    }

    const lines = content.split("\n");
    const lowerKey = cvarName.toLowerCase();
    const existingIdx = lines.findIndex(
      (l) => l.trim().toLowerCase().startsWith(lowerKey + "="),
    );

    if (existingIdx !== -1) {
      const currentVal = lines[existingIdx].slice(lines[existingIdx].indexOf("=") + 1);
      if (currentVal === cvarValue) return false; // Already correct
      lines[existingIdx] = `${cvarName}=${cvarValue}`;
    } else {
      // Insert before the last line if it's empty, otherwise append
      const insertIdx = lines.length > 0 && lines[lines.length - 1].trim() === ""
        ? lines.length - 1
        : lines.length;
      lines.splice(insertIdx, 0, `${cvarName}=${cvarValue}`);
    }

    await fs.writeFile(cfgPath, lines.join("\n"));
    return true;
  }

  /**
   * Remove a CVar reference from a server config file.
   * Returns true if the config was modified.
   */
  async removeConfigReference(
    configFile: string,
    cvarName: string,
  ): Promise<boolean> {
    const safe = this.safeName(configFile);
    if (!safe) return false;
    const cfgPath = path.join(this.gamePath, safe);
    let content: string;
    try {
      content = await fs.readFile(cfgPath, "utf-8");
    } catch {
      return false;
    }

    const lines = content.split("\n");
    const lowerKey = cvarName.toLowerCase();
    const filtered = lines.filter(
      (l) => !l.trim().toLowerCase().startsWith(lowerKey + "="),
    );

    if (filtered.length === lines.length) return false; // Nothing to remove
    await fs.writeFile(cfgPath, filtered.join("\n"));
    return true;
  }

  /** Read a file from gamePath by filename. */
  async readFile(filename: string): Promise<string> {
    const safe = this.safeName(filename);
    if (!safe) throw new Error("Invalid filename");
    return fs.readFile(path.join(this.gamePath, safe), "utf-8");
  }

  /** Write a file to gamePath by filename. */
  async writeFile(filename: string, content: string): Promise<void> {
    const safe = this.safeName(filename);
    if (!safe) throw new Error("Invalid filename");
    await fs.writeFile(path.join(this.gamePath, safe), content);
  }

  /** Delete a file from gamePath. */
  async deleteFile(filename: string): Promise<void> {
    const safe = this.safeName(filename);
    if (!safe) throw new Error("Invalid filename");
    await fs.rm(path.join(this.gamePath, safe), { force: true });
  }

  /** List config-related files in gamePath (.cfg, .mps, .dmfc). */
  async listGameFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.gamePath);
      return entries.filter((f) => {
        const lower = f.toLowerCase();
        return (
          lower.endsWith(".cfg") ||
          lower.endsWith(".mps") ||
          lower.endsWith(".dmfc")
        );
      });
    } catch {
      return [];
    }
  }

  /**
   * Classify all config-related files in gamePath by reading their headers.
   * Returns files grouped by type with extracted metadata.
   */
  async classifyGameFiles(): Promise<ClassifiedGameFile[]> {
    const filenames = await this.listGameFiles();
    const profiles = await this.loadProfiles();
    const profileByFile = new Map<string, string>();
    for (const p of profiles) {
      profileByFile.set(p.configFile, p.id);
    }

    const results: ClassifiedGameFile[] = [];

    for (const filename of filenames) {
      let content: string;
      try {
        content = await fs.readFile(path.join(this.gamePath, filename), "utf-8");
      } catch {
        continue;
      }

      const file = classifyFile(filename, content);
      file.linkedProfileId = profileByFile.get(filename) ?? null;
      results.push(file);
    }

    return results;
  }

  /** Reject path traversal in filenames. */
  private safeName(name: string): string | null {
    if (
      name.includes("..") ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0")
    ) {
      return null;
    }
    return name;
  }
}
