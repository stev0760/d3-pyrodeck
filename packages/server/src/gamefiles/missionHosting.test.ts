import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKUP_SUFFIX, Mn3Error, readMn3Msn, readMsnUrls, setMissionUrl } from "./Mn3UrlRewriter.js";
import {
  decideHosting,
  hostDirError,
  hostMission,
  hostPlaylistEntries,
  playlistHostingTarget,
  playlistMissionsChanged,
  summarizeHosting,
  type MissionHostingResult,
} from "./missionHosting.js";

/** A one-level .mn3 (HOG2, cfile/hogfile.h) whose .msn offers `urls`. */
function buildMn3(stem: string, urls: string[]): Buffer {
  stem = stem.slice(0, 20); // entry names hold 36 bytes; the engine falls back to the only .msn
  const msn = [
    `NAME\t\t${stem}`,
    "NUMLEVELS\t1",
    ...urls.map((u) => `URL\t\t${u}`),
    "MULTI\t\tYES",
    "",
    "LEVEL\t\t1",
    `MINE\t\t${stem}.d3l`,
    "",
  ].join("\r\n");
  const files = [
    { name: `${stem}.d3l`, data: Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251)) },
    { name: `${stem}.msn`, data: Buffer.from(msn, "latin1") },
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

const BASE = "http://example.org:3002";
const hosted = (file: string, base = BASE) => `${base}/missions/${file}`;
const DEAD = "http://www.outrage.com/files/mission.zip";

describe("decideHosting", () => {
  const facts = { hostedUrl: hosted("a.mn3"), urls: [DEAD], hasBackup: false, formerUrls: [] };

  it("leaves a mission already pointing at the host alone", () => {
    expect(decideHosting({ ...facts, urls: [hosted("a.mn3")], hasBackup: true }, { keepCustom: true })).toBe("already");
    expect(decideHosting({ ...facts, urls: [hosted("a.mn3")] }, { keepCustom: false })).toBe("already");
  });

  it("rewrites the mission's original links", () => {
    expect(decideHosting(facts, { keepCustom: true })).toBe("rewrite");
    expect(decideHosting({ ...facts, urls: [] }, { keepCustom: true })).toBe("rewrite");
  });

  it("keeps a link Pyrodeck set by hand when asked to, and replaces it otherwise", () => {
    const custom = { ...facts, urls: ["http://files.example.net/a.zip"], hasBackup: true };
    expect(decideHosting(custom, { keepCustom: true })).toBe("custom");
    expect(decideHosting(custom, { keepCustom: false })).toBe("rewrite");
  });

  it("replaces a link the host set under a former public URL", () => {
    const old = hosted("a.mn3", "http://old.example.org");
    expect(decideHosting({ ...facts, urls: [old], hasBackup: true, formerUrls: [old] }, { keepCustom: true })).toBe(
      "rewrite",
    );
    expect(decideHosting({ ...facts, urls: [], hasBackup: true }, { keepCustom: true })).toBe("rewrite");
  });
});

describe("hostMission / hostPlaylistEntries", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-hosting-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = (file: string, urls: string[]) =>
    fs.writeFile(path.join(dir, file), buildMn3(file.replace(/\.mn3$/i, ""), urls));
  const linksOf = async (file: string) => readMsnUrls((await readMn3Msn(path.join(dir, file))).text);

  it("points the original links at the host once, keeping the original as the backup", async () => {
    await write("alpha.mn3", [DEAD]);
    const original = await fs.readFile(path.join(dir, "alpha.mn3"));

    const first = await hostMission(dir, "alpha.mn3", BASE, { keepCustom: true });
    expect(first).toMatchObject({ outcome: "hosted", url: hosted("alpha.mn3"), backupCreated: true, urlBackup: true });
    expect(await linksOf("alpha.mn3")).toEqual([hosted("alpha.mn3")]);
    expect(await fs.readFile(path.join(dir, "alpha.mn3" + BACKUP_SUFFIX))).toEqual(original);

    const rewritten = await fs.stat(path.join(dir, "alpha.mn3"));
    const second = await hostMission(dir, "alpha.mn3", BASE, { keepCustom: true });
    expect(second).toMatchObject({ outcome: "already", url: hosted("alpha.mn3"), urlBackup: true });
    expect((await fs.stat(path.join(dir, "alpha.mn3"))).mtimeMs).toBe(rewritten.mtimeMs);
  });

  it("writes no backup for a mission whose own link already is the hosted one", async () => {
    await write("beta.mn3", [hosted("beta.mn3")]);
    expect(await hostMission(dir, "beta.mn3", BASE, { keepCustom: true })).toMatchObject({
      outcome: "already",
      urlBackup: false,
    });
    expect(await fs.readdir(dir)).toEqual(["beta.mn3"]);
  });

  it("never touches a stock mission and reports a missing one", async () => {
    await write("Chaos.mn3", [DEAD]);
    const before = await fs.readFile(path.join(dir, "Chaos.mn3"));
    expect(await hostMission(dir, "Chaos.mn3", BASE, { keepCustom: false })).toEqual({
      file: "Chaos.mn3",
      outcome: "stock",
      message: "Chaos.mn3 ships with Descent 3; every player already has it.",
    });
    expect(await fs.readFile(path.join(dir, "Chaos.mn3"))).toEqual(before);
    expect(await fs.readdir(dir)).toEqual(["Chaos.mn3"]);
    expect(await hostMission(dir, "gone.mn3", BASE, { keepCustom: true })).toMatchObject({ outcome: "missing" });
  });

  it("keeps an operator's own link unless told to replace it", async () => {
    await write("gamma.mn3", [DEAD]);
    await setMissionUrl(path.join(dir, "gamma.mn3"), "http://files.example.net/gamma.zip");
    expect(await hostMission(dir, "gamma.mn3", BASE, { keepCustom: true })).toMatchObject({
      outcome: "custom",
      urls: ["http://files.example.net/gamma.zip"],
      message: "Keeps its own link: http://files.example.net/gamma.zip",
    });
    expect(await linksOf("gamma.mn3")).toEqual(["http://files.example.net/gamma.zip"]);
    expect(await hostMission(dir, "gamma.mn3", BASE, { keepCustom: false })).toMatchObject({
      outcome: "hosted",
      backupCreated: false,
    });
    expect(await linksOf("gamma.mn3")).toEqual([hosted("gamma.mn3")]);
  });

  it("moves a link the host set under its former public URL", async () => {
    const formerBase = "http://old.example.org";
    await write("delta.mn3", [DEAD]);
    await setMissionUrl(path.join(dir, "delta.mn3"), hosted("delta.mn3", formerBase));
    expect(await hostMission(dir, "delta.mn3", BASE, { keepCustom: true })).toMatchObject({ outcome: "custom" });
    expect(
      await hostMission(dir, "delta.mn3", BASE, { keepCustom: true, formerBaseUrls: [formerBase] }),
    ).toMatchObject({ outcome: "hosted" });
    expect(await linksOf("delta.mn3")).toEqual([hosted("delta.mn3")]);
  });

  it("throws when the link cannot be built or the file is not a mission", async () => {
    const long = `${"m".repeat(60)}.mn3`;
    await write(long, [DEAD]);
    await expect(hostMission(dir, long, BASE, { keepCustom: true })).rejects.toThrow(/clients handle at most 86/);
    await fs.writeFile(path.join(dir, "bogus.mn3"), "not a mission");
    await expect(hostMission(dir, "bogus.mn3", BASE, { keepCustom: true })).rejects.toBeInstanceOf(Mn3Error);
  });

  it("reports every playlist entry, handles each mission once and never throws", async () => {
    await write("alpha.mn3", [DEAD]);
    await write("beta.mn3", [hosted("beta.mn3")]);
    await write("gamma.mn3", [DEAD]);
    await setMissionUrl(path.join(dir, "gamma.mn3"), "http://files.example.net/gamma.zip");
    await fs.writeFile(path.join(dir, "bogus.mn3"), "not a mission");
    const entries = [
      { id: "1", label: "Alpha", missionName: "alpha.mn3" },
      { id: "2", label: "Beta", missionName: "beta.mn3" },
      { id: "3", label: "Havoc", missionName: "havoc.mn3" },
      { id: "4", label: "Gamma", missionName: "gamma.mn3" },
      { id: "5", label: "Gone", missionName: "gone.mn3" },
      { id: "6", label: "Bogus", missionName: "bogus.mn3" },
      { id: "7", label: "Alpha again", missionName: "alpha.mn3" },
    ];
    const results = await hostPlaylistEntries(dir, entries, BASE, { keepCustom: true });
    expect(results.map((r) => [r.entryId, r.label, r.outcome])).toEqual([
      ["1", "Alpha", "hosted"],
      ["2", "Beta", "already"],
      ["3", "Havoc", "stock"],
      ["4", "Gamma", "custom"],
      ["5", "Gone", "missing"],
      ["6", "Bogus", "error"],
      ["7", "Alpha again", "hosted"],
    ]);
    expect(results[5].message).toMatch(/HOG2/);
    expect(summarizeHosting(results)).toBe("2 hosted, 1 ships with the game, 1 has its own link, 1 missing, 1 failed");

    // A second pass rewrites nothing.
    const again = await hostPlaylistEntries(dir, entries, BASE, { keepCustom: true });
    expect(again.map((r) => r.outcome)).toEqual([
      "already",
      "already",
      "stock",
      "custom",
      "missing",
      "error",
      "already",
    ]);
  });

  it("reports an unreadable missions directory per entry", async () => {
    const results = await hostPlaylistEntries(
      path.join(dir, "nothere"),
      [
        { id: "1", label: "A", missionName: "alpha.mn3" },
        { id: "2", label: "B", missionName: "bedlam.mn3" },
      ],
      BASE,
      { keepCustom: true },
    );
    expect(results.map((r) => r.outcome)).toEqual(["error", "stock"]);
    expect(results[0].message).toMatch(/ENOENT/);
  });
});

describe("summarizeHosting", () => {
  const r = (file: string, outcome: MissionHostingResult["outcome"]): MissionHostingResult => ({ file, outcome });

  it("counts mission files, hosted and already together, and leaves out zeros", () => {
    const results = [
      ...Array.from({ length: 7 }, (_, i) => r(`h${i}.mn3`, "hosted")),
      r("a1.mn3", "already"),
      r("a2.mn3", "already"),
      r("chaos.mn3", "stock"),
      r("havoc.mn3", "stock"),
      r("fury.mn3", "stock"),
      r("x.mn3", "error"),
      r("h0.mn3", "hosted"), // a second entry for the same mission
    ];
    expect(summarizeHosting(results)).toBe("9 hosted, 3 ship with the game, 1 failed");
    expect(summarizeHosting([r("a.mn3", "custom"), r("b.mn3", "custom"), r("c.mn3", "missing")])).toBe(
      "2 have their own link, 1 missing",
    );
    expect(summarizeHosting([])).toBe("no missions");
  });
});

describe("playlistHostingTarget / hostDirError", () => {
  const on = { enabled: true, port: 3002, publicBaseUrl: BASE };

  it("says nothing while the host is off or has no public URL", () => {
    expect(playlistHostingTarget({ ...on, enabled: false }, "/game/missions", "/game/missions")).toBeNull();
    expect(playlistHostingTarget({ ...on, publicBaseUrl: null }, "/game/missions", "/game/missions")).toBeNull();
  });

  it("hosts only from the directory the host serves", () => {
    expect(playlistHostingTarget(on, "/game/missions", "/game/./missions/")).toEqual({
      publicBaseUrl: BASE,
      missionsDir: "/game/./missions/",
    });
    expect(playlistHostingTarget(on, "/game/missions", "/other/missions")).toEqual({
      notice: "The mission host serves /game/missions, not the playlist's missions directory (/other/missions).",
    });
    expect(playlistHostingTarget(on, null, "/other/missions")).toEqual({
      notice: expect.stringMatching(/serves nothing \(no game path set\)/),
    });
    expect(playlistHostingTarget(on, "/game/missions", null)).toEqual({ notice: expect.stringMatching(/profile/) });
    expect(hostDirError("/game/missions", "/other/missions")).toMatch(/not this profile's missions directory/);
  });
});

describe("playlistMissionsChanged", () => {
  const e = (...names: string[]) => names.map((missionName) => ({ missionName }));

  it("ignores order and repeats, and sees a mission added, removed or replaced", () => {
    expect(playlistMissionsChanged(e("a.mn3", "b.mn3"), e("b.mn3", "a.mn3", "a.mn3"))).toBe(false);
    expect(playlistMissionsChanged(e("a.mn3"), e("a.mn3", "b.mn3"))).toBe(true);
    expect(playlistMissionsChanged(e("a.mn3", "b.mn3"), e("a.mn3"))).toBe(true);
    expect(playlistMissionsChanged(e("a.mn3", "b.mn3"), e("a.mn3", "c.mn3"))).toBe(true);
  });
});
