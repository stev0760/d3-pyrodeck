import { describe, it, expect } from "vitest";
import { parseHash, buildHash, tabOf, isRoot, sameRoute } from "./hashRoute.ts";

describe("parseHash", () => {
  it("parses segments and query parameters", () => {
    const r = parseHash("#/more/config/raw?file=bots.cfg&x=1");
    expect(r.path).toEqual(["more", "config", "raw"]);
    expect(r.params.get("file")).toBe("bots.cfg");
    expect(r.params.get("x")).toBe("1");
  });

  it("lands on the server tab for an empty or bare hash", () => {
    for (const h of ["", "#", "#/", "/", "#//"]) {
      expect(parseHash(h).path).toEqual(["server"]);
    }
  });

  it("decodes segments and drops empty ones", () => {
    expect(parseHash("#/more/logs/testing%202026.log//").path).toEqual(["more", "logs", "testing 2026.log"]);
  });

  it("keeps a malformed escape as written", () => {
    expect(parseHash("#/more/logs/100%").path).toEqual(["more", "logs", "100%"]);
  });
});

describe("buildHash", () => {
  it("encodes segments and parameters", () => {
    expect(buildHash(["more", "logs", "a b.log"])).toBe("#/more/logs/a%20b.log");
    expect(buildHash(["more", "config", "raw"], { file: "bots.cfg" })).toBe("#/more/config/raw?file=bots.cfg");
    expect(buildHash(["server"], new URLSearchParams({ q: "x y" }))).toBe("#/server?q=x+y");
  });

  it("round-trips through parseHash", () => {
    const r = parseHash(buildHash(["players", "history"], { who: "stv/Linux" }));
    expect(r.path).toEqual(["players", "history"]);
    expect(r.params.get("who")).toBe("stv/Linux");
  });
});

describe("tabOf / isRoot / sameRoute", () => {
  it("maps the first segment to a tab, defaulting to server", () => {
    expect(tabOf(parseHash("#/players/history"))).toBe("players");
    expect(tabOf(parseHash("#/nonsense"))).toBe("server");
    expect(tabOf(parseHash(""))).toBe("server");
  });

  it("knows a root from a stacked screen", () => {
    expect(isRoot(parseHash("#/bots"))).toBe(true);
    expect(isRoot(parseHash("#/bots/roster"))).toBe(false);
  });

  it("compares routes by path and parameters", () => {
    expect(sameRoute(parseHash("#/a?x=1"), parseHash("#/a?x=1"))).toBe(true);
    expect(sameRoute(parseHash("#/a?x=1"), parseHash("#/a?x=2"))).toBe(false);
    expect(sameRoute(parseHash("#/a"), parseHash("#/a/b"))).toBe(false);
  });
});
