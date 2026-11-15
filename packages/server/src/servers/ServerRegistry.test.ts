import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServerRegistry, type RegistrySettings } from "./ServerRegistry.js";
import { ServerEvents } from "../events/ServerEvents.js";
import { SessionManager } from "../session/SessionManager.js";
import { PlaylistManager } from "../launcher/PlaylistManager.js";
import { RotationHealthMonitor } from "../launcher/RotationHealthMonitor.js";
import { DEFAULT_SUPERVISOR_SETTINGS, type SupervisorSettings } from "../launcher/supervisorSettings.js";
import { RUN_RECORD_FILE, type RunRecord } from "../launcher/runRecord.js";
import { sayToAll } from "../players/playerActions.js";
import { FakeWorld } from "./testing/fakeGames.js";

/**
 * Several servers on one Pyrodeck: one registry, one bus, stand-in game
 * processes and consoles (testing/fakeGames.ts). Each server must launch,
 * log in, crash, relaunch, rotate and restart-when-empty on its own, with
 * commands and events never crossing to another; launches that would share
 * a port or a file are refused. Timers are fake; profiles, configs and run
 * records are real files in a temp directory.
 */

const realSetImmediate = setImmediate;

async function settle(cond: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 4_000;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((r) => realSetImmediate(r));
  }
}

/** As settle, moving the fake clock on 1 ms a turn: for waits on short timers (a 0 ms announce pause, a deferred event). */
async function settleTicking(cond: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 4_000;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((r) => realSetImmediate(r));
    await vi.advanceTimersByTimeAsync(1);
  }
}

interface ProfileSpec {
  id: string;
  name: string;
  cfg: string;
  consolePort: number;
  launchOptions?: Record<string, unknown>;
  startupFile?: string;
  lastLaunchedAt?: string;
}

const A: ProfileSpec = { id: "p-anarchy", name: "Anarchy", cfg: "anarchy.cfg", consolePort: 2601, launchOptions: { gamePort: 2092 } };
const B: ProfileSpec = { id: "p-ctf", name: "CTF", cfg: "ctf.cfg", consolePort: 2602, launchOptions: { gamePort: 2093 } };
const C: ProfileSpec = { id: "p-coop", name: "Co-op", cfg: "coop.cfg", consolePort: 2603, launchOptions: { gamePort: 2094 } };

function cfgText(consolePort: number): string {
  return [
    "GameName=Test",
    "MissionName=alpha.mn3",
    "Scriptname=anarchy.d3m",
    "MaxPlayers=8",
    "ConsolePassword=secret",
    `RemoteConsolePort=${consolePort}`,
    "AllowRemoteConsole=0",
    "",
  ].join("\n");
}

interface Harness {
  root: string;
  configDir: string;
  gamePath: string;
  world: FakeWorld;
  bus: ServerEvents;
  sessions: SessionManager;
  settings: RegistrySettings;
  registry: ServerRegistry;
  broadcasts: { serverId: string; type: string; payload: Record<string, unknown> }[];
  events: string[];
}

const harnesses: Harness[] = [];

interface SetUpOptions {
  profiles?: ProfileSpec[];
  supervisor?: Partial<SupervisorSettings>;
  env?: Record<string, string>;
  /** Reuse a config directory and world (a Pyrodeck restart). */
  from?: Harness;
  autostartProfileId?: string | null;
}

async function setUp(opts: SetUpOptions = {}): Promise<Harness> {
  const from = opts.from;
  const root = from?.root ?? (await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-registry-")));
  const configDir = path.join(root, "config");
  const gamePath = path.join(root, "game");
  if (!from) {
    const profiles = opts.profiles ?? [A, B, C];
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(path.join(gamePath, "missions"), { recursive: true });
    for (const m of ["alpha.mn3", "beta.mn3"]) await fs.writeFile(path.join(gamePath, "missions", m), "");
    for (const p of profiles) await fs.writeFile(path.join(gamePath, p.cfg), cfgText(p.consolePort));
    await fs.writeFile(
      path.join(configDir, "profiles.json"),
      JSON.stringify(
        profiles.map((p) => ({
          id: p.id,
          name: p.name,
          configFile: p.cfg,
          createdAt: "2026-11-01T00:00:00.000Z",
          ...(p.launchOptions ? { launchOptions: p.launchOptions } : {}),
          ...(p.startupFile ? { startupFile: p.startupFile } : {}),
          ...(p.lastLaunchedAt ? { lastLaunchedAt: p.lastLaunchedAt } : {}),
        })),
      ),
    );
  }
  const world = from?.world ?? new FakeWorld();
  const bus = new ServerEvents();
  const events: string[] = [];
  for (const name of ["server.started", "server.stopped", "server.crashed", "server.adopted", "player.joined"] as const) {
    bus.on(name, (p: { profileId: string; reason?: string }) => events.push(`${p.profileId} ${name}${p.reason ? ` ${p.reason}` : ""}`));
  }
  const sessions = new SessionManager();
  const settings: RegistrySettings = {
    gamePath,
    executablePath: path.join(gamePath, "Descent3"),
    logDir: path.join(root, "logs"),
    autostart: { profileId: opts.autostartProfileId ?? from?.settings.autostart.profileId ?? null },
    supervisor: { ...DEFAULT_SUPERVISOR_SETTINGS, ...opts.supervisor },
  };
  const broadcasts: Harness["broadcasts"] = [];
  const registry = new ServerRegistry({
    configDir,
    settings: () => settings,
    sessions,
    bus,
    broadcast: (serverId, type, payload) => broadcasts.push({ serverId, type, payload }),
    legacyPlaylist: new PlaylistManager(configDir),
    legacyRotationHealth: new RotationHealthMonitor(),
    env: opts.env ?? {},
    saveAutostartSetting: async (profileId) => {
      settings.autostart = { profileId };
    },
    tempBase: path.join(root, "tmp"),
    createProcess: (id, events) => world.process(id, events),
    createConnection: () => world.connect(),
    host: world.host(),
    supervisor: { emptyCheckMs: 1_000 },
    timing: { rotationAnnounceMs: 0 },
  });
  await registry.init();
  registry.applySupervisorSettings(settings.supervisor);
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  const h: Harness = { root, configDir, gamePath, world, bus, sessions, settings, registry, broadcasts, events };
  harnesses.push(h);
  return h;
}

const readyCount = (h: Harness, id: string) =>
  h.broadcasts.filter((b) => b.serverId === id && b.type === "connection_state" && b.payload.state === "ready").length;

async function launchAndLogIn(h: Harness, id: string): Promise<void> {
  const server = h.registry.get(id)!;
  const before = readyCount(h, id);
  const result = await server.start({ reason: "manual" });
  expect(result).toMatchObject({ ok: true });
  h.world.processes.get(id)!.consoleUp();
  await settle(() => readyCount(h, id) > before, `${id}'s console login`);
}

const proc = (h: Harness, id: string) => h.world.processes.get(id)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(async () => {
  const roots = new Set<string>();
  for (const h of harnesses.splice(0)) {
    h.registry.dispose();
    roots.add(h.root);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

describe("ServerRegistry: servers side by side", () => {
  it("has a server per profile and one without, and launches two that each log in to their own console", async () => {
    const h = await setUp();
    expect(h.registry.list().map((s) => s.id).sort()).toEqual(["launch", A.id, C.id, B.id].sort());

    await launchAndLogIn(h, A.id);
    await launchAndLogIn(h, B.id);

    const a = h.registry.get(A.id)!;
    const b = h.registry.get(B.id)!;
    expect(a.consoleSession()?.owner).toBe(A.id);
    expect(b.consoleSession()?.owner).toBe(B.id);
    expect(a.consoleSession()?.id).not.toBe(b.consoleSession()?.id);
    expect(h.sessions.list()).toHaveLength(2);
    // Each console was asked by its own server only.
    expect(proc(h, A.id).sent).toEqual(["$servercaps", "$players"]);
    expect(proc(h, B.id).sent).toEqual(["$servercaps", "$players"]);
    expect(proc(h, A.id).launches[0]).toMatchObject({ configFile: A.cfg, telnetPort: A.consolePort, profileId: A.id });
    expect(proc(h, B.id).launches[0]).toMatchObject({ configFile: B.cfg, telnetPort: B.consolePort, profileId: B.id });
    // Each server's own run record.
    await settle(() => existsSync(path.join(h.configDir, "servers", A.id, "run.json")), "A's run record");
    await settle(() => existsSync(path.join(h.configDir, "servers", B.id, "run.json")), "B's run record");
    expect(h.registry.running().map((s) => s.id)).toEqual([A.id, B.id]);
    // Broadcasts are tagged with the server they are about.
    expect(h.broadcasts.filter((m) => m.type === "process_state").map((m) => `${m.serverId} ${m.payload.state}`)).toEqual([
      `${A.id} starting`,
      `${A.id} running`,
      `${B.id} starting`,
      `${B.id} running`,
    ]);
  });

  it("three servers get three temp directories and, when none sets one, three GameSpy ports", async () => {
    const h = await setUp();
    for (const p of [A, B, C]) await launchAndLogIn(h, p.id);
    const launches = [A, B, C].map((p) => proc(h, p.id).launches[0]);
    const tempDirs = launches.map((l) => l.defaultOptions?.tempDir);
    expect(new Set(tempDirs).size).toBe(3);
    for (const dir of tempDirs) {
      expect(dir!.startsWith(path.join(h.root, "tmp", "pyrodeck-"))).toBe(true);
      expect(Buffer.byteLength(dir!)).toBeLessThanOrEqual(99);
    }
    expect(launches.map((l) => l.defaultOptions?.gameSpyPort)).toEqual([undefined, 20143, 20144]);
    // Stable per server: the same directory at the next launch.
    expect(h.registry.defaultTempDir(A.id)).toBe(tempDirs[0]);
  });

  it("a crash of one server is relaunched by its own supervisor; the others are not touched", async () => {
    const h = await setUp();
    await launchAndLogIn(h, A.id);
    await launchAndLogIn(h, B.id);
    const bSession = h.registry.get(B.id)!.consoleSession()?.id;

    proc(h, A.id).exit(null, "SIGSEGV");
    expect(h.registry.get(A.id)!.supervisor.snapshot().pendingRelaunch).toMatchObject({ cause: "crash" });
    expect(h.registry.get(B.id)!.supervisor.snapshot().pendingRelaunch).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(() => proc(h, A.id).launches.length === 2, "A's relaunch");
    expect(proc(h, A.id).launches[1]).toMatchObject({ configFile: A.cfg, profileId: A.id });

    expect(proc(h, B.id).launches).toHaveLength(1);
    expect(h.registry.get(B.id)!.consoleSession()?.id).toBe(bSession);
    expect(h.events.filter((e) => e.startsWith(B.id))).toEqual([`${B.id} server.started manual`]);
  });

  it("a human on one server does not hold back another's restart when empty", async () => {
    const h = await setUp({ supervisor: { emptyRestart: true, emptyRestartAfterHours: 0.1, emptyRestartGraceSec: 0 } });
    await launchAndLogIn(h, A.id);
    await launchAndLogIn(h, B.id);
    proc(h, A.id).humans = ["Pilot"];
    h.bus.emitEvent("player.joined", { profileId: A.id, name: "Pilot", bot: false });
    expect(h.registry.get(A.id)!.supervisor.humansOnline()).toBe(1);
    expect(h.registry.get(B.id)!.supervisor.humansOnline()).toBe(0);

    await vi.advanceTimersByTimeAsync(6 * 60_000 + 2_000);
    await settle(() => h.events.includes(`${B.id} server.stopped empty-restart`), "B's restart when empty");
    await settle(() => proc(h, B.id).launches.length === 2, "B's relaunch");
    expect(h.events).not.toContain(`${A.id} server.stopped empty-restart`);
    expect(proc(h, A.id).launches).toHaveLength(1);
  });

  it("two rotations at the same moment restart each server on its own profile", async () => {
    const h = await setUp();
    const library = h.registry.get(A.id)!.playlist;
    const one = await library.create("One", "sequential", [
      { label: "Alpha", missionName: "alpha.mn3" },
      { label: "Beta", missionName: "beta.mn3" },
    ]);
    const two = await library.create("Two", "sequential", [
      { label: "Beta", missionName: "beta.mn3" },
      { label: "Alpha", missionName: "alpha.mn3" },
    ]);
    for (const pl of [one, two]) await library.update(pl.id, { holdSeconds: 0 });
    await h.registry.get(A.id)!.playlist.activate(one.id);
    await h.registry.get(B.id)!.playlist.activate(two.id);
    await launchAndLogIn(h, A.id);
    await launchAndLogIn(h, B.id);
    const mission = async (cfg: string) => /^MissionName=(.*)$/m.exec(await fs.readFile(path.join(h.gamePath, cfg), "utf-8"))?.[1];
    expect(await mission(A.cfg)).toBe("alpha.mn3");
    expect(await mission(B.cfg)).toBe("beta.mn3");

    for (const id of [A.id, B.id]) {
      proc(h, id).print("Ending level.\n");
      proc(h, id).print("Mission over.  Looping back to first level...\n");
    }
    await settleTicking(() => proc(h, A.id).launches.length === 2 && proc(h, B.id).launches.length === 2, "both relaunches");

    expect(await mission(A.cfg)).toBe("beta.mn3");
    expect(await mission(B.cfg)).toBe("alpha.mn3");
    expect(proc(h, A.id).launches[1]).toMatchObject({ configFile: A.cfg, profileId: A.id, telnetPort: A.consolePort });
    expect(proc(h, B.id).launches[1]).toMatchObject({ configFile: B.cfg, profileId: B.id, telnetPort: B.consolePort });
    // Each announcement went to its own server.
    expect(proc(h, A.id).sent).toContain(sayToAll("Changing mission to Beta"));
    expect(proc(h, B.id).sent).toContain(sayToAll("Changing mission to Alpha"));
    expect(proc(h, A.id).sent).not.toContain(sayToAll("Changing mission to Alpha"));

    proc(h, A.id).consoleUp();
    proc(h, B.id).consoleUp();
    await settleTicking(
      () => h.registry.get(A.id)!.playlist.getStatus().status === "active" && h.registry.get(B.id)!.playlist.getStatus().status === "active",
      "both healthy restarts",
    );
    expect(h.registry.get(A.id)!.playlist.getStatus().activePlaylistId).toBe(one.id);
    expect(h.registry.get(B.id)!.playlist.getStatus().activePlaylistId).toBe(two.id);
  });

  it("keeps each server's playlist state in its own file; the legacy owner keeps playlist-state.json", async () => {
    const h = await setUp({ profiles: [{ ...A, lastLaunchedAt: "2026-11-01T00:00:00.000Z" }, B] });
    expect(h.registry.legacyOwner()).toBe(A.id);
    const library = h.registry.get(A.id)!.playlist;
    const pl = await library.create("One", "sequential", [{ label: "Alpha", missionName: "alpha.mn3" }]);
    await h.registry.get(A.id)!.playlist.activate(pl.id);
    await h.registry.get(B.id)!.playlist.activate(pl.id);
    const legacy = JSON.parse(await fs.readFile(path.join(h.configDir, "playlist-state.json"), "utf-8"));
    const own = JSON.parse(await fs.readFile(path.join(h.configDir, "servers", B.id, "playlist-state.json"), "utf-8"));
    expect(legacy.activePlaylistId).toBe(pl.id);
    expect(own.activePlaylistId).toBe(pl.id);
    h.registry.get(A.id)!.playlist.deactivate();
    expect(h.registry.get(B.id)!.playlist.isActive()).toBe(true);
  });
});

describe("ServerRegistry: launch conflicts", () => {
  it("refuses a second server on the same game port, console port, config file or Startup Commands file", async () => {
    const h = await setUp({
      profiles: [
        A,
        { id: "p-port", name: "Same port", cfg: "port.cfg", consolePort: 2610, launchOptions: { gamePort: 2092 } },
        { id: "p-console", name: "Same console", cfg: "console.cfg", consolePort: A.consolePort, launchOptions: { gamePort: 2120 } },
        { id: "p-startup", name: "Same startup", cfg: "startup.cfg", consolePort: 2611, launchOptions: { gamePort: 2121 } },
        { id: "p-own", name: "Own startup", cfg: "own.cfg", consolePort: 2612, launchOptions: { gamePort: 2122 }, startupFile: "own.dmfc" },
      ],
    });
    await fs.writeFile(path.join(h.gamePath, "autoexec.dmfc"), "$scorelimit 20\n");
    await launchAndLogIn(h, A.id);

    const port = await h.registry.get("p-port")!.start({ reason: "manual" });
    expect(port).toMatchObject({ ok: false, code: 409 });
    expect(!port.ok && port.error).toMatch(/game port 2092\/udp is used by "Anarchy" \(running, PID \d+\)/);

    const consolePort = await h.registry.get("p-console")!.start({ reason: "manual" });
    expect(!consolePort.ok && consolePort.error).toMatch(/console port 2601\/tcp is used by "Anarchy"/);

    const startup = await h.registry.get("p-startup")!.start({ reason: "manual" });
    expect(!startup.ok && startup.error).toMatch(/Startup Commands file .*autoexec\.dmfc is also used by "Anarchy"/);

    // Its own Startup Commands file: it starts.
    const own = await h.registry.get("p-own")!.start({ reason: "manual" });
    expect(own).toMatchObject({ ok: true });
    expect(proc(h, "p-own").launches[0]).toMatchObject({ startupFile: "own.dmfc" });

    // Nothing was spawned for the refused ones.
    for (const id of ["p-port", "p-console", "p-startup"]) expect(h.world.processes.get(id)!.launches).toHaveLength(0);
  });

  it("refuses the same config file, a GameSpy port the operator set, and a temp directory the operator set", async () => {
    const h = await setUp({
      profiles: [
        { ...A, launchOptions: { gamePort: 2092, gameSpyPort: 20200, tempDir: "/tmp/d3-a" } },
        { id: "p-copy", name: "Same cfg", cfg: A.cfg, consolePort: A.consolePort, launchOptions: { gamePort: 2130 } },
        { id: "p-gs", name: "Same GameSpy", cfg: "gs.cfg", consolePort: 2620, launchOptions: { gamePort: 2131, gameSpyPort: 20200 } },
        { id: "p-tmp", name: "Same temp", cfg: "tmp.cfg", consolePort: 2621, launchOptions: { gamePort: 2132, tempDir: "/tmp/d3-a" } },
      ],
    });
    await launchAndLogIn(h, A.id);
    const copy = await h.registry.get("p-copy")!.start({ reason: "manual" });
    expect(!copy.ok && copy.error).toMatch(/its server config .*anarchy\.cfg is the one "Anarchy"/);
    const gs = await h.registry.get("p-gs")!.start({ reason: "manual" });
    expect(!gs.ok && gs.error).toMatch(/GameSpy port 20200\/udp is used by "Anarchy"/);
    const tmp = await h.registry.get("p-tmp")!.start({ reason: "manual" });
    expect(!tmp.ok && tmp.error).toMatch(/temp directory \/tmp\/d3-a is used by "Anarchy"/);
    // The operator's settings were not changed, and nothing else started.
    expect(proc(h, A.id).launches[0].defaultOptions ?? {}).not.toHaveProperty("tempDir");
    expect(h.registry.running().map((s) => s.id)).toEqual([A.id]);
  });

  it("different bind addresses share UDP ports; a playlist rotation keeps its ports while it restarts", async () => {
    const h = await setUp({
      profiles: [
        { ...A, launchOptions: { gamePort: 2092, bindIp: "10.0.0.1" } },
        { ...B, launchOptions: { gamePort: 2092, bindIp: "10.0.0.2" } },
        { ...C, launchOptions: { gamePort: 2092 } },
      ],
    });
    await launchAndLogIn(h, A.id);
    await launchAndLogIn(h, B.id);
    // B shares A's game port on another address, and GameSpy's default too.
    expect(proc(h, B.id).launches[0].defaultOptions?.gameSpyPort).toBeUndefined();
    // C binds every address: it clashes with both.
    const c = await h.registry.get(C.id)!.start({ reason: "manual" });
    expect(!c.ok && c.error).toMatch(/game port 2092\/udp is used by "Anarchy"/);
  });

  it("a launch refused for a conflict leaves nothing reserved, and the same launch passes once the other stops", async () => {
    const h = await setUp({ profiles: [A, { ...B, launchOptions: { gamePort: 2092 } }] });
    await launchAndLogIn(h, A.id);
    expect((await h.registry.get(B.id)!.start({ reason: "manual" })).ok).toBe(false);
    await h.registry.get(A.id)!.stop("manual");
    expect((await h.registry.get(B.id)!.start({ reason: "manual" })).ok).toBe(true);
  });

  it("two launches at the same moment: the launch lock lets one through and refuses the other", async () => {
    const h = await setUp({ profiles: [A, { ...B, launchOptions: { gamePort: 2092 } }] });
    const [a, b] = await Promise.all([
      h.registry.get(A.id)!.start({ reason: "manual" }),
      h.registry.get(B.id)!.start({ reason: "manual" }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
  });

  it("removes a stale lock from the server's temp directory before it launches", async () => {
    const h = await setUp();
    const dir = h.registry.defaultTempDir(A.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ".lock"), "LOCK....");
    await launchAndLogIn(h, A.id);
    expect(existsSync(path.join(dir, ".lock"))).toBe(false);
  });

  it("gives two servers of one name launched in the same second their own log files", async () => {
    const h = await setUp({ profiles: [A, { ...B, name: A.name }] });
    await launchAndLogIn(h, A.id);
    await launchAndLogIn(h, B.id);
    const logs = [proc(h, A.id).launches[0].logPath, proc(h, B.id).launches[0].logPath];
    expect(logs[0]).not.toBe(logs[1]);
    expect(logs[1]).toMatch(/anarchy-.*-2\.log$/);
    expect(existsSync(logs[1]!)).toBe(true);
  });
});

describe("ServerRegistry: the default server", () => {
  it("is the only one running, stays the first while several run, and stays the last one when none does", async () => {
    const h = await setUp();
    expect(h.registry.defaultServerId()).toBe("launch");
    await launchAndLogIn(h, B.id);
    expect(h.registry.defaultServerId()).toBe(B.id);
    await launchAndLogIn(h, A.id);
    expect(h.registry.defaultServerId()).toBe(B.id);
    await h.registry.get(B.id)!.stop("manual");
    expect(h.registry.defaultServerId()).toBe(A.id);
    await h.registry.get(A.id)!.stop("manual");
    expect(h.registry.defaultServerId()).toBe(A.id);
  });

  it("aliases: the named server, else the only one running; a change with several running is refused", async () => {
    const h = await setUp();
    await launchAndLogIn(h, A.id);
    expect(await h.registry.resolveAlias(undefined, { changing: true, route: "X" })).toMatchObject({ server: { id: A.id } });
    await launchAndLogIn(h, B.id);
    const refused = await h.registry.resolveAlias(undefined, { changing: true, route: "POST /api/servers/:serverId/stop" });
    expect(refused).toMatchObject({ code: 409 });
    expect("error" in refused && refused.error).toMatch(/2 servers are running .*; name one: POST \/api\/servers\/:serverId\/stop/);
    expect(await h.registry.resolveAlias(B.id, { changing: true, route: "X" })).toMatchObject({ server: { id: B.id } });
    expect(await h.registry.resolveAlias(undefined, { changing: false, route: "" })).toMatchObject({ server: { id: A.id } });
    expect(await h.registry.resolveAlias("nope", { changing: true, route: "" })).toMatchObject({ code: 404 });
  });
});

describe("ServerRegistry: restart of Pyrodeck", () => {
  it("re-attaches to several games still running, each to its own console, and keeps running-server.json for one", async () => {
    const first = await setUp();
    await launchAndLogIn(first, A.id);
    await launchAndLogIn(first, B.id);
    await settle(() => existsSync(path.join(first.configDir, "servers", B.id, "run.json")), "B's run record");
    await first.registry.legacyRecordSettled();
    const pids = [A.id, B.id].map((id) => proc(first, id).getStatus().pid!);
    for (const pid of pids) first.world.alive.set(pid, { executable: path.join(first.gamePath, "Descent3") });
    const legacy = JSON.parse(await fs.readFile(path.join(first.configDir, RUN_RECORD_FILE), "utf-8")) as RunRecord;
    expect(legacy).toMatchObject({ version: 1, pid: pids[0], profileId: A.id });
    first.registry.dispose();

    // Pyrodeck restarts: the games keep running; new stand-in process objects re-attach to them.
    const world = first.world;
    world.processes.clear();
    world.listening.clear();
    const h = await setUp({ from: first });
    // The consoles still answer.
    await h.registry.reattachAll();
    for (const [i, id] of [A.id, B.id].entries()) {
      expect(proc(h, id).getStatus()).toMatchObject({ state: "running", adopted: true, pid: pids[i] });
    }
    await settleTicking(() => readyCount(h, A.id) === 1 && readyCount(h, B.id) === 1, "both console logins");
    expect(h.registry.get(A.id)!.consoleSession()?.connectionInfo.port).toBe(A.consolePort);
    expect(h.registry.get(B.id)!.consoleSession()?.connectionInfo.port).toBe(B.consolePort);
    expect(h.registry.get(C.id)!.process.getStatus().state).toBe("stopped");
  });

  it("re-attaches from an older Pyrodeck's running-server.json into its profile's server", async () => {
    const h0 = await setUp({ profiles: [A, B] });
    h0.registry.dispose();
    await fs.rm(path.join(h0.configDir, "servers.json"));
    const pid = 9100;
    h0.world.alive.set(pid, { executable: path.join(h0.gamePath, "Descent3") });
    const record: RunRecord = {
      version: 1,
      pid,
      profileId: B.id,
      executablePath: path.join(h0.gamePath, "Descent3"),
      gamePath: h0.gamePath,
      configFile: B.cfg,
      args: ["-dedicated", `./${B.cfg}`],
      logPath: null,
      telnetPort: B.consolePort,
      launchOptions: { gamePort: 2093 },
      allowRemoteConsole: false,
      startedAt: new Date().toISOString(),
      linux: { startTicks: `ticks-${pid}`, bootId: "boot-1" },
    };
    await fs.writeFile(path.join(h0.configDir, RUN_RECORD_FILE), JSON.stringify(record));
    const h = await setUp({ from: h0 });
    expect(h.registry.legacyOwner()).toBe(B.id);
    await h.registry.reattachAll();
    expect(proc(h, B.id).getStatus()).toMatchObject({ state: "running", adopted: true, pid });
    await settle(() => existsSync(path.join(h.configDir, "servers", B.id, "run.json")), "B's own run record");
    const own = JSON.parse(await fs.readFile(path.join(h.configDir, "servers", B.id, "run.json"), "utf-8"));
    expect(own).toMatchObject({ pid, serverId: B.id, profileId: B.id });
  });

  it("starts every profile on the autostart list, each with its own guard", async () => {
    const h = await setUp({ autostartProfileId: A.id });
    await h.registry.setAutostart(C.id, true);
    expect(h.settings.autostart.profileId).toBe(A.id);
    await h.registry.runAutostart();
    await settle(() => proc(h, A.id).launches.length === 1 && proc(h, C.id).launches.length === 1, "both autostarts");
    expect(proc(h, B.id).launches).toHaveLength(0);
    expect(h.registry.get(A.id)!.autostart.snapshot()).toMatchObject({ state: "watching", profileId: A.id });
    expect(h.registry.get(C.id)!.autostart.snapshot()).toMatchObject({ state: "watching", profileId: C.id });
    // A start of another server is not "someone else started the server" for these guards.
    await launchAndLogIn(h, B.id);
    expect(h.registry.get(A.id)!.autostart.snapshot().state).toBe("watching");
  });

  it("PYRODECK_AUTOSTART_PROFILES names several profiles; PYRODECK_AUTOSTART_PROFILE still names one, first", async () => {
    const h = await setUp({ env: { PYRODECK_AUTOSTART_PROFILE: "CTF", PYRODECK_AUTOSTART_PROFILES: "Co-op, nope" } });
    const plan = await h.registry.autostartPlan();
    expect(plan).toMatchObject({ source: "env", envNames: ["CTF", "Co-op", "nope"] });
    expect(plan.profiles.map((p) => p.id)).toEqual([B.id, C.id]);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]).toMatch(/names no profile: "nope"/);
  });
});
