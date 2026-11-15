import { describe, it, expect } from "vitest";
import { describeDownloads, type EntryHostingResult } from "./playlistDownloads.ts";

const r = (label: string, file: string, outcome: EntryHostingResult["outcome"], message?: string) => ({
  entryId: label,
  label,
  file,
  outcome,
  message,
});

describe("describeDownloads", () => {
  it("gives the summary line and lists each mission that needs a look once", () => {
    const d = describeDownloads({
      playlistId: "p",
      at: 1,
      summary: "1 hosted, 1 ships with the game, 1 has its own link, 1 failed",
      results: [
        r("Alpha", "alpha.mn3", "hosted"),
        r("Chaos", "chaos.mn3", "stock", "chaos.mn3 ships with Descent 3; every player already has it."),
        r("Gamma", "gamma.mn3", "custom", "Keeps its own link: http://files.example.net/gamma.zip"),
        r("Bogus", "bogus.mn3", "error", "not a .mn3 mission (no HOG2 header)"),
        r("Bogus again", "bogus.mn3", "error", "not a .mn3 mission (no HOG2 header)"),
      ],
    });
    expect(d.line).toBe("Downloads: 1 hosted, 1 ships with the game, 1 has its own link, 1 failed");
    expect(d.problems).toEqual([
      "Gamma (gamma.mn3): Keeps its own link: http://files.example.net/gamma.zip",
      "Bogus (bogus.mn3): not a .mn3 mission (no HOG2 header)",
    ]);
    expect(d.warn).toBe(true);
  });

  it("is quiet when every mission is served or ships with the game", () => {
    const d = describeDownloads({
      playlistId: "p",
      at: 1,
      summary: "2 hosted",
      results: [r("A", "a.mn3", "hosted"), r("B", "b.mn3", "already")],
    });
    expect(d).toEqual({ line: "Downloads: 2 hosted", problems: [], warn: false });
  });

  it("says why nothing was hosted", () => {
    const notice = "The mission host serves /a.";
    const d = describeDownloads({ playlistId: "p", at: 1, summary: "", notice, results: [] });
    expect(d).toEqual({ line: "Downloads not hosted: The mission host serves /a.", problems: [], warn: true });
  });
});
