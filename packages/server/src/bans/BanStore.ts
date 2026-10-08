import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Pyrodeck's ban data, kept in `<config dir>/bans.json`:
 * - name bans (the engine has none; applied on join by kicking),
 * - why and when each hosts.deny entry was added (the file has no fields),
 * - the server's writable directory as last seen in a launched server's log.
 */

export interface NameBan {
  id: string;
  /** Callsign, matched without regard to case; a trailing `*` matches any ending. */
  pattern: string;
  reason: string;
  createdAt: string;
}

export interface HostsEntryNote {
  reason: string;
  addedAt: string;
  /** The player name the entry was added for, if any. */
  name?: string;
}

interface BanFile {
  version: 1;
  nameBans: NameBan[];
  hostsNotes: Record<string, HostsEntryNote>;
  /** "Local dir" from the last launched server's log (mng_InitLocalTables). */
  detectedLocalDir: string | null;
}

export const MAX_NAME_BANS = 1000;
export const MAX_NAME_LENGTH = 31;

/** Check a name-ban pattern; returns the trimmed pattern or an error. */
export function checkNamePattern(raw: unknown): { pattern: string } | { error: string } {
  if (typeof raw !== "string") return { error: "Enter a name." };
  const pattern = raw.trim();
  if (!pattern || pattern === "*") return { error: "Enter a name (a lone * would match everyone)." };
  if (pattern.length > MAX_NAME_LENGTH + 1) return { error: `Callsigns are at most ${MAX_NAME_LENGTH} characters.` };
  if (pattern.indexOf("*") !== -1 && pattern.indexOf("*") !== pattern.length - 1) {
    return { error: "Only a trailing * is supported (Name* matches every name starting with Name)." };
  }
  return { pattern };
}

/** Whether `name` matches a name-ban pattern. */
export function nameMatches(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.trim().toLowerCase();
  return p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p;
}

/**
 * The engine's writable directory, where DMFC looks for netgames/hosts.deny
 * (LocalD3Dir, set from the first base directory in mng_InitLocalTables,
 * manage/manage.cpp:671). For the open-source engine and Matcen that is SDL's
 * preference path for "Outrage Entertainment" / "Descent 3"
 * (Descent3/init.cpp:1425, lib/d3_platform_path.h.in:25). Retail 1.4/1.5 on
 * Windows uses its install directory instead.
 */
export function defaultLocalDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const home = os.homedir();
  if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.win32.join(appData, "Outrage Entertainment", "Descent 3");
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Outrage Entertainment", "Descent 3");
  const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
  return path.join(dataHome, "Outrage Entertainment", "Descent 3");
}

export type HostsDenySource = "setting" | "server log" | "default";

export class BanStore {
  private data: BanFile = { version: 1, nameBans: [], hostsNotes: {}, detectedLocalDir: null };
  private loaded = false;

  constructor(private readonly filePath: string | null) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf-8")) as Partial<BanFile>;
      this.data = {
        version: 1,
        nameBans: Array.isArray(raw.nameBans) ? raw.nameBans.filter((b) => typeof b?.pattern === "string") : [],
        hostsNotes: raw.hostsNotes && typeof raw.hostsNotes === "object" ? raw.hostsNotes : {},
        detectedLocalDir: typeof raw.detectedLocalDir === "string" ? raw.detectedLocalDir : null,
      };
    } catch {
      // missing or unreadable: start empty
    }
  }

  nameBans(): NameBan[] {
    return [...this.data.nameBans];
  }

  findNameBan(name: string): NameBan | null {
    return this.data.nameBans.find((b) => nameMatches(b.pattern, name)) ?? null;
  }

  async addNameBan(pattern: string, reason: string): Promise<NameBan> {
    const existing = this.data.nameBans.find((b) => b.pattern.toLowerCase() === pattern.toLowerCase());
    if (existing) return existing;
    if (this.data.nameBans.length >= MAX_NAME_BANS) throw new Error(`At most ${MAX_NAME_BANS} name bans.`);
    const ban: NameBan = { id: crypto.randomUUID(), pattern, reason, createdAt: new Date().toISOString() };
    this.data.nameBans.push(ban);
    await this.save();
    return ban;
  }

  async removeNameBan(id: string): Promise<boolean> {
    const before = this.data.nameBans.length;
    this.data.nameBans = this.data.nameBans.filter((b) => b.id !== id);
    if (this.data.nameBans.length === before) return false;
    await this.save();
    return true;
  }

  hostsNote(entry: string): HostsEntryNote | null {
    return this.data.hostsNotes[entry] ?? null;
  }

  async setHostsNote(entry: string, note: HostsEntryNote | null): Promise<void> {
    if (note) this.data.hostsNotes[entry] = note;
    else delete this.data.hostsNotes[entry];
    await this.save();
  }

  get detectedLocalDir(): string | null {
    return this.data.detectedLocalDir;
  }

  async setDetectedLocalDir(dir: string): Promise<void> {
    if (this.data.detectedLocalDir === dir) return;
    this.data.detectedLocalDir = dir;
    await this.save();
  }

  /** Where hosts.deny is: the setting, else the directory a launched server reported, else the default. */
  hostsDenyPath(setting: string | null): { path: string; source: HostsDenySource } {
    if (setting) return { path: setting, source: "setting" };
    if (this.data.detectedLocalDir) {
      return { path: path.join(this.data.detectedLocalDir, "netgames", "hosts.deny"), source: "server log" };
    }
    return { path: path.join(defaultLocalDir(), "netgames", "hosts.deny"), source: "default" };
  }

  private async save(): Promise<void> {
    if (!this.filePath) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
    await fs.rename(tmp, this.filePath);
  }
}
