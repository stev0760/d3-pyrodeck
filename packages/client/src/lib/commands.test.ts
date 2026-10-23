import { describe, it, expect } from "vitest";
import { CATEGORIES, buildCommand, hasInputs, searchCommands, visibleCategories } from "./commands.ts";

const all = () => true;
const vanilla = (f: string) => f !== "bots";

describe("commands", () => {
  it("hides the bot groups from a server without the feature", () => {
    expect(visibleCategories(all).map((c) => c.id)).toContain("bots");
    expect(visibleCategories(vanilla).map((c) => c.id)).not.toContain("bots");
    expect(visibleCategories(vanilla).map((c) => c.id)).not.toContain("bot-debug");
  });

  it("knows which commands take input", () => {
    const players = CATEGORIES.find((c) => c.id === "players")!;
    expect(hasInputs(players.commands.find((d) => d.cmd === "$scores")!)).toBe(false);
    expect(hasInputs(players.commands.find((d) => d.cmd === "$kick")!)).toBe(true);
  });

  it("builds a command line from typed and chosen values, skipping blanks", () => {
    const bots = CATEGORIES.find((c) => c.id === "bots")!;
    const addbot = bots.commands.find((d) => d.cmd === "$addbot")!;
    expect(buildCommand(addbot, { name: " Reaper " }, { ship: "pyro", difficulty: "", team: "" })).toBe("$addbot Reaper pyro");
    const diff = bots.commands.find((d) => d.cmd === "$botdifficulty")!;
    expect(buildCommand(diff, { index: "all" }, {})).toBe("$botdifficulty all trainee");
  });

  it("searches by name or label, prefix matches first", () => {
    const hits = searchCommands("$bot", all).map((m) => m.def.cmd);
    expect(hits[0]).toMatch(/^\$bot/);
    expect(hits).toContain("$botlist");
    expect(searchCommands("scores", all)[0].def.cmd).toBe("$scores");
    expect(searchCommands("$addbot", vanilla)).toEqual([]);
    expect(searchCommands("", all)).toEqual([]);
    expect(searchCommands("$", all, 3)).toHaveLength(3);
  });

  it("marks remove-all as needing a confirmation", () => {
    const bots = CATEGORIES.find((c) => c.id === "bots")!;
    expect(bots.commands.find((d) => d.cmd === "$removebots")?.confirm).toBeTruthy();
  });
});
