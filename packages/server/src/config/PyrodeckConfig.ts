import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MISSION_HOST_SETTINGS,
  sanitizeStoredMissionHost,
  type MissionHostSettings,
} from "../gamefiles/missionHostSettings.js";
import {
  DEFAULT_SUPERVISOR_SETTINGS,
  sanitizeStoredSupervisor,
  type SupervisorSettings,
} from "../launcher/supervisorSettings.js";
import { checkJoinHost } from "../launcher/joinAddress.js";
import { DEFAULT_MAIL_SETTINGS, sanitizeStoredMail, type MailSettings } from "../ops/mailSettings.js";
import { DEFAULT_PRIORITY_CLASS, isPriorityClass, type PriorityClass } from "../ops/processPriority.js";
import { DEFAULT_UPDATE_SETTINGS, sanitizeStoredUpdate, type UpdateSettings } from "../ops/updateCheck.js";
import {
  DEFAULT_PLAYER_SETTINGS,
  sanitizeStoredPlayerSettings,
  type PlayerSettings,
} from "../players/playerSettings.js";
import { DEFAULT_PLAYER_RULES, sanitizeStoredPlayerRules, type PlayerRules } from "../rules/ruleSettings.js";
import {
  DEFAULT_LOG_RETENTION,
  sanitizeStoredLogRetention,
  type LogRetentionSettings,
} from "../launcher/logRetention.js";
import {
  DEFAULT_AUTOSTART_SETTINGS,
  sanitizeStoredAutostart,
  type AutostartSettings,
} from "../launcher/autostartSettings.js";

export interface PyrodeckConfig {
  /** Directory containing D3 game data (.hog files, missions, config files). Required for Launch mode. */
  gamePath: string | null;
  /** Full path to D3 binary, or filename if binary is in gamePath. */
  executablePath: string | null;
  /**
   * Directory where server logs are written. When null, logs are auto-placed
   * in the directory containing the D3 executable (next to the game), so they
   * sit alongside the install rather than buried in a Pyrodeck-internal path.
   */
  logDir: string | null;
  /**
   * Retention for the logs Pyrodeck writes (launcher/logRetention.ts). Set via
   * /api/logs/retention only; PYRODECK_LOG_RETENTION_DAYS and
   * PYRODECK_LOG_MAX_MB win over days and maxMb.
   */
  logRetention: LogRetentionSettings;
  /** Default telnet port for D3 remote console. */
  defaultTelnetPort: number;
  /** Preferred UI mode on startup. */
  preferredMode: "connect" | "launch";
  /** Scrypt hash of admin password ("salt:hash" hex). Null = no password set via config. */
  adminPasswordHash: string | null;
  /** Mission download listener (gamefiles/MissionHost.ts). Set via /api/mission-host only. */
  missionHost: MissionHostSettings;
  /** Crash relaunch, hang check, restart when empty (launcher/Supervisor.ts). Set via /api/launcher/supervisor only. */
  supervisor: SupervisorSettings;
  /**
   * The profile to launch when Pyrodeck starts (launcher/autostartSettings.ts).
   * Set with PATCH /api/profiles/:id { autostart } only; PYRODECK_AUTOSTART_PROFILE wins.
   */
  autostart: AutostartSettings;
  /** Host name or IPv4 address players join at, shown with the game port in the Launch panel. Null = unknown. */
  joinHost: string | null;
  /** Email alerts (ops/mailSettings.ts). Set via /api/alerts/mail only; the password is never returned. */
  mail: MailSettings;
  /** Priority class for the game process after each launch (ops/processPriority.ts). Set via /api/process-priority. */
  processPriority: PriorityClass;
  /** GitHub release check (ops/updateCheck.ts). Set via /api/update-check. */
  updateCheck: UpdateSettings;
  /** Player history, bans and join rules (players/playerSettings.ts). Set via /api/players/settings only. */
  players: PlayerSettings;
  /** Nickname rules and the profanity monitor (rules/ruleSettings.ts). Set via /api/players/rules only. */
  playerRules: PlayerRules;
}

/** Legacy config shape for migration from pre-profile versions. */
interface LegacyPyrodeckConfig {
  d3InstallPath?: string | null;
  d3Executable?: string | null;
  defaultConfigFile?: string;
  defaultTelnetPort?: number;
  preferredMode?: "connect" | "launch";
}

const DEFAULT_CONFIG: PyrodeckConfig = {
  gamePath: null,
  executablePath: null,
  logDir: null,
  logRetention: { ...DEFAULT_LOG_RETENTION },
  defaultTelnetPort: 2092,
  preferredMode: "connect",
  adminPasswordHash: null,
  missionHost: { ...DEFAULT_MISSION_HOST_SETTINGS },
  supervisor: { ...DEFAULT_SUPERVISOR_SETTINGS },
  autostart: { ...DEFAULT_AUTOSTART_SETTINGS },
  joinHost: null,
  mail: { ...DEFAULT_MAIL_SETTINGS, events: { ...DEFAULT_MAIL_SETTINGS.events } },
  processPriority: DEFAULT_PRIORITY_CLASS,
  updateCheck: { ...DEFAULT_UPDATE_SETTINGS },
  players: { ...DEFAULT_PLAYER_SETTINGS },
  playerRules: DEFAULT_PLAYER_RULES,
};

/**
 * Migrate legacy config fields to new schema.
 * - d3InstallPath → gamePath
 * - d3Executable → executablePath (joined with gamePath if relative)
 * - defaultConfigFile → removed (profiles always use dedicated.cfg)
 */
function migrateConfig(
  raw: Record<string, unknown>,
): Partial<PyrodeckConfig> {
  const migrated: Partial<PyrodeckConfig> = {};
  const legacy = raw as LegacyPyrodeckConfig;

  // Already new format — pass through known fields
  if ("gamePath" in raw) {
    migrated.gamePath = (raw.gamePath as string | null) ?? null;
  }
  if ("executablePath" in raw) {
    migrated.executablePath = (raw.executablePath as string | null) ?? null;
  }
  if ("logDir" in raw) {
    migrated.logDir = (raw.logDir as string | null) ?? null;
  }
  if ("logRetention" in raw) {
    migrated.logRetention = sanitizeStoredLogRetention(raw.logRetention);
  }

  // Migrate legacy fields
  if ("d3InstallPath" in raw && !("gamePath" in raw)) {
    migrated.gamePath = legacy.d3InstallPath ?? null;
  }
  if ("d3Executable" in raw && !("executablePath" in raw)) {
    const exe = legacy.d3Executable;
    const installPath = legacy.d3InstallPath ?? (migrated.gamePath as string | null);
    if (exe && installPath) {
      // If executable is just a filename, join with install path to make it absolute
      if (!path.isAbsolute(exe) && !exe.includes(path.sep)) {
        migrated.executablePath = path.join(installPath, exe);
      } else {
        migrated.executablePath = exe;
      }
    } else if (exe) {
      migrated.executablePath = exe;
    }
  }

  // Pass through shared fields
  if ("defaultTelnetPort" in raw && typeof raw.defaultTelnetPort === "number") {
    migrated.defaultTelnetPort = raw.defaultTelnetPort;
  }
  if ("preferredMode" in raw && (raw.preferredMode === "connect" || raw.preferredMode === "launch")) {
    migrated.preferredMode = raw.preferredMode;
  }
  if ("adminPasswordHash" in raw && typeof raw.adminPasswordHash === "string") {
    migrated.adminPasswordHash = raw.adminPasswordHash;
  }
  if ("missionHost" in raw) {
    migrated.missionHost = sanitizeStoredMissionHost(raw.missionHost);
  }
  if ("supervisor" in raw) {
    migrated.supervisor = sanitizeStoredSupervisor(raw.supervisor);
  }
  if ("autostart" in raw) {
    migrated.autostart = sanitizeStoredAutostart(raw.autostart);
  }
  if (typeof raw.joinHost === "string") {
    const check = checkJoinHost(raw.joinHost);
    migrated.joinHost = "host" in check ? check.host : null;
  }
  if ("mail" in raw) {
    migrated.mail = sanitizeStoredMail(raw.mail);
  }
  if ("processPriority" in raw && isPriorityClass(raw.processPriority)) {
    migrated.processPriority = raw.processPriority;
  }
  if ("updateCheck" in raw) {
    migrated.updateCheck = sanitizeStoredUpdate(raw.updateCheck);
  }
  if ("players" in raw) {
    migrated.players = sanitizeStoredPlayerSettings(raw.players);
  }
  if ("playerRules" in raw) {
    migrated.playerRules = sanitizeStoredPlayerRules(raw.playerRules);
  }

  return migrated;
}

export class PyrodeckConfigManager {
  private filePath: string;
  private config: PyrodeckConfig = { ...DEFAULT_CONFIG };

  constructor(configDir: string) {
    this.filePath = path.join(configDir, "pyrodeck.json");
  }

  async load(): Promise<PyrodeckConfig> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const saved = JSON.parse(raw) as Record<string, unknown>;
      const migrated = migrateConfig(saved);
      const merged = { ...DEFAULT_CONFIG, ...migrated };
      this.config = merged;

      // If migration changed anything, persist the new format
      const needsMigration = "d3InstallPath" in saved || "d3Executable" in saved || "defaultConfigFile" in saved;
      if (needsMigration) {
        await this.persist();
      }
    } catch {
      // File doesn't exist or is invalid — use defaults
      this.config = { ...DEFAULT_CONFIG };
    }
    return this.config;
  }

  async save(updates: Partial<PyrodeckConfig>): Promise<PyrodeckConfig> {
    this.config = { ...this.config, ...updates };
    await this.persist();
    return this.config;
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    // Owner-only: the file holds the SMTP password (and the admin password hash).
    await fs.writeFile(this.filePath, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    await fs.chmod(this.filePath, 0o600).catch(() => {});
  }

  get(): PyrodeckConfig {
    return this.config;
  }

  needsSetup(): boolean {
    return !this.config.gamePath;
  }
}

// --- Path validation ---

export interface GamePathValidation {
  valid: boolean;
  errors: string[];
  hogFiles: string[];
  missionFiles: string[];
}

export interface ExecutableValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a D3 game data directory.
 * Checks that the directory exists and contains required game data (d3.hog).
 * Also scans for available missions (.mn3) and other .hog files.
 */
export async function validateGamePath(gamePath: string): Promise<GamePathValidation> {
  const errors: string[] = [];
  const hogFiles: string[] = [];
  const missionFiles: string[] = [];

  // Check directory exists
  try {
    const stat = await fs.stat(gamePath);
    if (!stat.isDirectory()) {
      return { valid: false, errors: ["Path is not a directory"], hogFiles, missionFiles };
    }
  } catch {
    return { valid: false, errors: ["Directory does not exist"], hogFiles, missionFiles };
  }

  // Scan for game files
  try {
    const entries = await fs.readdir(gamePath);
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      if (lower.endsWith(".hog")) hogFiles.push(entry);
      if (lower.endsWith(".mn3")) missionFiles.push(entry);
    }
  } catch {
    errors.push("Cannot read directory contents");
  }

  // Check for required game data
  const hasD3Hog = hogFiles.some((f) => f.toLowerCase() === "d3.hog");
  if (!hasD3Hog) {
    errors.push("Required file d3.hog not found — game data may be missing");
  }

  return { valid: errors.length === 0, errors, hogFiles, missionFiles };
}

/**
 * Validate a D3 executable path.
 * Accepts either an absolute path or a filename to look for in gamePath.
 */
export async function validateExecutable(
  executablePath: string,
  gamePath?: string | null,
): Promise<ExecutableValidation> {
  const errors: string[] = [];

  // Resolve path: if not absolute, try joining with gamePath
  let resolved = executablePath;
  if (!path.isAbsolute(executablePath) && gamePath) {
    resolved = path.join(gamePath, executablePath);
  }

  try {
    await fs.access(resolved);
  } catch {
    errors.push(`Executable not found: ${resolved}`);
  }

  return { valid: errors.length === 0, errors };
}

