import { describe, it, expect } from "vitest";
import { parseBotstat } from "./botstat.js";

describe("parseBotstat", () => {
  it("parses status lines and skips the nav line", () => {
    const raw = [
      "  Bot 0 'Phantom[BOT]' slot=2 state=COMBAT role=Freelance lean=balanced speed=10.3 shields=100 target=Viper[BOT]",
      "      nav: dest_room=5 num_paths=1 path=0/3 mdir|0.98| ahead:WALL d=12.3 solid=0 portal=1 route:goal=19 dijkstra=3 boa=24 [DIVERGE] gcost=40",
      "  Bot 1 'Viper[BOT]' slot=3 state=EXPLORE role=Attack lean=attack speed=51.6 shields=43 target=(none)",
      "      nav: dest_room=7 num_paths=1 path=1/4 mdir|1.00| ahead:clear(>30u) route:goal=19 dijkstra=7 boa=7 gcost=0",
    ].join("\n");

    const result = parseBotstat(raw);
    expect(result).not.toBeNull();
    // nav lines are skipped — only the two status lines are counted
    expect(result!.bots).toHaveLength(2);

    expect(result!.bots[0]).toMatchObject({
      index: 0,
      callsign: "Phantom[BOT]",
      slot: 2,
      state: "COMBAT",
      role: "Freelance", // TitleCase preserved
      lean: "balanced",
      speed: 10.3,
      shields: 100,
      target: "Viper[BOT]",
    });

    const b1 = result!.bots[1];
    expect(b1.target).toBeNull(); // "(none)" -> null
    expect(b1.role).toBe("Attack");
    expect(b1.lean).toBe("attack");
  });

  it("skips a nav line with a trailing via: suffix", () => {
    const raw = [
      "  Bot 0 'Phantom[BOT]' slot=2 state=HUNT role=Freelance lean=balanced speed=22.1 shields=90 target=(none)",
      "      nav: dest_room=5 num_paths=1 path=0/3 mdir|0.98| ahead:clear(>30u) route:goal=19 dijkstra=3 boa=3 gcost=0 via:d=41.2 t=2.7",
    ].join("\n");

    const result = parseBotstat(raw);
    expect(result).not.toBeNull();
    expect(result!.bots).toHaveLength(1);
    expect(result!.bots[0].state).toBe("HUNT");
  });

  it("accepts every role and lean the fork prints, including '?'", () => {
    const roles = ["Freelance", "Attack", "Defend", "Follow", "Cover"];
    const leans = ["balanced", "attack", "defend", "runner", "flex", "?"];
    const raw = roles
      .map((role, i) =>
        `  Bot ${i} 'B${i}[BOT]' slot=${i + 1} state=EVADE role=${role} lean=${leans[i]} speed=1.0 shields=50 target=(none)`,
      )
      .concat(["  Bot 5 'B5[BOT]' slot=6 state=FLEE role=Cover lean=? speed=0.0 shields=0 target=(none)"])
      .join("\n");
    const result = parseBotstat(raw);
    expect(result!.bots.map((b) => b.role)).toEqual([...roles, "Cover"]);
    expect(result!.bots.map((b) => b.lean)).toEqual(leans);
  });

  it("parses a dead bot's negative shields (seen live on Matcen 0.9.17-dev)", () => {
    const raw =
      "  Bot 1 'Shadow[BOT]' slot=2 state=EXPLORE role=Freelance lean=runner speed=1.4 shields=-1 target=(none)";
    const result = parseBotstat(raw);
    expect(result).not.toBeNull();
    expect(result!.bots[0].shields).toBe(-1);
    expect(result!.bots[0].lean).toBe("runner");
  });

  it('keeps a "(robot)" target as a non-null string', () => {
    const raw =
      "  Bot 0 'Hunter[BOT]' slot=4 state=HUNT role=Defend lean=defend speed=5.0 shields=75 target=(robot)";
    const result = parseBotstat(raw);
    expect(result).not.toBeNull();
    expect(result!.bots[0].target).toBe("(robot)");
  });

  it("skips the no-object line of a respawning bot", () => {
    const raw = [
      "  Bot 0 'Ghost[BOT]' slot=2 (no object — respawning?)",
      "  Bot 1 'Solo[BOT]' slot=3 state=EXPLORE role=Freelance lean=balanced speed=0.0 shields=100 target=(none)",
    ].join("\n");
    const result = parseBotstat(raw);
    expect(result!.bots).toHaveLength(1);
    expect(result!.bots[0].callsign).toBe("Solo[BOT]");
  });

  it("parses a single status line (single-bot $botstat <index>)", () => {
    const raw =
      "  Bot 0 'Solo[BOT]' slot=2 state=EXPLORE role=Freelance lean=balanced speed=0.0 shields=100 target=(none)";
    const result = parseBotstat(raw);
    expect(result).not.toBeNull();
    expect(result!.bots).toHaveLength(1);
    expect(result!.bots[0].callsign).toBe("Solo[BOT]");
  });

  it("returns null when there are no bot status lines", () => {
    expect(parseBotstat("No bots active (or invalid index)")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseBotstat("")).toBeNull();
  });
});
