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
  createdAt: string;
  lastLaunchedAt?: string;
}

const PROFILES_FILE = "profiles.json";

/**
 * Generate a unique config filename from a profile name.
 * Avoids collisions with existing files in gamePath.
 */
function configFilename(name: string, existingFiles: string[]): string {
  const existing = new Set(existingFiles.map((f) => f.toLowerCase()));
  let base =
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
  ): Promise<ServerProfile> {
    const profiles = await this.loadProfiles();

    // Generate a unique config filename in gamePath
    let existingFiles: string[] = [];
    try {
      existingFiles = await fs.readdir(this.gamePath);
    } catch {
      // gamePath may not exist yet
    }
    const cfgFile = configFilename(name, existingFiles);

    // Write the config file to gamePath
    const cfgContent = generateDedicatedCfg(cfgDefaults);
    await fs.writeFile(path.join(this.gamePath, cfgFile), cfgContent);

    const profile: ServerProfile = {
      id: crypto.randomUUID(),
      name,
      configFile: cfgFile,
      createdAt: new Date().toISOString(),
    };

    profiles.push(profile);
    await this.saveProfiles(profiles);
    return profile;
  }

  /** Create a profile that links to an existing config file in gamePath (no new file generated). */
  async importExisting(name: string, configFile: string): Promise<ServerProfile> {
    // Verify the file exists
    try {
      await fs.access(path.join(this.gamePath, configFile));
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

  /** Update profile metadata (name, description). */
  async update(
    id: string,
    updates: { name?: string; description?: string },
  ): Promise<ServerProfile> {
    const profiles = await this.loadProfiles();
    const profile = profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`Profile not found: ${id}`);

    if (updates.name !== undefined) profile.name = updates.name;
    if (updates.description !== undefined) profile.description = updates.description;

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

    // Copy the config file to a new unique filename
    let existingFiles: string[] = [];
    try {
      existingFiles = await fs.readdir(this.gamePath);
    } catch {
      // gamePath may not exist
    }
    const newCfgFile = configFilename(name, existingFiles);

    try {
      await fs.copyFile(
        path.join(this.gamePath, source.configFile),
        path.join(this.gamePath, newCfgFile),
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
    profiles.push(profile);
    await this.saveProfiles(profiles);
    return profile;
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
