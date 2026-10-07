import { describe, it, expect } from "vitest";
import { parseServercaps } from "./servercaps.js";

describe("parseServercaps", () => {
  it("parses the Matcen 0.9.16 line", () => {
    const raw =
      "SERVERCAPS version=1 fork=Matcen fork_version=0.9.16 features=bots,roster,ships,difficulty";
    const result = parseServercaps(raw);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.fork).toBe("Matcen");
    expect(result!.forkVersion).toBe("0.9.16");
    expect(result!.features).toEqual(
      new Set(["bots", "roster", "ships", "difficulty"]),
    );
  });

  it("parses the extended feature list (teams, squad_orders, population)", () => {
    const raw =
      "SERVERCAPS version=1 fork=Matcen fork_version=0.9.17 features=bots,roster,ships,difficulty,teams,squad_orders,population";
    const result = parseServercaps(raw);
    expect(result).not.toBeNull();
    expect(result!.features.has("teams")).toBe(true);
    expect(result!.features.has("squad_orders")).toBe(true);
    expect(result!.features.has("population")).toBe(true);
    expect(result!.features.size).toBe(7);
  });

  it("keeps feature flags it does not know", () => {
    const raw =
      "SERVERCAPS version=1 fork=Matcen fork_version=0.10.0 features=bots,future_thing,roster";
    const result = parseServercaps(raw);
    expect(result!.features).toEqual(new Set(["bots", "future_thing", "roster"]));
  });

  it("ignores empty feature tokens and a trailing carriage return", () => {
    const raw =
      "SERVERCAPS version=1 fork=Matcen fork_version=0.9.16 features=bots,,ships,\r\n";
    const result = parseServercaps(raw);
    expect(result).not.toBeNull();
    expect(result!.features).toEqual(new Set(["bots", "ships"]));
  });

  it("ignores key=value fields it does not know, wherever they appear", () => {
    const raw =
      "SERVERCAPS version=2 fork=Matcen build=Debug fork_version=0.10.0 features=bots,teams proto=3";
    const result = parseServercaps(raw);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(2);
    expect(result!.forkVersion).toBe("0.10.0");
    expect(result!.features).toEqual(new Set(["bots", "teams"]));
  });

  it("accepts an empty feature list", () => {
    const result = parseServercaps("SERVERCAPS version=1 fork=Matcen fork_version=0.9.16 features=");
    expect(result).not.toBeNull();
    expect(result!.features.size).toBe(0);
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
    expect(parseServercaps("SERVERCAPS version=x fork=Matcen features=bots")).toBeNull();
    expect(parseServercaps("NOTCAPS version=1 fork=Matcen features=bots")).toBeNull();
  });

  it("handles a single feature", () => {
    const raw =
      "SERVERCAPS version=1 fork=TestFork fork_version=1.0.0 features=bots";
    const result = parseServercaps(raw);
    expect(result).not.toBeNull();
    expect(result!.features).toEqual(new Set(["bots"]));
  });
});
