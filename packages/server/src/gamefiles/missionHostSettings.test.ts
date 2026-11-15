import { describe, it, expect } from "vitest";
import {
  buildHostedMissionUrl,
  checkPublicBaseUrl,
  isServableMission,
  sanitizeStoredMissionHost,
  validateMissionHostSettings,
} from "./missionHostSettings.js";
import { MISSION_URL_MAX } from "./Mn3UrlRewriter.js";

describe("checkPublicBaseUrl", () => {
  it("normalizes to lower-case http://host[:port] with no trailing slash", () => {
    expect(checkPublicBaseUrl("HTTP://Example.ORG:3002/").url).toBe("http://example.org:3002");
    expect(checkPublicBaseUrl(" http://example.org:80 ").url).toBe("http://example.org");
    expect(checkPublicBaseUrl("http://[2001:db8::1]:3002").url).toBe("http://[2001:db8::1]:3002");
  });

  it("refuses https, other schemes, paths, queries and credentials", () => {
    expect(checkPublicBaseUrl("https://example.org").errors.join(" ")).toMatch(/plain http only/);
    expect(checkPublicBaseUrl("ftp://example.org").url).toBeNull();
    expect(checkPublicBaseUrl("http://example.org/d3").url).toBeNull();
    expect(checkPublicBaseUrl("http://example.org/?a=1").url).toBeNull();
    expect(checkPublicBaseUrl("http://user:pw@example.org").url).toBeNull();
    expect(checkPublicBaseUrl("example.org").url).toBeNull();
    expect(checkPublicBaseUrl("").url).toBeNull();
  });

  it("warns, without refusing, on addresses only the LAN can reach", () => {
    for (const lan of ["http://192.168.1.20:3002", "http://10.0.0.5", "http://localhost:3002", "http://[::1]:3002"]) {
      const check = checkPublicBaseUrl(lan);
      expect(check.url).not.toBeNull();
      expect(check.warnings).toHaveLength(1);
    }
    expect(checkPublicBaseUrl("http://203.0.113.7:3002").warnings).toHaveLength(0);
    expect(checkPublicBaseUrl("http://fdexample.org").warnings).toHaveLength(0);
  });
});

describe("validateMissionHostSettings", () => {
  it("needs a public base URL to enable", () => {
    const check = validateMissionHostSettings({ enabled: true, port: 3002 });
    expect(check.errors.join(" ")).toMatch(/public base URL/);
    expect(validateMissionHostSettings({ enabled: false, port: 3002 }).errors).toEqual([]);
  });

  it("checks the port range and keeps the normalized URL", () => {
    expect(validateMissionHostSettings({ port: 0 }).errors).toHaveLength(1);
    expect(validateMissionHostSettings({ port: 70000 }).errors).toHaveLength(1);
    expect(validateMissionHostSettings({ port: 30.5 }).errors).toHaveLength(1);
    expect(
      validateMissionHostSettings({ enabled: true, port: "3005", publicBaseUrl: "http://Example.org:3005/" }),
    ).toEqual({
      settings: { enabled: true, port: 3005, publicBaseUrl: "http://example.org:3005" },
      errors: [],
      warnings: [],
    });
  });

  it("never enables from a bad stored value", () => {
    expect(sanitizeStoredMissionHost({ enabled: true, port: 3002, publicBaseUrl: "https://x.org" })).toEqual({
      enabled: false,
      port: 3002,
      publicBaseUrl: null,
    });
    expect(sanitizeStoredMissionHost("junk")).toEqual({ enabled: false, port: 3002, publicBaseUrl: null });
  });
});

describe("buildHostedMissionUrl", () => {
  const base = "http://example.org:3002";

  it("builds <base>/missions/<file>, percent-encoding the name", () => {
    expect(buildHostedMissionUrl(base, "mymission.mn3")).toEqual({
      url: "http://example.org:3002/missions/mymission.mn3",
    });
    expect(buildHostedMissionUrl(base, "My Map+1.mn3")).toEqual({
      url: "http://example.org:3002/missions/My%20Map%2B1.mn3",
    });
  });

  it("refuses retail missions and names that are not plain .mn3 files", () => {
    expect(buildHostedMissionUrl(base, "d3.mn3")).toEqual({ error: expect.stringMatching(/Retail/) });
    expect(buildHostedMissionUrl(base, "Training.MN3")).toEqual({ error: expect.stringMatching(/Retail/) });
    expect(buildHostedMissionUrl(base, "../x.mn3")).toHaveProperty("error");
    expect(buildHostedMissionUrl(base, "x.hog")).toHaveProperty("error");
  });

  it("refuses every mission that ships with the game, in any case", () => {
    for (const stock of ["bedlam.mn3", "Chaos.MN3", "tri-pod.mn3", "bsidectf.mn3", "STONECUTTER.mn3"]) {
      expect(buildHostedMissionUrl(base, stock)).toEqual({
        error: expect.stringMatching(/ships with Descent 3; every player already has it/),
      });
    }
  });

  it("refuses a link longer than the client takes, naming the length", () => {
    const prefix = `${base}/missions/`; // 33 characters
    const fits = `${"a".repeat(MISSION_URL_MAX - prefix.length - 4)}.mn3`;
    expect(buildHostedMissionUrl(base, fits)).toEqual({ url: `${prefix}${fits}` });
    const tooLong = `a${fits}`;
    const result = buildHostedMissionUrl(base, tooLong);
    expect(result).toEqual({ error: expect.stringMatching(/would be 87 characters.*at most 86/) });
  });
});

describe("isServableMission", () => {
  const entries = [
    "mymission.mn3",
    "Other.MN3",
    "d3.mn3",
    "Havoc.mn3",
    "mymission.mn3.pyrodeck-orig",
    "readme.txt",
    "sub",
  ];

  it("serves only listed .mn3 names that do not ship with the game, case-exact", () => {
    expect(isServableMission("mymission.mn3", entries)).toBe(true);
    expect(isServableMission("Other.MN3", entries)).toBe(true);
    expect(isServableMission("Mymission.mn3", entries)).toBe(false);
    expect(isServableMission("other.mn3", entries)).toBe(false);
    expect(isServableMission("d3.mn3", entries)).toBe(false);
    expect(isServableMission("Havoc.mn3", entries)).toBe(false);
    expect(isServableMission("mymission.mn3.pyrodeck-orig", entries)).toBe(false);
    expect(isServableMission("readme.txt", entries)).toBe(false);
    expect(isServableMission("unknown.mn3", entries)).toBe(false);
  });

  it("refuses anything that is not a bare file name", () => {
    for (const bad of ["../mine.mn3", "sub/mine.mn3", "..\\mine.mn3", "mine.mn3\0", "..", ".", ""]) {
      expect(isServableMission(bad, [...entries, bad])).toBe(false);
    }
  });
});
