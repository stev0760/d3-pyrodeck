import { describe, it, expect } from "vitest";
import {
  chooseServer,
  namedMessage,
  readStoredServer,
  refusalLines,
  routeMessage,
  rowStateLabel,
  runningCount,
  writeStoredServer,
  SELECTED_SERVER_KEY,
  type ServerList,
  type ServerRow,
} from "./servers.ts";

function row(id: string, extra: Partial<ServerRow> = {}): ServerRow {
  return { id, kind: "profile", name: id.toUpperCase(), profileId: id, default: false, state: "stopped", console: "disconnected", ...extra };
}

const list = (servers: ServerRow[], defaultServerId: string | null = null): ServerList => ({ defaultServerId, servers });

describe("routeMessage", () => {
  it("gives a tagged message to its server", () => {
    expect(routeMessage({ type: "output", serverId: "ctf", payload: { raw: "x" } })).toEqual({ scope: "server", serverId: "ctf" });
    expect(routeMessage({ type: "players", serverId: "anarchy", payload: {} })).toEqual({ scope: "server", serverId: "anarchy" });
    expect(routeMessage({ type: "error", serverId: "ctf", payload: { message: "m" } })).toEqual({ scope: "server", serverId: "ctf" });
  });

  it("drops an untagged message of a server's kind (the greeting before hello), never guessing its server", () => {
    for (const type of ["output", "process_output", "connection_state", "capabilities", "level_changed", "players", "playlist_status"]) {
      expect(routeMessage({ type, payload: {} })).toEqual({ scope: "drop" });
    }
  });

  it("keeps pings, hello and errors of no server global", () => {
    expect(routeMessage({ type: "ping", payload: {} })).toEqual({ scope: "global" });
    expect(routeMessage({ type: "hello", payload: { protocol: 2 } })).toEqual({ scope: "global" });
    expect(routeMessage({ type: "error", payload: { message: "Scheduled start skipped" } })).toEqual({ scope: "global" });
  });

  it("treats an empty serverId as untagged", () => {
    expect(routeMessage({ type: "output", serverId: "", payload: {} })).toEqual({ scope: "drop" });
  });
});

describe("chooseServer", () => {
  const servers = [row("anarchy"), row("ctf", { state: "running" }), row("coop")];

  it("keeps the server asked for while it exists", () => {
    expect(chooseServer({ wanted: ["ctf"], list: list(servers, "anarchy") })).toBe("ctf");
  });

  it("takes the first wanted server that exists (the hash, then the stored one)", () => {
    expect(chooseServer({ wanted: ["gone", "coop"], list: list(servers, "anarchy") })).toBe("coop");
  });

  it("falls back to the default server when the wanted one was deleted", () => {
    expect(chooseServer({ wanted: ["gone"], list: list(servers, "ctf") })).toBe("ctf");
  });

  it("falls back to the first server when the default is unknown or Connect mode", () => {
    expect(chooseServer({ wanted: [null], list: list(servers, "connect") })).toBe("anarchy");
    expect(chooseServer({ wanted: [], list: list(servers, null) })).toBe("anarchy");
  });

  it("never picks Connect mode's session", () => {
    const withConnect = [row("connect", { kind: "connect", state: null, console: "ready" }), ...servers];
    expect(chooseServer({ wanted: ["connect"], list: list(withConnect, "connect") })).toBe("anarchy");
  });

  it("is null while there is no server to show", () => {
    expect(chooseServer({ wanted: ["x"], list: null })).toBeNull();
    expect(chooseServer({ wanted: ["x"], list: list([]) })).toBeNull();
  });
});

describe("the stored selection", () => {
  it("round-trips through storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readStoredServer(storage)).toBeNull();
    writeStoredServer("ctf", storage);
    expect(store.get(SELECTED_SERVER_KEY)).toBe("ctf");
    expect(readStoredServer(storage)).toBe("ctf");
  });

  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredServer(broken)).toBeNull();
    expect(() => writeStoredServer("x", broken)).not.toThrow();
  });
});

describe("rows", () => {
  it("counts the servers holding a process, not Connect mode", () => {
    const rows = [
      row("a", { state: "running" }),
      row("b", { state: "starting" }),
      row("c", { state: "crashed" }),
      row("connect", { kind: "connect", state: null, console: "ready" }),
    ];
    expect(runningCount(rows)).toBe(2);
  });

  it("reads a playlist restart and a held server before the process state", () => {
    expect(rowStateLabel(row("a", { state: "stopped", playlist: { id: "p", name: "P", status: "restarting", currentEntry: null, pausedReason: null } }))).toBe("restarting");
    expect(rowStateLabel(row("a", { state: "running", playlist: { id: "p", name: "P", status: "holding", currentEntry: null, pausedReason: null } }))).toBe("holding");
    expect(rowStateLabel(row("a", { state: "stopped", held: { why: "no login", pid: 9 } }))).toBe("holding ports");
    expect(rowStateLabel(row("a", { state: "running" }))).toBe("running");
  });

  it("names a message by its server", () => {
    expect(namedMessage("CTF", "Rotating to: Gamma")).toBe("CTF: Rotating to: Gamma");
    expect(namedMessage(null, "Scheduled start skipped")).toBe("Scheduled start skipped");
    // A refusal names its server already.
    expect(namedMessage("Clash", 'Cannot start "Clash": game port 2092/udp is used by "Anarchy"')).toBe(
      'Cannot start "Clash": game port 2092/udp is used by "Anarchy"',
    );
  });
});

describe("refusalLines", () => {
  it("splits Pyrodeck's joined refusal into its reasons", () => {
    const msg =
      'Cannot start "CTF": console port 2092/tcp is used by "Anarchy" (running); Pyrodeck would log in to that server. ' +
      'Cannot start "CTF": game port 2092/udp is used by "Anarchy" (running).';
    expect(refusalLines(msg)).toEqual([
      'Cannot start "CTF": console port 2092/tcp is used by "Anarchy" (running); Pyrodeck would log in to that server.',
      'Cannot start "CTF": game port 2092/udp is used by "Anarchy" (running).',
    ]);
  });

  it("keeps any other message whole", () => {
    expect(refusalLines("Executable not found")).toEqual(["Executable not found"]);
  });
});
