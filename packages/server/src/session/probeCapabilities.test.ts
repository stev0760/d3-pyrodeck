import { describe, it, expect, vi } from "vitest";
import type { ServerConnection } from "../connection/ServerConnection.js";
import type { ServerCapabilities } from "../parser/parsers/servercaps.js";
import {
  probeCapabilities,
  probeCapabilitiesDetailed,
  LATE_PROBE_ATTEMPTS,
} from "./probeCapabilities.js";

const CAPS_LINE =
  "SERVERCAPS version=1 fork=Matcen fork_version=0.9.15 features=bots,roster,ships,difficulty";

function fakeConnection(replies: string[]): ServerConnection & { sent: number } {
  const conn = {
    sent: 0,
    connect: async () => {},
    send: async () => replies[conn.sent++] ?? "",
    onData: () => {},
    onDisconnect: () => {},
    disconnect: async () => {},
    quit: async () => {},
    isConnected: () => true,
  };
  return conn;
}

describe("probeCapabilities", () => {
  it("returns fork caps from an immediate reply", async () => {
    const conn = fakeConnection([CAPS_LINE]);
    const caps = await probeCapabilities(conn, () => {}, 0);
    expect(caps.fork).toBe("Matcen");
    expect(caps.features.has("bots")).toBe(true);
    expect(conn.sent).toBe(1);
  });

  it("treats a non-empty reply without SERVERCAPS as vanilla, no retries", async () => {
    const conn = fakeConnection(["Unknown command"]);
    const onLate = vi.fn();
    const caps = await probeCapabilities(conn, onLate, 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(caps.fork).toBe("");
    expect(onLate).not.toHaveBeenCalled();
    expect(conn.sent).toBe(1);
  });

  it("reports caps that arrive on a background retry after a silent first probe", async () => {
    const conn = fakeConnection(["", "", CAPS_LINE]);
    const late: ServerCapabilities[] = [];
    const caps = await probeCapabilities(conn, (c) => late.push(c), 0);
    expect(caps.fork).toBe("");
    await vi.waitFor(() => expect(late).toHaveLength(1));
    expect(late[0].forkVersion).toBe("0.9.15");
    expect(conn.sent).toBe(3);
  });

  it("gives up after the retry budget when the server never answers", async () => {
    const conn = fakeConnection([]);
    const onLate = vi.fn();
    await probeCapabilities(conn, onLate, 0);
    await vi.waitFor(() => expect(conn.sent).toBe(1 + LATE_PROBE_ATTEMPTS));
    await new Promise((r) => setTimeout(r, 10));
    expect(onLate).not.toHaveBeenCalled();
    expect(conn.sent).toBe(1 + LATE_PROBE_ATTEMPTS);
  });

  it("reports whether the first probe was answered", async () => {
    expect((await probeCapabilitiesDetailed(fakeConnection([CAPS_LINE]), () => {}, 0)).answered).toBe(true);
    expect((await probeCapabilitiesDetailed(fakeConnection(["Unknown command"]), () => {}, 0)).answered).toBe(true);
    const silent = fakeConnection(["", CAPS_LINE]);
    const late = vi.fn();
    const result = await probeCapabilitiesDetailed(silent, late, 0);
    expect(result.answered).toBe(false);
    await vi.waitFor(() => expect(late).toHaveBeenCalledTimes(1));
  });
});
