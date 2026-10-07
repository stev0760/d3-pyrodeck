import { describe, it, expect } from "vitest";
import { parseBotlist } from "./botlist.js";

describe("parseBotlist", () => {
  it("parses the contract format (no space before [BOT], ship with a space)", () => {
    const raw = [
      "  Bot 0: 'Phantom[BOT]' slot=2 ship=Black Pyro diff=Ace (alive)",
      "  Bot 1: 'Viper[BOT]' slot=3 ship=Phoenix diff=Hotshot (dead)",
    ].join("\n");
    const result = parseBotlist(raw);
    expect(result).not.toBeNull();
    expect(result!.bots).toEqual([
      { index: 0, callsign: "Phantom[BOT]", slot: 2, ship: "Black Pyro", difficulty: "Ace", alive: true },
      { index: 1, callsign: "Viper[BOT]", slot: 3, ship: "Phoenix", difficulty: "Hotshot", alive: false },
    ]);
  });

  it("still accepts callsigns from pre-0.9.9 builds that printed a space before [BOT]", () => {
    const result = parseBotlist("  Bot 4: 'Old Name [BOT]' slot=7 ship=Pyro-GL diff=Rookie (alive)");
    expect(result!.bots[0].callsign).toBe("Old Name [BOT]");
    expect(result!.bots[0].ship).toBe("Pyro-GL");
  });

  it("keeps an apostrophe inside a callsign", () => {
    const result = parseBotlist("  Bot 0: 'O'Neil[BOT]' slot=1 ship=Magnum-AHT diff=Insane (alive)");
    expect(result!.bots[0].callsign).toBe("O'Neil[BOT]");
    expect(result!.bots[0].ship).toBe("Magnum-AHT");
  });

  it("returns an empty list for 'No bots active'", () => {
    expect(parseBotlist("No bots active")).toEqual({ bots: [] });
  });

  it("returns null for unrelated output", () => {
    expect(parseBotlist("")).toBeNull();
    expect(parseBotlist("Unknown command")).toBeNull();
  });
});
