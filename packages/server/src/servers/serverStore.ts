import fs from "node:fs/promises";
import path from "node:path";
import { readRunRecord, type RunRecord } from "../launcher/runRecord.js";
import { NO_PROFILE_ID } from "../events/ServerEvents.js";

/**
 * What Pyrodeck keeps about the servers it runs, in `<config>/servers/index.json`,
 * and each server's own files under `<config>/servers/<id>/` (run.json, the
 * run record; playlist-state.json, its playlist). Not `<config>/servers.json`:
 * that file is Connect mode's saved servers (routes/saved-servers.ts). Kept out of pyrodeck.json:
 * a Pyrodeck from before it ran several servers saves only the keys it
 * knows, and would drop these.
 *
 * Kept for such a Pyrodeck (a downgrade) as before: `running-server.json`
 * for one running server, `playlist-state.json` for the server that owned
 * it (the legacy owner), and pyrodeck.json `autostart.profileId` as the first
 * profile of the autostart list.
 */

export const SERVERS_DIR = "servers";
/** The autostart list and the legacy owner, relative to the config directory. */
export const SERVERS_FILE = path.join(SERVERS_DIR, "index.json");
/**
 * Where development builds before the release kept SERVERS_FILE: the name of
 * Connect mode's saved servers, which they overwrote. Moved once, when it
 * holds this store's shape (an object) and not saved servers (an array).
 */
const EARLY_SERVERS_FILE = "servers.json";
/** The server launched without a profile (the global dedicated.cfg); its events carry NO_PROFILE_ID. */
export const LAUNCH_SERVER_ID = NO_PROFILE_ID;
/** Connect mode's console session (one remote server), in the server list and on the WebSocket. */
export const CONNECT_SERVER_ID = "connect";
/** Ids a server cannot have: they name the two above, and /api/servers/saved (saved Connect targets). */
export const RESERVED_SERVER_IDS: ReadonlySet<string> = new Set([LAUNCH_SERVER_ID, CONNECT_SERVER_ID, "saved"]);

export interface ServersFile {
  version: 1;
  /** Profiles that start when Pyrodeck starts ("Start when Pyrodeck starts"), in order. */
  autostart: string[];
  /**
   * The server that keeps `<config>/playlist-state.json`, the playlist state
   * of a Pyrodeck that ran one server, so that a downgrade finds its
   * playlist where it left it.
   */
  legacyOwner: string | null;
}

/** A server id that can name a directory: profile ids are UUIDs. */
export function isServerIdSafe(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(id) && id !== "." && id !== "..";
}

export function serverDir(configDir: string, id: string): string {
  return path.join(configDir, SERVERS_DIR, id);
}

function sanitize(raw: unknown): ServersFile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const autostart = Array.isArray(r.autostart)
    ? [...new Set(r.autostart.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))]
    : [];
  const legacyOwner = typeof r.legacyOwner === "string" && r.legacyOwner ? r.legacyOwner : null;
  return { version: 1, autostart, legacyOwner };
}

export async function readServersFile(configDir: string): Promise<ServersFile | null> {
  try {
    return sanitize(JSON.parse(await fs.readFile(path.join(configDir, SERVERS_FILE), "utf-8")));
  } catch {
    return null;
  }
}

/** Move a development build's store out of the saved servers' file (see EARLY_SERVERS_FILE); true when moved. */
async function moveEarlyServersFile(configDir: string): Promise<boolean> {
  const early = path.join(configDir, EARLY_SERVERS_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(early, "utf-8"));
  } catch {
    return false;
  }
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || Array.isArray(r) || r.version !== 1 || !Array.isArray(r.autostart)) return false;
  if ((await readServersFile(configDir)) !== null) return false;
  await fs.mkdir(path.join(configDir, SERVERS_DIR), { recursive: true });
  await fs.rename(early, path.join(configDir, SERVERS_FILE));
  return true;
}

export async function writeServersFile(configDir: string, file: ServersFile): Promise<void> {
  const target = path.join(configDir, SERVERS_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(`${target}.tmp`, JSON.stringify(file, null, 2));
  await fs.rename(`${target}.tmp`, target);
}

/** The profile facts the upgrade reads. */
export interface ProfileRef {
  id: string;
  lastLaunchedAt?: string;
}

export interface UpgradeInput {
  configDir: string;
  profiles: readonly ProfileRef[];
  /** pyrodeck.json `autostart.profileId`. */
  autostartProfileId: string | null;
}

export interface UpgradeResult {
  file: ServersFile;
  /** servers/index.json did not exist: this is the first start of a Pyrodeck that runs several servers. */
  created: boolean;
  /** running-server.json, the record an older Pyrodeck (or this one, for a downgrade) keeps for one server. */
  legacyRecord: RunRecord | null;
  /** What changed, for the log. */
  notes: string[];
}

/** The server a record names: its profile, or the server without one. */
export function serverIdOfRecord(record: RunRecord): string {
  return record.serverId ?? record.profileId ?? LAUNCH_SERVER_ID;
}

/**
 * Bring a config directory up to date, at every start. Idempotent.
 *
 * First start (no servers/index.json): the legacy owner is the server
 * running-server.json names, else the autostart profile, else the most
 * recently launched profile, else the only profile, else the server without
 * a profile; the autostart list is pyrodeck.json's profile. Profiles,
 * schedules, bans, history and playlists are left as they are.
 *
 * Every start: when pyrodeck.json's autostart profile is not the first of
 * the list, a downgraded Pyrodeck changed it; the list follows (that profile
 * first, or the old first one dropped when it was cleared). The caller then
 * saves the list's first back into pyrodeck.json.
 */
export async function upgradeConfigDir(input: UpgradeInput): Promise<UpgradeResult> {
  const { configDir } = input;
  const legacyRecord = await readRunRecord(configDir);
  const notes: string[] = [];
  if (await moveEarlyServersFile(configDir)) {
    notes.push(`${EARLY_SERVERS_FILE} of a development build moved to ${SERVERS_FILE}; ${EARLY_SERVERS_FILE} is Connect mode's saved servers`);
  }
  const existing = await readServersFile(configDir);
  let file: ServersFile;
  const created = existing === null;
  if (existing) {
    file = existing;
  } else {
    const launched = [...input.profiles]
      .filter((p) => p.lastLaunchedAt)
      .sort((a, b) => (b.lastLaunchedAt ?? "").localeCompare(a.lastLaunchedAt ?? ""))[0];
    const legacyOwner = legacyRecord
      ? serverIdOfRecord(legacyRecord)
      : (input.autostartProfileId ??
        launched?.id ??
        (input.profiles.length === 1 ? input.profiles[0].id : null) ??
        LAUNCH_SERVER_ID);
    file = { version: 1, autostart: input.autostartProfileId ? [input.autostartProfileId] : [], legacyOwner };
    notes.push(
      `First start with several servers: ${SERVERS_FILE} created; ${legacyOwner} keeps playlist-state.json` +
        (legacyRecord ? `, and re-attaches to the running server (PID ${legacyRecord.pid})` : ""),
    );
  }

  const first = file.autostart[0] ?? null;
  if (!created && input.autostartProfileId !== first) {
    if (input.autostartProfileId) {
      file = { ...file, autostart: [input.autostartProfileId, ...file.autostart.filter((id) => id !== input.autostartProfileId)] };
      notes.push(`Autostart: ${input.autostartProfileId} first, as pyrodeck.json says`);
    } else if (first) {
      file = { ...file, autostart: file.autostart.slice(1) };
      notes.push(`Autostart: ${first} off, as pyrodeck.json says`);
    }
  }
  if (created || notes.length > 0) await writeServersFile(configDir, file);
  return { file, created, legacyRecord, notes };
}

/** Each server's run record, by server id (the directories under servers/). */
export async function readServerRunRecords(configDir: string): Promise<Map<string, RunRecord>> {
  const out = new Map<string, RunRecord>();
  let ids: string[];
  try {
    // Directories only: servers/index.json sits beside them.
    ids = (await fs.readdir(path.join(configDir, SERVERS_DIR), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const id of ids) {
    if (!isServerIdSafe(id)) continue;
    const record = await readRunRecord(serverDir(configDir, id), "run.json");
    if (record) out.set(id, record);
  }
  return out;
}
