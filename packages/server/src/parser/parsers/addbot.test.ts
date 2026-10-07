import { describe, it, expect } from "vitest";
import { parseAddbot } from "./addbot.js";

describe("parseAddbot", () => {
  it("parses the success line with the team field", () => {
    const result = parseAddbot(
      "Bot 'Phantom[BOT]' added in slot 2 (ship=Pyro-GL, diff=Hotshot, team=2)\n",
    );
    expect(result).toEqual({
      ok: true,
      callsign: "Phantom[BOT]",
      slot: 2,
      ship: "Pyro-GL",
      difficulty: "Hotshot",
      team: 2,
      error: null,
      warnings: [],
    });
  });

  it("parses a ship name with a space", () => {
    const result = parseAddbot("Bot 'Shade[BOT]' added in slot 5 (ship=Black Pyro, diff=Insane, team=1)");
    expect(result!.ship).toBe("Black Pyro");
    expect(result!.team).toBe(1);
  });

  it("accepts the pre-0.8.6 success line without a team field", () => {
    const result = parseAddbot("Bot 'Old [BOT]' added in slot 3 (ship=Phoenix, diff=Ace)");
    expect(result!.ok).toBe(true);
    expect(result!.callsign).toBe("Old [BOT]");
    expect(result!.team).toBeNull();
  });

  it("collects the unknown-ship and team-range warnings before the result", () => {
    const raw = [
      "Unknown ship 'galleon', using default. Valid: pyro, phoenix, magnum, blackpyro",
      "BOT: team 3 out of range for 2-team game — auto-balancing 'Phantom[BOT]'",
      "Bot 'Phantom[BOT]' added in slot 4 (ship=Pyro-GL, diff=Hotshot, team=1)",
    ].join("\n");
    const result = parseAddbot(raw);
    expect(result!.ok).toBe(true);
    expect(result!.warnings).toHaveLength(2);
    expect(result!.warnings[0]).toMatch(/^Unknown ship 'galleon'/);
    expect(result!.warnings[1]).toMatch(/^BOT: team 3 out of range/);
  });

  it("parses the failure line", () => {
    const result = parseAddbot("Failed to add bot (server full or max bots reached)");
    expect(result!.ok).toBe(false);
    expect(result!.error).toBe("Failed to add bot (server full or max bots reached)");
    expect(result!.callsign).toBeNull();
  });

  it("returns null for unrelated output", () => {
    expect(parseAddbot("")).toBeNull();
    expect(parseAddbot("Unknown command")).toBeNull();
  });
});
