import crypto from "node:crypto";

/**
 * D3 dedicated.cfg parser and generator.
 *
 * Config format: Key=Value, one per line. Some keys can repeat
 * (AllowPowerup, DisallowPowerup). Lines starting with # or ; are comments.
 * Blank lines are preserved.
 */

export interface DedicatedCfgEntry {
  key: string;
  value: string;
}

/**
 * Parse a dedicated.cfg file into key-value entries.
 * Preserves order and duplicate keys (e.g. AllowPowerup appearing multiple times).
 */
export function parseDedicatedCfg(content: string): DedicatedCfgEntry[] {
  const entries: DedicatedCfgEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    entries.push({
      key: trimmed.slice(0, eqIndex),
      value: trimmed.slice(eqIndex + 1),
    });
  }
  return entries;
}

/**
 * Get a single value from parsed config entries.
 * Returns the last occurrence if the key appears multiple times.
 */
export function getCfgValue(
  entries: DedicatedCfgEntry[],
  key: string,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].key.toLowerCase() === key.toLowerCase()) {
      return entries[i].value;
    }
  }
  return undefined;
}

/**
 * Get all values for a key that may repeat (e.g. AllowPowerup).
 */
export function getCfgValues(
  entries: DedicatedCfgEntry[],
  key: string,
): string[] {
  const lk = key.toLowerCase();
  return entries.filter((e) => e.key.toLowerCase() === lk).map((e) => e.value);
}

/**
 * Extract telnet connection info from a parsed config.
 * Used by ProcessManager to auto-connect after launching.
 *
 * The engine always opens its console; a ConsolePassword is what makes it
 * usable. `allowRemote` is AllowRemoteConsole=1: connections from other
 * machines are accepted (Connect mode from elsewhere needs it). With 0, the
 * engine's default, only 127.0.0.1 gets in, which is all Pyrodeck needs for a
 * server it launches on this machine (launchOptions.ts consoleHostFor).
 */
export function extractTelnetConfig(entries: DedicatedCfgEntry[]): {
  allowRemote: boolean;
  port: number;
  password: string | undefined;
} {
  const allowRemote = getCfgValue(entries, "AllowRemoteConsole");
  const port = getCfgValue(entries, "RemoteConsolePort");
  const password = getCfgValue(entries, "ConsolePassword");

  return {
    allowRemote: allowRemote?.trim() === "1",
    port: port ? parseInt(port, 10) : 2092,
    password,
  };
}

// ---------------------------------------------------------------------------
// Structured config schema
// ---------------------------------------------------------------------------

/** Known game type scripts (Scriptname= values, without .d3m extension). */
export const GAME_SCRIPTS = [
  "Anarchy",
  "Team Anarchy",
  "CTF",
  "Monsterball",
  "Entropy",
  "Hoard",
  "Hyper-Anarchy",
  "Robo-Anarchy",
  "Co-op",
] as const;
export type GameScript = (typeof GAME_SCRIPTS)[number];

/** Network model derived from Peer2Peer= and Permissable= CVars. */
export type NetworkModel = "client-server" | "peer2peer" | "permissable";

/** All valid powerup names, grouped by category. */
export const POWERUP_CATEGORIES = {
  primary: [
    "SuperLaser",
    "Fusioncannon",
    "MassDriver",
    "Microwave",
    "Plasmacannon",
    "EMDlauncher",
    "Omegacannon",
    "Vauss",
    "Napalm",
  ],
  secondary: [
    "Concussion",
    "Homing",
    "Smart",
    "Mega",
    "Frag",
    "Guided",
    "ImpactMortar",
    "NapalmRocket",
    "Cyclone",
    "BlackShark",
  ],
  utility: [
    "Energy",
    "Shield",
    "QuadLaser",
    "Cloak",
    "Invulnerability",
    "Afterburner",
    "Converter",
  ],
  countermeasures: [
    "Chaff",
    "Betty4Pack",
    "Seeker3Pack",
    "GunboyPowerup",
    "ProxMinePowerup",
  ],
} as const;

export const ALL_POWERUPS: string[] = Object.values(POWERUP_CATEGORIES).flat();

/** Ship full names (used in SHIPBAN .mps entries). */
export const ALL_SHIPS = ["Pyro-GL", "Phoenix", "Magnum-AHT", "Black Pyro"] as const;
export type ShipName = (typeof ALL_SHIPS)[number];

/**
 * Fully structured representation of a dedicated.cfg.
 * All fields have explicit values — no undefined, no reliance on D3 defaults.
 * Ship bans live here but are stored in an .mps file on disk.
 */
export interface DedicatedCfgData {
  // Identity
  gameName: string;        // GameName= (max 32)
  missionName: string;     // MissionName= (max 32)
  scriptName: string;      // Scriptname= (max 32, e.g. "Anarchy.d3m")
  motd: string;            // MOTD= (max 400)
  startingLevel: number;   // SetLevel=

  // Network
  maxPlayers: number;        // MaxPlayers= (2-32)
  pps: number;               // PPS= (2-40)
  networkModel: NetworkModel; // derived from Peer2Peer= / Permissable=
  sendRotVel: boolean;       // SendRotVel=
  useSmoothing: boolean;     // UseSmoothing=

  // Rules
  timeLimit: number;         // Timelimit= (0 = disabled)
  killGoal: number;          // Killgoal= (0 = disabled)
  respawnTime: number;       // RespawnTime=
  randomizeRespawn: boolean; // RandomizeRespawn=
  difficulty: number;        // SetDifficulty= (0-4)
  numTeams: number;          // NumTeams= (2-4, team modes only)
  audioTauntDelay: number;   // AudioTauntDelay=

  // Gameplay toggles
  accurateCollisions: boolean; // AccurateCollisions=
  brightPlayers: boolean;      // BrightPlayers=
  allowMouselook: boolean;     // AllowMouselook=

  // Remote console
  allowRemoteConsole: boolean; // AllowRemoteConsole=
  remoteConsolePort: number;   // RemoteConsolePort=
  consolePassword: string;     // ConsolePassword=

  // Powerup control
  // Empty allowedPowerups = no explicit allow list (all allowed unless disallowed).
  // Non-empty allowedPowerups = ONLY these powerups spawn (AllowPowerup= lines).
  allowedPowerups: string[];
  disallowedPowerups: string[];

  // Ship bans — stored in an .mps file, referenced via MultiSettingsFile=.
  bannedShips: string[];

  // Companion file references (as they appear in the cfg).
  botConfigFile: string | null;
  multiSettingsFile: string | null;
}

/** D3 engine defaults (before any config is applied). */
const D3_DEFAULTS: DedicatedCfgData = {
  gameName: "Generic D3 Game",
  missionName: "fury.mn3",
  scriptName: "Anarchy.d3m",
  motd: "",
  startingLevel: 1,

  maxPlayers: 8,
  pps: 10,
  networkModel: "client-server",
  sendRotVel: false,
  useSmoothing: false,

  timeLimit: 0,
  killGoal: 0,
  respawnTime: 60,
  randomizeRespawn: true, // NF_RANDOMIZE_RESPAWN is on by default
  difficulty: 2,
  numTeams: 2,
  audioTauntDelay: 0,

  accurateCollisions: false,
  brightPlayers: false,
  allowMouselook: false,

  allowRemoteConsole: false,
  remoteConsolePort: 2092,
  consolePassword: "",

  allowedPowerups: [],
  disallowedPowerups: [],
  bannedShips: [],

  botConfigFile: null,
  multiSettingsFile: null,
};

/** Pyrodeck-recommended defaults for new server configs. */
export const PYRODECK_DEFAULTS: Partial<DedicatedCfgData> = {
  pps: 20,
  // Console on this machine only; Pyrodeck needs no more for a server it launches.
  allowRemoteConsole: false,
  remoteConsolePort: 2092,
  randomizeRespawn: true,
  disallowedPowerups: ["Guided", "4PackGuided"],
};

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function parseInt10(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

function parseFloat10(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseFloat(value);
  return isNaN(n) ? fallback : n;
}

/**
 * Convert parsed cfg entries into a structured DedicatedCfgData object.
 * Unknown keys are ignored. Missing keys get D3 engine defaults.
 */
export function entriesToStructured(entries: DedicatedCfgEntry[]): DedicatedCfgData {
  const get = (key: string) => getCfgValue(entries, key);

  // Network model: check Peer2Peer and Permissable flags
  let networkModel: NetworkModel = "client-server";
  if (parseBool(get("Peer2Peer"), false)) networkModel = "peer2peer";
  else if (parseBool(get("Permissable"), false)) networkModel = "permissable";

  // Scriptname: normalize — D3 stores as e.g. "Anarchy" or "Anarchy.d3m"
  const rawScript = get("Scriptname") ?? D3_DEFAULTS.scriptName;
  const scriptName = rawScript.toLowerCase().endsWith(".d3m")
    ? rawScript
    : `${rawScript}.d3m`;

  return {
    gameName: get("GameName") ?? D3_DEFAULTS.gameName,
    missionName: get("MissionName") ?? D3_DEFAULTS.missionName,
    scriptName,
    motd: get("MOTD") ?? "",
    startingLevel: parseInt10(get("SetLevel"), 1),

    maxPlayers: parseInt10(get("MaxPlayers"), D3_DEFAULTS.maxPlayers),
    pps: parseInt10(get("PPS"), D3_DEFAULTS.pps),
    networkModel,
    sendRotVel: parseBool(get("SendRotVel"), false),
    useSmoothing: parseBool(get("UseSmoothing"), false),

    timeLimit: parseInt10(get("Timelimit"), 0),
    killGoal: parseInt10(get("Killgoal"), 0),
    respawnTime: parseInt10(get("RespawnTime"), D3_DEFAULTS.respawnTime),
    randomizeRespawn: parseBool(get("RandomizeRespawn"), D3_DEFAULTS.randomizeRespawn),
    difficulty: parseInt10(get("SetDifficulty"), D3_DEFAULTS.difficulty),
    numTeams: parseInt10(get("NumTeams"), 2),
    audioTauntDelay: parseFloat10(get("AudioTauntDelay"), 0),

    accurateCollisions: parseBool(get("AccurateCollisions"), false),
    brightPlayers: parseBool(get("BrightPlayers"), false),
    allowMouselook: parseBool(get("AllowMouselook"), false),

    allowRemoteConsole: parseBool(get("AllowRemoteConsole"), false),
    remoteConsolePort: parseInt10(get("RemoteConsolePort"), 2092),
    consolePassword: get("ConsolePassword") ?? "",

    allowedPowerups: getCfgValues(entries, "AllowPowerup"),
    disallowedPowerups: getCfgValues(entries, "DisallowPowerup"),

    // Ship bans come from the .mps file, not from entries — filled in by caller.
    bannedShips: [],

    botConfigFile: get("BotConfig") ?? null,
    multiSettingsFile: get("MultiSettingsFile") ?? null,
  };
}

/**
 * Generate a dedicated.cfg string from a structured DedicatedCfgData object.
 * Always writes all fields explicitly (no relying on D3 defaults).
 * This is the "structured mode" output — raw mode preserves the existing file as-is.
 */
export function structuredToString(data: DedicatedCfgData): string {
  const lines: string[] = ["[server config file]"];

  // Identity
  lines.push(`GameName=${data.gameName}`);
  lines.push(`MissionName=${data.missionName}`);
  lines.push(`Scriptname=${data.scriptName}`);
  if (data.motd) lines.push(`MOTD=${data.motd}`);
  if (data.startingLevel !== 1) lines.push(`SetLevel=${data.startingLevel}`);

  // Network
  lines.push(`ConnectionName=Direct TCP~IP`);
  lines.push(`MaxPlayers=${data.maxPlayers}`);
  lines.push(`PPS=${data.pps}`);
  if (data.numTeams !== 2) lines.push(`NumTeams=${data.numTeams}`);

  // Network model flags
  if (data.networkModel === "peer2peer") {
    lines.push(`Peer2Peer=1`);
  } else if (data.networkModel === "permissable") {
    lines.push(`Permissable=1`);
  }

  if (data.sendRotVel) lines.push(`SendRotVel=1`);
  if (data.useSmoothing) lines.push(`UseSmoothing=1`);

  // Rules
  lines.push(`Timelimit=${data.timeLimit}`);
  lines.push(`Killgoal=${data.killGoal}`);
  lines.push(`RespawnTime=${data.respawnTime}`);
  lines.push(`SetDifficulty=${data.difficulty}`);
  if (!data.randomizeRespawn) lines.push(`RandomizeRespawn=0`);
  if (data.audioTauntDelay > 0) lines.push(`AudioTauntDelay=${data.audioTauntDelay}`);

  // Gameplay
  if (data.accurateCollisions) lines.push(`AccurateCollisions=1`);
  if (data.brightPlayers) lines.push(`BrightPlayers=1`);
  if (data.allowMouselook) lines.push(`AllowMouselook=1`);

  // Remote console
  lines.push(`AllowRemoteConsole=${data.allowRemoteConsole ? 1 : 0}`);
  lines.push(`RemoteConsolePort=${data.remoteConsolePort}`);
  lines.push(`ConsolePassword=${data.consolePassword}`);

  // Companion files
  if (data.botConfigFile) lines.push(`BotConfig=${data.botConfigFile}`);
  if (data.multiSettingsFile) lines.push(`MultiSettingsFile=${data.multiSettingsFile}`);

  // Powerups
  for (const p of data.allowedPowerups) lines.push(`AllowPowerup=${p}`);
  for (const p of data.disallowedPowerups) lines.push(`DisallowPowerup=${p}`);

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// MPS file (.mps) — ship bans and additional settings
// ---------------------------------------------------------------------------

export interface MpsData {
  bannedShips: string[];
}

/**
 * Parse an .mps file into structured data.
 * Format: tab-separated LABEL\tVALUE lines.
 */
export function parseMpsFile(content: string): MpsData {
  const bannedShips: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;

    const tabIdx = trimmed.indexOf("\t");
    if (tabIdx === -1) continue;

    const label = trimmed.slice(0, tabIdx).trim().toUpperCase();
    const value = trimmed.slice(tabIdx + 1).trim();

    if (label === "SHIPBAN") {
      bannedShips.push(value);
    }
  }

  return { bannedShips };
}

/**
 * Generate an .mps file from structured ship ban data.
 */
export function generateMpsFile(data: MpsData): string {
  const lines: string[] = [];
  for (const ship of data.bannedShips) {
    lines.push(`SHIPBAN\t${ship}`);
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

// ---------------------------------------------------------------------------
// Bot roster file (bots.cfg)
// ---------------------------------------------------------------------------

export interface BotEntry {
  name: string;
  ship?: string;       // pyro | phoenix | magnum | blackpyro
  difficulty?: string; // trainee | rookie | hotshot | ace | insane
  team?: number;       // 1-indexed (1–4), undefined = auto-balance
}

export interface BotRosterData {
  botCount: number;
  defaultDifficulty?: string;
  bots: BotEntry[];
}

/**
 * Parse a bot roster file (Key=Value format) into structured data.
 */
export function parseBotRoster(content: string): BotRosterData {
  const entries = parseDedicatedCfg(content);
  const get = (key: string) => getCfgValue(entries, key);

  const botCount = parseInt10(get("BotCount"), 0);
  const defaultDifficulty = get("BotDifficulty");
  const bots: BotEntry[] = [];

  for (let i = 1; i <= botCount; i++) {
    const name = get(`BotName${i}`);
    if (!name) continue;
    const teamVal = get(`BotTeam${i}`);
    const team = teamVal ? parseInt(teamVal, 10) : undefined;
    bots.push({
      name,
      ship: get(`BotShip${i}`),
      difficulty: get(`BotDifficulty${i}`),
      team: team !== undefined && team >= 1 && team <= 4 ? team : undefined,
    });
  }

  return { botCount, defaultDifficulty, bots };
}

/**
 * Generate a bot roster file from structured data.
 */
export function generateBotRoster(data: BotRosterData): string {
  const lines: string[] = [
    `BotCount=${data.bots.length}`,
  ];

  if (data.defaultDifficulty) {
    lines.push(`BotDifficulty=${data.defaultDifficulty}`);
  }

  for (let i = 0; i < data.bots.length; i++) {
    const bot = data.bots[i];
    const n = i + 1;
    lines.push(`BotName${n}=${bot.name}`);
    if (bot.ship) lines.push(`BotShip${n}=${bot.ship}`);
    if (bot.difficulty) lines.push(`BotDifficulty${n}=${bot.difficulty}`);
    if (bot.team !== undefined && bot.team >= 1 && bot.team <= 4) lines.push(`BotTeam${n}=${bot.team}`);
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Legacy generate function — kept for backwards compat with ServerProfile
// ---------------------------------------------------------------------------

export interface DedicatedCfgDefaults {
  gameName?: string;
  missionName?: string;
  scriptName?: string;
  maxPlayers?: number;
  pps?: number;
  timeLimit?: number;
  killGoal?: number;
  consolePassword?: string;
  remoteConsolePort?: number;
  /** AllowRemoteConsole=1: accept console connections from other machines. Default off. */
  allowRemoteConsole?: boolean;
}

/**
 * Generate a dedicated.cfg with sensible defaults for Pyrodeck-managed servers.
 *
 * D3's config format requires:
 * - First line must be "[server config file]" (tag_check in InfFile::Open)
 * - Key=Value syntax, one per line (no comments — D3 only strips ; and # in some parsers)
 * - Key casing must match CVar registration (e.g. Scriptname not ScriptName)
 * - ConnectionName is required for network mode
 * - ConsolePassword is what Pyrodeck logs in with. AllowRemoteConsole=0 keeps
 *   the console to connections from 127.0.0.1, all Pyrodeck needs for a server
 *   it launches here; set 1 only for Connect mode from another machine.
 */
export function generateDedicatedCfg(
  opts: DedicatedCfgDefaults = {},
): string {
  const password =
    opts.consolePassword ?? crypto.randomBytes(4).toString("hex");
  const port = opts.remoteConsolePort ?? 2092;

  const lines = [
    "[server config file]",
    `GameName=${opts.gameName ?? "Pyrodeck Server"}`,
    `MissionName=${opts.missionName ?? "fury.mn3"}`,
    `Scriptname=${opts.scriptName ?? "anarchy.d3m"}`,
    `ConnectionName=Direct TCP~IP`,
    `MaxPlayers=${opts.maxPlayers ?? 8}`,
    `PPS=${opts.pps ?? 20}`,
    `Timelimit=${opts.timeLimit ?? 0}`,
    `Killgoal=${opts.killGoal ?? 0}`,
    `AllowRemoteConsole=${opts.allowRemoteConsole ? 1 : 0}`,
    `RemoteConsolePort=${port}`,
    `ConsolePassword=${password}`,
  ];

  return lines.join("\n") + "\n";
}
