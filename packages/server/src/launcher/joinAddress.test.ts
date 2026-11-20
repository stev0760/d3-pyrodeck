import { describe, it, expect, vi, afterEach } from "vitest";
import { checkJoinHost, ipv4Lookup, joinAddressFor, resolveJoinAddress, type IPv4Lookup } from "./joinAddress.js";

describe("resolveJoinAddress", () => {
  it("uses the game port from -useport, else the engine default 2092", () => {
    expect(resolveJoinAddress({ gamePort: 2116 }, "d3.example.org", null).port).toBe(2116);
    expect(resolveJoinAddress(null, "d3.example.org", null).port).toBe(2092);
  });

  it("prefers the Join Host setting over everything else", () => {
    expect(resolveJoinAddress({ bindIp: "203.0.113.7" }, "d3.example.org", "http://other.example:3002")).toEqual({
      host: "d3.example.org",
      port: 2092,
      hostSource: "setting",
    });
  });

  it("then a public -useip address, then the mission host's public URL, then a LAN -useip address", () => {
    expect(resolveJoinAddress({ bindIp: "203.0.113.7" }, null, "http://d3.example.org:3002")).toEqual({
      host: "203.0.113.7",
      port: 2092,
      hostSource: "bind-address",
    });
    expect(resolveJoinAddress({ bindIp: "192.168.0.103" }, null, "http://d3.example.org:3002")).toEqual({
      host: "d3.example.org",
      port: 2092,
      hostSource: "mission-host",
    });
    expect(resolveJoinAddress({ bindIp: "192.168.0.103", gamePort: 2116 }, null, null)).toEqual({
      host: "192.168.0.103",
      port: 2116,
      hostSource: "bind-address",
    });
  });

  it("ignores the wildcard bind address and reports an unknown host", () => {
    expect(resolveJoinAddress({ bindIp: "0.0.0.0", gamePort: 2116 }, null, null)).toEqual({
      host: null,
      port: 2116,
      hostSource: null,
    });
  });
});

describe("joinAddressFor", () => {
  const never: IPv4Lookup = () => {
    throw new Error("no lookup expected");
  };
  const table =
    (answers: Record<string, string>): IPv4Lookup =>
    async (name) =>
      answers[name] ?? null;

  it("gives an IPv4 host as it is, without a lookup", async () => {
    expect(await joinAddressFor({ host: "203.0.113.7", port: 2116, hostSource: "setting" }, never)).toEqual({
      host: "203.0.113.7",
      port: 2116,
      hostSource: "setting",
      hostKind: "ipv4",
      resolved: null,
      address: "203.0.113.7:2116",
      lanOnly: false,
    });
  });

  it("flags a loopback or private IPv4 host as LAN only", async () => {
    const choice = resolveJoinAddress(null, null, "http://192.168.0.103:3002");
    expect(await joinAddressFor(choice, never)).toMatchObject({
      address: "192.168.0.103:2092",
      hostKind: "ipv4",
      lanOnly: true,
    });
    expect((await joinAddressFor({ host: "127.0.0.1", port: 2092, hostSource: "setting" }, never)).lanOnly).toBe(true);
  });

  it("gives a host name's IPv4 address and keeps the name", async () => {
    const lookup = vi.fn(table({ "d3.example.org": "192.0.2.10" }));
    expect(await joinAddressFor({ host: "d3.example.org", port: 2092, hostSource: "setting" }, lookup)).toEqual({
      host: "d3.example.org",
      port: 2092,
      hostSource: "setting",
      hostKind: "name",
      resolved: "192.0.2.10",
      address: "192.0.2.10:2092",
      lanOnly: false,
    });
    expect(lookup).toHaveBeenCalledWith("d3.example.org");
  });

  it("flags a name that resolves to a private address as LAN only", async () => {
    const choice = { host: "d3.example.org", port: 2116, hostSource: "mission-host" as const };
    expect(await joinAddressFor(choice, table({ "d3.example.org": "10.0.0.5" }))).toMatchObject({
      resolved: "10.0.0.5",
      address: "10.0.0.5:2116",
      lanOnly: true,
    });
  });

  it("gives no address for a name that does not resolve", async () => {
    expect(await joinAddressFor({ host: "d3.example.org", port: 2092, hostSource: "setting" }, table({}))).toEqual({
      host: "d3.example.org",
      port: 2092,
      hostSource: "setting",
      hostKind: "name",
      resolved: null,
      address: null,
      lanOnly: false,
    });
  });

  it("gives no address for an IPv6 host, without a lookup", async () => {
    const choice = resolveJoinAddress(null, null, "http://[2001:db8::10]:3002");
    expect(await joinAddressFor(choice, never)).toMatchObject({
      host: "[2001:db8::10]",
      hostKind: "ipv6",
      address: null,
      lanOnly: false,
    });
  });

  it("gives nothing for an unknown host", async () => {
    expect(await joinAddressFor({ host: null, port: 2092, hostSource: null }, never)).toEqual({
      host: null,
      port: 2092,
      hostSource: null,
      hostKind: null,
      resolved: null,
      address: null,
      lanOnly: false,
    });
  });
});

describe("ipv4Lookup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the resolver's IPv4 address", async () => {
    const resolver = vi.fn(async () => ({ address: "192.0.2.10" }));
    expect(await ipv4Lookup(1000, resolver)("d3.example.org")).toBe("192.0.2.10");
    expect(resolver).toHaveBeenCalledWith("d3.example.org");
  });

  it("returns null when the name does not resolve, or the answer is not IPv4", async () => {
    const fail = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND d3.example.org"), { code: "ENOTFOUND" });
    };
    expect(await ipv4Lookup(1000, fail)("d3.example.org")).toBeNull();
    expect(await ipv4Lookup(1000, async () => ({ address: "2001:db8::10" }))("d3.example.org")).toBeNull();
  });

  it("gives up after the time limit", async () => {
    vi.useFakeTimers();
    const answer = ipv4Lookup(2000, () => new Promise(() => {}))("d3.example.org");
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toBeNull();
  });

  it("shares a lookup still running for the same name, and looks again once it is done", async () => {
    vi.useFakeTimers();
    let finish: (r: { address: string }) => void = () => {};
    const resolver = vi.fn(
      () =>
        new Promise<{ address: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const lookup = ipv4Lookup(2000, resolver);
    const first = lookup("d3.example.org");
    await vi.advanceTimersByTimeAsync(2000);
    expect(await first).toBeNull();
    const second = lookup("d3.example.org");
    finish({ address: "192.0.2.10" });
    expect(await second).toBe("192.0.2.10");
    expect(resolver).toHaveBeenCalledTimes(1);

    const third = lookup("d3.example.org");
    await vi.advanceTimersByTimeAsync(0);
    finish({ address: "192.0.2.11" });
    expect(await third).toBe("192.0.2.11");
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});

describe("checkJoinHost", () => {
  it("accepts host names and IPv4 addresses, lower-cased", () => {
    expect(checkJoinHost(" D3.Example.org ")).toEqual({ host: "d3.example.org" });
    expect(checkJoinHost("203.0.113.7")).toEqual({ host: "203.0.113.7" });
  });

  it("refuses a URL, a port, a path or junk", () => {
    for (const bad of ["http://d3.example.org", "d3.example.org:2092", "d3.example.org/join", "two words", "-bad.org", ""]) {
      expect(checkJoinHost(bad)).toHaveProperty("error");
    }
  });

  it("refuses numbers that are not a dotted IPv4 address", () => {
    for (const bad of ["192.0.2", "203.0.113.256", "192.0.2.10.", "3221225994"]) {
      expect(checkJoinHost(bad)).toEqual({
        error: "Not a valid IPv4 address: four numbers from 0 to 255 (example: 192.0.2.10).",
      });
    }
  });
});
