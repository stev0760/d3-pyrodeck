import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

/**
 * Retention for the game-server logs Pyrodeck writes, one per launch
 * (`<profile>-<YYYY-MM-DDTHH-MM-SS>.log`, buildLogFilename in logPaths.ts).
 * A server writes 12-28 MB an hour and nothing pruned them, so a Log
 * Directory grew without bound.
 *
 * Each run, at startup and then about once an hour:
 * 1. deletes Pyrodeck's logs last written more than `days` ago;
 * 2. gzips each closed log (`.log` → `.log.gz`, keeping its modification time);
 * 3. deletes the oldest of what is left until Pyrodeck's logs fit in `maxMb`.
 *
 * Only files whose names Pyrodeck generates are touched: the Log Directory may
 * be the game's own folder, so every other file there, a `.log` of another
 * name included, is left alone, and so are symlinks and directories. The
 * running server's log is never compressed or deleted, nor is any log written
 * in the last ten minutes (a launch that just created its file, a server that
 * just stopped). Every deletion and compression is logged at info level.
 */

export interface LogRetentionSettings {
  /** Delete logs last written more than this many days ago. 0 = keep whatever their age. */
  days: number;
  /** Keep Pyrodeck's logs under this many MB in total, deleting the oldest. 0 = no cap. */
  maxMb: number;
  /** Gzip closed logs. */
  compress: boolean;
}

export const DEFAULT_LOG_RETENTION: LogRetentionSettings = { days: 30, maxMb: 2048, compress: true };

export const MAX_RETENTION_DAYS = 3650;
export const MAX_LOG_MB = 1_048_576;

/** A log written within this window counts as open: never compressed or deleted. */
export const LOG_QUIET_MS = 10 * 60_000;

const DAY_MS = 86_400_000;
const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function wholeNumber(value: unknown, max: number): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

/** Settings read from pyrodeck.json: anything out of range falls back to the default. */
export function sanitizeStoredLogRetention(raw: unknown): LogRetentionSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    days: wholeNumber(r.days, MAX_RETENTION_DAYS) ?? DEFAULT_LOG_RETENTION.days,
    maxMb: wholeNumber(r.maxMb, MAX_LOG_MB) ?? DEFAULT_LOG_RETENTION.maxMb,
    compress: typeof r.compress === "boolean" ? r.compress : DEFAULT_LOG_RETENTION.compress,
  };
}

/** Settings from the Logs tab (PUT /api/logs/retention). */
export function validateLogRetention(body: unknown): { settings: LogRetentionSettings } | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const days = wholeNumber(b.days, MAX_RETENTION_DAYS);
  if (days === null) return { error: `Days must be a whole number from 0 (keep forever) to ${MAX_RETENTION_DAYS}.` };
  const maxMb = wholeNumber(b.maxMb, MAX_LOG_MB);
  if (maxMb === null) return { error: `The size cap must be a whole number of MB from 0 (no cap) to ${MAX_LOG_MB}.` };
  if (typeof b.compress !== "boolean") return { error: "compress must be true or false." };
  return { settings: { days, maxMb, compress: b.compress } };
}

/** PYRODECK_LOG_RETENTION_DAYS and PYRODECK_LOG_MAX_MB; null where unset. They win over the Logs tab. */
export interface LogRetentionEnv {
  days: number | null;
  maxMb: number | null;
}

/**
 * Read PYRODECK_LOG_RETENTION_DAYS and PYRODECK_LOG_MAX_MB. Unset or blank
 * leaves the setting to the Logs tab (default 30 days, 2048 MB); 0 turns that
 * limit off. A value that is not a whole number in range throws, so a typo
 * stops Pyrodeck at startup instead of deleting logs by a guess.
 */
export function parseLogRetentionEnv(env: Record<string, string | undefined>): LogRetentionEnv {
  const read = (name: string, max: number, meaning: string): number | null => {
    const raw = (env[name] ?? "").trim();
    if (raw === "") return null;
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!(n >= 0 && n <= max)) throw new Error(`${name}: "${raw}" is not a whole number from 0 (${meaning}) to ${max}.`);
    return n;
  };
  return {
    days: read("PYRODECK_LOG_RETENTION_DAYS", MAX_RETENTION_DAYS, "keep forever"),
    maxMb: read("PYRODECK_LOG_MAX_MB", MAX_LOG_MB, "no size cap"),
  };
}

/** The settings in force: the environment's value where it is set, the stored one otherwise. */
export function effectiveLogRetention(stored: LogRetentionSettings, env: LogRetentionEnv): LogRetentionSettings {
  return {
    days: env.days ?? stored.days,
    maxMb: env.maxMb ?? stored.maxMb,
    compress: stored.compress,
  };
}

export function describeLogRetention(s: LogRetentionSettings): string {
  const parts = [
    s.days > 0 ? `delete Pyrodeck's logs older than ${s.days} days` : "keep logs whatever their age",
    s.maxMb > 0 ? `keep them under ${s.maxMb} MB in total` : "no size cap",
    s.compress ? "gzip closed logs" : "no compression",
  ];
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Which files are Pyrodeck's
// ---------------------------------------------------------------------------

/** buildLogFilename's output: slug ([a-z0-9_-], at most 48), "-", UTC time with "-" for ":", ".log". */
const LOG_NAME = /^[a-z0-9_-]{1,48}-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.log$/;

export type PyrodeckLogKind = "log" | "gz" | "partial";

/**
 * What a directory entry is to retention: a Pyrodeck log ("log"), one it
 * compressed ("gz"), a compression it left unfinished ("partial"), or null
 * for anything else, which retention never touches.
 */
export function pyrodeckLogKind(name: string): PyrodeckLogKind | null {
  let base = name;
  let kind: PyrodeckLogKind = "log";
  if (name.endsWith(".log.gz.partial")) {
    base = name.slice(0, -".gz.partial".length);
    kind = "partial";
  } else if (name.endsWith(".log.gz")) {
    base = name.slice(0, -".gz".length);
    kind = "gz";
  }
  const m = LOG_NAME.exec(base);
  if (!m) return null;
  // A real UTC time, as toISOString wrote it (no 2026-02-31 or 25:00).
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  const t = Date.parse(`${iso}Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 19) !== iso) return null;
  return kind;
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

export interface RetentionLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface LogRetentionRunOptions {
  /** Directories to look in; duplicates are looked at once. */
  dirs: string[];
  settings: LogRetentionSettings;
  /** The log the running server is writing, or null. */
  activeLogPath: string | null;
  log: RetentionLogger;
  now?: number;
  /** Logs written within this many ms are left alone (default LOG_QUIET_MS). */
  quietMs?: number;
}

export interface LogRetentionResult {
  /** When the run finished (ISO). */
  at: string;
  compressed: number;
  deleted: number;
  /** Disk space the run gave back: deleted files and what compression saved. */
  freedBytes: number;
  /** Pyrodeck's logs left in those directories, and their size on disk. */
  files: number;
  totalBytes: number;
  errors: string[];
}

interface Entry {
  path: string;
  kind: PyrodeckLogKind;
  size: number;
  mtimeMs: number;
  /** Open: the running server's log, or written within the quiet window. */
  open: boolean;
}

function formatMb(bytes: number): string {
  return bytes < MB ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / MB).toFixed(1)} MB`;
}

async function scanDir(dir: string, activeLogPath: string | null, now: number, quietMs: number): Promise<Entry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // a directory that does not exist (yet) has nothing to prune
  }
  const entries: Entry[] = [];
  for (const name of names) {
    const kind = pyrodeckLogKind(name);
    if (!kind) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = await fs.lstat(full);
    } catch {
      continue;
    }
    // Regular files only: a symlink with a log's name may point anywhere.
    if (!st.isFile()) continue;
    const isActive = activeLogPath !== null && path.resolve(full) === activeLogPath;
    entries.push({ path: full, kind, size: st.size, mtimeMs: st.mtimeMs, open: isActive || now - st.mtimeMs < quietMs });
  }
  return entries;
}

/**
 * Gzip `src` to `src.gz` through a `.partial` file: written, synced to disk,
 * given the original's times, renamed, then the original removed. If the
 * original changed while it was being read, nothing is replaced. Returns the
 * compressed size, or null when the original changed.
 */
export async function gzipLog(src: string): Promise<number | null> {
  const dst = `${src}.gz`;
  const tmp = `${dst}.partial`;
  const before = await fs.lstat(src);
  try {
    await pipeline(
      createReadStream(src),
      createGzip({ level: 6 }),
      createWriteStream(tmp, { flags: "w", mode: before.mode & 0o777 }),
    );
    const handle = await fs.open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const after = await fs.lstat(src);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      await fs.rm(tmp, { force: true });
      return null;
    }
    await fs.utimes(tmp, before.atime, before.mtime);
    await fs.rename(tmp, dst);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await fs.unlink(src);
  return (await fs.stat(dst)).size;
}

export async function runLogRetention(options: LogRetentionRunOptions): Promise<LogRetentionResult> {
  const { settings, log } = options;
  const now = options.now ?? Date.now();
  const quietMs = options.quietMs ?? LOG_QUIET_MS;
  const activeLogPath = options.activeLogPath ? path.resolve(options.activeLogPath) : null;
  const dirs = [...new Set(options.dirs.filter(Boolean).map((d) => path.resolve(d)))];

  const result: LogRetentionResult = {
    at: "",
    compressed: 0,
    deleted: 0,
    freedBytes: 0,
    files: 0,
    totalBytes: 0,
    errors: [],
  };
  const fail = (message: string) => {
    result.errors.push(message);
    log.warn(`Log retention: ${message}`);
  };
  const remove = async (entry: Entry, why: string): Promise<boolean> => {
    try {
      await fs.unlink(entry.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      fail(`cannot delete ${entry.path} (${(err as Error).message}).`);
      return false;
    }
    result.deleted++;
    result.freedBytes += entry.size;
    log.info(
      `Log retention: deleted ${entry.path} (${formatMb(entry.size)}, last written ${new Date(entry.mtimeMs).toISOString()}; ${why}).`,
    );
    return true;
  };

  let entries: Entry[] = [];
  for (const dir of dirs) entries.push(...(await scanDir(dir, activeLogPath, now, quietMs)));

  // A compression that never finished (Pyrodeck stopped mid-way) leaves a
  // .partial; the original .log is still there.
  for (const entry of entries.filter((e) => e.kind === "partial" && !e.open)) {
    try {
      await fs.unlink(entry.path);
      log.info(`Log retention: removed the unfinished compression ${entry.path}.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") fail(`cannot remove ${entry.path} (${(err as Error).message}).`);
    }
  }
  entries = entries.filter((e) => e.kind !== "partial").sort((a, b) => a.mtimeMs - b.mtimeMs);

  // 1. Age.
  if (settings.days > 0) {
    const cutoff = now - settings.days * DAY_MS;
    const kept: Entry[] = [];
    for (const entry of entries) {
      if (!entry.open && entry.mtimeMs < cutoff && (await remove(entry, `older than ${settings.days} days`))) continue;
      kept.push(entry);
    }
    entries = kept;
  }

  // 2. Compression, oldest first.
  if (settings.compress) {
    for (const entry of entries.filter((e) => e.kind === "log" && !e.open)) {
      try {
        const size = await gzipLog(entry.path);
        if (size === null) {
          log.info(`Log retention: ${entry.path} changed while it was being compressed; left as it is.`);
          continue;
        }
        log.info(`Log retention: compressed ${entry.path} (${formatMb(entry.size)} -> ${formatMb(size)}).`);
        result.compressed++;
        result.freedBytes += Math.max(0, entry.size - size);
        // The .gz takes the log's place (and replaces a stale .gz of the same name).
        const gzPath = `${entry.path}.gz`;
        entries = entries.filter((e) => e.path !== gzPath);
        Object.assign(entry, { path: gzPath, kind: "gz", size });
      } catch (err) {
        fail(`cannot compress ${entry.path} (${(err as Error).message}); the log is kept as it is.`);
      }
    }
  }

  // 3. Total size, oldest first.
  if (settings.maxMb > 0) {
    const cap = settings.maxMb * MB;
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    const kept: Entry[] = [];
    for (const entry of entries) {
      if (total > cap && !entry.open && (await remove(entry, `Pyrodeck's logs were over ${settings.maxMb} MB`))) {
        total -= entry.size;
        continue;
      }
      kept.push(entry);
    }
    entries = kept;
    if (total > cap) {
      log.warn(
        `Log retention: Pyrodeck's logs take ${formatMb(total)}, over the ${settings.maxMb} MB cap; ` +
          "what is left is the running server's log or was written in the last 10 minutes.",
      );
    }
  }

  result.files = entries.length;
  result.totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  result.at = new Date().toISOString();
  return result;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export interface LogRetentionServiceDeps {
  /** Directories to prune: the Log Directory, and the folder of the last launch's log. */
  dirs(): string[];
  activeLogPath(): string | null;
  settings(): LogRetentionSettings;
  log: RetentionLogger;
  /** Default: an hour. */
  intervalMs?: number;
  /** First run this long after start (default 5 s, so it stays out of startup's way). */
  startDelayMs?: number;
}

/** Runs retention at startup and then every hour, one run at a time. */
export class LogRetentionService {
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private running: Promise<LogRetentionResult> | null = null;
  private last: LogRetentionResult | null = null;

  constructor(private readonly deps: LogRetentionServiceDeps) {}

  start(): void {
    this.stop();
    const first = setTimeout(() => void this.runNow(), this.deps.startDelayMs ?? 5000);
    const every = setInterval(() => void this.runNow(), this.deps.intervalMs ?? 60 * 60_000);
    first.unref?.();
    every.unref?.();
    this.timers = [first, every];
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  getLastResult(): LogRetentionResult | null {
    return this.last;
  }

  /**
   * Run with the settings as they are now: after the run already going, if
   * any, since that one read the settings when it started.
   */
  runAfterChange(): Promise<LogRetentionResult> {
    return this.running ? this.running.then(() => this.runNow()) : this.runNow();
  }

  /** Run now, or join the run already going. */
  runNow(): Promise<LogRetentionResult> {
    this.running ??= this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce(): Promise<LogRetentionResult> {
    try {
      const result = await runLogRetention({
        dirs: this.deps.dirs(),
        settings: this.deps.settings(),
        activeLogPath: this.deps.activeLogPath(),
        log: this.deps.log,
      });
      if (result.compressed > 0 || result.deleted > 0) {
        this.deps.log.info(
          `Log retention: ${result.compressed} compressed, ${result.deleted} deleted, ${formatMb(result.freedBytes)} freed; ` +
            `${result.files} logs left (${formatMb(result.totalBytes)}).`,
        );
      }
      this.last = result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.warn(`Log retention failed: ${message}`);
      this.last = {
        at: new Date().toISOString(),
        compressed: 0,
        deleted: 0,
        freedBytes: 0,
        files: 0,
        totalBytes: 0,
        errors: [message],
      };
    }
    return this.last;
  }
}
