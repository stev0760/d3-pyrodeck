import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION } from "./version.js";

describe("VERSION", () => {
  it("matches package.json (bump both together)", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
