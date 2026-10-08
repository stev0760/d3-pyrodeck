import { describe, it, expect } from "vitest";
import { countHumanPlayers, parsePlayers } from "./players.js";

const OUTPUT = ["PNum Name", "00: -Server-", "01: Viper[BOT]", "03: Hunter", "07: Cold Steel", ""].join("\n");

describe("parsePlayers", () => {
  it("reads slot and callsign, marking the server slot and bots", () => {
    expect(parsePlayers(OUTPUT)).toEqual([
      { slot: 0, name: "-Server-", isServer: true, isBot: false },
      { slot: 1, name: "Viper[BOT]", isServer: false, isBot: true },
      { slot: 3, name: "Hunter", isServer: false, isBot: false },
      { slot: 7, name: "Cold Steel", isServer: false, isBot: false },
    ]);
  });

  it("reads the real engine's reply, console echo and CRLF included", () => {
    // Matcen Debug build, 2026-10-07, empty server: what the console returned for "$players".
    const raw = "players\r\n[127.0.0.1] $players\r\nPNum Name\r\n00: -Server-\r\n";
    expect(parsePlayers(raw)).toEqual([{ slot: 0, name: "-Server-", isServer: true, isBot: false }]);
    expect(countHumanPlayers(raw)).toBe(0);
  });

  it("counts humans only", () => {
    expect(countHumanPlayers(OUTPUT)).toBe(2);
    expect(countHumanPlayers("PNum Name\n00: -Server-\n02: Shadow[BOT]\n")).toBe(0);
    expect(countHumanPlayers("")).toBe(0);
  });
});
