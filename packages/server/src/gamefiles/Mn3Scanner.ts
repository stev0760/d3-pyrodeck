import fs from "node:fs/promises";
import path from "node:path";
import { readMsnUrls } from "./Mn3UrlRewriter.js";

/**
 * Mission (.mn3) game-mode compatibility scanner.
 *
 * A .mn3 is a HOG2 archive (cfile/hogfile.h) containing a .msn text file whose
 * KEYWORDS line declares author-supplied compatibility tags. Mode matching is a
 * faithful port of the engine's Mission.cpp MissionGetKeywords() — Pyrodeck's
 * answer is exactly as trustworthy as the game's own mission list.
 * Reference prototype: tools/mn3info.py in the engine fork (spec Addendum A).
 */

/** Per-mode compatibility: maxTeams is only meaningful when compatible. */
export interface ModeSupport {
  compatible: boolean;
  maxTeams: number;
}

export interface Mn3Info {
  /** Filename within the missions directory (e.g. "bedlam.mn3"). */
  file: string;
  /** Display name from the .msn NAME line, or null if absent/unreadable. */
  name: string | null;
  numLevels: number | null;
  /** Raw comma-separated KEYWORDS value ("" when the line is absent). */
  keywords: string;
  multi: boolean;
  /** Mission-level URL lines: the download links the server offers clients (max 5). */
  urls: string[];
  /** Set when the file could not be parsed (bad magic, no .msn, I/O error). */
  error?: string;
  /** Keyed by normalized script basename ("ctf", "teamanarchy", ...). */
  modes: Record<string, ModeSupport>;
}

const HOG2_MAGIC = "HOG2";
const HEADER_SIZE = 68;
const ENTRY_SIZE = 48;
const MAX_NET_PLAYERS = 32;

/**
 * Requirement strings from netgames/(mode)/ options->requirements, verified in
 * engine source. Keys are .d3m basenames normalized via normalizeScriptKey()
 * ("team anarchy.d3m" -> "teamanarchy", "co-op.d3m" -> "coop").
 * Semantics (MissionGetKeywords):
 *   MINGOALS<n>  -> mission GOALS >= n
 *   GOALPERTEAM  -> max supported teams = mission GOALS count
 *   <anything>   -> literal tag that must appear in mission KEYWORDS
 */
const MODE_REQUIREMENTS: Record<string, string> = {
  anarchy: "",
  teamanarchy: "",
  hyperanarchy: "",
  ctf: "MINGOALS2,GOALPERTEAM",
  hoard: "MINGOALS1",
  entropy: "ENTROPY",
  monsterball: "MINGOALS2,GOALPERTEAM,SPEC1",
  coop: "COOP",
  roboanarchy: "COOP",
};

/** Whether a normalized script key is a stock mode the scanner can judge. */
export function isKnownModeKey(key: string): boolean {
  return key in MODE_REQUIREMENTS;
}

/** Normalize a .d3m script name for MODE_REQUIREMENTS lookup. */
export function normalizeScriptKey(script: string): string {
  return script
    .replace(/\.d3m$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Read the HOG2 container and return the .msn text, or throw on a bad file. */
async function readMsnText(filePath: string): Promise<string | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    const { bytesRead } = await handle.read(header, 0, HEADER_SIZE, 0);
    if (bytesRead < HEADER_SIZE || header.toString("latin1", 0, 4) !== HOG2_MAGIC) {
      throw new Error("not a HOG2 container");
    }
    const nfiles = header.readUInt32LE(4);
    const dataOffset = header.readUInt32LE(8);

    const table = Buffer.alloc(nfiles * ENTRY_SIZE);
    const tableRead = await handle.read(table, 0, table.length, HEADER_SIZE);
    if (tableRead.bytesRead < table.length) {
      throw new Error("truncated entry table");
    }

    // Payloads are sequential in entry order starting at dataOffset.
    let offset = dataOffset;
    for (let i = 0; i < nfiles; i++) {
      const base = i * ENTRY_SIZE;
      const nul = table.indexOf(0, base);
      const nameEnd = nul >= base && nul < base + 36 ? nul : base + 36;
      const name = table.toString("latin1", base, nameEnd);
      const len = table.readUInt32LE(base + 40);
      if (name.toLowerCase().endsWith(".msn")) {
        const blob = Buffer.alloc(len);
        const blobRead = await handle.read(blob, 0, len, offset);
        return blob.toString("latin1", 0, blobRead.bytesRead);
      }
      offset += len;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** Compute per-mode support from a mission's KEYWORDS tags (MissionGetKeywords port). */
export function computeModeSupport(keywords: string): Record<string, ModeSupport> {
  const tags = keywords
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  let goals = 0;
  for (const tag of tags) {
    const m = /^GOALS(\d+)$/.exec(tag);
    if (m) goals = parseInt(m[1], 10); // last one wins
  }

  const modes: Record<string, ModeSupport> = {};
  for (const [mode, req] of Object.entries(MODE_REQUIREMENTS)) {
    let goalsNeeded = 0;
    let goalPerTeam = false;
    let compatible = true;
    for (const token of req.split(",").map((t) => t.trim()).filter(Boolean)) {
      const min = /^MINGOALS(\d+)$/.exec(token);
      if (min) goalsNeeded = parseInt(min[1], 10);
      else if (token === "GOALPERTEAM") goalPerTeam = true;
      else if (!tags.includes(token)) compatible = false;
    }
    const teams = goalPerTeam ? goals : MAX_NET_PLAYERS;
    if (teams < goalsNeeded || goals < goalsNeeded) compatible = false;
    modes[mode] = { compatible, maxTeams: compatible ? teams : 0 };
  }
  return modes;
}

/** Parse one .mn3 file. Never throws — errors land in the `error` field. */
export async function parseMn3(filePath: string): Promise<Mn3Info> {
  const file = path.basename(filePath);
  try {
    const text = await readMsnText(filePath);
    if (text === null) {
      return {
        file,
        name: null,
        numLevels: null,
        keywords: "",
        multi: false,
        urls: [],
        error: "no .msn file in archive",
        modes: {},
      };
    }

    let name: string | null = null;
    let numLevels: number | null = null;
    let keywords = "";
    let multi = false;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      const match = /^(\S+)\s*(.*)$/.exec(trimmed);
      if (!match) continue;
      const token = match[1].toUpperCase();
      const operand = match[2].trim();
      if (token === "NAME") name = operand;
      else if (token === "NUMLEVELS") {
        const n = parseInt(operand, 10);
        if (!Number.isNaN(n)) numLevels = n;
      } else if (token === "KEYWORDS") keywords = operand;
      else if (token === "MULTI") multi = true;
    }

    return {
      file,
      name,
      numLevels,
      keywords,
      multi,
      urls: readMsnUrls(text),
      modes: computeModeSupport(keywords),
    };
  } catch (err) {
    return {
      file,
      name: null,
      numLevels: null,
      keywords: "",
      multi: false,
      urls: [],
      error: err instanceof Error ? err.message : "failed to parse",
      modes: {},
    };
  }
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  info: Mn3Info;
}

const cache = new Map<string, CacheEntry>();

/** Parse with an mtime+size cache keyed by absolute path. */
export async function parseMn3Cached(filePath: string): Promise<Mn3Info> {
  const abs = path.resolve(filePath);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (err) {
    cache.delete(abs);
    return {
      file: path.basename(abs),
      name: null,
      numLevels: null,
      keywords: "",
      multi: false,
      urls: [],
      error: err instanceof Error ? err.message : "stat failed",
      modes: {},
    };
  }
  const cached = cache.get(abs);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.info;
  }
  const info = await parseMn3(abs);
  cache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, info });
  return info;
}

/** Scan a missions directory, returning details for every .mn3 (sorted by filename). */
export async function scanMissionsDir(missionsDir: string): Promise<Mn3Info[]> {
  const entries = await fs.readdir(missionsDir);
  const mn3Files = entries.filter((f) => f.toLowerCase().endsWith(".mn3")).sort();
  return Promise.all(mn3Files.map((f) => parseMn3Cached(path.join(missionsDir, f))));
}
