import { describe, it, expect } from "vitest";
import { parseScores } from "./scores.js";

describe("parseScores", () => {
  it("flags bots by the [BOT] suffix, with or without a space before it", () => {
    const raw = [
      "Pilot                Points K D S Ping",
      "Viper[BOT]:          5      6 1 1 ---",
      "Human:               4      6 2 2 45",
      "Old [BOT]:           0      0 8 0 ---",
      "*Reaper[BOT]:        0      0 0 0 ---",
    ].join("\n");
    const result = parseScores(raw);
    expect(result).not.toBeNull();
    expect(result!.players.map((p) => [p.name, p.isBot, p.isObserver, p.ping])).toEqual([
      ["Viper[BOT]", true, false, null],
      ["Human", false, false, 45],
      ["Old [BOT]", true, false, null],
      ["Reaper[BOT]", true, true, null],
    ]);
    expect(result!.players[0]).toMatchObject({ points: 5, kills: 6, deaths: 1, suicides: 1 });
  });

  it("handles a 19-character name that lost its colon", () => {
    const raw = [
      "Pilot                Points K D S Ping",
      "LongestNamePos[BOT]  3      3 0 0 ---",
    ].join("\n");
    const result = parseScores(raw);
    expect(result!.players[0].name).toBe("LongestNamePos[BOT]");
    expect(result!.players[0].isBot).toBe(true);
    expect(result!.players[0].points).toBe(3);
  });

  it("returns null without a header line", () => {
    expect(parseScores("Unknown command")).toBeNull();
  });
});
