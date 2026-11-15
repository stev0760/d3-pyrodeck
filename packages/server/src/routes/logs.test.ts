import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_LOG_RETENTION, RECOMMENDED_LOG_RETENTION, type LogRetentionSettings } from "../launcher/logRetention.js";
import { logsRoutes } from "./logs.js";

/**
 * The Logs tab's API with compressed logs and the retention settings. The
 * stored config and the process manager are stand-ins; the log directory is a
 * temp directory.
 */
const mocks = vi.hoisted(() => ({
  config: {} as { logDir: string | null; logRetention: LogRetentionSettings; gamePath: string | null; executablePath: string | null },
  activeLog: null as string | null,
}));
vi.mock("./pyrodeck-config.js", () => ({
  pyrodeckConfig: {
    get: () => mocks.config,
    save: async (updates: Record<string, unknown>) => Object.assign(mocks.config, updates),
  },
}));
vi.mock("./launcher.js", () => ({
  processManager: {
    getActiveLogPath: () => mocks.activeLog,
    getLaunchConfig: () => (mocks.activeLog ? { logPath: mocks.activeLog } : null),
    getActiveLogPaths: () => (mocks.activeLog ? [mocks.activeLog] : []),
    getLastLogPaths: () => (mocks.activeLog ? [mocks.activeLog] : []),
  },
}));

let dir: string;
let app: FastifyInstance;
const opened: FastifyInstance[] = [];

const PLAIN = "testing-2026-10-01T10-00-00.log";
const PACKED = "testing-2026-09-01T10-00-00.log.gz";
const LINE = "Opening level 1 of the mission\n";

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  opened.push(instance);
  await instance.register(logsRoutes);
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-logs-route-"));
  mocks.config = { logDir: dir, logRetention: { ...DEFAULT_LOG_RETENTION }, gamePath: null, executablePath: null };
  mocks.activeLog = null;
  await fs.writeFile(path.join(dir, PLAIN), LINE.repeat(10));
  // 400 KB of text compressed: bigger than the viewer's 256 KB tail.
  await fs.writeFile(path.join(dir, PACKED), gzipSync(Buffer.from(LINE.repeat(13_000))));
  await fs.writeFile(path.join(dir, "notes.txt"), "not a log");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const instance of opened.splice(0)) await instance.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("compressed logs in the Logs tab", () => {
  beforeEach(async () => {
    app = await buildApp();
  });

  it("lists .log and .log.gz files and marks the compressed ones", async () => {
    const res = await app.inject({ url: "/api/logs" });
    const files = res.json().files as Array<{ name: string; compressed: boolean }>;
    expect(files.map((f) => [f.name, f.compressed]).sort()).toEqual([
      [PACKED, true],
      [PLAIN, false],
    ]);
  });

  it("views a compressed log decompressed, the last 256 KB with ?tail=1", async () => {
    const full = await app.inject({ url: `/api/logs/${PACKED}` });
    expect(full.statusCode).toBe(200);
    expect(full.headers["content-type"]).toMatch(/^text\/plain/);
    expect(full.body).toBe(LINE.repeat(13_000));

    const tail = await app.inject({ url: `/api/logs/${PACKED}?tail=1` });
    expect(tail.headers["x-log-truncated"]).toBe("1");
    expect(tail.headers["x-log-total-size"]).toBe(String(LINE.length * 13_000));
    expect(tail.rawPayload.length).toBe(256 * 1024);
    expect(LINE.repeat(13_000).endsWith(tail.body)).toBe(true);
  });

  it("downloads a compressed log as the .gz file itself", async () => {
    const res = await app.inject({ url: `/api/logs/${PACKED}?download=1` });
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${PACKED}"`);
    expect(gunzipSync(res.rawPayload).toString()).toBe(LINE.repeat(13_000));
  });

  it("reports a corrupt .gz instead of sending garbage", async () => {
    await fs.writeFile(path.join(dir, "broken-2026-09-02T10-00-00.log.gz"), "not gzip");
    const res = await app.inject({ url: "/api/logs/broken-2026-09-02T10-00-00.log.gz?tail=1" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/Cannot decompress/);
  });

  it("deletes a compressed log, and still refuses the running server's log", async () => {
    expect((await app.inject({ method: "DELETE", url: `/api/logs/${PACKED}` })).statusCode).toBe(200);
    await expect(fs.access(path.join(dir, PACKED))).rejects.toThrow();
    mocks.activeLog = path.join(dir, PLAIN);
    expect((await app.inject({ method: "DELETE", url: `/api/logs/${PLAIN}` })).statusCode).toBe(409);
  });

  it("refuses names that are not logs or leave the directory", async () => {
    for (const name of ["notes.txt", "..%2Fetc%2Fpasswd.log", "x.gz"]) {
      expect((await app.inject({ url: `/api/logs/${name}` })).statusCode).toBe(400);
    }
  });
});

describe("retention settings", () => {
  it("is off until the operator sets it, and shows the stored and environment values", async () => {
    app = await buildApp();
    const res = await app.inject({ url: "/api/logs/retention" });
    expect(res.json()).toMatchObject({
      settings: { days: 0, maxMb: 0, compress: false },
      stored: { days: 0, maxMb: 0, compress: false },
      env: { days: null, maxMb: null, compress: null },
      dirs: [path.resolve(dir)],
    });
  });

  it("reports the over-1 GB warning to the Logs tab while retention is off, and clears it once set", async () => {
    const huge = await fs.open(path.join(dir, "testing-2026-08-01T10-00-00.log"), "w");
    await huge.truncate(1100 * 1024 * 1024); // sparse: no disk space
    await huge.close();
    const old = new Date(Date.now() - 60 * 86_400_000);
    await fs.utimes(path.join(dir, "testing-2026-08-01T10-00-00.log"), old, old);
    app = await buildApp();
    await app.inject({ method: "PUT", url: "/api/logs/retention", payload: { ...DEFAULT_LOG_RETENTION } });
    await vi.waitFor(async () => {
      expect((await app.inject({ url: "/api/logs/retention" })).json().lastRun?.warning).toMatch(/Log retention is off/);
    });
    expect((await fs.readdir(dir)).sort()).toEqual(["notes.txt", PLAIN, PACKED, "testing-2026-08-01T10-00-00.log"].sort());

    await app.inject({ method: "PUT", url: "/api/logs/retention", payload: { ...RECOMMENDED_LOG_RETENTION } });
    await vi.waitFor(async () => {
      const lastRun = (await app.inject({ url: "/api/logs/retention" })).json().lastRun;
      expect(lastRun).toMatchObject({ warning: null, deleted: 1 });
    });
    expect((await fs.readdir(dir)).sort()).toEqual(["notes.txt", PLAIN, PACKED].sort());
  });

  it("saves the Logs tab's settings and runs retention with them", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "PUT", url: "/api/logs/retention", payload: { days: 7, maxMb: 100, compress: false } });
    expect(res.statusCode).toBe(200);
    expect(mocks.config.logRetention).toEqual({ days: 7, maxMb: 100, compress: false });
    expect(res.json().settings).toEqual({ days: 7, maxMb: 100, compress: false });
    await vi.waitFor(async () => {
      expect((await app.inject({ url: "/api/logs/retention" })).json().lastRun).not.toBeNull();
    });
    // The packed log was last written now, so it stays; nothing else is Pyrodeck's to prune.
    expect((await fs.readdir(dir)).sort()).toEqual(["notes.txt", PLAIN, PACKED].sort());
  });

  it("refuses values out of range", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "PUT", url: "/api/logs/retention", payload: { days: -1, maxMb: 100, compress: true } });
    expect(res.statusCode).toBe(400);
    expect(mocks.config.logRetention).toEqual(DEFAULT_LOG_RETENTION);
  });

  it("lets the three environment variables win over what is saved", async () => {
    vi.stubEnv("PYRODECK_LOG_RETENTION_DAYS", "90");
    vi.stubEnv("PYRODECK_LOG_MAX_MB", "0");
    vi.stubEnv("PYRODECK_LOG_COMPRESS", "1");
    app = await buildApp();
    const res = await app.inject({ method: "PUT", url: "/api/logs/retention", payload: { days: 7, maxMb: 100, compress: false } });
    expect(res.json()).toMatchObject({
      settings: { days: 90, maxMb: 0, compress: true },
      stored: { days: 7, maxMb: 100, compress: false },
      env: { days: 90, maxMb: 0, compress: true },
    });
  });

  it("stops the start on a malformed environment value", async () => {
    vi.stubEnv("PYRODECK_LOG_MAX_MB", "2GB");
    await expect(buildApp()).rejects.toThrow(/PYRODECK_LOG_MAX_MB/);
  });
});
