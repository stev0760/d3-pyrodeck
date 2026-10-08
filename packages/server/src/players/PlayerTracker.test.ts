import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServerEvents, type ServerEventMap } from "../events/ServerEvents.js";
import { PlayerTracker, LEVEL_REJOIN_GRACE_MS } from "./PlayerTracker.js";
import { PlayerHistory, MAX_ROWS } from "./PlayerHistory.js";
import { decideIpLookup, engineClearsTextBuffer, type ConsoleLink } from "./consoleLink.js";
import type { ServerCapabilities } from "../parser/parsers/servercaps.js";

const MATCEN: ServerCapabilities = { version: 1, fork: "Matcen", forkVersion: "0.9.16", features: new Set(["bots"]) };
const VANILLA: ServerCapabilities = { version: 0, fork: "", forkVersion: "", features: new Set() };

/** A console that answers $players and $playerinfo from a slot table. */
function fakeConsole(slots: Record<number, { name: string; ip?: string }>, caps = MATCEN) {
  const sent: string[] = [];
  const link: ConsoleLink = {
    profileId: "p1",
    capabilities: caps,
    send: async (cmd) => {
      sent.push(cmd);
      if (cmd === "$players") {
        return ["PNum Name", "00: -Server-", ...Object.entries(slots).map(([s, p]) => `${s.padStart(2, "0")}: ${p.name}`)].join(
          "\r\n",
        );
      }
      const m = /^\$playerinfo (\d+)$/.exec(cmd);
      if (m) {
        const p = slots[Number(m[1])];
        if (!p) return "";
        return `*Getting Playerinfo for ${p.name}\r\n${p.name} (Client)\r\nPlayerNum: ${m[1]}\r\nIP: ${p.ip ?? "0.0.0.0"}:2092\r\nShip: Pyro-GL\r\n`;
      }
      return "";
    },
  };
  return { link, sent };
}

function setup(slots: Record<number, { name: string; ip?: string }>, caps = MATCEN, budget = 20) {
  const bus = new ServerEvents();
  const { link, sent } = fakeConsole(slots, caps);
  let now = Date.parse("2026-10-07T20:00:00Z");
  const tracker = new PlayerTracker({
    historyDir: null,
    console: () => link,
    ipLookup: () => ({ enabled: true, budget }),
    bus,
    now: () => now,
    log: () => {},
  });
  tracker.start();
  const identified: ServerEventMap["player.identified"][] = [];
  bus.onEvent("player.identified", (p) => identified.push(p));
  return {
    bus,
    tracker,
    sent,
    identified,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("PlayerTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a human join with the slot and address, then the leave", async () => {
    const t = setup({ 3: { name: "Bob", ip: "203.0.113.9" } });
    t.bus.emitEvent("player.joined", { profileId: "p1", name: "Bob", bot: false });
    await t.tracker.idle("p1");
    t.bus.emitEvent("player.left", { profileId: "p1", name: "Bob", bot: false, reason: "left the game" });
    await t.tracker.idle("p1");

    expect(t.sent).toEqual(["$players", "$playerinfo 3"]);
    expect(t.identified).toEqual([{ profileId: "p1", name: "Bob", slot: 3, ip: "203.0.113.9" }]);
    const h = await t.tracker.history("p1");
    const rows = h.search().rows.reverse();
    expect(rows.map((r) => [r.event, r.name, r.slot, r.ip, r.reason])).toEqual([
      ["join", "Bob", 3, "203.0.113.9", undefined],
      ["leave", "Bob", 3, "203.0.113.9", "left the game"],
    ]);
    expect(h.addresses("bob")).toMatchObject([{ name: "Bob", ip: "203.0.113.9", count: 1 }]);
  });

  it("treats a join while present as a level re-entry: no row, no query", async () => {
    const t = setup({ 3: { name: "Bob" } });
    t.bus.emitEvent("player.joined", { profileId: "p1", name: "Bob", bot: false });
    t.bus.emitEvent("player.joined", { profileId: "p1", name: "Bob", bot: false });
    await t.tracker.idle("p1");
    expect((await t.tracker.history("p1")).rowCount).toBe(1);
    expect(t.sent.filter((c) => c.startsWith("$playerinfo"))).toHaveLength(1);
  });

  it("never queries a bot", async () => {
    const t = setup({ 1: { name: "Alpha[BOT]" } });
    t.bus.emitEvent("player.joined", { profileId: "p1", name: "Alpha[BOT]", bot: true, slot: 1 });
    t.bus.emitEvent("player.left", { profileId: "p1", name: "Alpha[BOT]", bot: true, slot: 1, reason: "bot removed" });
    await t.tracker.idle("p1");
    expect(t.sent).toEqual([]);
    const rows = (await t.tracker.history("p1")).search().rows.reverse();
    expect(rows.map((r) => [r.event, r.name, r.slot, r.bot])).toEqual([
      ["join", "Alpha[BOT]", 1, true],
      ["leave", "Alpha[BOT]", 1, true],
    ]);
  });

  it("stops querying an engine that keeps its text buffer once the budget is used", async () => {
    const t = setup({ 1: { name: "A" }, 2: { name: "B" }, 3: { name: "C" } }, VANILLA, 2);
    for (const name of ["A", "B", "C"]) t.bus.emitEvent("player.joined", { profileId: "p1", name, bot: false });
    await t.tracker.idle("p1");
    expect(t.sent.filter((c) => c.startsWith("$playerinfo"))).toEqual(["$playerinfo 1", "$playerinfo 2"]);
    expect(t.identified.map((p) => [p.name, p.slot])).toEqual([
      ["A", 1],
      ["B", 2],
      ["C", 3],
    ]);
    expect(t.tracker.lookupsUsed("p1")).toBe(2);
  });

  it("refuses an address it cannot verify (DMFC repeats the previous player for a gone slot)", async () => {
    const t = setup({ 3: { name: "Bob" } });
    // $players says slot 3 but $playerinfo answers for someone else.
    const original = t.tracker["opts"].console;
    t.tracker["opts"].console = () => {
      const link = original("p1")!;
      return {
        ...link,
        send: async (cmd: string) =>
          cmd.startsWith("$playerinfo") ? "Eve (Client)\r\nPlayerNum: 2\r\nIP: 198.51.100.1:2092\r\n" : link.send(cmd),
      };
    };
    t.bus.emitEvent("player.joined", { profileId: "p1", name: "Bob", bot: false });
    await t.tracker.idle("p1");
    expect(t.identified).toEqual([{ profileId: "p1", name: "Bob", slot: 3 }]);
  });

  it("closes sessions of players who did not come back after a level change", async () => {
    vi.useFakeTimers();
    const t = setup({ 1: { name: "Stays" } });
    t.bus.emitEvent("player.joined", { profileId: "p1", name: "Stays", bot: false });
    t.bus.emitEvent("player.joined", { profileId: "p1", name: "Gone", bot: false });
    t.bus.emitEvent("player.joined", { profileId: "p1", name: "Back[BOT]", bot: true });
    await t.tracker.idle("p1");
    t.advance(1000);
    t.bus.emitEvent("level.started", { profileId: "p1", level: "Apparition" });
    t.advance(1000);
    t.bus.emitEvent("player.joined", { profileId: "p1", name: "Back[BOT]", bot: true });
    await t.tracker.idle("p1");
    t.advance(LEVEL_REJOIN_GRACE_MS);
    await vi.advanceTimersByTimeAsync(LEVEL_REJOIN_GRACE_MS);
    await t.tracker.idle("p1");
    const leaves = (await t.tracker.history("p1")).search().rows.filter((r) => r.event === "leave");
    expect(leaves.map((r) => [r.name, r.reason])).toEqual([["Gone", "not back after a level change"]]);
  });

  it("ends every open session when the server stops", async () => {
    const t = setup({ 1: { name: "Bob" } });
    t.bus.emitEvent("player.joined", { profileId: "p1", name: "Bob", bot: false });
    t.bus.emitEvent("server.stopped", { profileId: "p1", pid: 1, reason: "manual" });
    await t.tracker.idle("p1");
    const rows = (await t.tracker.history("p1")).search().rows;
    expect(rows[0]).toMatchObject({ event: "leave", name: "Bob", reason: "server stopped" });
    expect(t.tracker.present("p1")).toEqual([]);
  });
});

describe("PlayerHistory", () => {
  it("pairs joins and leaves into sessions and answers 'who was on'", async () => {
    const h = await PlayerHistory.open("p1", null);
    h.recordJoin({ name: "Bob", ip: "203.0.113.9", time: new Date("2026-10-07T18:00:00Z") });
    h.recordJoin({ name: "Eve", time: new Date("2026-10-07T19:00:00Z") });
    h.recordLeave({ name: "Bob", reason: "left the game", time: new Date("2026-10-07T19:30:00Z") });
    h.recordJoin({ name: "Zed", time: new Date("2026-10-07T21:00:00Z") });

    const at1915 = h.sessions({ from: new Date("2026-10-07T19:15:00Z"), to: new Date("2026-10-07T19:15:00Z") });
    expect(at1915.map((s) => [s.name, s.leftAt])).toEqual([
      ["Eve", null],
      ["Bob", "2026-10-07T19:30:00.000Z"],
    ]);
    expect(h.sessions({ q: "203.0.113" }).map((s) => s.name)).toEqual(["Bob"]);
  });

  it("ends a session that never saw its leave when the same name joins again", async () => {
    const h = await PlayerHistory.open("p1", null);
    h.recordJoin({ name: "Bob", time: new Date("2026-10-07T18:00:00Z") });
    h.recordJoin({ name: "Bob", time: new Date("2026-10-07T20:00:00Z") });
    expect(h.sessions().map((s) => [s.joinedAt, s.leftAt, s.reason])).toEqual([
      ["2026-10-07T20:00:00.000Z", null, undefined],
      ["2026-10-07T18:00:00.000Z", "2026-10-07T20:00:00.000Z", "no leave seen"],
    ]);
  });

  it("searches by name or address, newest first", async () => {
    const h = await PlayerHistory.open("p1", null);
    h.recordJoin({ name: "Bob", ip: "203.0.113.9" });
    h.recordJoin({ name: "bobby" });
    h.recordJoin({ name: "Eve", ip: "198.51.100.4" });
    expect(h.search({ q: "BOB" }).rows.map((r) => r.name)).toEqual(["bobby", "Bob"]);
    expect(h.search({ q: "198.51" }).rows.map((r) => r.name)).toEqual(["Eve"]);
  });

  it("caps the rows, dropping the oldest", async () => {
    const h = await PlayerHistory.open("p1", null);
    for (let i = 0; i < MAX_ROWS + 10; i++) h.recordJoin({ name: `p${i}` });
    expect(h.rowCount).toBe(MAX_ROWS);
    expect(h.search({ limit: 1000 }).total).toBe(MAX_ROWS);
    expect(h.sessions().at(-1)?.name).toBe("p10");
  });

  it("persists to disk and reads it back", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-history-"));
    try {
      const h = await PlayerHistory.open("connect:203.0.113.1:2092", dir);
      const row = h.recordJoin({ name: "Bob" });
      h.update(row.id, { slot: 2, ip: "203.0.113.9" });
      await h.flush();
      expect(await fs.readdir(dir)).toEqual(["connect_203.0.113.1_2092.json"]);
      const again = await PlayerHistory.open("connect:203.0.113.1:2092", dir);
      expect(again.search().rows[0]).toMatchObject({ name: "Bob", slot: 2, ip: "203.0.113.9" });
      expect(again.recordJoin({ name: "Eve" }).id).toBe(row.id + 1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("IP lookup rationing", () => {
  it("knows which engines clear the text buffer", () => {
    expect(engineClearsTextBuffer(MATCEN)).toBe(true);
    expect(engineClearsTextBuffer({ ...MATCEN, forkVersion: "0.9.3" })).toBe(true);
    expect(engineClearsTextBuffer({ ...MATCEN, forkVersion: "0.9.2" })).toBe(false);
    expect(engineClearsTextBuffer({ ...MATCEN, forkVersion: "0.10.0" })).toBe(true);
    expect(engineClearsTextBuffer(VANILLA)).toBe(false);
  });

  it("never queries a name with %, and honours the switch and the budget", () => {
    const on = { enabled: true, budget: 2 };
    expect(decideIpLookup(on, MATCEN, "50%off", 0).allowed).toBe(false);
    expect(decideIpLookup({ ...on, enabled: false }, MATCEN, "Bob", 0).allowed).toBe(false);
    expect(decideIpLookup(on, MATCEN, "Bob", 99).allowed).toBe(true);
    expect(decideIpLookup(on, VANILLA, "Bob", 1).allowed).toBe(true);
    expect(decideIpLookup(on, VANILLA, "Bob", 2).allowed).toBe(false);
  });
});
