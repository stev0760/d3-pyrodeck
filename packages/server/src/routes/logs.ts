import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { resolveLogDir } from "../launcher/logPaths.js";
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

/** Reject path traversal / non-log filenames. Returns the safe basename or null. */
function safeLogName(name: string): string | null {
  if (
    !name ||
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    !name.toLowerCase().endsWith(".log")
  ) {
    return null;
  }
  return name;
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
          .filter((f) => f.toLowerCase().endsWith(".log"))
          .map(async (name) => {
            try {
              const st = await fs.stat(path.join(logDir, name));
              if (!st.isFile()) return null;
              return { name, size: st.size, mtimeMs: st.mtimeMs };
            } catch {
              return null;
            }
          }),
      )
    ).filter((f): f is { name: string; size: number; mtimeMs: number } => f !== null);

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
