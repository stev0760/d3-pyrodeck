import { describe, it, expect } from "vitest";
import { joinAddressNote, joinAddressText, type JoinAddress } from "./joinAddress.ts";

const join = (over: Partial<JoinAddress>): JoinAddress => ({
  host: "203.0.113.7",
  port: 2092,
  hostSource: "setting",
  hostKind: "ipv4",
  resolved: null,
  address: "203.0.113.7:2092",
  lanOnly: false,
  ...over,
});

describe("joinAddressText", () => {
  it("shows the address, or the port alone when there is none", () => {
    expect(joinAddressText(join({}))).toBe("203.0.113.7:2092");
    expect(joinAddressText(join({ host: "d3.example.org", hostKind: "name", address: null, port: 2116 }))).toBe("?:2116");
  });
});

describe("joinAddressNote", () => {
  it("names the source of an IPv4 host, and flags a local one", () => {
    expect(joinAddressNote(join({}))).toEqual({
      text: "Host from the Join Host setting. Players enter it under Multiplayer → Direct TCP/IP.",
      tone: "info",
    });
    expect(
      joinAddressNote(join({ host: "192.168.0.103", hostSource: "bind-address", address: "192.168.0.103:2092", lanOnly: true }))
        .text,
    ).toBe(
      "Host from the bind address; a local address, so only players on this network can use it. " +
        "Players enter it under Multiplayer → Direct TCP/IP.",
    );
  });

  it("gives a host name with the number it resolves to", () => {
    const named = join({ host: "d3.example.org", hostKind: "name", resolved: "192.0.2.10", address: "192.0.2.10:2092" });
    expect(joinAddressNote(named)).toEqual({
      text:
        "Host from the Join Host setting: d3.example.org is 192.0.2.10. The game's join screen takes the number, " +
        "not the name. Players enter it under Multiplayer → Direct TCP/IP.",
      tone: "info",
    });
    expect(
      joinAddressNote({ ...named, hostSource: "mission-host", resolved: "10.0.0.5", address: "10.0.0.5:2092", lanOnly: true })
        .text,
    ).toBe(
      "Host from the mission host URL: d3.example.org is 10.0.0.5, a local address, so only players on this network can " +
        "use it. The game's join screen takes the number, not the name. Players enter it under Multiplayer → Direct TCP/IP.",
    );
  });

  it("says why there is no address for a name that does not resolve or an IPv6 host", () => {
    expect(joinAddressNote(join({ host: "d3.example.org", hostKind: "name", address: null }))).toEqual({
      text:
        "Host from the Join Host setting: d3.example.org does not resolve to an IPv4 address from this machine. " +
        "The game's join screen takes only an IPv4 address. Set the Join Host to the IPv4 address players reach this machine at.",
      tone: "warn",
    });
    expect(
      joinAddressNote(join({ host: "[2001:db8::10]", hostSource: "mission-host", hostKind: "ipv6", address: null })),
    ).toEqual({
      text:
        "Host from the mission host URL: [2001:db8::10] is an IPv6 address. " +
        "The game's join screen takes only an IPv4 address. Set the Join Host to the IPv4 address players reach this machine at.",
      tone: "warn",
    });
  });

  it("asks for the Join Host when the host is unknown", () => {
    expect(joinAddressNote(join({ host: null, hostSource: null, hostKind: null, address: null })).text).toBe(
      "Pyrodeck doesn't know the address players reach this machine at. Set the Join Host.",
    );
  });
});
