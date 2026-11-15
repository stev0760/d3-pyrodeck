import fs from "node:fs/promises";
import path from "node:path";
import {
  BACKUP_SUFFIX,
  Mn3Error,
  isStockMission,
  readMn3Msn,
  readMsnUrls,
  setMissionUrl,
  stockMissionMessage,
} from "./Mn3UrlRewriter.js";
import { buildHostedMissionUrl, type MissionHostSettings } from "./missionHostSettings.js";

/**
 * Pointing missions' download links at Pyrodeck's mission host, for one
 * mission (the Config tab's "Host this mission") or for every mission of a
 * playlist. The rewrite itself is Mn3UrlRewriter.setMissionUrl, so the first
 * one keeps the original as <file>.pyrodeck-orig. A rewrite takes effect the
 * next time the server loads the mission.
 */

/**
 * hosted: the link was pointed at the host now. already: it pointed there.
 * custom: Pyrodeck set another link before (a backup exists), left alone.
 * stock: ships with the game, never hosted. missing: no such file.
 * error: the link could not be set (message says why).
 */
export type HostingOutcome = "hosted" | "already" | "custom" | "stock" | "missing" | "error";

export interface MissionHostingResult {
  file: string;
  outcome: HostingOutcome;
  /** The hosted link (hosted, already). */
  url?: string;
  /** The mission's links after the call (hosted, already, custom). */
  urls?: string[];
  /** hosted: this rewrite saved the original as the backup. */
  backupCreated?: boolean;
  /** A .pyrodeck-orig backup exists after the call. */
  urlBackup?: boolean;
  /** Why (stock, missing, error), or the link that was kept (custom). */
  message?: string;
}

export interface HostingPolicy {
  /** Leave a link the operator set by hand (playlists). False replaces it (an explicit "Host this mission"). */
  keepCustom: boolean;
  /** Public base URLs the host had before: their links are Pyrodeck's own and get replaced, never kept as custom. */
  formerBaseUrls?: readonly string[];
}

/** What to do with a mission whose hosted link is `hostedUrl`, given its current links. Pure. */
export function decideHosting(
  facts: { hostedUrl: string; urls: readonly string[]; hasBackup: boolean; formerUrls: readonly string[] },
  policy: HostingPolicy,
): "already" | "custom" | "rewrite" {
  if (facts.urls.includes(facts.hostedUrl)) return "already";
  // A backup means Pyrodeck set the current links: one the operator typed, unless the host itself set it under a
  // former public URL.
  const typed = facts.urls.filter((u) => !facts.formerUrls.includes(u));
  if (policy.keepCustom && facts.hasBackup && typed.length > 0) return "custom";
  return "rewrite";
}

/**
 * Point `file` in `missionsDir` at `<publicBaseUrl>/missions/<file>`. Stock,
 * missing, already hosted and custom-link missions are reported without a
 * write (no rewrite, no backup). Throws (Mn3Error, or the file system's
 * error) when the link cannot be built or the file cannot be read or
 * rewritten; hostPlaylistEntries turns that into an "error" result.
 * `listing` is the directory's entries, when the caller has read them.
 */
export async function hostMission(
  missionsDir: string,
  file: string,
  publicBaseUrl: string,
  policy: HostingPolicy,
  listing?: readonly string[],
): Promise<MissionHostingResult> {
  if (isStockMission(file)) return { file, outcome: "stock", message: stockMissionMessage(file) };
  const entries = listing ?? (await fs.readdir(missionsDir));
  if (!entries.includes(file)) return { file, outcome: "missing", message: `Mission not found: ${file}` };
  const built = buildHostedMissionUrl(publicBaseUrl, file);
  if (!("url" in built)) throw new Mn3Error(built.error);

  const filePath = path.join(missionsDir, file);
  const urls = readMsnUrls((await readMn3Msn(filePath)).text);
  const hasBackup = entries.includes(file + BACKUP_SUFFIX);
  const formerUrls = (policy.formerBaseUrls ?? []).flatMap((base) => {
    const former = buildHostedMissionUrl(base, file);
    return "url" in former ? [former.url] : [];
  });
  const decision = decideHosting({ hostedUrl: built.url, urls, hasBackup, formerUrls }, policy);
  if (decision === "already") return { file, outcome: "already", url: built.url, urls, urlBackup: hasBackup };
  if (decision === "custom") {
    return { file, outcome: "custom", urls, urlBackup: true, message: `Keeps its own link: ${urls.join(" ")}` };
  }
  const result = await setMissionUrl(filePath, built.url);
  return {
    file,
    outcome: "hosted",
    url: built.url,
    urls: result.urls,
    backupCreated: result.backupCreated,
    urlBackup: true,
  };
}

export interface EntryHostingResult extends MissionHostingResult {
  entryId: string;
  label: string;
}

/**
 * Host the mission of every playlist entry; never throws. Each mission file is
 * handled once, in entry order, and its result repeated for every entry that
 * names it. Rewrites run one at a time (each copies the whole .mn3).
 */
export async function hostPlaylistEntries(
  missionsDir: string,
  entries: readonly { id: string; label: string; missionName: string }[],
  publicBaseUrl: string,
  policy: HostingPolicy,
): Promise<EntryHostingResult[]> {
  let listing: string[] | undefined;
  try {
    listing = await fs.readdir(missionsDir);
  } catch {
    // Each mission reports the error (hostMission reads the directory itself).
  }
  const byFile = new Map<string, MissionHostingResult>();
  const results: EntryHostingResult[] = [];
  for (const entry of entries) {
    const file = entry.missionName;
    let result = byFile.get(file);
    if (!result) {
      try {
        result = await hostMission(missionsDir, file, publicBaseUrl, policy, listing);
      } catch (err) {
        result = { file, outcome: "error", message: err instanceof Error ? err.message : String(err) };
      }
      byFile.set(file, result);
    }
    results.push({ ...result, entryId: entry.id, label: entry.label });
  }
  return results;
}

/**
 * One line for a playlist's results, counting mission files (an entry that
 * repeats a mission counts once): "9 hosted, 3 ship with the game, 1 failed".
 * Hosted includes the missions that were hosted already.
 */
export function summarizeHosting(results: readonly MissionHostingResult[]): string {
  const outcomes = new Map<string, HostingOutcome>();
  for (const r of results) if (!outcomes.has(r.file)) outcomes.set(r.file, r.outcome);
  const count = (...which: HostingOutcome[]) => [...outcomes.values()].filter((o) => which.includes(o)).length;
  const hosted = count("hosted", "already");
  const stock = count("stock");
  const custom = count("custom");
  const missing = count("missing");
  const failed = count("error");
  const parts: string[] = [];
  if (hosted) parts.push(`${hosted} hosted`);
  if (stock) parts.push(`${stock} ship${stock === 1 ? "s" : ""} with the game`);
  if (custom) parts.push(`${custom} ${custom === 1 ? "has its" : "have their"} own link`);
  if (missing) parts.push(`${missing} missing`);
  if (failed) parts.push(`${failed} failed`);
  return parts.length > 0 ? parts.join(", ") : "no missions";
}

/** Why the mission host, serving `hostDir`, cannot serve `missionsDir`; null when it can. */
export function hostDirError(hostDir: string | null, missionsDir: string, whose = "this profile's"): string | null {
  if (hostDir && path.resolve(hostDir) === path.resolve(missionsDir)) return null;
  const serves = hostDir ?? "nothing (no game path set)";
  return `The mission host serves ${serves}, not ${whose} missions directory (${missionsDir}).`;
}

/**
 * Where a playlist's links would point: the host's public base URL when the
 * host is on and serves the playlist's missions directory (`missionsDir`,
 * null when no profile gives one), else why not. Null while the host is off.
 */
export function playlistHostingTarget(
  settings: MissionHostSettings,
  hostDir: string | null,
  missionsDir: string | null,
): { publicBaseUrl: string; missionsDir: string } | { notice: string } | null {
  if (!settings.enabled || !settings.publicBaseUrl) return null;
  if (!missionsDir) return { notice: "No server profile names the playlist's missions directory." };
  const dirError = hostDirError(hostDir, missionsDir, "the playlist's");
  return dirError ? { notice: dirError } : { publicBaseUrl: settings.publicBaseUrl, missionsDir };
}

/** Whether two entry lists name different sets of missions (a re-order or a new label is no change). */
export function playlistMissionsChanged(
  before: readonly { missionName: string }[],
  after: readonly { missionName: string }[],
): boolean {
  const a = new Set(before.map((e) => e.missionName));
  const b = new Set(after.map((e) => e.missionName));
  return a.size !== b.size || [...a].some((m) => !b.has(m));
}

/** The result of hosting a playlist's missions, kept for the playlist status (PlaylistManager.setDownloads). */
export interface PlaylistHostingReport {
  playlistId: string;
  /** Epoch ms. */
  at: number;
  /** summarizeHosting's line; empty when `notice` is set. */
  summary: string;
  /** Set when nothing was hosted because the host cannot serve this playlist's missions. */
  notice?: string;
  results: EntryHostingResult[];
}
