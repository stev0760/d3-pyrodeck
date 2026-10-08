import { describe, it, expect } from "vitest";
import { checkNickname, compileWordList, Escalation } from "./rules.js";
import {
  DEFAULT_PLAYER_RULES,
  DEFAULT_PROFANITY_WORDS,
  sanitizeStoredPlayerRules,
  validatePlayerRules,
  type PlayerRules,
} from "./ruleSettings.js";
import { RuleService } from "./RuleService.js";
import { ServerEvents } from "../events/ServerEvents.js";
import type { ConsoleLink } from "../players/consoleLink.js";

const ON = { ...DEFAULT_PLAYER_RULES.nickname, enabled: true };

describe("checkNickname", () => {
  it("passes ordinary names, and everything while off", () => {
    expect(checkNickname("stvLinux", ON)).toEqual({ ok: true });
    expect(checkNickname("ace mcnasty", ON)).toEqual({ ok: true });
    expect(checkNickname("", DEFAULT_PLAYER_RULES.nickname)).toEqual({ ok: true });
  });

  it("flags empty, %, control characters and short names", () => {
    expect(checkNickname("", ON)).toMatchObject({ ok: false, code: "empty", label: "INVALID NICKNAME" });
    expect(checkNickname("   ", ON)).toMatchObject({ ok: false, code: "empty" });
    expect(checkNickname("100%", ON)).toMatchObject({ ok: false, code: "percent", label: "INVALID NICKNAME" });
    expect(checkNickname("bad\x07name", ON)).toMatchObject({ ok: false, code: "control", label: "HACKED NICKNAME" });
    expect(checkNickname("x\x7f", ON)).toMatchObject({ ok: false, code: "control" });
    expect(checkNickname("ab", { ...ON, minLength: 3 })).toMatchObject({ ok: false, code: "short" });
    expect(checkNickname("abc", { ...ON, minLength: 3 })).toEqual({ ok: true });
  });

  it("checks only what is switched on", () => {
    expect(checkNickname("100%", { ...ON, rejectPercent: false })).toEqual({ ok: true });
    expect(checkNickname("", { ...ON, rejectEmpty: false })).toEqual({ ok: true });
  });
});

describe("compileWordList", () => {
  const match = compileWordList(["darn", "heck*", "go away"]);

  it("matches whole words without regard to case", () => {
    expect(match("well DARN it")).toBe("darn");
    expect(match("darnation")).toBeNull();
    expect(match("hecking fine")).toBe("heck*");
    expect(match("check this")).toBeNull();
    expect(match("just go   away!")).toBe("go away");
    expect(match("go-away")).toBe("go away");
    expect(match("nothing here")).toBeNull();
  });

  it("ships a default list as data, and it matches", () => {
    expect(DEFAULT_PROFANITY_WORDS.length).toBeGreaterThan(5);
    expect(compileWordList(DEFAULT_PROFANITY_WORDS)("this is bullshit")).toBe("bullshit");
    expect(compileWordList(DEFAULT_PROFANITY_WORDS)("Scunthorpe cocktail assessment")).toBeNull();
  });
});

describe("Escalation", () => {
  const policy = { warnings: 2, kicks: 1, ban: true, cooldownSeconds: 10 };

  it("warns, warns, kicks, bans, with a cooldown between counted offences", () => {
    const e = new Escalation(() => policy);
    const actions = [0, 1_000, 11_000, 22_000, 33_000].map((t) => e.hit("Bob", t).action);
    // the second line falls in the cooldown after the first warning
    expect(actions).toEqual(["warn", null, "warn", "kick", "ban"]);
    expect(e.list()[0]).toMatchObject({ name: "Bob", offences: 4, warnings: 2, kicks: 1, lastAction: "ban" });
  });

  it("keeps kicking when banning is off, and counts players apart (any case)", () => {
    const e = new Escalation(() => ({ ...policy, warnings: 0, ban: false }));
    expect(e.hit("Bob", 0).action).toBe("kick");
    expect(e.hit("bob", 20_000).action).toBe("kick");
    expect(e.hit("Eve", 20_000).action).toBe("kick");
    e.reset();
    expect(e.list()).toEqual([]);
  });

  it("goes straight to a ban with no warnings and no kicks", () => {
    const e = new Escalation(() => ({ ...policy, warnings: 0, kicks: 0 }));
    expect(e.hit("Bob", 0).action).toBe("ban");
  });
});

describe("rule settings", () => {
  it("are off by default", () => {
    expect(DEFAULT_PLAYER_RULES.nickname.enabled).toBe(false);
    expect(DEFAULT_PLAYER_RULES.profanity.enabled).toBe(false);
  });

  it("validate input and normalize the word list", () => {
    const ok = validatePlayerRules(
      { nickname: { enabled: true, minLength: "3" }, profanity: { words: " Darn \nheck*\n\ndarn", warnings: 1 } },
      DEFAULT_PLAYER_RULES,
    );
    expect(ok.errors).toEqual([]);
    expect(ok.rules.nickname).toMatchObject({ enabled: true, minLength: 3 });
    expect(ok.rules.profanity).toMatchObject({ words: ["darn", "heck*"], warnings: 1 });
    expect(validatePlayerRules({ profanity: { words: ["a*b"] } }, DEFAULT_PLAYER_RULES).errors).toHaveLength(1);
    expect(validatePlayerRules({ profanity: { cooldownSeconds: -1 } }, DEFAULT_PLAYER_RULES).errors).toHaveLength(1);
    expect(validatePlayerRules({ nickname: { enabled: "yes" } }, DEFAULT_PLAYER_RULES).errors).toHaveLength(1);
  });

  it("turn off when the stored rules are damaged", () => {
    const stored = sanitizeStoredPlayerRules({ nickname: { enabled: true, minLength: 99 }, profanity: { enabled: true } });
    expect(stored.nickname.enabled).toBe(false);
    expect(stored.profanity.enabled).toBe(false);
  });
});

describe("RuleService", () => {
  function setup(rules: PlayerRules) {
    const bus = new ServerEvents();
    const said: string[] = [];
    const calls: string[] = [];
    const link: ConsoleLink = {
      profileId: "p1",
      capabilities: { version: 0, fork: "", forkVersion: "", features: new Set() },
      send: async (cmd) => {
        said.push(cmd);
        return "";
      },
    };
    let now = 0;
    const svc = new RuleService({
      rules: () => rules,
      console: () => link,
      slotOf: (_p, name) => (name === "Bob" ? 3 : undefined),
      kick: async (_p, name, reason, slot) => {
        calls.push(`kick ${name} ${slot} ${reason}`);
        return { ok: true };
      },
      ban: async (_p, name, reason, opts) => {
        calls.push(`ban ${name} ${opts.slot} ${reason} hostsDeny=${opts.hostsDeny} nameBan=${opts.nameBan}`);
        return { ok: true };
      },
      bus,
      now: () => now,
      log: () => {},
    });
    svc.start();
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return {
      bus,
      said,
      calls,
      svc,
      flush,
      at: (t: number) => {
        now = t;
      },
    };
  }

  it("kicks a joining player whose name breaks a rule", async () => {
    const t = setup({ ...DEFAULT_PLAYER_RULES, nickname: ON });
    t.bus.emitEvent("player.identified", { profileId: "p1", name: "50%off", slot: 4 });
    t.bus.emitEvent("player.identified", { profileId: "p1", name: "Fine", slot: 5 });
    await t.flush();
    expect(t.calls).toEqual(["kick 50%off 4 INVALID NICKNAME (names cannot contain %)"]);
    expect(t.svc.recent()[0]).toMatchObject({ rule: "nickname", action: "kick", name: "50%off" });
  });

  it("escalates profanity: a private warning, a kick, then a name and address ban", async () => {
    const rules: PlayerRules = {
      ...DEFAULT_PLAYER_RULES,
      profanity: { ...DEFAULT_PLAYER_RULES.profanity, enabled: true, words: ["darn"], warnings: 1, kicks: 1 },
    };
    const t = setup(rules);
    t.bus.emitEvent("player.chat", { profileId: "p1", name: "Bob", text: "darn it" });
    await t.flush();
    t.at(20_000);
    t.bus.emitEvent("player.chat", { profileId: "p1", name: "Bob", text: "DARN" });
    await t.flush();
    t.at(40_000);
    t.bus.emitEvent("player.chat", { profileId: "p1", name: "Bob", text: "darn darn" });
    t.bus.emitEvent("player.chat", { profileId: "p1", name: "Bob", text: "clean line" });
    t.bus.emitEvent("player.chat", { profileId: "p1", name: "Viper[BOT]", text: "darn" });
    await t.flush();
    expect(t.said).toEqual(["say 3: Bob, watch your language. Last warning before a kick"]);
    expect(t.calls).toEqual(["kick Bob 3 language", "ban Bob 3 language hostsDeny=true nameBan=true"]);
    expect(t.svc.offenders("p1")[0]).toMatchObject({ name: "Bob", offences: 3 });
  });

  it("does nothing while the monitor is off", async () => {
    const t = setup(DEFAULT_PLAYER_RULES);
    t.bus.emitEvent("player.chat", { profileId: "p1", name: "Bob", text: "bullshit" });
    await t.flush();
    expect(t.said).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it("forgets the counts when the server restarts", async () => {
    const rules: PlayerRules = {
      ...DEFAULT_PLAYER_RULES,
      profanity: { ...DEFAULT_PLAYER_RULES.profanity, enabled: true, words: ["darn"] },
    };
    const t = setup(rules);
    t.bus.emitEvent("player.chat", { profileId: "p1", name: "Eve", text: "darn" });
    await t.flush();
    expect(t.said).toEqual(["say Eve, watch your language (warning 1 of 2)"]);
    t.bus.emitEvent("server.started", { profileId: "p1", pid: 2, args: [], reason: "relaunch" });
    await t.flush();
    expect(t.svc.offenders("p1")).toEqual([]);
  });
});
