import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SERVERS_FILE, readServerRunRecords, readServersFile, serverIdOfRecord, upgradeConfigDir } from "./serverStore.js";
import { RUN_RECORD_FILE, type RunRecord } from "../launcher/runRecord.js";

/**
 * The config directory of a Pyrodeck that ran one server, brought up to date
 * at the first start of one that runs several, and again after a downgrade.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-store-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const P1 = { id: "p1", lastLaunchedAt: "2026-11-01T10:00:00.000Z" };
const P2 = { id: "p2", lastLaunchedAt: "2026-11-02T10:00:00.000Z" };

function record(profileId: string | null, pid = 4242): RunRecord {
  return {
    version: 1,
    pid,
    profileId,
    executablePath: "/srv/d3/Descent3",
    gamePath: "/srv/d3",
    configFile: "ctf.cfg",
    args: ["-dedicated", "./ctf.cfg"],
    logPath: null,
    telnetPort: 2600,
    startedAt: "2026-11-02T10:00:00.000Z",
  };
}

describe("upgradeConfigDir", () => {
  it("fresh: an empty servers/index.json, the server without a profile keeps the legacy playlist state", async () => {
    const result = await upgradeConfigDir({ configDir: dir, profiles: [], autostartProfileId: null });
    expect(result).toMatchObject({ created: true, legacyRecord: null });
    expect(await readServersFile(dir)).toEqual({ version: 1, autostart: [], legacyOwner: "launch" });
  });

  it("0.5.x idle: the autostart profile owns the legacy state and heads the autostart list", async () => {
    await fs.writeFile(path.join(dir, "playlist-state.json"), JSON.stringify({ activePlaylistId: "pl", currentIndex: 1 }));
    const result = await upgradeConfigDir({ configDir: dir, profiles: [P1, P2], autostartProfileId: "p1" });
    expect(result.file).toEqual({ version: 1, autostart: ["p1"], legacyOwner: "p1" });
    // Nothing else is moved or rewritten.
    expect(JSON.parse(await fs.readFile(path.join(dir, "playlist-state.json"), "utf-8"))).toEqual({ activePlaylistId: "pl", currentIndex: 1 });
    expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(["playlist-state.json", "servers"]));
    expect(await fs.readdir(path.join(dir, "servers"))).toEqual(["index.json"]);
  });

  it("0.5.x idle without autostart: the most recently launched profile, else the only one, owns it", async () => {
    expect((await upgradeConfigDir({ configDir: dir, profiles: [P1, P2], autostartProfileId: null })).file.legacyOwner).toBe("p2");
    await fs.rm(path.join(dir, SERVERS_FILE));
    expect((await upgradeConfigDir({ configDir: dir, profiles: [{ id: "only" }], autostartProfileId: null })).file.legacyOwner).toBe("only");
  });

  it("0.5.x running with a playlist: the running server's profile owns the state and gets the record", async () => {
    await fs.writeFile(path.join(dir, RUN_RECORD_FILE), JSON.stringify(record("p1")));
    await fs.writeFile(path.join(dir, "playlist-state.json"), JSON.stringify({ activePlaylistId: "pl", currentIndex: 0 }));
    const result = await upgradeConfigDir({ configDir: dir, profiles: [P1, P2], autostartProfileId: "p2" });
    expect(result.file.legacyOwner).toBe("p1");
    expect(result.file.autostart).toEqual(["p2"]);
    expect(result.legacyRecord).toMatchObject({ pid: 4242, profileId: "p1" });
    expect(serverIdOfRecord(result.legacyRecord!)).toBe("p1");
    // running-server.json stays for a downgrade.
    expect(JSON.parse(await fs.readFile(path.join(dir, RUN_RECORD_FILE), "utf-8")).pid).toBe(4242);
  });

  it("running without a profile: the server without one owns the record", async () => {
    await fs.writeFile(path.join(dir, RUN_RECORD_FILE), JSON.stringify(record(null)));
    const result = await upgradeConfigDir({ configDir: dir, profiles: [P1], autostartProfileId: null });
    expect(result.file.legacyOwner).toBe("launch");
    expect(serverIdOfRecord(result.legacyRecord!)).toBe("launch");
  });

  it("is idempotent: a second start changes nothing", async () => {
    await upgradeConfigDir({ configDir: dir, profiles: [P1, P2], autostartProfileId: "p1" });
    const before = await fs.readFile(path.join(dir, SERVERS_FILE), "utf-8");
    const again = await upgradeConfigDir({ configDir: dir, profiles: [P1, P2], autostartProfileId: "p1" });
    expect(again).toMatchObject({ created: false, notes: [] });
    expect(await fs.readFile(path.join(dir, SERVERS_FILE), "utf-8")).toBe(before);
  });

  it("downgrade then upgrade: the older Pyrodeck's autostart choice and its running server are taken back", async () => {
    await upgradeConfigDir({ configDir: dir, profiles: [P1, P2], autostartProfileId: "p1" });
    await fs.writeFile(
      path.join(dir, SERVERS_FILE),
      JSON.stringify({ version: 1, autostart: ["p1", "p2"], legacyOwner: "p1" }),
    );
    // The downgraded Pyrodeck ticked p2 instead and launched it.
    await fs.writeFile(path.join(dir, RUN_RECORD_FILE), JSON.stringify(record("p2", 5151)));
    const result = await upgradeConfigDir({ configDir: dir, profiles: [P1, P2], autostartProfileId: "p2" });
    expect(result.created).toBe(false);
    expect(result.file).toEqual({ version: 1, autostart: ["p2", "p1"], legacyOwner: "p1" });
    expect(serverIdOfRecord(result.legacyRecord!)).toBe("p2");
    // And when it cleared the autostart profile, the first of the list goes.
    const cleared = await upgradeConfigDir({ configDir: dir, profiles: [P1, P2], autostartProfileId: null });
    expect(cleared.file.autostart).toEqual(["p1"]);
  });

  it("leaves Connect mode's saved servers (0.5.x servers.json) alone, and still runs the first start", async () => {
    const saved = JSON.stringify([{ id: "s1", name: "Public CTF", host: "203.0.113.5", port: 2092 }], null, 2);
    await fs.writeFile(path.join(dir, "servers.json"), saved);
    const result = await upgradeConfigDir({ configDir: dir, profiles: [P1, P2], autostartProfileId: "p1" });
    expect(result).toMatchObject({ created: true, file: { autostart: ["p1"], legacyOwner: "p1" } });
    expect(await fs.readFile(path.join(dir, "servers.json"), "utf-8")).toBe(saved);
  });

  it("moves a development build's store out of servers.json, once", async () => {
    await fs.writeFile(
      path.join(dir, "servers.json"),
      JSON.stringify({ version: 1, autostart: ["p2", "p1"], legacyOwner: "p1" }),
    );
    const result = await upgradeConfigDir({ configDir: dir, profiles: [P1, P2], autostartProfileId: "p2" });
    expect(result).toMatchObject({ created: false, file: { version: 1, autostart: ["p2", "p1"], legacyOwner: "p1" } });
    expect(result.notes[0]).toMatch(/moved/);
    await expect(fs.access(path.join(dir, "servers.json"))).rejects.toThrow();
    const again = await upgradeConfigDir({ configDir: dir, profiles: [P1, P2], autostartProfileId: "p2" });
    expect(again).toMatchObject({ created: false, notes: [] });
  });

  it("reads the run records of the server directories, not the index beside them", async () => {
    await upgradeConfigDir({ configDir: dir, profiles: [P1], autostartProfileId: null });
    await fs.mkdir(path.join(dir, "servers", "p1"), { recursive: true });
    await fs.writeFile(path.join(dir, "servers", "p1", "run.json"), JSON.stringify(record("p1")));
    expect([...(await readServerRunRecords(dir)).keys()]).toEqual(["p1"]);
  });

  it("takes the server id from a record that carries one", () => {
    expect(serverIdOfRecord({ ...record("p1"), serverId: "p1" })).toBe("p1");
  });
});
