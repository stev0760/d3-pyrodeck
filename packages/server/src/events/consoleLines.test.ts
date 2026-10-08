import { describe, it, expect, vi, afterEach } from "vitest";
import { LineSplitter, isBotName, parseConsoleLine } from "./consoleLines.js";
import { ConsoleEventSource } from "./ConsoleEventSource.js";
import { ServerEvents, type ServerEventMap } from "./ServerEvents.js";

describe("parseConsoleLine", () => {
  it("reads every game mode's join line (strings printed by a Matcen 0.9.16 server)", () => {
    const lines = [
      "*Alpha[BOT] has joined the Anarchy",
      "*Viper[BOT] has joined CTF",
      "*Zed[BOT] has joined the Hyper Anarchy!",
      "*Zed[BOT] has joined the Red Team",
      "*Hawk[BOT] Has Joined The Blue Team",
      "*stvLinux has joined the Hoard",
      "*ace mcnasty has joined the game",
    ];
    expect(lines.map((l) => parseConsoleLine(l))).toEqual([
      { kind: "join", name: "Alpha[BOT]" },
      { kind: "join", name: "Viper[BOT]" },
      { kind: "join", name: "Zed[BOT]" },
      { kind: "join", name: "Zed[BOT]" },
      { kind: "join", name: "Hawk[BOT]" },
      { kind: "join", name: "stvLinux" },
      { kind: "join", name: "ace mcnasty" },
    ]);
  });

  it("reads empty and blank names (modified clients)", () => {
    expect(parseConsoleLine("* has joined the Anarchy")).toEqual({ kind: "join", name: "" });
    expect(parseConsoleLine("*   has joined CTF")).toEqual({ kind: "join", name: "  " });
    expect(parseConsoleLine("* disconnected!")).toEqual({ kind: "leave", name: "", how: "dropped" });
  });

  it("reads both leave lines", () => {
    expect(parseConsoleLine("*stvLinux has left the game")).toEqual({ kind: "leave", name: "stvLinux", how: "left" });
    expect(parseConsoleLine("*stvLinux disconnected!")).toEqual({ kind: "leave", name: "stvLinux", how: "dropped" });
  });

  it("reads the bot console replies with their slots", () => {
    expect(parseConsoleLine("Bot 'Alpha[BOT]' added in slot 1 (ship=Pyro-GL, diff=Hotshot, team=1)")).toEqual({
      kind: "bot-added",
      name: "Alpha[BOT]",
      slot: 1,
    });
    expect(parseConsoleLine("  Bot 'Viper[BOT]' spawned (ship=Phoenix, diff=Ace, team=2, slot=4)")).toEqual({
      kind: "bot-added",
      name: "Viper[BOT]",
      slot: 4,
    });
    expect(parseConsoleLine("Removing bot 'Alpha[BOT]' from slot 1")).toEqual({
      kind: "bot-removed",
      name: "Alpha[BOT]",
      slot: 1,
    });
    expect(parseConsoleLine("All bots removed")).toEqual({ kind: "bots-cleared" });
  });

  it("reads chat, keeping the text whole (colons and all)", () => {
    expect(parseConsoleLine("*stvLinux says: gg: well played")).toEqual({
      kind: "chat",
      name: "stvLinux",
      text: "gg: well played",
    });
  });

  it("never reads a chat message as a join or leave", () => {
    expect(parseConsoleLine("*Bob says: Eve has joined the Anarchy")).toEqual({
      kind: "chat",
      name: "Bob",
      text: "Eve has joined the Anarchy",
    });
    expect(parseConsoleLine("*Bob says: x disconnected!")?.kind).toBe("chat");
  });

  it("reads the level being opened, even glued to 'Ending level.'", () => {
    expect(parseConsoleLine("Opening level 'Apparition.d3l'...")).toEqual({ kind: "level", level: "Apparition" });
    expect(parseConsoleLine("Ending level.Opening level 'TheCore.d3l'...")).toEqual({
      kind: "level",
      level: "TheCore",
    });
    expect(parseConsoleLine("Ending level.*Bob has joined CTF")).toEqual({ kind: "join", name: "Bob" });
  });

  it("ignores echoes, replies and other HUD lines", () => {
    for (const line of [
      "[127.0.0.1] say hello",
      "01: Alpha[BOT]",
      "*Rehashing Hosts.allow and Hosts.deny",
      "*Viper[BOT] was killed by Hawk[BOT]",
      "*Getting Playerinfo for Alpha[BOT]",
      "",
    ]) {
      expect(parseConsoleLine(line)).toBeNull();
    }
  });
});

describe("isBotName", () => {
  it("knows the engine's bot tag, old and new", () => {
    expect(isBotName("Viper[BOT]")).toBe(true);
    expect(isBotName("[BOT] Reaper")).toBe(true);
    expect(isBotName("stvLinux")).toBe(false);
  });
});

describe("LineSplitter", () => {
  it("joins lines split across chunks and holds a partial line", () => {
    const s = new LineSplitter();
    expect(s.push("*Bob has jo")).toEqual([]);
    expect(s.push("ined CTF\r\n*Eve says: hi\r")).toEqual(["*Bob has joined CTF"]);
    expect(s.push("\nnext")).toEqual(["*Eve says: hi"]);
  });
});

describe("ConsoleEventSource", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function collect(bus: ServerEvents) {
    const events: Array<[string, unknown]> = [];
    for (const name of ["player.joined", "player.left", "player.chat", "level.started"] as const) {
      bus.onEvent(name, (p: ServerEventMap[typeof name]) => events.push([name, p]));
    }
    return events;
  }

  it("emits a bot join with the slot from the line that follows it, and its removal", () => {
    vi.useFakeTimers();
    const bus = new ServerEvents();
    const events = collect(bus);
    const src = new ConsoleEventSource("p1", bus);
    src.feed(
      "[127.0.0.1] $addbot Alpha\r\n*Alpha[BOT] has joined the Anarchy\r\n" +
        "Bot 'Alpha[BOT]' added in slot 1 (ship=Pyro-GL, diff=Hotshot, team=1)\r\n",
    );
    src.feed("Removing bot 'Alpha[BOT]' from slot 1\r\n");
    expect(events).toEqual([
      ["player.joined", { profileId: "p1", name: "Alpha[BOT]", bot: true, slot: 1 }],
      ["player.left", { profileId: "p1", name: "Alpha[BOT]", slot: 1, bot: true, reason: "bot removed" }],
    ]);
  });

  it("emits a bot join without a slot when no slot line comes", () => {
    vi.useFakeTimers();
    const bus = new ServerEvents();
    const events = collect(bus);
    const src = new ConsoleEventSource("p1", bus);
    src.feed("*Viper[BOT] has joined CTF\r\n");
    expect(events).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(events).toEqual([["player.joined", { profileId: "p1", name: "Viper[BOT]", bot: true }]]);
  });

  it("removes every bot it knows on 'All bots removed'", () => {
    vi.useFakeTimers();
    const bus = new ServerEvents();
    const events = collect(bus);
    const src = new ConsoleEventSource("p1", bus);
    src.feed("  Bot 'A[BOT]' spawned (ship=Pyro-GL, diff=Ace, team=1, slot=1)\r\n*A[BOT] has joined CTF\r\n");
    src.feed("*B[BOT] has joined CTF\r\nBot 'B[BOT]' added in slot 2 (ship=Pyro-GL, diff=Ace, team=2)\r\n");
    src.feed("All bots removed\r\n");
    const left = events.filter(([n]) => n === "player.left").map(([, p]) => (p as { name: string }).name);
    expect(left).toEqual(["A[BOT]", "B[BOT]"]);
  });

  it("emits human joins, leaves, chat (not the server's own) and level starts", () => {
    const bus = new ServerEvents();
    const events = collect(bus);
    const src = new ConsoleEventSource("p1", bus);
    src.feed("Opening level 'Apparition.d3l'...\r\n*Bob has joined the Anarchy\r\n");
    src.feed("*Bob says: hello\r\n*-Server- says: welcome\r\n*Bob disconnected!\r\n");
    expect(events).toEqual([
      ["level.started", { profileId: "p1", level: "Apparition" }],
      ["player.joined", { profileId: "p1", name: "Bob", bot: false }],
      ["player.chat", { profileId: "p1", name: "Bob", text: "hello" }],
      ["player.left", { profileId: "p1", name: "Bob", bot: false, reason: "disconnected" }],
    ]);
  });
});
