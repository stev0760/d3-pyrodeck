import { describe, it, expect } from "vitest";
import { parseHash, buildHash, tabOf, isRoot, sameRoute, serverOfRoute, withServer } from "./hashRoute.ts";

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

describe("the server on screen (?s=)", () => {
  it("reads the server a route names", () => {
    expect(serverOfRoute(parseHash("#/console?s=ctf-1"))).toBe("ctf-1");
    expect(serverOfRoute(parseHash("#/more/config/raw?file=bots.cfg&s=launch"))).toBe("launch");
    expect(serverOfRoute(parseHash("#/console"))).toBeNull();
    expect(serverOfRoute(parseHash("#/console?s="))).toBeNull();
  });

  it("names a server and keeps the path and the other parameters", () => {
    const hash = withServer("#/more/config/raw?file=bots.cfg", "ctf-1");
    const r = parseHash(hash);
    expect(r.path).toEqual(["more", "config", "raw"]);
    expect(r.params.get("file")).toBe("bots.cfg");
    expect(serverOfRoute(r)).toBe("ctf-1");
  });

  it("replaces the server named before, and drops it for null", () => {
    expect(serverOfRoute(parseHash(withServer("#/players?s=a", "b")))).toBe("b");
    expect(withServer("#/players?s=a", null)).toBe("#/players");
  });

  it("names a server on an empty hash (the Server tab)", () => {
    expect(withServer("", "anarchy")).toBe("#/server?s=anarchy");
  });

  it("does not change what tab or screen a route is", () => {
    const r = parseHash(withServer("#/players/history", "x"));
    expect(tabOf(r)).toBe("players");
    expect(isRoot(r)).toBe(false);
  });
});
