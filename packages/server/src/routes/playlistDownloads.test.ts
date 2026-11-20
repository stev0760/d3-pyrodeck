import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

// A queued state write may still land while the temp directory is being removed (ENOTEMPTY): retry.
const RM_TEMP = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 } as const;

/**
 * Playlists hosting their missions: activation, saving the active playlist
 * with other missions, and turning the mission host on while a playlist is
 * active. The config directory and the game path are temp directories; the
 * stored Pyrodeck config is a stand-in, and so is the listener (nothing
 * binds a port).
 */
const mocks = await vi.hoisted(async () => {
  // Before playlistInstance.ts and the routes read PYRODECK_CONFIG_DIR at import.
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "pyrodeck-playlist-hosting-"));
  const configDir = join(root, "config");
  const gamePath = join(root, "game");
  mkdirSync(configDir);
  mkdirSync(join(gamePath, "missions"), { recursive: true });
  const previousConfigDir = process.env.PYRODECK_CONFIG_DIR;
  process.env.PYRODECK_CONFIG_DIR = configDir;
  return {
    root,
    configDir,
    gamePath,
    previousConfigDir,
    config: {
      gamePath,
      missionHost: { enabled: false, port: 3002, publicBaseUrl: null as string | null },
    },
  };
});
vi.mock("./pyrodeck-config.js", () => ({
  pyrodeckConfig: {
    get: () => mocks.config,
    save: async (updates: Record<string, unknown>) => Object.assign(mocks.config, updates),
  },
}));
vi.mock("../gamefiles/MissionHost.js", () => ({
  MissionHost: class {
    setLogger() {}
    async apply(s: { enabled: boolean; port: number; publicBaseUrl: string | null }) {
      return { ...s, bound: s.enabled, error: null, missionsDir: null };
    }
    getStatus() {
      return { enabled: true, port: 3002, bound: true, error: null, publicBaseUrl: null, missionsDir: null };
    }
    async stop() {}
  },
}));

const { playlistRoutes } = await import("./playlists.js");
const { missionHostRoutes } = await import("./mission-host.js");
const { playlistManager } = await import("../launcher/playlistInstance.js");
const { readMn3Msn, readMsnUrls, BACKUP_SUFFIX } = await import("../gamefiles/Mn3UrlRewriter.js");

const BASE = "http://example.org:3002";
const DEAD = "http://www.outrage.com/files/mission.zip";
const missionsDir = path.join(mocks.gamePath, "missions");

/** A one-level .mn3 (HOG2) whose .msn offers `urls`. */
function buildMn3(stem: string, urls: string[]): Buffer {
  const msn = [`NAME ${stem}`, "NUMLEVELS 1", ...urls.map((u) => `URL ${u}`), "MULTI YES", "LEVEL 1", "MINE x.d3l", ""];
  const files = [
    { name: "x.d3l", data: Buffer.alloc(500, 7) },
    { name: `${stem}.msn`, data: Buffer.from(msn.join("\r\n"), "latin1") },
  ];
  const header = Buffer.alloc(68);
  header.write("HOG2", 0, "latin1");
  header.writeUInt32LE(files.length, 4);
  header.writeUInt32LE(68 + files.length * 48, 8);
  const table = Buffer.alloc(files.length * 48);
  files.forEach((f, i) => {
    table.write(f.name, i * 48, "latin1");
    table.writeUInt32LE(f.data.length, i * 48 + 40);
  });
  return Buffer.concat([header, table, ...files.map((f) => f.data)]);
}

const linksOf = async (file: string) => readMsnUrls((await readMn3Msn(path.join(missionsDir, file))).text);
const entry = (label: string, missionName: string) => ({ label, missionName });

let app: FastifyInstance;

beforeEach(async () => {
  await fs.rm(missionsDir, RM_TEMP);
  await fs.mkdir(missionsDir);
  await fs.writeFile(path.join(missionsDir, "alpha.mn3"), buildMn3("alpha", [DEAD]));
  await fs.writeFile(path.join(missionsDir, "beta.mn3"), buildMn3("beta", [DEAD]));
  await fs.writeFile(path.join(missionsDir, "chaos.mn3"), buildMn3("chaos", [DEAD]));
  await fs.writeFile(path.join(missionsDir, "bogus.mn3"), "not a mission");
  await fs.writeFile(
    path.join(mocks.configDir, "profiles.json"),
    JSON.stringify([{ id: "p1", name: "Server", configFile: "server.cfg", createdAt: "2026-11-01T00:00:00.000Z" }]),
  );
  await fs.rm(path.join(mocks.configDir, "playlists.json"), { force: true });
  mocks.config.missionHost = { enabled: true, port: 3002, publicBaseUrl: BASE };
  playlistManager.deactivate();
  app = Fastify({ logger: false });
  await app.register(playlistRoutes);
  await app.register(missionHostRoutes);
  await app.ready();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  playlistManager.deactivate();
  await app.close();
});

afterAll(async () => {
  if (mocks.previousConfigDir === undefined) delete process.env.PYRODECK_CONFIG_DIR;
  else process.env.PYRODECK_CONFIG_DIR = mocks.previousConfigDir;
  await fs.rm(mocks.root, RM_TEMP);
});

describe("playlist activation", () => {
  it("points every entry at the host, reports per entry, and still activates past a failure", async () => {
    const pl = await playlistManager.create("Rotation", "sequential", [
      entry("Alpha", "alpha.mn3"),
      entry("Chaos", "chaos.mn3"),
      entry("Gone", "gone.mn3"),
      entry("Bogus", "bogus.mn3"),
    ]);
    const res = await app.inject({ method: "POST", url: `/api/playlists/${pl.id}/activate`, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toMatchObject({ status: "active", activePlaylistId: pl.id });
    expect(body.downloads.summary).toBe("1 hosted, 1 ships with the game, 1 missing, 1 failed");
    expect(body.downloads.results.map((r: { label: string; outcome: string }) => [r.label, r.outcome])).toEqual([
      ["Alpha", "hosted"],
      ["Chaos", "stock"],
      ["Gone", "missing"],
      ["Bogus", "error"],
    ]);
    expect(body.status.downloads).toEqual(body.downloads);
    expect(await linksOf("alpha.mn3")).toEqual([`${BASE}/missions/alpha.mn3`]);
    expect(await linksOf("chaos.mn3")).toEqual([DEAD]);
    expect(await fs.readdir(missionsDir)).not.toContain("chaos.mn3" + BACKUP_SUFFIX);
  });

  it("rewrites nothing while the host is off", async () => {
    mocks.config.missionHost = { enabled: false, port: 3002, publicBaseUrl: BASE };
    const pl = await playlistManager.create("Rotation", "sequential", [entry("Alpha", "alpha.mn3")]);
    const res = await app.inject({ method: "POST", url: `/api/playlists/${pl.id}/activate`, payload: {} });
    expect(res.json()).toMatchObject({ ok: true, downloads: null, status: { downloads: null } });
    expect(await linksOf("alpha.mn3")).toEqual([DEAD]);
  });

  it("says why when the host serves another missions directory", async () => {
    const other = path.join(mocks.root, "other-game");
    await fs.writeFile(
      path.join(mocks.configDir, "profiles.json"),
      JSON.stringify([
        { id: "p2", name: "Other", configFile: "server.cfg", gamePath: other, createdAt: "2026-11-01T00:00:00.000Z" },
      ]),
    );
    const pl = await playlistManager.create("Rotation", "sequential", [entry("Alpha", "alpha.mn3")]);
    const res = await app.inject({ method: "POST", url: `/api/playlists/${pl.id}/activate`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().downloads).toMatchObject({
      summary: "",
      notice: expect.stringMatching(/not the playlist's missions directory/),
      results: [],
    });
    expect(await linksOf("alpha.mn3")).toEqual([DEAD]);
  });
});

describe("saving the active playlist", () => {
  it("hosts a mission added to it, and rewrites nothing on a re-order", async () => {
    const pl = await playlistManager.create("Rotation", "sequential", [entry("Alpha", "alpha.mn3")]);
    await app.inject({ method: "POST", url: `/api/playlists/${pl.id}/activate`, payload: {} });
    const entries = playlistManager.getActivePlaylist()!.entries;

    const added = [...entries, { id: "e2", label: "Beta", missionName: "beta.mn3" }];
    const res = await app.inject({ method: "PUT", url: `/api/playlists/${pl.id}`, payload: { entries: added } });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(2);
    expect(await linksOf("beta.mn3")).toEqual([`${BASE}/missions/beta.mn3`]);
    const report = playlistManager.getStatus().downloads;
    expect(report?.summary).toBe("2 hosted");

    await app.inject({ method: "PUT", url: `/api/playlists/${pl.id}`, payload: { entries: [...added].reverse() } });
    expect(playlistManager.getStatus().downloads).toBe(report);
  });

  it("leaves an inactive playlist's missions alone", async () => {
    const pl = await playlistManager.create("Rotation", "sequential", [entry("Alpha", "alpha.mn3")]);
    const payload = { entries: [{ id: "e2", label: "Beta", missionName: "beta.mn3" }] };
    await app.inject({ method: "PUT", url: `/api/playlists/${pl.id}`, payload });
    expect(await linksOf("beta.mn3")).toEqual([DEAD]);
  });
});

describe("turning the mission host on", () => {
  it("hosts the active playlist, moves links from a former URL, and clears the report when turned off", async () => {
    mocks.config.missionHost = { enabled: false, port: 3002, publicBaseUrl: null };
    const pl = await playlistManager.create("Rotation", "sequential", [
      entry("Alpha", "alpha.mn3"),
      entry("Beta", "beta.mn3"),
    ]);
    await app.inject({ method: "POST", url: `/api/playlists/${pl.id}/activate`, payload: {} });
    expect(await linksOf("alpha.mn3")).toEqual([DEAD]);

    const put = (publicBaseUrl: string, enabled = true) =>
      app.inject({ method: "PUT", url: "/api/mission-host", payload: { enabled, port: 3002, publicBaseUrl } });

    const on = await put("http://old.example.org:3002");
    expect(on.json().downloads.summary).toBe("2 hosted");
    expect(await linksOf("alpha.mn3")).toEqual(["http://old.example.org:3002/missions/alpha.mn3"]);

    const moved = await put(BASE);
    expect(moved.json().downloads.summary).toBe("2 hosted");
    expect(await linksOf("beta.mn3")).toEqual([`${BASE}/missions/beta.mn3`]);

    const again = await put(BASE); // no change: nothing to do
    expect(again.json().downloads).toBeNull();
    expect(playlistManager.getStatus().downloads?.summary).toBe("2 hosted");

    await put(BASE, false);
    expect(playlistManager.getStatus().downloads).toBeNull();
  });
});
