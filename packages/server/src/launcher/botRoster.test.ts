import { describe, it, expect } from "vitest";
import {
  parseBotRoster,
  generateBotRoster,
  updateBotRoster,
  normalizeBotRoster,
  MAX_ROSTER_BOTS,
} from "./botRoster.js";
import { SAMPLE_BOT_ROSTER } from "./sampleBotRoster.js";

const BASIC =
  "BotCount=3\n" +
  "BotDifficulty=hotshot\n" +
  "BotName1=Viper\n" +
  "BotShip1=pyro\n" +
  "BotName2=Reaper\n" +
  "BotShip2=phoenix\n" +
  "BotDifficulty2=ace\n" +
  "BotName3=Shadow\n" +
  "BotShip3=blackpyro\n";

describe("parseBotRoster", () => {
  it("parses a basic roster", () => {
    const r = parseBotRoster(BASIC);
    expect(r.botCount).toBe(3);
    expect(r.defaultDifficulty).toBe("hotshot");
    expect(r.targetPlayers).toBeUndefined();
    expect(r.reservedSlots).toBeUndefined();
    expect(r.bots).toEqual([
      { name: "Viper", ship: "pyro", difficulty: undefined, team: undefined },
      { name: "Reaper", ship: "phoenix", difficulty: "ace", team: undefined },
      { name: "Shadow", ship: "blackpyro", difficulty: undefined, team: undefined },
    ]);
  });

  it("reads the population keys and every entry, not only the first BotCount", () => {
    const r = parseBotRoster(SAMPLE_BOT_ROSTER);
    expect(r.botCount).toBe(4);
    expect(r.targetPlayers).toBe(12);
    expect(r.reservedSlots).toBe(1);
    expect(r.bots.map((b) => b.name)).toEqual(["Reaper", "Phantom", "Viper", "Shadow"]);
    expect(r.bots[0]).toEqual({ name: "Reaper", ship: "pyro", difficulty: "ace", team: 1 });

    const pool = parseBotRoster("BotCount=1\nBotName1=A\nBotName2=B\nBotName3=C\n");
    expect(pool.botCount).toBe(1);
    expect(pool.bots).toHaveLength(3);
  });

  it("is case-insensitive about keys and tolerant of spaces", () => {
    const r = parseBotRoster("botcount = 2\nBOTTARGETPLAYERS=6\nbotreservedslots=2\nbotname1 = Alpha\nBOTSHIP1=magnum\n");
    expect(r.botCount).toBe(2);
    expect(r.targetPlayers).toBe(6);
    expect(r.reservedSlots).toBe(2);
    expect(r.bots[0]).toMatchObject({ name: "Alpha", ship: "magnum" });
  });

  it("clamps BotCount, raises a reserve below 1, and skips entries without a name", () => {
    const r = parseBotRoster("BotCount=40\nBotReservedSlots=0\nBotShip1=pyro\nBotName2=Beta\n");
    expect(r.botCount).toBe(MAX_ROSTER_BOTS);
    expect(r.reservedSlots).toBe(1);
    expect(r.bots).toEqual([{ name: "Beta", ship: undefined, difficulty: undefined, team: undefined }]);
  });

  it("ignores teams outside 1-4", () => {
    const r = parseBotRoster("BotCount=1\nBotName1=A\nBotTeam1=7\n");
    expect(r.bots[0].team).toBeUndefined();
  });
});

describe("generateBotRoster", () => {
  it("writes BotCount as given, the population keys when set, then the entries", () => {
    const out = generateBotRoster({
      botCount: 2,
      defaultDifficulty: "hotshot",
      targetPlayers: 8,
      reservedSlots: 1,
      bots: [
        { name: "Viper", ship: "pyro" },
        { name: "Reaper", ship: "phoenix", difficulty: "ace", team: 2 },
        { name: "Pool" },
      ],
    });
    expect(out).toBe(
      "BotCount=2\n" +
        "BotTargetPlayers=8\n" +
        "BotReservedSlots=1\n" +
        "BotDifficulty=hotshot\n" +
        "BotName1=Viper\n" +
        "BotShip1=pyro\n" +
        "BotName2=Reaper\n" +
        "BotShip2=phoenix\n" +
        "BotDifficulty2=ace\n" +
        "BotTeam2=2\n" +
        "BotName3=Pool\n",
    );
  });

  it("leaves out the population keys when they are not set", () => {
    const out = generateBotRoster({ botCount: 1, bots: [{ name: "A" }] });
    expect(out).toBe("BotCount=1\nBotName1=A\n");
  });

  it("round-trips", () => {
    const original = {
      botCount: 1,
      defaultDifficulty: "rookie",
      targetPlayers: 10,
      reservedSlots: 2,
      bots: [
        { name: "Alpha", ship: "pyro" },
        { name: "Beta", ship: "magnum", difficulty: "insane", team: 3 },
      ],
    };
    const again = parseBotRoster(generateBotRoster(original));
    expect(again).toEqual({
      ...original,
      bots: [
        { name: "Alpha", ship: "pyro", difficulty: undefined, team: undefined },
        { name: "Beta", ship: "magnum", difficulty: "insane", team: 3 },
      ],
    });
  });
});

describe("updateBotRoster", () => {
  it("round-trips the Matcen sample byte for byte", () => {
    const parsed = parseBotRoster(SAMPLE_BOT_ROSTER);
    expect(updateBotRoster(SAMPLE_BOT_ROSTER, parsed)).toBe(SAMPLE_BOT_ROSTER);
  });

  it("changes one ship with a one-line diff", () => {
    const parsed = parseBotRoster(SAMPLE_BOT_ROSTER);
    parsed.bots[1].ship = "magnum";
    const out = updateBotRoster(SAMPLE_BOT_ROSTER, parsed);
    const before = SAMPLE_BOT_ROSTER.split("\n");
    const after = out.split("\n");
    expect(after).toHaveLength(before.length);
    const changed = before.map((l, i) => [l, after[i]]).filter(([a, b]) => a !== b);
    expect(changed).toEqual([["BotShip2=phoenix", "BotShip2=magnum"]]);
  });

  it("keeps comments and the population keys when only the bots change", () => {
    const parsed = parseBotRoster(SAMPLE_BOT_ROSTER);
    parsed.bots.push({ name: "Ghost", ship: "blackpyro" });
    const out = updateBotRoster(SAMPLE_BOT_ROSTER, parsed);
    expect(out).toContain("BotTargetPlayers=12\n");
    expect(out).toContain("BotReservedSlots=1\n");
    expect(out).toContain("; Seats always left free for humans (default 1, minimum 1).\n");
    expect(out.endsWith("BotName4=Shadow\nBotName5=Ghost\nBotShip5=blackpyro\n")).toBe(true);
  });

  it("shrinks the roster by removing only the later entries", () => {
    const parsed = parseBotRoster(SAMPLE_BOT_ROSTER);
    parsed.bots = parsed.bots.slice(0, 2);
    const out = updateBotRoster(SAMPLE_BOT_ROSTER, parsed);
    expect(out).toBe(SAMPLE_BOT_ROSTER.replace("BotName3=Viper\nBotName4=Shadow\n", ""));
  });

  it("adds missing population keys after BotCount, in order", () => {
    const existing = "; my roster\nBotCount=2\nBotDifficulty=ace\nBotName1=A\nBotName2=B\n";
    const parsed = parseBotRoster(existing);
    parsed.targetPlayers = 6;
    parsed.reservedSlots = 1;
    expect(updateBotRoster(existing, parsed)).toBe(
      "; my roster\nBotCount=2\nBotTargetPlayers=6\nBotReservedSlots=1\nBotDifficulty=ace\nBotName1=A\nBotName2=B\n",
    );
  });

  it("leaves a scalar alone when the data does not mention it", () => {
    const existing = "BotCount=1\nBotTargetPlayers=12\nBotDifficulty=ace\nBotName1=A\n";
    const out = updateBotRoster(existing, { botCount: 1, bots: [{ name: "A" }] });
    expect(out).toBe(existing);
  });

  it("updates BotCount independently of the roster length", () => {
    const existing = "BotCount=4\nBotName1=A\nBotName2=B\n";
    const out = updateBotRoster(existing, { botCount: 1, bots: [{ name: "A" }, { name: "B" }] });
    expect(out).toBe("BotCount=1\nBotName1=A\nBotName2=B\n");
  });

  it("keeps unknown keys, blank lines, the file's key casing and CRLF", () => {
    const existing = "botcount=1\r\n\r\nSomethingElse=yes\r\nbotname1=A\r\nbotship1=pyro\r\n";
    const parsed = parseBotRoster(existing);
    parsed.bots[0].ship = "magnum";
    expect(updateBotRoster(existing, parsed)).toBe(
      "botcount=1\r\n\r\nSomethingElse=yes\r\nBotName1=A\r\nBotShip1=magnum\r\n",
    );
  });

  it("drops a later duplicate of a managed key", () => {
    const existing = "BotCount=1\nBotCount=3\nBotName1=A\n";
    expect(updateBotRoster(existing, parseBotRoster(existing))).toBe("BotCount=3\nBotName1=A\n");
  });

  it("keeps comments that sit inside the entry block at its head", () => {
    const existing = "BotCount=2\nBotName1=A\n; second bot\nBotName2=B\n";
    const parsed = parseBotRoster(existing);
    parsed.bots[1].name = "C";
    expect(updateBotRoster(existing, parsed)).toBe("BotCount=2\n; second bot\nBotName1=A\nBotName2=C\n");
  });

  it("inserts BotCount at the top of a file that has none and appends entries to a file with none", () => {
    const existing = "; notes only\nBotDifficulty=rookie\n";
    const out = updateBotRoster(existing, { botCount: 1, defaultDifficulty: "rookie", bots: [{ name: "A" }] });
    expect(out).toBe("BotCount=1\n; notes only\nBotDifficulty=rookie\nBotName1=A\n");
  });

  it("writes a file with no trailing newline back with one", () => {
    const existing = "BotCount=1\nBotName1=A";
    expect(updateBotRoster(existing, parseBotRoster(existing))).toBe("BotCount=1\nBotName1=A\n");
  });

  it("starts an empty file like generateBotRoster would", () => {
    const data = { botCount: 1, targetPlayers: 4, bots: [{ name: "A" }] };
    expect(updateBotRoster("", data)).toBe(generateBotRoster(data));
  });
});

describe("normalizeBotRoster", () => {
  it("drops nameless bots, trims, clamps the count and raises the reserve", () => {
    const n = normalizeBotRoster({
      botCount: 99,
      reservedSlots: 0,
      targetPlayers: -3,
      bots: [{ name: "  A " }, { name: "" }, { name: "B", team: 9 }],
    });
    expect(n).toEqual({
      botCount: MAX_ROSTER_BOTS,
      reservedSlots: 1,
      targetPlayers: 0,
      bots: [
        { name: "A", ship: undefined, difficulty: undefined, team: undefined },
        { name: "B", ship: undefined, difficulty: undefined, team: undefined },
      ],
    });
  });

  it("defaults botCount to the roster length when missing", () => {
    const n = normalizeBotRoster({ bots: [{ name: "A" }, { name: "B" }] } as never);
    expect(n.botCount).toBe(2);
  });
});
