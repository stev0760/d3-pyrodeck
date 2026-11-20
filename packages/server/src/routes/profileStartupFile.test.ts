import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";

// A queued state write may still land while the temp directory is being removed (ENOTEMPTY): retry.
const RM_TEMP = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 } as const;

/**
 * A new profile in a game directory another profile already uses gets its
 * own Startup Commands file (`<config>.dmfc`), so both servers can run at
 * once; one alone in its directory keeps autoexec.dmfc. A duplicate gets its
 * own and the source's commands copied in. profiles.json and the game
 * directory are temp directories; the stored Pyrodeck config is a stand-in.
 */
const mocks = await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pyrodeck-startupfile-route-"));
  const game = join(dir, "game");
  const otherGame = join(dir, "other-game");
  mkdirSync(game);
  mkdirSync(otherGame);
  const previousConfigDir = process.env.PYRODECK_CONFIG_DIR;
  process.env.PYRODECK_CONFIG_DIR = dir;
  return { dir, game, otherGame, previousConfigDir, config: { gamePath: game, autostart: { profileId: null } } };
});
vi.mock("./pyrodeck-config.js", () => ({
  pyrodeckConfig: {
    get: () => mocks.config,
    save: async (updates: Record<string, unknown>) => Object.assign(mocks.config, updates),
  },
}));
vi.mock("./mission-host.js", () => ({
  missionHost: {},
  hostedLinkFor: () => null,
  missionHostMissionsDir: () => null,
}));

const { configRoutes } = await import("./config.js");

let app: FastifyInstance;

beforeEach(async () => {
  await fs.writeFile(`${mocks.dir}/profiles.json`, "[]");
  for (const d of [mocks.game, mocks.otherGame]) {
    for (const f of await fs.readdir(d)) await fs.rm(`${d}/${f}`);
  }
  app = Fastify();
  await app.register(configRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  if (mocks.previousConfigDir === undefined) delete process.env.PYRODECK_CONFIG_DIR;
  else process.env.PYRODECK_CONFIG_DIR = mocks.previousConfigDir;
  await fs.rm(mocks.dir, RM_TEMP);
});

const create = async (payload: Record<string, unknown>) => {
  const res = await app.inject({ method: "POST", url: "/api/profiles", payload });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; configFile: string; startupFile?: string };
};

describe("a new profile's Startup Commands file", () => {
  it("stays autoexec.dmfc for the only profile in its game directory", async () => {
    const first = await create({ name: "Anarchy" });
    expect(first.startupFile).toBeUndefined();
  });

  it("is <config>.dmfc for a profile in a game directory another profile uses", async () => {
    await create({ name: "Anarchy" });
    const second = await create({ name: "CTF" });
    expect(second.startupFile).toBe(`${second.configFile.replace(/\.cfg$/, "")}.dmfc`);
    const saved = (await app.inject({ method: "GET", url: `/api/profiles/${second.id}` })).json() as { startupFile?: string };
    expect(saved.startupFile).toBe(second.startupFile);
  });

  it("counts the global game path as the directory of a profile without its own", async () => {
    await create({ name: "Anarchy" });
    const elsewhere = await create({ name: "Coop", gamePath: mocks.otherGame });
    expect(elsewhere.startupFile).toBeUndefined();
    const same = await create({ name: "CTF", gamePath: mocks.game });
    expect(same.startupFile).toMatch(/\.dmfc$/);
  });

  it("gives a duplicate its own file with the source's commands copied in", async () => {
    const source = await create({ name: "Anarchy" });
    await fs.writeFile(`${mocks.game}/autoexec.dmfc`, "$killmsgfilter simple\n");
    const res = await app.inject({ method: "POST", url: `/api/profiles/${source.id}/duplicate`, payload: { name: "Anarchy 2" } });
    expect(res.statusCode).toBe(200);
    const copy = res.json() as { configFile: string; startupFile?: string };
    expect(copy.startupFile).toBe(`${copy.configFile.replace(/\.cfg$/, "")}.dmfc`);
    expect(await fs.readFile(`${mocks.game}/${copy.startupFile}`, "utf-8")).toBe("$killmsgfilter simple\n");
    // The source's own file is left as it was.
    expect(await fs.readFile(`${mocks.game}/autoexec.dmfc`, "utf-8")).toBe("$killmsgfilter simple\n");
  });

  it("never takes a file of that name already in the directory", async () => {
    await create({ name: "Anarchy" });
    await fs.writeFile(`${mocks.game}/ctf.dmfc`, "operator's own\n");
    const ctf = await create({ name: "CTF" });
    const stem = ctf.configFile.replace(/\.cfg$/, "");
    expect(stem).toBe("ctf");
    expect(ctf.startupFile).toBe("ctf-2.dmfc");
    expect(await fs.readFile(`${mocks.game}/ctf.dmfc`, "utf-8")).toBe("operator's own\n");
  });
});
