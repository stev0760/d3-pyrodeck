import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * "Start when Pyrodeck starts" on the profile API: one profile at a time,
 * cleared with its profile, and PYRODECK_AUTOSTART_PROFILE winning (said in
 * the save's warnings). profiles.json lives in a temp config directory; the
 * stored Pyrodeck config is a stand-in.
 */
const mocks = await vi.hoisted(async () => {
  // Before routes/config.ts reads PYRODECK_CONFIG_DIR at import.
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pyrodeck-autostart-route-"));
  const previousConfigDir = process.env.PYRODECK_CONFIG_DIR;
  process.env.PYRODECK_CONFIG_DIR = dir;
  return { dir, previousConfigDir, config: { autostart: { profileId: null as string | null } } };
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

const PROFILES = [
  { id: "id-ctf", name: "Public CTF", configFile: "ctf.cfg", createdAt: "2026-10-01T00:00:00.000Z" },
  { id: "id-anarchy", name: "Anarchy", configFile: "anarchy.cfg", createdAt: "2026-10-01T00:00:00.000Z" },
];

let app: FastifyInstance;

beforeEach(async () => {
  await fs.writeFile(`${mocks.dir}/profiles.json`, JSON.stringify(PROFILES));
  mocks.config.autostart = { profileId: null };
  app = Fastify();
  await app.register(configRoutes);
  await app.ready();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

afterAll(async () => {
  if (mocks.previousConfigDir === undefined) delete process.env.PYRODECK_CONFIG_DIR;
  else process.env.PYRODECK_CONFIG_DIR = mocks.previousConfigDir;
  await fs.rm(mocks.dir, { recursive: true, force: true });
});

const patch = (id: string, payload: unknown) => app.inject({ method: "PATCH", url: `/api/profiles/${id}`, payload: payload as object });

describe("PATCH /api/profiles/:id { autostart }", () => {
  it("makes the profile the one that starts with Pyrodeck; ticking another replaces it", async () => {
    expect((await patch("id-ctf", { autostart: true })).statusCode).toBe(200);
    expect(mocks.config.autostart.profileId).toBe("id-ctf");
    await patch("id-anarchy", { autostart: true });
    expect(mocks.config.autostart.profileId).toBe("id-anarchy");
  });

  it("clears it only from the profile that has it", async () => {
    await patch("id-anarchy", { autostart: true });
    await patch("id-ctf", { autostart: false });
    expect(mocks.config.autostart.profileId).toBe("id-anarchy");
    await patch("id-anarchy", { autostart: false });
    expect(mocks.config.autostart.profileId).toBeNull();
  });

  it("leaves it alone when the save does not mention it", async () => {
    await patch("id-ctf", { autostart: true });
    await patch("id-ctf", { description: "Fridays" });
    expect(mocks.config.autostart.profileId).toBe("id-ctf");
  });

  it("refuses a value that is not true or false", async () => {
    const res = await patch("id-ctf", { autostart: "yes" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("autostart must be true or false.");
    expect(mocks.config.autostart.profileId).toBeNull();
  });

  it("refuses an unknown profile", async () => {
    expect((await patch("nope", { autostart: true })).statusCode).toBe(404);
    expect(mocks.config.autostart.profileId).toBeNull();
  });

  it("warns that PYRODECK_AUTOSTART_PROFILE wins when it is set", async () => {
    vi.stubEnv("PYRODECK_AUTOSTART_PROFILE", "Public CTF");
    const res = await patch("id-anarchy", { autostart: true });
    expect(res.json().warnings).toEqual([
      'PYRODECK_AUTOSTART_PROFILE is set and wins over "Start when Pyrodeck starts": Pyrodeck starts the profile it names ("Public CTF").',
    ]);
  });
});

describe("DELETE /api/profiles/:id", () => {
  it("clears autostart along with its profile", async () => {
    await patch("id-ctf", { autostart: true });
    expect((await app.inject({ method: "DELETE", url: "/api/profiles/id-anarchy" })).statusCode).toBe(200);
    expect(mocks.config.autostart.profileId).toBe("id-ctf");
    expect((await app.inject({ method: "DELETE", url: "/api/profiles/id-ctf" })).statusCode).toBe(200);
    expect(mocks.config.autostart.profileId).toBeNull();
  });
});
