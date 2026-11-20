import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";

// A queued state write may still land while the temp directory is being removed (ENOTEMPTY): retry.
const RM_TEMP = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 } as const;

/**
 * A profile's join address (GET /api/profiles/:id/join-address): an IPv4
 * host as it is, a host name looked up to the IPv4 address the game's join
 * screen takes, and no address for a name that does not resolve.
 * profiles.json is in a temp directory; the stored Pyrodeck config and the
 * system resolver are stand-ins.
 */
const mocks = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pyrodeck-joinaddress-route-"));
  const previousConfigDir = process.env.PYRODECK_CONFIG_DIR;
  process.env.PYRODECK_CONFIG_DIR = dir;
  return {
    dir,
    previousConfigDir,
    config: {
      gamePath: dir,
      autostart: { profileId: null },
      joinHost: null as string | null,
      missionHost: { publicBaseUrl: null as string | null },
    },
    lookup: vi.fn(),
  };
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
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));

const { configRoutes } = await import("./config.js");

let app: FastifyInstance;

async function useProfile(launchOptions?: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    `${mocks.dir}/profiles.json`,
    JSON.stringify([{ id: "ctf", name: "CTF", configFile: "ctf.cfg", launchOptions, createdAt: "2026-11-01T00:00:00.000Z" }]),
  );
}

beforeEach(async () => {
  mocks.config.joinHost = null;
  mocks.config.missionHost.publicBaseUrl = null;
  mocks.lookup.mockReset();
  await useProfile();
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

const read = (id: string) => app.inject({ method: "GET", url: `/api/profiles/${id}/join-address` });

describe("GET /api/profiles/:id/join-address", () => {
  it("gives an IPv4 Join Host and the profile's game port as they are", async () => {
    mocks.config.joinHost = "203.0.113.7";
    await useProfile({ gamePort: 2116 });
    const res = await read("ctf");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      host: "203.0.113.7",
      port: 2116,
      hostSource: "setting",
      hostKind: "ipv4",
      resolved: null,
      address: "203.0.113.7:2116",
      lanOnly: false,
    });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("looks a host name up, IPv4 only, and gives its address with the name", async () => {
    mocks.config.joinHost = "d3.example.org";
    mocks.lookup.mockResolvedValue({ address: "192.0.2.10", family: 4 });
    expect((await read("ctf")).json()).toEqual({
      host: "d3.example.org",
      port: 2092,
      hostSource: "setting",
      hostKind: "name",
      resolved: "192.0.2.10",
      address: "192.0.2.10:2092",
      lanOnly: false,
    });
    expect(mocks.lookup).toHaveBeenCalledWith("d3.example.org", { family: 4 });
  });

  it("marks a name that resolves to a private address as LAN only", async () => {
    mocks.config.missionHost.publicBaseUrl = "http://d3.example.org:3002";
    mocks.lookup.mockResolvedValue({ address: "192.168.0.103", family: 4 });
    expect((await read("ctf")).json()).toMatchObject({
      hostSource: "mission-host",
      address: "192.168.0.103:2092",
      lanOnly: true,
    });
  });

  it("gives no address for a name that does not resolve", async () => {
    mocks.config.missionHost.publicBaseUrl = "http://d3.example.org:3002";
    mocks.lookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND d3.example.org"), { code: "ENOTFOUND" }));
    const res = await read("ctf");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      host: "d3.example.org",
      port: 2092,
      hostSource: "mission-host",
      hostKind: "name",
      resolved: null,
      address: null,
      lanOnly: false,
    });
  });

  it("answers 404 for an unknown profile", async () => {
    expect((await read("nope")).statusCode).toBe(404);
  });
});
