import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addHostsEntry,
  checkHostsLine,
  matchesEntry,
  normalizeEntryInput,
  parseHostsFile,
  removeHostsEntry,
  serializeHostsFile,
} from "./hostsFile.js";
import { BanStore, checkNamePattern, defaultLocalDir, nameMatches } from "./BanStore.js";
import { BanService } from "./BanService.js";
import { ServerEvents, type ServerEventMap } from "../events/ServerEvents.js";
import type { ConsoleLink } from "../players/consoleLink.js";
import { sayToAll, sayToSlot } from "../players/playerActions.js";

// A queued state write may still land while the temp directory is being removed (ENOTEMPTY): retry.
const RM_TEMP = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 } as const;

describe("hosts.deny lines as DMFC's ParseHostsFile reads them", () => {
  it("accepts addresses and whole-part wildcards", () => {
    for (const [line, octets] of [
      ["203.0.113.9", [203, 0, 113, 9]],
      ["203.0.113.*", [203, 0, 113, null]],
      ["10.*.0.1", [10, null, 0, 1]],
      ["  \t198.51.100.007", [198, 51, 100, 7]],
      ["255.255.255.255", [255, 255, 255, 255]],
    ] as const) {
      expect(checkHostsLine(line)).toEqual({ ok: true, octets });
    }
  });

  it("ignores what the engine ignores", () => {
    for (const line of [
      "198.51.100.7 ", // trailing space: invalid character
      "# a comment",
      "203.0.113.0/24",
      "203.0.113", // three parts
      "1.2.3.4.5",
      "1.2.3.256",
      "1*.2.3.4", // * shares a part
      "0001.2.3.4",
      "1..3.4",
      "100.100.100.1000", // part too long
    ]) {
      expect(checkHostsLine(line).ok).toBe(false);
    }
    expect(checkHostsLine("")).toEqual({ ok: false, error: "" });
  });

  it("matches per part, * matching anything", () => {
    const octets = (checkHostsLine("10.*.0.1") as { octets: [number | null, number | null, number | null, number | null] })
      .octets;
    expect(matchesEntry(octets, "10.200.0.1")).toBe(true);
    expect(matchesEntry(octets, "10.200.0.2")).toBe(false);
  });

  it("round-trips a file, keeping lines the engine ignores where they were", () => {
    const content = "# bans\r\n203.0.113.*\r\n198.51.100.7 \r\n\r\n10.0.0.1\r\n";
    const lines = parseHostsFile(content);
    expect(lines.map((l) => [l.line, l.entry, l.error !== null])).toEqual([
      [1, null, true],
      [2, "203.0.113.*", false],
      [3, null, true],
      [4, null, false],
      [5, "10.0.0.1", false],
    ]);
    const out = serializeHostsFile(lines);
    expect(out).toBe("# bans\n203.0.113.*\n198.51.100.7 \n\n10.0.0.1\n");
    expect(parseHostsFile(out).map((l) => l.entry)).toEqual(lines.map((l) => l.entry));
  });

  it("adds an entry once and removes every line the engine reads as it", () => {
    const added = addHostsEntry("203.0.113.*\n", "198.51.100.7");
    expect(added).toEqual({ content: "203.0.113.*\n198.51.100.7\n", added: true });
    expect(addHostsEntry(added.content, "198.51.100.7").added).toBe(false);
    expect(removeHostsEntry("010.0.0.1\n# keep\n10.0.0.1\n", "10.0.0.1")).toEqual({ content: "# keep\n", removed: 2 });
    expect(addHostsEntry("", "10.0.0.1").content).toBe("10.0.0.1\n");
  });

  it("normalizes operator input to a line the engine reads", () => {
    expect(normalizeEntryInput(" 203.0.113.9 ")).toMatchObject({ ok: true, entry: "203.0.113.9" });
    expect(normalizeEntryInput("203.0.113.0/24")).toMatchObject({ ok: true, entry: "203.0.113.*" });
    expect(normalizeEntryInput("10.1.0.0/16")).toMatchObject({ ok: true, entry: "10.1.*.*" });
    expect(normalizeEntryInput("10.1.2.3/32")).toMatchObject({ ok: true, entry: "10.1.2.3" });
    expect(normalizeEntryInput("10.1.2.0/23").ok).toBe(false);
    expect(normalizeEntryInput("*.*.*.*").ok).toBe(false);
    expect(normalizeEntryInput("0/0").ok).toBe(false);
    expect(normalizeEntryInput("example.org").ok).toBe(false);
  });
});

describe("name bans", () => {
  it("match without regard to case, with a trailing * for a prefix", () => {
    expect(nameMatches("Griefer", "griefer")).toBe(true);
    expect(nameMatches("Griefer", "Griefer2")).toBe(false);
    expect(nameMatches("Grief*", "Griefer2")).toBe(true);
    expect(nameMatches("Grief*", "NotGrief")).toBe(false);
  });

  it("refuse patterns that would match everyone or that the matcher cannot read", () => {
    expect(checkNamePattern("*")).toHaveProperty("error");
    expect(checkNamePattern("  ")).toHaveProperty("error");
    expect(checkNamePattern("a*b")).toHaveProperty("error");
    expect(checkNamePattern(" Bob* ")).toEqual({ pattern: "Bob*" });
  });
});

describe("hosts.deny location", () => {
  it("is the engine's writable preference directory by default", () => {
    expect(defaultLocalDir({ XDG_DATA_HOME: "/x/data" }, "linux")).toBe("/x/data/Outrage Entertainment/Descent 3");
    expect(defaultLocalDir({}, "linux")).toBe(path.join(os.homedir(), ".local/share/Outrage Entertainment/Descent 3"));
    expect(defaultLocalDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toBe(
      "C:\\Users\\a\\AppData\\Roaming\\Outrage Entertainment\\Descent 3",
    );
  });

  it("prefers the setting, then the directory a launched server logged", async () => {
    const store = new BanStore(null);
    expect(store.hostsDenyPath(null).source).toBe("default");
    await store.setDetectedLocalDir("/srv/d3pref");
    expect(store.hostsDenyPath(null)).toEqual({ path: "/srv/d3pref/netgames/hosts.deny", source: "server log" });
    expect(store.hostsDenyPath("/etc/d3/hosts.deny")).toEqual({ path: "/etc/d3/hosts.deny", source: "setting" });
  });
});

describe("chat commands", () => {
  it("keep public text free of the colon the server reads as a destination", () => {
    expect(sayToAll("Bob kicked: spam")).toBe("say Bob kicked - spam");
    expect(sayToSlot(3, "warning: language")).toBe("say 3: warning: language");
    expect(sayToAll("50%\x01off")).toBe("say 50off");
    expect(sayToAll("Vote closed \u2014 next: Caf\u00e9")).toBe("say Vote closed  next - Caf");
  });
});

describe("BanService", () => {
  let dir: string;
  let sent: string[];
  let slots: Record<number, string>;
  let bus: ServerEvents;
  let svc: BanService;
  const events: Array<[string, unknown]> = [];

  const link: ConsoleLink = {
    profileId: "p1",
    capabilities: { version: 1, fork: "Matcen", forkVersion: "0.9.16", features: new Set() },
    send: async (cmd) => {
      sent.push(cmd);
      if (cmd === "$players") {
        return ["PNum Name", "00: -Server-", ...Object.entries(slots).map(([s, n]) => `${s.padStart(2, "0")}: ${n}`)].join(
          "\n",
        );
      }
      return "";
    },
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-bans-"));
    sent = [];
    slots = { 2: "Griefer", 3: "Bob" };
    events.length = 0;
    bus = new ServerEvents();
    for (const name of ["player.kicked", "player.banned"] as const) {
      bus.onEvent(name, (p: ServerEventMap[typeof name]) => events.push([name, p]));
    }
    svc = new BanService({
      store: new BanStore(path.join(dir, "bans.json")),
      console: () => link,
      openConsole: () => link,
      settings: () => ({ hostsDenyPath: path.join(dir, "netgames", "hosts.deny"), rehashOnLevelStart: true }),
      lookupAddress: async () => "203.0.113.9",
      bus,
      sleep: async () => {},
      log: () => {},
    });
    await svc.store.load();
    svc.start();
  });

  afterEach(async () => {
    svc.stop();
    await fs.rm(dir, RM_TEMP);
  });

  it("adds a hosts.deny entry with its note and sends $rehash", async () => {
    const result = await svc.addHostsDeny("203.0.113.0/24", "spam");
    expect(result).toMatchObject({ ok: true, entry: "203.0.113.*" });
    expect(await fs.readFile(path.join(dir, "netgames", "hosts.deny"), "utf-8")).toBe("203.0.113.*\n");
    expect(sent).toEqual(["$rehash"]);
    const view = await svc.readHostsDeny();
    expect(view.lines[0]).toMatchObject({ entry: "203.0.113.*", reason: "spam" });
    expect((await svc.removeHostsDeny("203.0.113.*")).ok).toBe(true);
    expect(await fs.readFile(path.join(dir, "netgames", "hosts.deny"), "utf-8")).toBe("");
  });

  it("kicks with the reason said first", async () => {
    const result = await svc.kick("p1", "Bob", "camping the flag");
    expect(result.ok).toBe(true);
    expect(sent).toEqual(["$players", "say Bob kicked - camping the flag", "$players", "$kick 3"]);
    expect(events).toEqual([["player.kicked", { profileId: "p1", name: "Bob", reason: "camping the flag" }]]);
  });

  it("does not kick a slot that changed hands while it waited", async () => {
    const svcSleep = svc as unknown as { deps: { sleep: () => Promise<void> } };
    svcSleep.deps.sleep = async () => {
      slots[3] = "Newcomer";
    };
    const result = await svc.kick("p1", "Bob", "x");
    expect(result.ok).toBe(false);
    expect(sent.some((c) => c.startsWith("$kick"))).toBe(false);
  });

  it("bans: $ban, the address into hosts.deny, the name into the list", async () => {
    const result = await svc.ban("p1", "Griefer", "team killing", { hostsDeny: true, nameBan: true });
    expect(result).toMatchObject({ ok: true, ip: "203.0.113.9" });
    expect(sent).toEqual([
      "$players",
      "say Griefer banned - team killing",
      "$players",
      "$ban 2",
      "$rehash",
    ]);
    expect(await fs.readFile(path.join(dir, "netgames", "hosts.deny"), "utf-8")).toBe("203.0.113.9\n");
    expect(svc.store.findNameBan("griefer")?.reason).toBe("team killing");
    expect(events).toEqual([
      ["player.banned", { profileId: "p1", name: "Griefer", ip: "203.0.113.9", reason: "team killing" }],
    ]);
  });

  it("refuses to ban a bot and never denies the server machine's own address", async () => {
    expect(await svc.ban("p1", "Alpha[BOT]", "x", { hostsDeny: true, nameBan: false })).toMatchObject({ ok: false });
    const local = svc as unknown as { deps: { lookupAddress: () => Promise<string> } };
    local.deps.lookupAddress = async () => "127.0.0.1";
    const result = await svc.ban("p1", "Bob", "x", { hostsDeny: true, nameBan: false });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.message).toContain("not added to hosts.deny");
    expect(sent).not.toContain("$rehash");
  });

  it("kicks a banned name when it joins, and sends $rehash at a level start", async () => {
    await svc.addNameBan("Grief*", "banned name");
    bus.emitEvent("player.identified", { profileId: "p1", name: "Griefer", slot: 2 });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["say Griefer kicked - banned name", "$players", "$kick 2"]);
    expect(events[0]).toEqual([
      "player.kicked",
      { profileId: "p1", name: "Griefer", reason: "name ban: banned name" },
    ]);
    sent.length = 0;
    bus.emitEvent("level.started", { profileId: "p1", level: "Apparition" });
    expect(sent).toEqual(["$rehash"]);
  });
});
