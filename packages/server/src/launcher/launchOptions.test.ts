import { describe, it, expect } from "vitest";
import {
  consoleHostFor,
  effectivePorts,
  findPortConflicts,
  launchOptionArgs,
  sanitizeStoredLaunchOptions,
  validateLaunchOptions,
} from "./launchOptions.js";

describe("validateLaunchOptions", () => {
  it("accepts every option and normalizes form strings", () => {
    const check = validateLaunchOptions({
      bindIp: " 192.168.0.103 ",
      gamePort: "2116",
      frameCap: "30",
      noMultiBmp: true,
      gameSpyPort: 20206,
      gameSpyFile: "pro-gamespy.cfg",
    });
    expect(check.errors).toEqual([]);
    expect(check.options).toEqual({
      bindIp: "192.168.0.103",
      gamePort: 2116,
      frameCap: 30,
      noMultiBmp: true,
      gameSpyPort: 20206,
      gameSpyFile: "pro-gamespy.cfg",
    });
  });

  it("stores nothing when every field is empty", () => {
    expect(validateLaunchOptions({ bindIp: "", gamePort: "", frameCap: null, noMultiBmp: false })).toEqual({
      options: null,
      errors: [],
      warnings: [],
    });
    expect(validateLaunchOptions(undefined).options).toBeNull();
  });

  it("refuses a host name, an out-of-range octet and INADDR_NONE for the bind address", () => {
    expect(validateLaunchOptions({ bindIp: "example.org" }).errors[0]).toMatch(/IPv4 address/);
    expect(validateLaunchOptions({ bindIp: "10.0.0.256" }).errors).toHaveLength(1);
    expect(validateLaunchOptions({ bindIp: "10.0.0.01" }).errors).toHaveLength(1); // inet_addr reads 01 as octal
    expect(validateLaunchOptions({ bindIp: "255.255.255.255" }).errors[0]).toMatch(/not a usable/);
  });

  it("warns about loopback and wildcard bind addresses", () => {
    expect(validateLaunchOptions({ bindIp: "127.0.0.1" }).warnings[0]).toMatch(/loopback/);
    expect(validateLaunchOptions({ bindIp: "0.0.0.0" }).warnings[0]).toMatch(/all addresses/);
  });

  it("refuses ports outside 1-65535 and non-integers", () => {
    for (const bad of [0, 65536, "2.5", "abc", -1]) {
      expect(validateLaunchOptions({ gamePort: bad }).errors).toHaveLength(1);
      expect(validateLaunchOptions({ gameSpyPort: bad }).errors).toHaveLength(1);
    }
    expect(validateLaunchOptions({ gamePort: 80 }).warnings[0]).toMatch(/below 1024/);
  });

  it("keeps the frame cap within 1-999 (0 divides by zero in the engine)", () => {
    expect(validateLaunchOptions({ frameCap: 0 }).errors).toHaveLength(1);
    expect(validateLaunchOptions({ frameCap: 1000 }).errors).toHaveLength(1);
    expect(validateLaunchOptions({ frameCap: 999 }).options).toEqual({ frameCap: 999 });
    expect(validateLaunchOptions({ frameCap: 1 }).options).toEqual({ frameCap: 1 });
  });

  it("takes only a plain file name for the GameSpy file", () => {
    for (const bad of ["../gamespy.cfg", "dir/gamespy.cfg", "C:\\gamespy.cfg", "game spy.cfg", ".."]) {
      expect(validateLaunchOptions({ gameSpyFile: bad }).errors).toHaveLength(1);
    }
  });

  it("warns when the game and GameSpy ports collide", () => {
    expect(validateLaunchOptions({ gamePort: 20142 }).warnings[0]).toMatch(/both 20142\/udp/);
    expect(validateLaunchOptions({ gamePort: 2116, gameSpyPort: 2116 }).warnings[0]).toMatch(/both 2116\/udp/);
  });

  it("drops stored options that no longer validate", () => {
    expect(sanitizeStoredLaunchOptions({ gamePort: 2116 })).toEqual({ gamePort: 2116 });
    expect(sanitizeStoredLaunchOptions({ gamePort: 99999 })).toBeNull();
    expect(sanitizeStoredLaunchOptions("junk")).toBeNull();
  });
});

describe("launchOptionArgs", () => {
  it("renders the flags in a fixed order", () => {
    expect(
      launchOptionArgs({
        gameSpyFile: "gs.cfg",
        gameSpyPort: 20206,
        noMultiBmp: true,
        frameCap: 30,
        gamePort: 2116,
        bindIp: "192.168.0.103",
      }),
    ).toEqual([
      "-useip", "192.168.0.103",
      "-useport", "2116",
      "-framecap", "30",
      "-nomultibmp",
      "-gamespyport", "20206",
      "-gspyfile", "gs.cfg",
    ]);
  });

  it("renders nothing for no options", () => {
    expect(launchOptionArgs(null)).toEqual([]);
    expect(launchOptionArgs({})).toEqual([]);
    expect(launchOptionArgs({ noMultiBmp: false })).toEqual([]);
  });
});

describe("consoleHostFor and effectivePorts", () => {
  it("follows -useip, except the wildcard", () => {
    expect(consoleHostFor({ bindIp: "192.168.0.103" })).toBe("192.168.0.103");
    expect(consoleHostFor({ bindIp: "0.0.0.0" })).toBeNull();
    expect(consoleHostFor(null)).toBeNull();
  });

  it("falls back to the engine's default ports", () => {
    expect(effectivePorts(null)).toEqual({ game: 2092, gameSpy: 20142 });
    expect(effectivePorts({ gamePort: 2116, gameSpyPort: 20206 })).toEqual({ game: 2116, gameSpy: 20206 });
  });
});

describe("findPortConflicts", () => {
  const self = { name: "Pro", game: 2116, gameSpy: 20206, console: 2106 };

  it("reports nothing for distinct ports", () => {
    expect(findPortConflicts(self, [{ name: "Other", game: 2092, gameSpy: 20142, console: 2092 }])).toEqual([]);
  });

  it("names the other profile and every shared port, once per profile", () => {
    const warnings = findPortConflicts(self, [{ name: "Twin", game: 2116, gameSpy: 20206, console: 2106 }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Profile "Twin"');
    expect(warnings[0]).toContain("game port 2116/udp");
    expect(warnings[0]).toContain("GameSpy port 20206/udp");
    expect(warnings[0]).toContain("console port 2106/tcp");
  });

  it("matches UDP against UDP across kinds, never UDP against TCP", () => {
    // Our game port is the other's GameSpy port: both UDP.
    expect(findPortConflicts(self, [{ name: "A", game: 2092, gameSpy: 2116, console: 2092 }])[0]).toContain(
      "game port 2116/udp (its GameSpy port)",
    );
    // Our console port (TCP) equals the other's game port (UDP): no clash.
    expect(findPortConflicts(self, [{ name: "B", game: 2106, gameSpy: 20142, console: 2092 }])).toEqual([]);
  });

  it("skips an unknown console port and checks TCP services", () => {
    expect(findPortConflicts({ ...self, console: null }, [{ name: "C", game: 1, gameSpy: 2, console: null }])).toEqual(
      [],
    );
    expect(findPortConflicts(self, [], [{ name: "mission host", port: 2106 }])[0]).toMatch(/mission host port/);
  });
});
