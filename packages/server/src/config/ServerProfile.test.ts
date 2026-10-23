import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServerProfileManager } from "./ServerProfile.js";

let dir: string;
let manager: ServerProfileManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-profile-"));
  manager = new ServerProfileManager(path.join(dir, "config"), path.join(dir, "game"));
  await fs.mkdir(path.join(dir, "game"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const read = (name: string) => fs.readFile(path.join(dir, "game", name), "utf-8");
const exists = (name: string) =>
  fs.access(path.join(dir, "game", name)).then(() => true, () => false);

describe("ServerProfileManager.writeFile", () => {
  it("writes a new file without a backup", async () => {
    await manager.writeFile("bots.cfg", "BotCount=1\n");
    expect(await read("bots.cfg")).toBe("BotCount=1\n");
    expect(await exists("bots.cfg.bak")).toBe(false);
    expect(await exists("bots.cfg.tmp")).toBe(false);
  });

  it("keeps the previous content in <name>.bak when the content changes", async () => {
    await manager.writeFile("bots.cfg", "BotCount=1\n");
    await manager.writeFile("bots.cfg", "BotCount=2\n");
    expect(await read("bots.cfg")).toBe("BotCount=2\n");
    expect(await read("bots.cfg.bak")).toBe("BotCount=1\n");
  });

  it("leaves the backup alone when the content is unchanged", async () => {
    await manager.writeFile("bots.cfg", "BotCount=1\n");
    await manager.writeFile("bots.cfg", "BotCount=2\n");
    await manager.writeFile("bots.cfg", "BotCount=2\n");
    expect(await read("bots.cfg.bak")).toBe("BotCount=1\n");
  });

  it("rejects path traversal", async () => {
    await expect(manager.writeFile("../bots.cfg", "x")).rejects.toThrow("Invalid filename");
  });
});

describe("ServerProfileManager backups", () => {
  it("reads the backup and restores it, keeping the replaced content as the new backup", async () => {
    expect(await manager.readBackup("bots.cfg")).toBeNull();
    await manager.writeFile("bots.cfg", "BotCount=1\n");
    await manager.writeFile("bots.cfg", "BotCount=2\n");

    const backup = await manager.readBackup("bots.cfg");
    expect(backup?.content).toBe("BotCount=1\n");
    expect(typeof backup?.mtime).toBe("string");

    expect(await manager.restoreBackup("bots.cfg")).toBe(true);
    expect(await read("bots.cfg")).toBe("BotCount=1\n");
    expect(await read("bots.cfg.bak")).toBe("BotCount=2\n");
  });

  it("restores nothing when there is no backup", async () => {
    await manager.writeFile("bots.cfg", "BotCount=1\n");
    expect(await manager.restoreBackup("bots.cfg")).toBe(false);
    expect(await read("bots.cfg")).toBe("BotCount=1\n");
  });

  it("keeps backups out of the game file list", async () => {
    await manager.writeFile("bots.cfg", "BotCount=1\n");
    await manager.writeFile("bots.cfg", "BotCount=2\n");
    expect(await manager.listGameFiles()).toEqual(["bots.cfg"]);
  });
});

describe("ServerProfileManager.classifyGameFiles", () => {
  it("recognises a roster by BotCount or a numbered BotName, whatever the key casing", async () => {
    await manager.writeFile("a.cfg", "botcount=2\nbotname1=A\n");
    await manager.writeFile("b.cfg", "; pool only\nBotName1=A\nBotName2=B\n");
    await manager.writeFile("c.cfg", "[server config file]\nGameName=X\n");
    const files = await manager.classifyGameFiles();
    const typeOf = (name: string) => files.find((f) => f.filename === name)?.type;
    expect(typeOf("a.cfg")).toBe("bot-roster");
    expect(typeOf("b.cfg")).toBe("bot-roster");
    expect(typeOf("c.cfg")).toBe("server-config");
    expect(files.find((f) => f.filename === "a.cfg")?.meta.botCount).toBe("2");
  });
});
