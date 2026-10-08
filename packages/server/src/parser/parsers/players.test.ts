import { describe, it, expect } from "vitest";
import { countHumanPlayers, parsePlayers, parsePlayerinfo } from "./players.js";

// Replies as a Matcen 0.9.16 dedicated server printed them (2026-10-07), echo stripped.
describe("parsePlayers", () => {
  it("lists the slots and names, the server included", () => {
    expect(parsePlayers("PNum Name\r\n00: -Server-\r\n01: Alpha[BOT]\r\n")).toEqual({
      players: [
        { slot: 0, name: "-Server-" },
        { slot: 1, name: "Alpha[BOT]" },
      ],
    });
  });

  it("keeps names with spaces and colons, and slots past 9", () => {
    const parsed = parsePlayers("PNum Name\n00: -Server-\n12: ace: mcnasty\n");
    expect(parsed!.players[1]).toEqual({ slot: 12, name: "ace: mcnasty" });
  });

  it("skips unsolicited lines inside the reply", () => {
    const parsed = parsePlayers("PNum Name\n00: -Server-\n*Viper[BOT] was killed by Hawk[BOT]\n03: Bob\n");
    expect(parsed!.players.map((p) => p.slot)).toEqual([0, 3]);
  });

  it("returns null without the header", () => {
    expect(parsePlayers("")).toBeNull();
    expect(parsePlayers("Unknown command")).toBeNull();
  });
});

describe("countHumanPlayers", () => {
  it("counts humans only: not the server's slot, not bots", () => {
    const output = ["PNum Name", "00: -Server-", "01: Viper[BOT]", "03: Hunter", "07: Cold Steel", ""].join("\n");
    expect(countHumanPlayers(output)).toBe(2);
    expect(countHumanPlayers("PNum Name\n00: -Server-\n02: Shadow[BOT]\n")).toBe(0);
  });

  it("reads the real engine's reply, console echo and CRLF included", () => {
    // Matcen Debug build, 2026-10-07, empty server: what the console returned for "$players".
    expect(countHumanPlayers("players\r\n[127.0.0.1] $players\r\nPNum Name\r\n00: -Server-\r\n")).toBe(0);
  });

  it("does not know the count from a reply that is not $players", () => {
    expect(countHumanPlayers("")).toBeNull();
  });
});

describe("parsePlayerinfo", () => {
  it("reads a bot's reply", () => {
    const raw =
      "*Getting Playerinfo for Alpha[BOT]\r\nAlpha[BOT] (Client)\r\nPlayerNum: 1\r\nIP: 127.0.1.1:0\r\n" +
      "Ship: Pyro-GL\r\n\r\nTotal Time In Game: 6 seconds\r\n\r\n";
    expect(parsePlayerinfo(raw)).toEqual({
      name: "Alpha[BOT]",
      role: "Client",
      slot: 1,
      team: null,
      ip: "127.0.1.1",
      port: 0,
      ship: "Pyro-GL",
    });
  });

  it("reads a team game's reply and the server's own", () => {
    const team = parsePlayerinfo("Bob (Client)\nTeam: Red\nPlayerNum: 4\nIP: 203.0.113.9:2092\nShip: Magnum-AHT\n");
    expect(team).toMatchObject({ name: "Bob", team: "Red", slot: 4, ip: "203.0.113.9", port: 2092 });
    const server = parsePlayerinfo("-Server- (Server)\nPlayerNum: 0\nIP: 0.0.0.0:0\nShip: Pyro-GL\n");
    expect(server).toMatchObject({ name: "-Server-", role: "Server", slot: 0 });
  });

  it("has no address when the engine printed none", () => {
    expect(parsePlayerinfo("Bob (Client)\nPlayerNum: 4\nShip: Pyro-GL\n")!.ip).toBeNull();
  });

  it("returns null for an empty reply (slot not in the game)", () => {
    expect(parsePlayerinfo("")).toBeNull();
  });
});
