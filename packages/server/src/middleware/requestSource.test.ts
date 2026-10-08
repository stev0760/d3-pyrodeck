import { describe, it, expect } from "vitest";
import {
  crossSiteRefusal,
  isLocalRequest,
  isLoopbackAddress,
  isLoopbackName,
  isProxiedRequest,
  parseOriginList,
  parseTrustProxy,
  rateLimitKey,
} from "./requestSource.js";

describe("parseTrustProxy", () => {
  it("is off when unset or false-like", () => {
    for (const v of [undefined, "", " ", "0", "false", "FALSE", "no", "off"]) {
      expect(parseTrustProxy(v)).toBe(false);
    }
  });

  it("trusts a proxy on this machine only for 1/true, never every hop", () => {
    for (const v of ["1", "true", "True", "yes", "on"]) {
      expect(parseTrustProxy(v)).toEqual(["loopback"]);
    }
  });

  it("takes a list of addresses, CIDR blocks and proxy-addr names", () => {
    expect(parseTrustProxy("10.0.0.5")).toEqual(["10.0.0.5"]);
    expect(parseTrustProxy(" 10.0.0.0/24, fd00::/8 ,loopback")).toEqual(["10.0.0.0/24", "fd00::/8", "loopback"]);
    expect(parseTrustProxy("::1,127.0.0.1")).toEqual(["::1", "127.0.0.1"]);
  });

  it("refuses anything else, and a /0 block that would trust every client", () => {
    expect(() => parseTrustProxy("nginx")).toThrow(/PYRODECK_TRUST_PROXY: "nginx" is not/);
    expect(() => parseTrustProxy("10.0.0.0/33")).toThrow(/10\.0\.0\.0\/33/);
    expect(() => parseTrustProxy("0.0.0.0/0")).toThrow(/\/0 block/);
    expect(() => parseTrustProxy("::/0")).toThrow();
    expect(() => parseTrustProxy("10.0.0.1/x")).toThrow();
    expect(() => parseTrustProxy(",")).toThrow();
  });
});

describe("isLoopbackAddress / isLoopbackName", () => {
  it("knows the loopback addresses, IPv4-mapped included", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.8.9.10")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("203.0.113.9")).toBe(false);
    expect(isLoopbackAddress("::ffff:203.0.113.9")).toBe(false);
    expect(isLoopbackAddress("localhost")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("knows the loopback host names, bracketed IPv6 included", () => {
    expect(isLoopbackName("localhost")).toBe(true);
    expect(isLoopbackName("tauri.localhost")).toBe(true);
    expect(isLoopbackName("127.0.0.1")).toBe(true);
    expect(isLoopbackName("[::1]")).toBe(true);
    expect(isLoopbackName("panel.example.com")).toBe(false);
    expect(isLoopbackName("")).toBe(false);
  });
});

describe("isLocalRequest", () => {
  const req = (ip: string, hostname: string, headers: Record<string, string> = {}) => ({ ip, hostname, headers });

  it("is local for a loopback client asking for a loopback host, with no proxy header", () => {
    expect(isLocalRequest(req("127.0.0.1", "localhost"))).toBe(true);
    expect(isLocalRequest(req("::1", "127.0.0.1"))).toBe(true);
    expect(isLocalRequest(req("::ffff:127.0.0.1", "[::1]"))).toBe(true);
  });

  it("is never local through a proxy, whichever forwarding header it sent", () => {
    for (const h of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip"]) {
      const r = req("127.0.0.1", "localhost", { [h]: "127.0.0.1" });
      expect(isProxiedRequest(r)).toBe(true);
      expect(isLocalRequest(r)).toBe(false);
    }
  });

  it("is not local for a remote client, or a page that rebound its own name to 127.0.0.1", () => {
    expect(isLocalRequest(req("203.0.113.9", "localhost"))).toBe(false);
    expect(isLocalRequest(req("127.0.0.1", "attacker.example"))).toBe(false);
    expect(isLocalRequest(req("127.0.0.1", ""))).toBe(false);
  });
});

describe("rateLimitKey", () => {
  it("keys IPv4 by address, IPv4-mapped IPv6 as IPv4", () => {
    expect(rateLimitKey("203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("keys IPv6 by its /64, however it is written", () => {
    const key = "2001:db8:1:2::/64";
    expect(rateLimitKey("2001:db8:1:2::1")).toBe(key);
    expect(rateLimitKey("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe(key);
    expect(rateLimitKey("2001:db8:1:2:0:0:0:9")).toBe(key);
    expect(rateLimitKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateLimitKey("64:ff9b::203.0.113.9")).toBe("64:ff9b:0:0::/64");
  });
});

describe("crossSiteRefusal", () => {
  it("lets a request without Origin through", () => {
    expect(crossSiteRefusal(undefined, "panel.example.com", [])).toBeNull();
  });

  it("lets the same host name through, whatever the ports", () => {
    expect(crossSiteRefusal("https://panel.example.com", "panel.example.com", [])).toBeNull();
    expect(crossSiteRefusal("https://Panel.Example.com:8443", "panel.example.com", [])).toBeNull();
    expect(crossSiteRefusal("http://[::1]:5173", "[::1]", [])).toBeNull();
  });

  it("lets the Vite dev proxy through: loopback page, loopback Host on another port and name", () => {
    expect(crossSiteRefusal("http://localhost:5173", "localhost", [])).toBeNull();
    expect(crossSiteRefusal("http://127.0.0.1:5173", "localhost", [])).toBeNull();
  });

  it("lets a PYRODECK_CORS_ORIGIN origin through", () => {
    const allowed = parseOriginList(" https://admin.example.org , https://other.example ");
    expect(allowed).toEqual(["https://admin.example.org", "https://other.example"]);
    expect(crossSiteRefusal("https://admin.example.org", "panel.example.com", allowed)).toBeNull();
  });

  it("refuses another site, a null origin and a malformed one", () => {
    expect(crossSiteRefusal("https://evil.example", "panel.example.com", [])).toMatch(/Origin https:\/\/evil\.example/);
    expect(crossSiteRefusal("https://evil.example", "localhost", [])).not.toBeNull();
    expect(crossSiteRefusal("http://localhost:5173", "panel.example.com", [])).not.toBeNull();
    expect(crossSiteRefusal("null", "localhost", [])).not.toBeNull();
    expect(crossSiteRefusal("not a url", "localhost", [])).not.toBeNull();
  });

  it("points at the Host header when a proxy did not pass it on", () => {
    expect(crossSiteRefusal("https://panel.example.com", "127.0.0.1", [])).toMatch(/proxy_set_header Host \$host/);
  });
});
