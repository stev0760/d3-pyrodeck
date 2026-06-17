import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { resolveLogDir } from "../launcher/logPaths.js";

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
    const logDir = viewerLogDir();
    if (!logDir) return reply.status(404).send({ error: "No log directory configured" });

    const { name } = request.params as { name: string };
    const safe = safeLogName(name);
    if (!safe) return reply.status(400).send({ error: "Invalid log filename" });

    const filePath = path.join(logDir, safe);
    // Defense in depth against traversal: the resolved path must stay in logDir.
    const resolvedDir = path.resolve(logDir);
    if (!path.resolve(filePath).startsWith(resolvedDir + path.sep)) {
      return reply.status(400).send({ error: "Invalid log path" });
    }

    try {
      const st = await fs.stat(filePath);
      if (!st.isFile()) return reply.status(404).send({ error: "Not found" });
    } catch {
      return reply.status(404).send({ error: "Log not found" });
    }

    const { download } = request.query as { download?: string };
    reply.type("text/plain; charset=utf-8");
    if (download === "1") {
      reply.header("Content-Disposition", `attachment; filename="${safe}"`);
    }
    return reply.send(createReadStream(filePath));
  });
}
