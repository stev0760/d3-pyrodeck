import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

// A queued state write may still land while the temp directory is being removed (ENOTEMPTY): retry.
const RM_TEMP = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 } as const;

/**
 * A profile's tracker list (GET and PUT /api/profiles/:id/tracker-list): the
 * file its server reads (-gspyfile, else gamespy.cfg, in its game
 * directory), written as region/tracker pairs with the old file kept as the
 * backup, refused for a file the panel does not write, and the other
 * profiles reading the same file. profiles.json and the game directories are
 * temp directories; the stored Pyrodeck config is a stand-in.
 */
const mocks = await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pyrodeck-trackerlist-route-"));
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
const { serverRegistry } = await import("../servers/ServerRegistry.js");

interface Profile {
  id: string;
  name: string;
  configFile: string;
  gamePath?: string;
  launchOptions?: Record<string, unknown>;
  startupFile?: string;
}

const profile = (id: string, name: string, extra: Partial<Profile> = {}): Profile => ({
  id,
  name,
  configFile: `${id}.cfg`,
  ...extra,
});

let app: FastifyInstance;

async function useProfiles(profiles: Profile[]): Promise<void> {
  await fs.writeFile(
    `${mocks.dir}/profiles.json`,
    JSON.stringify(profiles.map((p) => ({ ...p, createdAt: "2026-11-01T00:00:00.000Z" }))),
  );
}

beforeEach(async () => {
  for (const d of [mocks.game, mocks.otherGame]) {
    for (const f of await fs.readdir(d)) await fs.rm(`${d}/${f}`);
  }
  await useProfiles([profile("ctf", "CTF")]);
  app = Fastify();
  await app.register(configRoutes);
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  if (mocks.previousConfigDir === undefined) delete process.env.PYRODECK_CONFIG_DIR;
  else process.env.PYRODECK_CONFIG_DIR = mocks.previousConfigDir;
  await fs.rm(mocks.dir, RM_TEMP);
});

const read = (id: string) => app.inject({ method: "GET", url: `/api/profiles/${id}/tracker-list` });
const save = (id: string, payload: unknown) =>
  app.inject({ method: "PUT", url: `/api/profiles/${id}/tracker-list`, payload: payload as object });
const gameFile = (name: string) => fs.readFile(path.join(mocks.game, name), "utf-8");

describe("GET /api/profiles/:id/tracker-list", () => {
  it("reads a missing gamespy.cfg as no list", async () => {
    const res = await read("ctf");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      file: "gamespy.cfg",
      path: path.join(mocks.game, "gamespy.cfg"),
      exists: false,
      writable: true,
      writeError: null,
      region: 0,
      trackers: [],
      ignored: [],
      sharedWith: [],
      gameSpyPort: { port: 20142, source: "default" },
      running: false,
    });
  });

  it("reads a one-region-then-hosts file as the game does and reports the line it takes for a region", async () => {
    await fs.writeFile(
      path.join(mocks.game, "gamespy.cfg"),
      "5\ntracker.example.org\n192.0.2.10:27952\ntracker.example.net\n",
    );
    expect((await read("ctf")).json()).toMatchObject({
      exists: true,
      region: 192,
      trackers: ["tracker.example.org", "tracker.example.net"],
      ignored: ["192.0.2.10:27952"],
    });
  });

  it("reads the profile's own -gspyfile, with its own GameSpy port", async () => {
    await useProfiles([profile("ctf", "CTF", { launchOptions: { gameSpyFile: "ctf-trackers.cfg", gameSpyPort: 20150 } })]);
    await fs.writeFile(path.join(mocks.game, "ctf-trackers.cfg"), "2\ntracker.example.org\n");
    expect((await read("ctf")).json()).toMatchObject({
      file: "ctf-trackers.cfg",
      exists: true,
      region: 2,
      trackers: ["tracker.example.org"],
      gameSpyPort: { port: 20150, source: "profile" },
    });
  });

  it("names the other profiles that read the same file: same game directory, same name", async () => {
    await useProfiles([
      profile("ctf", "CTF"),
      profile("anarchy", "Anarchy", { gamePath: mocks.game }),
      profile("coop", "Co-op", { gamePath: mocks.otherGame }),
      profile("duel", "Duel", { launchOptions: { gameSpyFile: "duel.cfg" } }),
      profile("hoard", "Hoard", { launchOptions: { gameSpyFile: "GameSpy.cfg" } }),
    ]);
    expect((await read("ctf")).json().sharedWith).toEqual(["Anarchy", "Hoard"]);
    expect((await read("coop")).json().sharedWith).toEqual([]);
    expect((await read("duel")).json().sharedWith).toEqual([]);
  });

  it("gives the running server's port, a move to a free one included", async () => {
    vi.spyOn(serverRegistry, "get").mockReturnValue({
      heldLaunch: () => ({
        launch: {
          executablePath: path.join(mocks.game, "Descent3"),
          gamePath: mocks.game,
          configFile: "ctf.cfg",
          telnetPort: 2702,
          telnetPassword: "x",
          launchOptions: null,
          defaultOptions: { gameSpyPort: 20143 },
        },
        pid: 4242,
        why: "running",
      }),
    } as never);
    expect((await read("ctf")).json()).toMatchObject({ running: true, gameSpyPort: { port: 20143, source: "running" } });
  });

  it("answers 404 for an unknown profile", async () => {
    expect((await read("nope")).statusCode).toBe(404);
    expect((await save("nope", { region: 0, trackers: [] })).statusCode).toBe(404);
  });
});

describe("PUT /api/profiles/:id/tracker-list", () => {
  it("writes region and tracker pairs and keeps the old file as the backup", async () => {
    const handWritten = "5\ntracker.example.org\n192.0.2.10:27952\ntracker.example.net\n";
    await fs.writeFile(path.join(mocks.game, "gamespy.cfg"), handWritten);
    const res = await save("ctf", {
      region: 5,
      trackers: ["tracker.example.org", "192.0.2.10:27952", "tracker.example.net"],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      written: true,
      exists: true,
      region: 5,
      trackers: ["tracker.example.org", "192.0.2.10:27952", "tracker.example.net"],
      ignored: [],
    });
    expect(await gameFile("gamespy.cfg")).toBe(
      "5\ntracker.example.org\n5\n192.0.2.10:27952\n5\ntracker.example.net\n",
    );
    expect(await gameFile("gamespy.cfg.bak")).toBe(handWritten);
  });

  it("creates the file, and writes the region line alone once every tracker is removed", async () => {
    expect((await save("ctf", { region: 3, trackers: ["tracker.example.org"] })).json()).toMatchObject({
      written: true,
      exists: true,
    });
    expect(await gameFile("gamespy.cfg")).toBe("3\ntracker.example.org\n");
    expect((await save("ctf", { region: 0, trackers: [] })).json()).toMatchObject({ written: true, trackers: [] });
    expect(await gameFile("gamespy.cfg")).toBe("0\n");
  });

  it("writes nothing for region 0 and no trackers when there is no file", async () => {
    const res = await save("ctf", { region: 0, trackers: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, written: false, exists: false });
    await expect(fs.access(path.join(mocks.game, "gamespy.cfg"))).rejects.toThrow();
  });

  it("refuses a GameSpy file the panel does not write, and still reads it", async () => {
    await useProfiles([profile("ctf", "CTF", { launchOptions: { gameSpyFile: "trackers" } })]);
    await fs.writeFile(path.join(mocks.game, "trackers"), "1\ntracker.example.org\n");
    const view = (await read("ctf")).json();
    expect(view).toMatchObject({ file: "trackers", writable: false, trackers: ["tracker.example.org"] });
    expect(view.writeError).toMatch(/ends in \.cfg/);

    const res = await save("ctf", { region: 1, trackers: ["tracker.example.net"] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ writable: false });
    expect(res.json().error).toMatch(/^The tracker list cannot be saved to trackers\. Pyrodeck writes only \.cfg/);
    expect(await gameFile("trackers")).toBe("1\ntracker.example.org\n");
  });

  it("refuses a GameSpy file that is a server config or a Startup Commands file", async () => {
    await useProfiles([
      profile("ctf", "CTF", { launchOptions: { gameSpyFile: "anarchy.cfg" } }),
      profile("anarchy", "Anarchy"),
      profile("duel", "Duel", { launchOptions: { gameSpyFile: "autoexec.dmfc" } }),
    ]);
    await fs.writeFile(path.join(mocks.game, "anarchy.cfg"), "[server config file]\nGameName=Anarchy\n");
    const res = await save("ctf", { region: 0, trackers: ["tracker.example.org"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().writeError).toBe(
      'anarchy.cfg is the server config of "Anarchy". Choose a GameSpy file of its own, such as gamespy.cfg (Launch Options).',
    );
    expect(await gameFile("anarchy.cfg")).toBe("[server config file]\nGameName=Anarchy\n");
    expect((await read("duel")).json().writeError).toMatch(/^autoexec\.dmfc is the Startup Commands file of "CTF"/);
  });

  it("refuses an invalid list and leaves the file alone", async () => {
    await fs.writeFile(path.join(mocks.game, "gamespy.cfg"), "0\ntracker.example.org\n");
    const res = await save("ctf", { region: 13, trackers: ["tracker.example.org", "bad host", "TRACKER.example.org:27900"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual([
      "The region must be a whole number from 0 to 12.",
      "Tracker 2 has a space in it.",
      "Tracker 3 repeats tracker 1 (tracker.example.org:27900).",
    ]);
    expect((await save("ctf", { region: 0, trackers: Array(6).fill("tracker.example.org") })).statusCode).toBe(400);
    expect((await save("ctf", undefined)).statusCode).toBe(400);
    expect(await gameFile("gamespy.cfg")).toBe("0\ntracker.example.org\n");
  });

  it("writes the file another profile of the game directory reads too, and says so", async () => {
    await useProfiles([profile("ctf", "CTF"), profile("anarchy", "Anarchy")]);
    const res = await save("anarchy", { region: 2, trackers: ["tracker.example.org"] });
    expect(res.json().sharedWith).toEqual(["CTF"]);
    expect((await read("ctf")).json()).toMatchObject({ region: 2, trackers: ["tracker.example.org"] });
  });
});
