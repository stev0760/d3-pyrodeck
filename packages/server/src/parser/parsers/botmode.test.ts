import { describe, it, expect } from "vitest";
import { parseBotmode } from "./botmode.js";

describe("parseBotmode", () => {
  it.each([
    ["Anarchy", "anarchy", 1],
    ["Team Anarchy", "team anarchy", 2],
    ["Robo-Anarchy", "robo-anarchy", 1],
    ["Co-op", "co-op", 1],
    ["CTF", "ctf", 2],
    ["Hyper-Anarchy", "hyperanarchy", 1],
    ["Hoard", "hoard", 1],
    ["Entropy", "entropy", 2],
    ["Monsterball", "monsterball", 2],
    ["Unknown", "mymod", 4],
  ])("parses %s", (mode, script, teams) => {
    const result = parseBotmode(`Game mode: ${mode} (scriptname='${script}', teams=${teams})\n`);
    expect(result).toEqual({ mode, scriptName: script, teams });
  });

  it("does not match the bare $botobj game-mode line", () => {
    expect(parseBotmode("Game mode: CTF\n  Red flag: home")).toBeNull();
  });

  it("returns null for unrelated output", () => {
    expect(parseBotmode("")).toBeNull();
    expect(parseBotmode("Unknown command")).toBeNull();
  });
});
