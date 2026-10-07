import { describe, it, expect } from "vitest";
import { buildPostStartCommands, sanitizePostStart } from "./postStartSettings.js";

describe("post-start settings", () => {
  it("builds the DMFC commands in a fixed order", () => {
    expect(
      buildPostStartCommands({
        autoSaveDisconnect: false,
        killMsgFilter: "simple",
        hudNames: "team",
        autoSaveLevel: true,
      }),
    ).toEqual([
      "$serverhudnames team",
      "$killmsgfilter simple",
      "$autosavelevel on",
      "$autosavedisconnect off",
    ]);
  });

  it("sends nothing for unset settings", () => {
    expect(buildPostStartCommands(null)).toEqual([]);
    expect(buildPostStartCommands({})).toEqual([]);
    expect(buildPostStartCommands({ killMsgFilter: "none" })).toEqual(["$killmsgfilter none"]);
  });

  it("keeps only valid values from untrusted input", () => {
    expect(
      sanitizePostStart({
        hudNames: "full",
        killMsgFilter: "loud",
        autoSaveLevel: "yes",
        autoSaveDisconnect: true,
        extra: 1,
      }),
    ).toEqual({ hudNames: "full", autoSaveDisconnect: true });
    expect(sanitizePostStart({ hudNames: "everyone" })).toBeNull();
    expect(sanitizePostStart("full")).toBeNull();
    expect(sanitizePostStart(null)).toBeNull();
  });
});
