import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BACKUP_SUFFIX,
  MISSION_URL_MAX,
  MSN_URL_MAX,
  readMn3Msn,
  readMsnUrls,
  restoreMissionUrl,
  rewriteMsnUrls,
  setMissionUrl,
  validateMissionUrl,
  checkLinkableMission,
  checkMissionFilename,
  isStockMission,
  RETAIL_MISSIONS,
  STOCK_MISSIONS,
} from "./Mn3UrlRewriter.js";
import { parseMn3 } from "./Mn3Scanner.js";

// A queued state write may still land while the temp directory is being removed (ENOTEMPTY): retry.
const RM_TEMP = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 } as const;

/** Build a HOG2 archive the way the engine lays one out (cfile/hogfile.h). */
function buildHog(files: { name: string; data: Buffer }[], gap = 0): Buffer {
  const header = Buffer.alloc(68);
  header.write("HOG2", 0, "latin1");
  header.writeUInt32LE(files.length, 4);
  const dataOffset = 68 + files.length * 48 + gap;
  header.writeUInt32LE(dataOffset, 8);
  const table = Buffer.alloc(files.length * 48 + gap);
  files.forEach((f, i) => {
    table.write(f.name, i * 48, "latin1");
    table.writeUInt32LE(0, i * 48 + 36);
    table.writeUInt32LE(f.data.length, i * 48 + 40);
    table.writeUInt32LE(915148800 + i, i * 48 + 44);
  });
  return Buffer.concat([header, table, ...files.map((f) => f.data)]);
}

const MSN = [
  "NAME\t\tTest Mission",
  "NUMLEVELS\t1",
  "AUTHOR\t\tSomeone",
  "URL\t\thttp://www.outrage.com/files/test.zip",
  "URL\t\thttp://dead.example.org/test.zip",
  "DESCRIPTION\tA mission",
  "MULTI\t\tYES",
  "KEYWORDS\tGOALS2,GOALPERTEAM",
  "",
  "LEVEL\t\t1",
  "MINE\t\ttest.d3l",
  "",
].join("\r\n");

const LEVEL_BYTES = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
const OGF_BYTES = Buffer.from("not really an ogf, but bytes that must survive");

describe("rewriteMsnUrls / readMsnUrls", () => {
  it("reads mission-level URLs only", () => {
    expect(readMsnUrls(MSN)).toEqual([
      "http://www.outrage.com/files/test.zip",
      "http://dead.example.org/test.zip",
    ]);
  });

  it("replaces every mission-level URL line with one, keeping CRLF and the tab prefix", () => {
    const out = rewriteMsnUrls(MSN, "https://files.example.net/test.zip");
    expect(readMsnUrls(out)).toEqual(["https://files.example.net/test.zip"]);
    expect(out).toContain("AUTHOR\t\tSomeone\r\nURL\t\thttps://files.example.net/test.zip\r\nDESCRIPTION");
    expect(out.split("\r\n").filter((l) => l.startsWith("URL"))).toHaveLength(1);
    // Every other line is untouched, and still CRLF-only.
    expect(out.replace(/URL\t\thttps:\/\/files\.example\.net\/test\.zip\r\n/, "")).toBe(
      MSN.replace(/URL[^\r]*\r\n/g, ""),
    );
    expect(/[^\r]\n/.test(out)).toBe(false);
  });

  it("inserts a URL line before the first LEVEL line when there is none", () => {
    const noUrl = "NAME x\nNUMLEVELS 1\n\nLEVEL 1\nMINE x.d3l\n";
    const out = rewriteMsnUrls(noUrl, "https://a.example/x.zip");
    expect(out).toBe("NAME x\nNUMLEVELS 1\n\nURL https://a.example/x.zip\nLEVEL 1\nMINE x.d3l\n");
  });

  it("leaves level-section lines alone and appends when there is no LEVEL line", () => {
    expect(rewriteMsnUrls("NAME x", "https://a.example/x.zip")).toBe(
      "NAME x\nURL https://a.example/x.zip\n",
    );
  });
});

describe("validateMissionUrl", () => {
  it("accepts http links to a .zip or .mn3", () => {
    expect(validateMissionUrl("http://example.org/m/test.zip")).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
    expect(validateMissionUrl("http://example.org/test.MN3").valid).toBe(true);
  });

  it("accepts https with a warning (clients without TLS cannot use it)", () => {
    const v = validateMissionUrl("https://example.org/m/test.zip");
    expect(v.valid).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/https/);
  });

  it("caps links at the client's 86-character display buffer", () => {
    const head = "http://example.org/";
    const at = (n: number) => `${head}${"a".repeat(n - head.length - 4)}.zip`;
    expect(at(MISSION_URL_MAX)).toHaveLength(86);
    expect(validateMissionUrl(at(MISSION_URL_MAX)).valid).toBe(true);
    const over = validateMissionUrl(at(MISSION_URL_MAX + 1));
    expect(over.valid).toBe(false);
    expect(over.errors.join(" ")).toMatch(/87 characters.*at most 86/);
  });

  it("refuses an upper-case scheme (the client's HTTP library matches lower case only)", () => {
    expect(validateMissionUrl("HTTP://example.org/test.zip").valid).toBe(false);
  });

  it("warns, without refusing, on a link that is neither .zip nor .mn3", () => {
    const v = validateMissionUrl("http://example.org/download.php");
    expect(v.valid).toBe(true);
    expect(v.warnings).toHaveLength(1);
  });

  it("refuses what the engine or clients cannot use", () => {
    expect(validateMissionUrl("").valid).toBe(false);
    expect(validateMissionUrl("ftp://example.org/test.zip").valid).toBe(false);
    expect(validateMissionUrl("https://example.org/").valid).toBe(false);
    expect(validateMissionUrl("https://example.org/a b.zip").valid).toBe(false);
    expect(validateMissionUrl(`https://example.org/${"a".repeat(MSN_URL_MAX)}.zip`).valid).toBe(false);
  });

  it("refuses retail missions and path tricks", () => {
    expect(checkMissionFilename("bedlam.mn3")).toBeNull();
    expect(checkMissionFilename("D3_2.MN3")).toMatch(/Retail/);
    expect(checkMissionFilename("../x.mn3")).not.toBeNull();
    expect(checkMissionFilename("x.hog")).not.toBeNull();
  });
});

describe("stock missions", () => {
  it("lists all 18 that ship with the game, the engine's four retail ones among them", () => {
    expect(STOCK_MISSIONS.size).toBe(18);
    for (const retail of RETAIL_MISSIONS) expect(STOCK_MISSIONS.has(retail)).toBe(true);
  });

  it("matches any case, and only whole names", () => {
    expect(isStockMission("Tri-Pod.MN3")).toBe(true);
    expect(isStockMission("KATA12.mn3")).toBe(true);
    expect(isStockMission("bedlam2.mn3")).toBe(false);
    expect(isStockMission("mymission.mn3")).toBe(false);
  });

  it("takes no new link, while checkMissionFilename (restore) still accepts it", () => {
    expect(checkLinkableMission("Havoc.mn3")).toBe("Havoc.mn3 ships with Descent 3; every player already has it.");
    expect(checkMissionFilename("Havoc.mn3")).toBeNull();
    expect(checkLinkableMission("d3.mn3")).toMatch(/Retail/);
    expect(checkLinkableMission("mymission.mn3")).toBeNull();
  });
});

describe("setMissionUrl / restoreMissionUrl", () => {
  let dir: string;
  let file: string;
  let original: Buffer;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-mn3-"));
    file = path.join(dir, "test.mn3");
    original = buildHog(
      [
        { name: "test.d3l", data: LEVEL_BYTES },
        { name: "test.msn", data: Buffer.from(MSN, "latin1") },
        { name: "test.ogf", data: OGF_BYTES },
      ],
      16, // a gap between the table and the payloads must survive too
    );
    await fs.writeFile(file, original);
  });

  afterEach(async () => {
    await fs.rm(dir, RM_TEMP);
  });

  it("rewrites the .msn, keeps every other payload byte-identical, and backs up once", async () => {
    const result = await setMissionUrl(file, "https://files.example.net/test.zip");
    expect(result.backupCreated).toBe(true);
    expect(result.urls).toEqual(["https://files.example.net/test.zip"]);
    expect(await fs.readFile(file + BACKUP_SUFFIX)).toEqual(original);

    const { table, text } = await readMn3Msn(file);
    expect(readMsnUrls(text)).toEqual(["https://files.example.net/test.zip"]);
    const bytes = await fs.readFile(file);
    const level = table.entries.find((e) => e.name === "test.d3l")!;
    const ogf = table.entries.find((e) => e.name === "test.ogf")!;
    expect(bytes.subarray(level.offset, level.offset + level.len)).toEqual(LEVEL_BYTES);
    expect(bytes.subarray(ogf.offset, ogf.offset + ogf.len)).toEqual(OGF_BYTES);
    expect(bytes.length).toBe(ogf.offset + ogf.len);

    // The scanner still reads the mission, now with the new link.
    const info = await parseMn3(file);
    expect(info.error).toBeUndefined();
    expect(info.name).toBe("Test Mission");
    expect(info.urls).toEqual(["https://files.example.net/test.zip"]);
    expect(info.modes.ctf.compatible).toBe(true);

    // A second rewrite keeps the first backup (the true original).
    const again = await setMissionUrl(file, "https://mirror.example.net/test.mn3");
    expect(again.backupCreated).toBe(false);
    expect(await fs.readFile(file + BACKUP_SUFFIX)).toEqual(original);
    expect((await parseMn3(file)).urls).toEqual(["https://mirror.example.net/test.mn3"]);
  });

  it("restores the original bytes and removes the backup", async () => {
    await setMissionUrl(file, "https://files.example.net/test.zip");
    const restored = await restoreMissionUrl(file);
    expect(restored.urls).toEqual([
      "http://www.outrage.com/files/test.zip",
      "http://dead.example.org/test.zip",
    ]);
    expect(await fs.readFile(file)).toEqual(original);
    await expect(fs.access(file + BACKUP_SUFFIX)).rejects.toThrow();
    await expect(restoreMissionUrl(file)).rejects.toThrow(/No Pyrodeck backup/);
  });

  it("refuses to restore over a mission that was replaced since the backup", async () => {
    await setMissionUrl(file, "https://files.example.net/test.zip");
    await fs.writeFile(
      file,
      buildHog([
        { name: "test.d3l", data: Buffer.alloc(10) },
        { name: "test.msn", data: Buffer.from(MSN, "latin1") },
        { name: "test.ogf", data: OGF_BYTES },
      ]),
    );
    await expect(restoreMissionUrl(file)).rejects.toThrow(/no longer matches/);
    await expect(fs.access(file + BACKUP_SUFFIX)).resolves.toBeUndefined();
  });

  it("refuses to set a link on a stock mission, and still restores one rewritten before", async () => {
    const stock = path.join(dir, "chaos.mn3");
    await fs.writeFile(stock, original);
    await expect(setMissionUrl(stock, "http://example.org/chaos.mn3")).rejects.toThrow(/ships with Descent 3/);
    expect(await fs.readFile(stock)).toEqual(original);
    await expect(fs.access(stock + BACKUP_SUFFIX)).rejects.toThrow();

    // A rewrite from before stock missions were refused: restore still puts the original back.
    await setMissionUrl(file, "https://files.example.net/test.zip");
    await fs.copyFile(stock, stock + BACKUP_SUFFIX);
    await fs.copyFile(file, stock);
    await restoreMissionUrl(stock);
    expect(await fs.readFile(stock)).toEqual(original);
  });

  it("refuses a file that is not a HOG2 archive, without leaving files behind", async () => {
    const bogus = path.join(dir, "bogus.mn3");
    await fs.writeFile(bogus, "this is not a mission");
    await expect(setMissionUrl(bogus, "https://a.example/x.zip")).rejects.toThrow(/HOG2/);
    expect((await fs.readdir(dir)).sort()).toEqual(["bogus.mn3", "test.mn3"]);
  });

  it("refuses an archive whose payloads run past the end of the file", async () => {
    await fs.writeFile(file, original.subarray(0, original.length - 10));
    await expect(setMissionUrl(file, "https://a.example/x.zip")).rejects.toThrow(/truncated/);
  });

  it("picks the .msn named after the mission when an archive holds more than one", async () => {
    const other = "NAME Other\r\nURL http://other.example/o.zip\r\nLEVEL 1\r\n";
    await fs.writeFile(
      file,
      buildHog([
        { name: "aaa.msn", data: Buffer.from(other, "latin1") },
        { name: "test.d3l", data: LEVEL_BYTES },
        { name: "test.msn", data: Buffer.from(MSN, "latin1") },
      ]),
    );
    await setMissionUrl(file, "https://files.example.net/test.zip");
    const bytes = await fs.readFile(file);
    expect(bytes.toString("latin1")).toContain("URL http://other.example/o.zip");
    expect(readMsnUrls((await readMn3Msn(file)).text)).toEqual(["https://files.example.net/test.zip"]);
  });
});
