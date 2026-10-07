import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveLogDir, buildLogFilename, validateLogDir, prepareLogFile } from "./logPaths.js";

describe("resolveLogDir", () => {
  it("defaults to the directory containing the executable", () => {
    expect(resolveLogDir(null, "/opt/d3/builds/Descent3")).toBe("/opt/d3/builds");
    expect(resolveLogDir(undefined, "/opt/d3/Descent3")).toBe("/opt/d3");
  });

  it("uses an explicit logDir when set", () => {
    expect(resolveLogDir("/var/log/d3", "/opt/d3/Descent3")).toBe("/var/log/d3");
  });

  it("treats blank/whitespace logDir as unset and trims a real one", () => {
    expect(resolveLogDir("", "/opt/d3/Descent3")).toBe("/opt/d3");
    expect(resolveLogDir("   ", "/opt/d3/Descent3")).toBe("/opt/d3");
    expect(resolveLogDir("  /var/log/d3  ", "/opt/d3/Descent3")).toBe("/var/log/d3");
  });
});

describe("buildLogFilename", () => {
  const at = new Date("2026-06-17T22:20:31.434Z");

  it("auto-names with a filesystem-safe timestamp", () => {
    expect(buildLogFilename("testing", at)).toBe("testing-2026-06-17T22-20-31.log");
  });

  it("slugifies labels with spaces and punctuation", () => {
    expect(buildLogFilename("Matcen Anarchy!", at)).toBe(
      "matcen-anarchy-2026-06-17T22-20-31.log",
    );
  });

  it("falls back to 'server' for an empty/symbol-only label", () => {
    expect(buildLogFilename("", at)).toBe("server-2026-06-17T22-20-31.log");
    expect(buildLogFilename("***", at)).toBe("server-2026-06-17T22-20-31.log");
  });

  it("produces a name with no path separators (no traversal)", () => {
    const name = buildLogFilename("../../etc/passwd", at);
    expect(name.includes("/")).toBe(false);
    expect(name.includes("..")).toBe(false);
    expect(path.basename(name)).toBe(name);
  });
});

describe("validateLogDir / prepareLogFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-logs-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("accepts an existing directory and one that launch will create", async () => {
    expect(await validateLogDir(dir)).toEqual({ valid: true, errors: [] });
    expect((await validateLogDir(path.join(dir, "not", "yet"))).valid).toBe(true);
  });

  it("refuses relative paths, ~ paths, and files", async () => {
    expect((await validateLogDir("logs")).valid).toBe(false);
    expect((await validateLogDir("~/logs")).valid).toBe(false);
    const file = path.join(dir, "a-file");
    await fs.writeFile(file, "x");
    const r = await validateLogDir(path.join(file, "sub"));
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/not a directory/);
  });

  it("creates the directory and the log file before launch", async () => {
    const logPath = path.join(dir, "deep", "er", "server-x.log");
    expect(await prepareLogFile(logPath)).toBeNull();
    expect((await fs.stat(logPath)).isFile()).toBe(true);
  });

  it("reports a log whose parent is a file (the mangled-path case)", async () => {
    const file = path.join(dir, "navmappin");
    await fs.writeFile(file, "x");
    const err = await prepareLogFile(path.join(file, "navmapping25.log"));
    expect(err).toMatch(/Cannot write the server log/);
  });
});
