import type { FastifyInstance } from "fastify";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { MissionHost } from "../gamefiles/MissionHost.js";
import {
  buildHostedMissionUrl,
  isServableMission,
  validateMissionHostSettings,
} from "../gamefiles/missionHostSettings.js";

/** The directory the mission host serves: the global game path's missions/. */
export function missionHostMissionsDir(): string | null {
  const gamePath = pyrodeckConfig.get().gamePath;
  return gamePath ? path.join(gamePath, "missions") : null;
}

export const missionHost = new MissionHost({ getMissionsDir: missionHostMissionsDir });

/**
 * Host fields for a mission in `missionsDir`, added to the mission details:
 * `hostUrl` when the host can serve it, `hostError` when it cannot, nothing
 * while the host is off.
 */
export function hostedLinkFor(file: string, missionsDir: string): { hostUrl?: string; hostError?: string } {
  const settings = pyrodeckConfig.get().missionHost;
  if (!settings.enabled || !settings.publicBaseUrl) return {};
  const hostDir = missionHostMissionsDir();
  if (!hostDir || path.resolve(hostDir) !== path.resolve(missionsDir)) {
    return {
      hostError: `The mission host serves ${hostDir ?? "nothing (no game path set)"}, not this profile's missions directory.`,
    };
  }
  const built = buildHostedMissionUrl(settings.publicBaseUrl, file);
  return "url" in built ? { hostUrl: built.url } : { hostError: built.error };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

interface HostTestResult {
  ok: boolean;
  url: string;
  status: number | null;
  contentLength: number | null;
  bytes: number;
  /** Bytes received equal the file on disk (size and SHA-256). */
  matches: boolean;
  elapsedMs: number;
  error: string | null;
}

/** GET `url` the way a client would and compare the body with `filePath`. */
async function fetchAndCompare(url: string, filePath: string): Promise<HostTestResult> {
  const started = Date.now();
  const result: HostTestResult = {
    ok: false,
    url,
    status: null,
    contentLength: null,
    bytes: 0,
    matches: false,
    elapsedMs: 0,
    error: null,
  };
  try {
    const received = await new Promise<{ bytes: number; digest: string }>((resolve, reject) => {
      const req = http.get(url, { timeout: 15_000, headers: { Connection: "close" } }, (res) => {
        result.status = res.statusCode ?? null;
        const len = res.headers["content-length"];
        result.contentLength = len !== undefined ? Number(len) : null;
        const hash = crypto.createHash("sha256");
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          hash.update(chunk);
        });
        res.on("end", () => resolve({ bytes, digest: hash.digest("hex") }));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("no answer within 15 s")));
      req.on("error", reject);
    });
    result.bytes = received.bytes;
    if (result.status === 200) {
      const [stat, digest] = await Promise.all([fs.stat(filePath), sha256File(filePath)]);
      result.matches = received.bytes === stat.size && received.digest === digest;
      result.ok = result.matches && result.contentLength === stat.size;
      if (!result.matches) result.error = "The download differs from the file on disk.";
      else if (!result.ok) result.error = "The response has no correct Content-Length.";
    } else {
      result.error = `HTTP ${result.status}`;
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    result.error = e.code ? `${e.code}: ${e.message}` : e.message;
  }
  result.elapsedMs = Date.now() - started;
  return result;
}

export async function missionHostRoutes(app: FastifyInstance): Promise<void> {
  missionHost.setLogger({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
  // A bind failure at boot lands in the status; it never stops Pyrodeck.
  await missionHost.apply(pyrodeckConfig.get().missionHost);
  app.addHook("onClose", async () => {
    await missionHost.stop();
  });

  /** GET /api/mission-host: saved settings and the listener's state. */
  app.get("/api/mission-host", async () => ({
    settings: pyrodeckConfig.get().missionHost,
    status: missionHost.getStatus(),
  }));

  /**
   * PUT /api/mission-host  { enabled, port, publicBaseUrl }
   * Save the settings and start, stop or move the listener to match.
   */
  app.put("/api/mission-host", async (request, reply) => {
    const check = validateMissionHostSettings(request.body);
    if (check.errors.length > 0) {
      return reply.status(400).send({ error: check.errors.join(" "), errors: check.errors });
    }
    const warnings = [...check.warnings];
    if (check.settings.enabled && !missionHostMissionsDir()) {
      warnings.push("No game path is set, so there is nothing to serve yet.");
    }
    await pyrodeckConfig.save({ missionHost: check.settings });
    const status = await missionHost.apply(check.settings);
    return { settings: check.settings, status, warnings };
  });

  /**
   * POST /api/mission-host/test  { file }
   * Fetch the mission through the public base URL from this machine and
   * compare it with the file on disk. Only the configured base and a mission
   * the host would serve are ever fetched.
   */
  app.post("/api/mission-host/test", async (request, reply) => {
    const { file } = (request.body ?? {}) as { file?: unknown };
    const settings = pyrodeckConfig.get().missionHost;
    if (!settings.enabled || !settings.publicBaseUrl) {
      return reply.status(409).send({ error: "The mission host is off." });
    }
    const missionsDir = missionHostMissionsDir();
    if (typeof file !== "string" || !missionsDir) {
      return reply.status(400).send({ error: "file is required and a game path must be set" });
    }
    let entries: string[];
    try {
      entries = await fs.readdir(missionsDir);
    } catch {
      return reply.status(400).send({ error: `Cannot read ${missionsDir}` });
    }
    if (!isServableMission(file, entries)) {
      return reply.status(404).send({ error: `The mission host does not serve ${file}.` });
    }
    const built = buildHostedMissionUrl(settings.publicBaseUrl, file);
    if (!("url" in built)) return reply.status(400).send({ error: built.error });
    return fetchAndCompare(built.url, path.join(missionsDir, file));
  });
}
