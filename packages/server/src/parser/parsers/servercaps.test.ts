import { describe, it, expect } from "vitest";
import { parseServercaps } from "./servercaps.js";

describe("parseServercaps", () => {
  it("parses a valid servercaps response", () => {
    const raw =
      "SERVERCAPS version=1 fork=Matcen fork_version=0.8.0 features=bots,roster,ships,difficulty";
    const result = parseServercaps(raw);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.fork).toBe("Matcen");
    expect(result!.forkVersion).toBe("0.8.0");
    expect(result!.features).toEqual(
      new Set(["bots", "roster", "ships", "difficulty"]),
    );
  });

  it("parses when SERVERCAPS line is among other output", () => {
    const raw = [
      "Some other server output",
      "SERVERCAPS version=1 fork=Matcen fork_version=0.8.0 features=bots",
      "",
    ].join("\n");
    const result = parseServercaps(raw);
    expect(result).not.toBeNull();
    expect(result!.features).toEqual(new Set(["bots"]));
  });

  it("returns null for Unknown command (vanilla server)", () => {
    expect(parseServercaps("Unknown command")).toBeNull();
  });

  it("returns null for empty response", () => {
    expect(parseServercaps("")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseServercaps("SERVERCAPS broken")).toBeNull();
  });

  it("handles a single feature", () => {
    const raw =
      "SERVERCAPS version=1 fork=TestFork fork_version=1.0.0 features=bots";
    const result = parseServercaps(raw);
    expect(result).not.toBeNull();
    expect(result!.features).toEqual(new Set(["bots"]));
  });
});
