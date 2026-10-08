import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { resolveLogDir } from "../launcher/logPaths.js";
import {
  LogRetentionService,
  describeLogRetention,
  effectiveLogRetention,
  parseLogRetentionEnv,
  sanitizeStoredLogRetention,
  validateLogRetention,
  type LogRetentionEnv,
} from "../launcher/logRetention.js";
import { processManager } from "./launcher.js";

/**
 * Resolve the directory the log viewer enumerates. Mirrors the launch-time
 * resolution: explicit logDir wins, otherwise next to the (global) executable,
 * falling back to the game directory.
 */
function viewerLogDir(): string | null {
  const config = pyrodeckConfig.get();
  if (config.logDir && config.logDir.trim()) return config.logDir.trim();

  if (config.executablePath) {
    const exe = path.isAbsolute(config.executablePath) || !config.gamePath
      ? config.executablePath
      : path.join(config.gamePath, config.executablePath);
    return resolveLogDir(null, exe);
  }
  return config.gamePath ?? null;
}

/** How much of a log the in-browser viewer fetches with ?tail=1 (last N bytes). */
const TAIL_BYTES = 256 * 1024;

/** A log the viewer lists: `.log`, or `.log.gz` (log retention compresses closed logs). */
function isLogFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".log") || lower.endsWith(".log.gz");
}

function isCompressed(name: string): boolean {
  return name.toLowerCase().endsWith(".gz");
}

/** Reject path traversal / non-log filenames. Returns the safe basename or null. */
function safeLogName(name: string): string | null {
  if (
    !name ||
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    !isLogFileName(name)
  ) {
    return null;
  }
  return name;
}

/**
 * The last `TAIL_BYTES` of a gzipped log, decompressed, and its full
 * decompressed size. A gzip stream has no index, so this reads the whole file
 * and keeps only the end.
 */
async function gunzipTail(filePath: string): Promise<{ tail: Buffer; total: number }> {
  let chunks: Buffer[] = [];
  let held = 0;
  let total = 0;
  await pipeline(
    createReadStream(filePath),
    createGunzip(),
    new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(chunk);
        held += chunk.length;
        total += chunk.length;
        if (held > 2 * TAIL_BYTES) {
          const joined = Buffer.concat(chunks);
          chunks = [joined.subarray(joined.length - TAIL_BYTES)];
          held = TAIL_BYTES;
        }
        done();
      },
    }),
  );
  const joined = Buffer.concat(chunks);
  return { tail: joined.length > TAIL_BYTES ? joined.subarray(joined.length - TAIL_BYTES) : joined, total };
}

/** Directories log retention looks in: the Log Directory, and the folder of the last launch's log. */
function retentionDirs(): string[] {
  const dirs: string[] = [];
  const viewer = viewerLogDir();
  if (viewer) dirs.push(viewer);
  const last = processManager.getLaunchConfig()?.logPath;
  if (last) dirs.push(path.dirname(last));
  return dirs;
}

/**
 * Resolve a request's :name param to an absolute path inside the log dir,
 * rejecting traversal. Shared by the read and delete routes.
 */
function resolveLogFile(name: string): { filePath: string } | { status: number; error: string } {
  const logDir = viewerLogDir();
  if (!logDir) return { status: 404, error: "No log directory configured" };

  const safe = safeLogName(name);
  if (!safe) return { status: 400, error: "Invalid log filename" };

  const filePath = path.join(logDir, safe);
  // Defense in depth against traversal: the resolved path must stay in logDir.
  const resolvedDir = path.resolve(logDir);
  if (!path.resolve(filePath).startsWith(resolvedDir + path.sep)) {
    return { status: 400, error: "Invalid log path" };
  }
  return { filePath };
}

export async function logsRoutes(app: FastifyInstance): Promise<void> {
  // Log retention, off unless the operator sets it: PYRODECK_LOG_RETENTION_DAYS,
  // PYRODECK_LOG_MAX_MB and PYRODECK_LOG_COMPRESS win over the Logs tab's
  // settings. A malformed value stops the start here.
  const retentionEnv: LogRetentionEnv = parseLogRetentionEnv(process.env);
  const storedRetention = () => sanitizeStoredLogRetention(pyrodeckConfig.get().logRetention);
  const retentionSettings = () => effectiveLogRetention(storedRetention(), retentionEnv);
  const retention = new LogRetentionService({
    dirs: retentionDirs,
    activeLogPath: () => processManager.getActiveLogPath(),
    settings: retentionSettings,
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
  });
  app.log.info(`Log retention: ${describeLogRetention(retentionSettings())}; at startup and every hour.`);
  retention.start();
  app.addHook("onClose", async () => retention.stop());

  const retentionState = () => ({
    settings: retentionSettings(),
    stored: storedRetention(),
    env: retentionEnv,
    dirs: [...new Set(retentionDirs().map((d) => path.resolve(d)))],
    lastRun: retention.getLastResult(),
  });

  app.get("/api/logs/retention", async () => retentionState());

  // Save the Logs tab's retention settings and run retention with them. Values
  // set in the environment stay in force whatever is saved.
  app.put("/api/logs/retention", async (request, reply) => {
    const checked = validateLogRetention(request.body);
    if ("error" in checked) return reply.status(400).send({ error: checked.error });
    await pyrodeckConfig.save({ logRetention: checked.settings });
    app.log.info(`Log retention settings saved: ${describeLogRetention(retentionSettings())}.`);
    void retention.runAfterChange();
    return retentionState();
  });

  // List available log files in the resolved log directory.
  app.get("/api/logs", async () => {
    const logDir = viewerLogDir();
    if (!logDir) return { logDir: null, files: [] };

    let entries: string[];
    try {
      entries = await fs.readdir(logDir);
    } catch {
      return { logDir, files: [] };
    }

    const files = (
      await Promise.all(
        entries
          .filter(isLogFileName)
          .map(async (name) => {
            try {
              const st = await fs.stat(path.join(logDir, name));
              if (!st.isFile()) return null;
              return { name, size: st.size, mtimeMs: st.mtimeMs, compressed: isCompressed(name) };
            } catch {
              return null;
            }
          }),
      )
    ).filter((f): f is { name: string; size: number; mtimeMs: number; compressed: boolean } => f !== null);

    // Newest first — that's the run you almost always want.
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { logDir, files };
  });

  // Fetch a single log: text/plain inline by default, or as a download with
  // ?download=1. Used by the panel to view in-browser or save a run.
  app.get("/api/logs/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const resolved = resolveLogFile(name);
    if ("error" in resolved) return reply.status(resolved.status).send({ error: resolved.error });
    const { filePath } = resolved;

    let st;
    try {
      st = await fs.stat(filePath);
      if (!st.isFile()) return reply.status(404).send({ error: "Not found" });
    } catch {
      return reply.status(404).send({ error: "Log not found" });
    }

    const { download, tail } = request.query as { download?: string; tail?: string };

    // A compressed log downloads as the .gz file itself and is decompressed
    // for viewing.
    if (isCompressed(filePath)) {
      if (download === "1") {
        reply.type("application/gzip");
        reply.header("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
        return reply.send(createReadStream(filePath));
      }
      if (tail === "1") {
        let decompressed: { tail: Buffer; total: number };
        try {
          decompressed = await gunzipTail(filePath);
        } catch (err) {
          return reply.status(500).send({ error: `Cannot decompress ${path.basename(filePath)}: ${(err as Error).message}` });
        }
        reply.type("text/plain; charset=utf-8");
        if (decompressed.total > decompressed.tail.length) {
          reply.header("X-Log-Truncated", "1");
          reply.header("X-Log-Total-Size", String(decompressed.total));
        }
        return reply.send(decompressed.tail);
      }
      const source = createReadStream(filePath);
      const gunzip = createGunzip();
      source.on("error", (err) => gunzip.destroy(err));
      reply.type("text/plain; charset=utf-8");
      return reply.send(source.pipe(gunzip));
    }

    reply.type("text/plain; charset=utf-8");
    if (download === "1") {
      reply.header("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
    }
    // Soak logs run to hundreds of MB — the in-browser viewer only ever shows
    // the recent end, so let it ask for just that instead of the whole file.
    // Never truncate downloads: a saved file must always be the complete log.
    if (tail === "1" && download !== "1" && st.size > TAIL_BYTES) {
      reply.header("X-Log-Truncated", "1");
      reply.header("X-Log-Total-Size", String(st.size));
      return reply.send(createReadStream(filePath, { start: st.size - TAIL_BYTES }));
    }
    return reply.send(createReadStream(filePath));
  });

  // Delete a log file. The log a running launch is writing is protected —
  // deleting it would silently discard the rest of the run's output.
  app.delete("/api/logs/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const resolved = resolveLogFile(name);
    if ("error" in resolved) return reply.status(resolved.status).send({ error: resolved.error });
    const { filePath } = resolved;

    const activeLog = processManager.getActiveLogPath();
    if (activeLog && path.resolve(activeLog) === path.resolve(filePath)) {
      return reply.status(409).send({
        error: "This log is being written by the running server — stop the server first",
      });
    }

    try {
      await fs.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.status(404).send({ error: "Log not found" });
      }
      return reply.status(500).send({ error: "Failed to delete log" });
    }
    return { ok: true };
  });
}
