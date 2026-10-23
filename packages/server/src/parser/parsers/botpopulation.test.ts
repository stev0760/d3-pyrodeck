import { describe, it, expect } from "vitest";
import { parseBotpopulation } from "./botpopulation.js";

describe("parseBotpopulation", () => {
  it("parses the status line", () => {
    const result = parseBotpopulation(
      "Population: manager=on target=6 reserve=1 humans=0 bots=6 seats=7/8 bot_limit=6\n",
    );
    expect(result).toEqual({
      manager: true,
      target: 6,
      reserve: 1,
      humans: 0,
      bots: 6,
      seatsUsed: 7,
      seats: 8,
      botLimit: 6,
    });
  });

  it("parses a manager that is off with no target", () => {
    const result = parseBotpopulation(
      "Population: manager=off target=0 reserve=1 humans=2 bots=3 seats=6/14 bot_limit=12\r\n",
    );
    expect(result).toMatchObject({ manager: false, target: 0, humans: 2, bots: 3, seats: 14 });
  });

  it("keeps the lines after the status as a note", () => {
    const result = parseBotpopulation(
      "Population: manager=on target=12 reserve=1 humans=1 bots=11 seats=13/14 bot_limit=12\n" +
        "  Note: a bot leaves when a human joins and the reserve would be used.\n" +
        "\n",
    );
    expect(result?.note).toBe("Note: a bot leaves when a human joins and the reserve would be used.");
  });

  it("finds the status line after an echoed command", () => {
    const result = parseBotpopulation(
      "[127.0.0.1] $botpopulation\n" +
        "Population: manager=on target=6 reserve=1 humans=0 bots=6 seats=7/8 bot_limit=6\n",
    );
    expect(result?.target).toBe(6);
  });

  it("returns null for the mutation replies and unrelated output", () => {
    expect(parseBotpopulation("Population manager is on (target 6): it adds or removes bots to match\n")).toBeNull();
    expect(parseBotpopulation("Reserved seats set to 2\n")).toBeNull();
    expect(parseBotpopulation("Unknown command\n")).toBeNull();
    expect(parseBotpopulation("")).toBeNull();
  });
});
