import { describe, it, expect } from "vitest";
import {
  LineSplitter,
  humansIn,
  isBotCallsign,
  parsePlayersReply,
  parseServerLine,
} from "./serverLines.js";

describe("parseServerLine", () => {
  it("reads every game mode's welcome line as a join", () => {
    const lines = [
      "*Hunter has joined the Anarchy",
      "*Hunter has joined CTF",
      "*Hunter has joined the Hyper Anarchy!",
      "*Hunter has joined the Hoard",
      "*Hunter has joined the game",
      "*Hunter has joined the Red Team",
      "*Hunter Has Joined The Blue Team",
    ];
    for (const line of lines) {
      expect(parseServerLine(line), line).toEqual({ kind: "join", name: "Hunter" });
    }
  });

  it("keeps spaces in a callsign", () => {
    expect(parseServerLine("*Big Al has joined CTF")).toEqual({ kind: "join", name: "Big Al" });
  });

  it("reads the leave and disconnect lines", () => {
    expect(parseServerLine("*Hunter has left the game")).toEqual({ kind: "leave", name: "Hunter" });
    expect(parseServerLine("*Hunter disconnected!")).toEqual({ kind: "leave", name: "Hunter" });
    expect(parseServerLine("*Hunter disconnected")).toEqual({ kind: "leave", name: "Hunter" });
  });

  it("reads chat before anything a player could type into it", () => {
    expect(parseServerLine("*Hunter says: Eve has joined CTF")).toEqual({
      kind: "chat",
      name: "Hunter",
      text: "Eve has joined CTF",
    });
    expect(parseServerLine("*Hunter says: Bob disconnected!")).toMatchObject({ kind: "chat" });
  });

  it("does not let chat pose as a load-status prefix", () => {
    expect(parseServerLine("*Eve says: 100 Percent Complete*Bob has joined CTF")).toMatchObject({
      kind: "chat",
      name: "Eve",
    });
  });

  it("finds a HUD line glued after the level-load status", () => {
    expect(
      parseServerLine("Analyzing data...Batteries Included level 1 100 Percent Complete*Reaper[BOT] has joined CTF"),
    ).toEqual({ kind: "join", name: "Reaper[BOT]" });
    expect(parseServerLine("\b\b\b\b*Hunter has left the game\r")).toEqual({ kind: "leave", name: "Hunter" });
  });

  it("ignores other HUD messages", () => {
    expect(parseServerLine("*Reaper[BOT] joined to keep the game at 6 players.")).toBeNull();
    expect(parseServerLine("*Hunter was killed by Reaper[BOT]")).toBeNull();
  });

  it("reads level markers even with a debug log line glued on", () => {
    expect(
      parseServerLine("Opening level 'batteriesincluded.d3l'...2026-10-06 07:01:48.848 DEBUG [1098255] [FreeAllRooms@715] x"),
    ).toEqual({ kind: "level-opening", level: "batteriesincluded" });
    expect(parseServerLine("Ending level.2026-10-06 07:16:49.919 DEBUG [1] [MultiSendLevelEnded@3588] y")).toEqual({
      kind: "level-ending",
    });
  });

  it("never reads a level marker out of chat", () => {
    expect(parseServerLine("*Hunter says: Ending level.")).toMatchObject({ kind: "chat" });
  });

  it("reads the echo of a console quit", () => {
    expect(parseServerLine("[127.0.0.1] quit")).toEqual({ kind: "console-quit", from: "127.0.0.1" });
    expect(parseServerLine("[10.0.0.5] QUIT now")).toEqual({ kind: "console-quit", from: "10.0.0.5" });
    expect(parseServerLine("[127.0.0.1] $quit")).toBeNull();
    expect(parseServerLine("[127.0.0.1] quitter")).toBeNull();
  });

  it("returns null for anything else", () => {
    expect(parseServerLine("")).toBeNull();
    expect(parseServerLine("Remote host 127.0.0.1 logged in.")).toBeNull();
  });
});

describe("isBotCallsign", () => {
  it("matches the [BOT] suffix with or without a space", () => {
    expect(isBotCallsign("Phantom[BOT]")).toBe(true);
    expect(isBotCallsign("Phantom [BOT]")).toBe(true);
    expect(isBotCallsign("BOTany")).toBe(false);
    expect(isBotCallsign("[BOT]Hunter")).toBe(false);
  });
});

describe("parsePlayersReply", () => {
  it("parses the roster and skips other lines in the reply window", () => {
    const reply = "PNum Name\n00: Server\n01: Hunter\n*Hunter was killed by Phantom[BOT]\n02: Phantom[BOT]\n";
    const entries = parsePlayersReply(reply);
    expect(entries).toEqual([
      { slot: 0, name: "Server" },
      { slot: 1, name: "Hunter" },
      { slot: 2, name: "Phantom[BOT]" },
    ]);
    expect(humansIn(entries!)).toEqual(["Hunter"]);
  });

  it("returns an empty roster for a server with only itself", () => {
    expect(parsePlayersReply("PNum Name\r\n00: Server\r\n")).toEqual([{ slot: 0, name: "Server" }]);
  });

  it("returns null without the header", () => {
    expect(parsePlayersReply("")).toBeNull();
    expect(parsePlayersReply("Unknown command")).toBeNull();
  });
});

describe("LineSplitter", () => {
  it("joins lines split across chunks and keeps the tail", () => {
    const s = new LineSplitter();
    expect(s.push("*Hunter has jo")).toEqual([]);
    expect(s.push("ined CTF\n*Bob")).toEqual(["*Hunter has joined CTF"]);
    expect(s.push(" disconnected!\n")).toEqual(["*Bob disconnected!"]);
  });
});
