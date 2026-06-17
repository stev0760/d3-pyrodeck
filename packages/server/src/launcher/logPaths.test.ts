import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveLogDir, buildLogFilename } from "./logPaths.js";

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
