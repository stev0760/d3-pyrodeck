import { describe, it, expect } from "vitest";
import { checkJoinHost, resolveJoinAddress } from "./joinAddress.js";

describe("resolveJoinAddress", () => {
  it("uses the game port from -useport, else the engine default 2092", () => {
    expect(resolveJoinAddress({ gamePort: 2116 }, "d3.example.org", null).address).toBe("d3.example.org:2116");
    expect(resolveJoinAddress(null, "d3.example.org", null).address).toBe("d3.example.org:2092");
  });

  it("prefers the Join Host setting over everything else", () => {
    expect(resolveJoinAddress({ bindIp: "203.0.113.7" }, "d3.example.org", "http://other.example:3002")).toMatchObject({
      host: "d3.example.org",
      hostSource: "setting",
      lanOnly: false,
    });
  });

  it("then a public -useip address, then the mission host's public URL, then a LAN -useip address", () => {
    expect(resolveJoinAddress({ bindIp: "203.0.113.7" }, null, "http://d3.example.org:3002")).toMatchObject({
      address: "203.0.113.7:2092",
      hostSource: "bind-address",
    });
    expect(resolveJoinAddress({ bindIp: "192.168.0.103" }, null, "http://d3.example.org:3002")).toMatchObject({
      address: "d3.example.org:2092",
      hostSource: "mission-host",
    });
    expect(resolveJoinAddress({ bindIp: "192.168.0.103", gamePort: 2116 }, null, null)).toEqual({
      host: "192.168.0.103",
      port: 2116,
      address: "192.168.0.103:2116",
      hostSource: "bind-address",
      lanOnly: true,
    });
  });

  it("ignores the wildcard bind address and reports an unknown host", () => {
    expect(resolveJoinAddress({ bindIp: "0.0.0.0", gamePort: 2116 }, null, null)).toEqual({
      host: null,
      port: 2116,
      address: null,
      hostSource: null,
      lanOnly: false,
    });
  });

  it("flags a local mission host URL as LAN only", () => {
    expect(resolveJoinAddress(null, null, "http://192.168.0.103:3002")).toMatchObject({
      address: "192.168.0.103:2092",
      lanOnly: true,
    });
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
});
