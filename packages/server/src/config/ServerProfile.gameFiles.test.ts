import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ServerProfileManager, gameFileWriteError } from "./ServerProfile.js";

// A queued state write may still land while the temp directory is being removed (ENOTEMPTY): retry.
const RM_TEMP = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 } as const;

/**
 * Writes and deletes in the game directory are limited to the config file types the
 * panel edits. The directory also holds the game's executable, and a file written under
 * its name would run at the next launch.
 */
describe("ServerProfileManager game-file writes", () => {
  let configDir: string;
  let gamePath: string;
  let manager: ServerProfileManager;

  beforeEach(async () => {
    configDir = mkdtempSync(path.join(tmpdir(), "pyrodeck-gamefiles-cfg-"));
    gamePath = mkdtempSync(path.join(tmpdir(), "pyrodeck-gamefiles-game-"));
    await fs.writeFile(path.join(gamePath, "Descent3"), "#!/bin/sh\necho real\n", { mode: 0o755 });
    manager = new ServerProfileManager(configDir, gamePath);
  });

  afterEach(async () => {
    await fs.rm(configDir, RM_TEMP);
    await fs.rm(gamePath, RM_TEMP);
  });

  it("writes and deletes the config file types", async () => {
    for (const name of ["dedicated.cfg", "bots.CFG", "ships.mps", "autoexec.dmfc", "notes.txt"]) {
      await manager.writeFile(name, "x");
      expect(await fs.readFile(path.join(gamePath, name), "utf-8")).toBe("x");
      await manager.deleteFile(name);
      await expect(fs.access(path.join(gamePath, name))).rejects.toThrow();
    }
  });

  it("refuses to write over the executable or any other file type", async () => {
    for (const name of ["Descent3", "Descent3.exe", "run.sh", "d3.hog", "level.mn3", "x.cfg.sh", ".cfg"]) {
      await expect(manager.writeFile(name, "#!/bin/sh\necho pwned\n")).rejects.toThrow(/Only .* can be written/);
    }
    expect(await fs.readFile(path.join(gamePath, "Descent3"), "utf-8")).toContain("echo real");
  });

  it("refuses to restore a backup over a file outside the allowlist", async () => {
    await fs.writeFile(path.join(gamePath, "Descent3.bak"), "#!/bin/sh\necho pwned\n");
    await expect(manager.restoreBackup("Descent3")).rejects.toThrow(/Only .* can be written/);
    expect(await fs.readFile(path.join(gamePath, "Descent3"), "utf-8")).toContain("echo real");
  });

  it("refuses to delete files outside the allowlist", async () => {
    await expect(manager.deleteFile("Descent3")).rejects.toThrow(/Only .* can be written/);
    await expect(fs.access(path.join(gamePath, "Descent3"))).resolves.toBeUndefined();
  });

  it("still rejects path traversal first", async () => {
    for (const name of ["../x.cfg", "sub/x.cfg", "sub\\x.cfg", "x\0.cfg"]) {
      await expect(manager.writeFile(name, "x")).rejects.toThrow("Invalid filename");
      await expect(manager.deleteFile(name)).rejects.toThrow("Invalid filename");
    }
  });

  it("leaves reads unrestricted", async () => {
    expect(await manager.readFile("Descent3")).toContain("echo real");
  });

  it("gives the reason without writing (gameFileWriteError)", () => {
    expect(gameFileWriteError("gamespy.cfg")).toBeNull();
    expect(gameFileWriteError("trackers.TXT")).toBeNull();
    expect(gameFileWriteError("gamespy")).toBe("Only .cfg, .mps, .dmfc, .txt files can be written or deleted here");
    expect(gameFileWriteError(".cfg")).not.toBeNull();
  });
});
