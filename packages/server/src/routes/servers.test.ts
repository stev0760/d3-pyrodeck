import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebSocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { FakeWorld } from "../servers/testing/fakeGames.js";

/**
 * The servers API (GET /api/servers, /api/servers/:serverId/...), the flat
 * routes of a single-server Pyrodeck as aliases, and the WebSocket's hello,
 * over Fastify's inject against a registry of stand-in game servers
 * (servers/testing/fakeGames.ts) sharing one game directory. Nothing is
 * spawned and no port is bound. The stored Pyrodeck config is a stand-in.
 */
const mocks = await vi.hoisted(async () => {
  // Before the routes read PYRODECK_CONFIG_DIR at import.
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "pyrodeck-servers-route-"));
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
    world: null as FakeWorld | null,
    config: {
      gamePath,
      executablePath: join(gamePath, "Descent3"),
      logDir: join(root, "logs"),
      autostart: { profileId: null as string | null },
      supervisor: {
        relaunchOnCrash: true,
        hangCheck: false,
        hangProbeAfterSec: 60,
        hangRestartAfterSec: 120,
        emptyRestart: false,
        emptyRestartAfterHours: 24,
        emptyRestartGraceSec: 130,
      },
      missionHost: { enabled: false, port: 3002, publicBaseUrl: null as string | null },
      players: { ipLookup: false, ipLookupBudget: 0, hostsDenyPath: null, rehashOnLevelStart: false },
    },
  };
});
vi.mock("./pyrodeck-config.js", () => ({
  pyrodeckConfig: {
    get: () => mocks.config,
    save: async (updates: Record<string, unknown>) => Object.assign(mocks.config, updates),
  },
}));
vi.mock("../servers/ServerRegistry.js", async (importActual) => {
  const actual = await importActual<typeof import("../servers/ServerRegistry.js")>();
  const { FakeWorld } = await import("../servers/testing/fakeGames.js");
  const { sessionManager } = await import("../session/sessionStore.js");
  const { serverEvents } = await import("../events/ServerEvents.js");
  const { serverBroadcast, setDefaultServerResolver } = await import("../ws/wsHub.js");
  const { PlaylistManager } = await import("../launcher/PlaylistManager.js");
  const { join } = await import("node:path");
  const world = new FakeWorld();
  mocks.world = world;
  const registry = new actual.ServerRegistry({
    configDir: mocks.configDir,
    settings: () => mocks.config as never,
    sessions: sessionManager,
    bus: serverEvents,
    broadcast: serverBroadcast,
    legacyPlaylist: new PlaylistManager(mocks.configDir),
    env: {},
    saveAutostartSetting: async (profileId) => {
      mocks.config.autostart = { profileId };
    },
    tempBase: join(mocks.root, "tmp"),
    createProcess: (id, events) => world.process(id, events),
    createConnection: () => world.connect(),
    host: world.host(),
    timing: { rotationAnnounceMs: 0 },
  });
  setDefaultServerResolver(() => registry.defaultServerId());
  return { ...actual, serverRegistry: registry };
});

const { launcherRoutes } = await import("./launcher.js");
const { serversRoutes } = await import("./servers.js");
const { playlistRoutes } = await import("./playlists.js");
const { commandRoutes } = await import("./command.js");
const { serverRegistry } = await import("../servers/ServerRegistry.js");
const { startConsoleEvents } = await import("../events/consoleEventHub.js");
const { serverEvents } = await import("../events/ServerEvents.js");

const PROFILES = [
  { id: "p-anarchy", name: "Anarchy", configFile: "anarchy.cfg", consolePort: 2701, launchOptions: { gamePort: 2092 } },
  { id: "p-ctf", name: "CTF", configFile: "ctf.cfg", consolePort: 2702, launchOptions: { gamePort: 2093 } },
  { id: "p-coop", name: "Co-op", configFile: "coop.cfg", consolePort: 2703, launchOptions: { gamePort: 2094 } },
  { id: "p-clash", name: "Clash", configFile: "clash.cfg", consolePort: 2704, launchOptions: { gamePort: 2092 } },
];
const [A, B, C, D] = PROFILES;

let app: FastifyInstance;
const realSetImmediate = setImmediate;

async function settle(cond: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 4_000;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((r) => realSetImmediate(r));
  }
}

const world = () => mocks.world!;
const inject = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, ...(payload ? { payload } : {}) });

async function startAndLogIn(id: string): Promise<void> {
  const res = await inject("POST", `/api/servers/${id}/start`);
  expect(res.statusCode).toBe(200);
  world().processes.get(id)!.consoleUp();
  await settle(() => serverRegistry.get(id)?.consoleSession()?.state === "ready", `${id}'s console login`);
}

beforeAll(async () => {
  for (const p of PROFILES) {
    await fs.writeFile(
      path.join(mocks.gamePath, p.configFile),
      [
        "GameName=Test",
        "MissionName=alpha.mn3",
        "Scriptname=anarchy.d3m",
        "MaxPlayers=8",
        "ConsolePassword=secret",
        `RemoteConsolePort=${p.consolePort}`,
        "",
      ].join("\n"),
    );
  }
  for (const m of ["alpha.mn3", "beta.mn3"]) await fs.writeFile(path.join(mocks.gamePath, "missions", m), "");
  await fs.writeFile(
    path.join(mocks.configDir, "profiles.json"),
    JSON.stringify(
      PROFILES.map((p) => ({
        id: p.id,
        name: p.name,
        configFile: p.configFile,
        launchOptions: p.launchOptions,
        createdAt: "2026-11-01T00:00:00.000Z",
      })),
    ),
  );
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  startConsoleEvents();
  app = Fastify({ logger: false });
  await app.register(fastifyWebSocket);
  await app.register(launcherRoutes);
  await app.register(serversRoutes);
  await app.register(playlistRoutes);
  await app.register(commandRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
  if (mocks.previousConfigDir === undefined) delete process.env.PYRODECK_CONFIG_DIR;
  else process.env.PYRODECK_CONFIG_DIR = mocks.previousConfigDir;
  await fs.rm(mocks.root, { recursive: true, force: true });
});

/** A WebSocket's messages as they arrive. */
function collect(ws: WebSocket): { type: string; serverId?: string; payload?: Record<string, unknown> }[] {
  const got: { type: string; serverId?: string; payload?: Record<string, unknown> }[] = [];
  ws.on("message", (data: Buffer) => got.push(JSON.parse(data.toString())));
  return got;
}

describe("the servers API with several servers", () => {
  it("lists every profile's server, stopped, with its ports", async () => {
    const res = await inject("GET", "/api/servers");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.servers.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining([A.id, B.id, C.id, D.id]));
    expect(body.servers.some((s: { id: string }) => s.id === "launch")).toBe(false);
    const a = body.servers.find((s: { id: string }) => s.id === A.id);
    expect(a).toMatchObject({
      name: "Anarchy",
      kind: "profile",
      state: "stopped",
      console: "disconnected",
      mission: "alpha.mn3",
      gameType: "anarchy",
      maxPlayers: 8,
      playlist: null,
      ports: { game: 2092, gameSpy: 20142, console: 2701 },
    });
  });

  it("starts two servers side by side, and refuses a third on a port one of them holds", async () => {
    await startAndLogIn(A.id);
    await startAndLogIn(B.id);
    const clash = await inject("POST", `/api/servers/${D.id}/start`);
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toMatch(/Cannot start "Clash": game port 2092\/udp is used by "Anarchy"/);

    const list = (await inject("GET", "/api/servers")).json();
    const rows = Object.fromEntries(list.servers.map((s: { id: string }) => [s.id, s]));
    expect(rows[A.id]).toMatchObject({ state: "running", console: "ready", default: true, ports: { gameSpy: 20142 } });
    expect(rows[B.id]).toMatchObject({ state: "running", console: "ready", default: false, ports: { gameSpy: 20143 } });
    expect(rows[A.id].ports.tempDir).not.toBe(rows[B.id].ports.tempDir);
    expect(list.defaultServerId).toBe(A.id);
  });

  it("the flat routes: read the default server, refuse a change that names none, and act on a named one", async () => {
    const status = (await inject("GET", "/api/launcher/status")).json();
    expect(status).toMatchObject({ state: "running", activeProfileId: A.id });
    expect((await inject("GET", `/api/launcher/status?profileId=${B.id}`)).json()).toMatchObject({ activeProfileId: B.id });

    const stop = await inject("POST", "/api/launcher/stop", {});
    expect(stop.statusCode).toBe(409);
    expect(stop.json().error).toMatch(/2 servers are running \("Anarchy", "CTF"\); name one: POST \/api\/servers\/:serverId\/stop/);

    const start = await inject("POST", "/api/launcher/start", { profileId: C.id });
    expect(start.statusCode).toBe(409);
    expect(start.json().error).toBe(
      `Server is already running ("Anarchy"). To run another beside it, use POST /api/servers/${C.id}/start`,
    );
    expect(world().processes.get(C.id)?.launches ?? []).toHaveLength(0);
  });

  it("reads each console's joins as its own server's: the events never cross", async () => {
    const joins: string[] = [];
    const listener = (p: { profileId: string; name: string }) => joins.push(`${p.profileId} ${p.name}`);
    serverEvents.onEvent("player.joined", listener);
    try {
      world().consoleOf(B.id)!.print("*Pilot has joined CTF\n");
      world().consoleOf(A.id)!.print("*Gunner has joined the Anarchy\n");
      await settle(() => joins.length === 2, "both joins");
      expect(joins).toEqual([`${B.id} Pilot`, `${A.id} Gunner`]);
      expect(serverRegistry.get(B.id)!.supervisor.humansOnline()).toBe(1);
      expect(serverRegistry.get(A.id)!.supervisor.humansOnline()).toBe(1);
      expect(serverRegistry.get(C.id)!.supervisor.humansOnline()).toBeNull();
      world().consoleOf(B.id)!.print("*Pilot has left the game\n");
      await settle(() => serverRegistry.get(B.id)!.supervisor.humansOnline() === 0, "B's leave");
      expect(serverRegistry.get(A.id)!.supervisor.humansOnline()).toBe(1);
    } finally {
      serverEvents.offEvent("player.joined", listener);
    }
  });

  it("sends a console command to the server named, and only to it", async () => {
    const before = world().processes.get(A.id)!.sent.length;
    world().processes.get(B.id)!.humans = ["Pilot"];
    const res = await inject("POST", `/api/servers/${B.id}/command`, { command: "$players" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serverId: B.id, reply: expect.stringContaining("01: Pilot") });
    expect(world().processes.get(B.id)!.sent.at(-1)).toBe("$players");
    expect(world().processes.get(A.id)!.sent).toHaveLength(before);
    expect((await inject("POST", `/api/servers/${C.id}/command`, { command: "$players" })).statusCode).toBe(409);
    expect((await inject("POST", `/api/servers/${B.id}/command`, { command: "" })).statusCode).toBe(400);
  });

  it("activates a different playlist on each server; a flat deactivate naming none is refused", async () => {
    const one = (await inject("POST", "/api/playlists", { name: "One", entries: [{ label: "Alpha", missionName: "alpha.mn3" }] })).json();
    const two = (await inject("POST", "/api/playlists", { name: "Two", entries: [{ label: "Beta", missionName: "beta.mn3" }] })).json();

    const onA = await inject("POST", `/api/servers/${A.id}/playlist/activate`, { playlistId: one.id });
    expect(onA.statusCode).toBe(200);
    expect(onA.json()).toMatchObject({ ok: true, serverId: A.id, status: { status: "active", activePlaylistId: one.id } });
    expect((await inject("GET", `/api/servers/${B.id}/playlist`)).json()).toMatchObject({ status: "inactive" });
    // The flat route of a single-server Pyrodeck, naming the profile.
    const onB = await inject("POST", `/api/playlists/${two.id}/activate`, { profileId: B.id });
    expect(onB.json()).toMatchObject({ ok: true, status: { activePlaylistId: two.id } });
    expect((await inject("GET", `/api/servers/${A.id}/playlist`)).json()).toMatchObject({ activePlaylistId: one.id });

    const rows = (await inject("GET", "/api/servers")).json().servers;
    expect(rows.find((s: { id: string }) => s.id === A.id).playlist).toMatchObject({ name: "One", status: "active" });
    expect(rows.find((s: { id: string }) => s.id === B.id).playlist).toMatchObject({ name: "Two", status: "active" });

    expect((await inject("POST", "/api/playlists/deactivate", {})).statusCode).toBe(409);
    expect((await inject("POST", "/api/playlists/deactivate", { profileId: B.id })).statusCode).toBe(200);
    expect(serverRegistry.get(B.id)!.playlist.isActive()).toBe(false);
    expect(serverRegistry.get(A.id)!.playlist.isActive()).toBe(true);
    // With one active, the flat status and deactivate find it.
    expect((await inject("POST", `/api/servers/${A.id}/playlist/resume`)).statusCode).toBe(409);
  });

  it("answers 404 for an unknown server and 400 for a process action on Connect mode", async () => {
    expect((await inject("POST", "/api/servers/nope/start")).statusCode).toBe(404);
    expect((await inject("POST", "/api/servers/connect/start")).statusCode).toBe(400);
    expect((await inject("GET", "/api/servers/connect/status")).json()).toMatchObject({ serverId: "connect", console: "disconnected" });
    expect((await inject("POST", "/api/servers/saved/start")).statusCode).toBe(404);
  });

  it("the WebSocket: an old client gets the default server's messages only; hello { protocol: 2 } gets all, tagged", async () => {
    const old = await app.injectWS("/ws");
    const oldGot = collect(old);
    const fresh = await app.injectWS("/ws");
    const freshGot = collect(fresh);
    fresh.send(JSON.stringify({ type: "hello", payload: { protocol: 2 } }));
    await settle(() => freshGot.some((m) => m.type === "hello"), "the hello reply");
    expect(freshGot.find((m) => m.type === "hello")?.payload).toMatchObject({ protocol: 2, defaultServerId: A.id });
    // Greeted for each server it can see.
    await settle(() => freshGot.filter((m) => m.type === "connection_state" && m.serverId).length >= 2, "the per-server greeting");

    world().processes.get(B.id)!.print("B line\n");
    world().processes.get(A.id)!.print("A line\n");
    await settle(() => freshGot.filter((m) => m.type === "process_output").length >= 2, "both servers' output");
    await settle(() => oldGot.some((m) => m.type === "process_output"), "the default server's output");
    await new Promise((r) => setTimeout(r, 150));

    const oldOutput = oldGot.filter((m) => m.type === "process_output");
    expect(oldOutput.map((m) => m.payload?.data)).toEqual(["A line\n"]);
    expect(oldOutput[0]).not.toHaveProperty("serverId");
    expect(
      freshGot.filter((m) => m.type === "process_output").map((m) => `${m.serverId} ${String(m.payload?.data).trim()}`).sort(),
    ).toEqual([`${A.id} A line`, `${B.id} B line`]);

    // A command names its server on protocol 2, and goes to the default server's console otherwise.
    fresh.send(JSON.stringify({ type: "command", payload: { command: "$scores", serverId: B.id } }));
    old.send(JSON.stringify({ type: "command", payload: { command: "$scores", serverId: B.id } }));
    await settle(
      () =>
        world().processes.get(B.id)!.sent.includes("$scores") && world().processes.get(A.id)!.sent.includes("$scores"),
      "both commands",
    );
    old.terminate();
    fresh.terminate();
  });

  it("stops a named server through the flat route, then the only one left without a name", async () => {
    const first = await inject("POST", "/api/launcher/stop", { profileId: A.id });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, status: { state: "stopped" } });
    const second = await inject("POST", "/api/launcher/stop", {});
    expect(second.statusCode).toBe(200);
    expect(serverRegistry.running()).toHaveLength(0);
    expect((await inject("POST", `/api/servers/${A.id}/stop`)).json()).toMatchObject({ error: "Server is not running" });
  });
});
