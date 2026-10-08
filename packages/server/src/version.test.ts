import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { REPOSITORY_URL, VERSION } from "./version.js";

describe("VERSION", () => {
  it("matches package.json (bump both together)", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("REPOSITORY_URL matches the root package.json repository", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf-8"),
    ) as { repository: { url: string } };
    expect(REPOSITORY_URL).toBe(pkg.repository.url);
  });
});
