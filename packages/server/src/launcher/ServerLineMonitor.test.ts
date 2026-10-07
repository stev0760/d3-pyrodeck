import { describe, it, expect, beforeEach } from "vitest";
import { ServerEvents } from "../events/ServerEvents.js";
import { ServerLineMonitor } from "./ServerLineMonitor.js";

describe("ServerLineMonitor", () => {
  let events: ServerEvents;
  let monitor: ServerLineMonitor;
  let seen: string[];

  beforeEach(() => {
    events = new ServerEvents();
    monitor = new ServerLineMonitor(events);
    seen = [];
    events.onEvent("player.joined", (p) => seen.push(`joined ${p.profileId} ${p.name}`));
    events.onEvent("player.left", (p) => seen.push(`left ${p.profileId} ${p.name}`));
    events.onEvent("player.chat", (p) => seen.push(`chat ${p.name}: ${p.text}`));
    events.onEvent("level.started", (p) => seen.push(`level ${p.profileId} ${p.level}`));
    monitor.reset("ctf");
  });

  it("reports humans and level starts, never bots", () => {
    monitor.push("Opening level 'abend2.d3l'...\n*Reaper[BOT] has joined CTF\n*Hunter has joined CTF\n");
    monitor.push("*Hunter says: gg\n*Reaper[BOT] left to keep the game at 6 players.\n*Hunter has left the game\n");
    expect(seen).toEqual([
      "level ctf abend2",
      "joined ctf Hunter",
      "chat Hunter: gg",
      "left ctf Hunter",
    ]);
  });

  it("drops a partial line when a new process starts", () => {
    monitor.push("*Hunter has jo");
    monitor.reset("anarchy");
    monitor.push("*Bob has joined the Anarchy\n");
    expect(seen).toEqual(["joined anarchy Bob"]);
  });

  it("passes the console quit echo to its callback", () => {
    const quits: string[] = [];
    monitor.onConsoleQuit = (from) => quits.push(from);
    monitor.push("[192.168.1.4] quit\n");
    expect(quits).toEqual(["192.168.1.4"]);
  });
});
