import { describe, it, expect } from "vitest";
import { buildTeamSettingLines, sanitizeStoredTeamSettings, validateTeamSettings } from "./teamSettings.js";

describe("team settings", () => {
  it("builds the DMFC lines in a fixed order, team names by DMFC team index", () => {
    expect(
      buildTeamSettingLines({
        hoardMinOrbs: 3,
        teamNames: { yellow: "Gold", red: "Crimson" },
        autoBalance: false,
        allowTeamChange: true,
      }),
    ).toEqual([
      "$allowteamchange on",
      "$autobalance off",
      "$setteamname 0 Crimson",
      "$setteamname 3 Gold",
      "$mincount 3",
    ]);
  });

  it("builds nothing for unset settings", () => {
    expect(buildTeamSettingLines(null)).toEqual([]);
    expect(buildTeamSettingLines({})).toEqual([]);
  });

  it("accepts form input and drops blank team names", () => {
    expect(
      validateTeamSettings({
        allowTeamChange: false,
        teamNames: { red: " Crimson ", blue: "", green: "  " },
        hoardMinOrbs: "12",
      }),
    ).toEqual({ settings: { allowTeamChange: false, teamNames: { red: "Crimson" }, hoardMinOrbs: 12 }, errors: [] });
    expect(validateTeamSettings({ autoBalance: "yes", teamNames: {} })).toEqual({ settings: null, errors: [] });
  });

  it("refuses team names DMFC would cut or split, and orb counts outside 1-12", () => {
    expect(validateTeamSettings({ teamNames: { red: "Two Words" } }).errors).toHaveLength(1);
    expect(validateTeamSettings({ teamNames: { blue: "x".repeat(16) } }).errors).toHaveLength(1);
    expect(validateTeamSettings({ teamNames: { green: "100%" } }).errors).toHaveLength(1);
    expect(validateTeamSettings({ teamNames: { yellow: "x".repeat(15) } }).errors).toEqual([]);
    for (const bad of [0, 13, "2.5", "many"]) {
      expect(validateTeamSettings({ hoardMinOrbs: bad }).errors).toHaveLength(1);
    }
  });

  it("drops stored settings that no longer validate", () => {
    expect(sanitizeStoredTeamSettings({ hoardMinOrbs: 99 })).toBeNull();
    expect(sanitizeStoredTeamSettings({ autoBalance: true })).toEqual({ autoBalance: true });
  });
});
