import { describe, it, expect } from "vitest";
import {
  LINE_KEEP,
  MAX_TRACKERS,
  TRACKER_HOST_MAX,
  formatTrackerList,
  parseTracker,
  parseTrackerList,
  validateTrackerList,
} from "./trackerList.js";

/**
 * The tracker list as gspy_Init (Descent3/gamespy.cpp) reads it: pairs of a
 * region line and a tracker line, at most five, with cf_ReadString's line
 * ends and its 298-character lines.
 */
describe("parseTrackerList", () => {
  it("reads region and tracker pairs", () => {
    const text = "3\ntracker.example.org\n3\ntracker.example.net:28000\n3\n192.0.2.10\n";
    expect(parseTrackerList(text)).toEqual({
      region: 3,
      trackers: ["tracker.example.org", "tracker.example.net:28000", "192.0.2.10"],
      ignored: [],
    });
  });

  it("reads one region line then hosts the way the game does: the first and third only", () => {
    // The game reads the second host as a region: atoi("192.0.2.10:27952") is 192.
    const text = "5\ntracker.example.org\n192.0.2.10:27952\ntracker.example.net\n";
    expect(parseTrackerList(text)).toEqual({
      region: 192,
      trackers: ["tracker.example.org", "tracker.example.net"],
      ignored: ["192.0.2.10:27952"],
    });
  });

  it("gives region 0 for a host name in a region line", () => {
    expect(parseTrackerList("5\ntracker.example.org\ntracker.example.net\n")).toEqual({
      region: 0,
      trackers: ["tracker.example.org"],
      ignored: ["tracker.example.net"],
    });
  });

  it("keeps the last region read", () => {
    expect(parseTrackerList("2\ntracker.example.org\n7\ntracker.example.net\n").region).toBe(7);
  });

  it("ends lines at CR LF, CR or LF", () => {
    const expected = { region: 4, trackers: ["tracker.example.org", "tracker.example.net"], ignored: [] };
    expect(parseTrackerList("4\r\ntracker.example.org\r\n4\r\ntracker.example.net\r\n")).toEqual(expected);
    expect(parseTrackerList("4\rtracker.example.org\r4\rtracker.example.net")).toEqual(expected);
    expect(parseTrackerList("4\ntracker.example.org\r\n4\rtracker.example.net\n")).toEqual(expected);
  });

  it("counts a blank line as a line read: it keeps its slot and is used for nothing", () => {
    // Line 1 (region) blank: the region stays 0. Line 4 (a tracker) blank: that slot is empty.
    expect(parseTrackerList("\ntracker.example.org\n6\n\n6\ntracker.example.net\n")).toEqual({
      region: 6,
      trackers: ["tracker.example.org", "tracker.example.net"],
      ignored: [],
    });
    // Two blank lines between pairs shift every later line by two: still pairs.
    expect(parseTrackerList("1\ntracker.example.org\n\n\n1\ntracker.example.net\n").trackers).toEqual([
      "tracker.example.org",
      "tracker.example.net",
    ]);
  });

  it("reports a line of spaces: as a region it reads 0, as a tracker it resolves to nothing", () => {
    expect(parseTrackerList("8\n   \n  \ntracker.example.org\n")).toEqual({
      region: 0,
      trackers: ["tracker.example.org"],
      ignored: ["   ", "  "],
    });
  });

  it("reads five pairs and reports every line after them", () => {
    const pairs = Array.from({ length: 6 }, (_, i) => `1\nt${i + 1}.example.org`).join("\n");
    const read = parseTrackerList(`${pairs}\n9\n`);
    expect(read.trackers).toEqual(["t1.example.org", "t2.example.org", "t3.example.org", "t4.example.org", "t5.example.org"]);
    expect(read.region).toBe(1);
    expect(read.ignored).toEqual(["1", "t6.example.org", "9"]);
  });

  it("keeps host:port as written", () => {
    expect(parseTrackerList("0\ntracker.example.org:27901\n").trackers).toEqual(["tracker.example.org:27901"]);
  });

  it("reads a region line as atoi does", () => {
    expect(parseTrackerList(" 12\nx.example.org\n").region).toBe(12);
    expect(parseTrackerList("-3\nx.example.org\n").region).toBe(-3);
    expect(parseTrackerList("5 \nx.example.org\n")).toMatchObject({ region: 5, ignored: [] });
    // A number followed by other text: the game reads 9, but the line is not in the form the panel writes.
    expect(parseTrackerList("9 west\nx.example.org\n")).toMatchObject({ region: 9, ignored: ["9 west"] });
    expect(parseTrackerList("west\nx.example.org\n")).toMatchObject({ region: 0, ignored: ["west"] });
  });

  it("cuts a line at 298 characters and stops it at a NUL", () => {
    const long = "a".repeat(LINE_KEEP + 20);
    expect(parseTrackerList(`0\n${long}\n`).trackers).toEqual(["a".repeat(LINE_KEEP)]);
    expect(parseTrackerList("0\ntracker.example.org\0junk\n").trackers).toEqual(["tracker.example.org"]);
  });

  it("reads an empty file, or one with no line end at the close", () => {
    expect(parseTrackerList("")).toEqual({ region: 0, trackers: [], ignored: [] });
    expect(parseTrackerList("2\ntracker.example.org")).toEqual({ region: 2, trackers: ["tracker.example.org"], ignored: [] });
  });
});

describe("formatTrackerList", () => {
  it("writes region and tracker pairs with LF line ends", () => {
    expect(formatTrackerList({ region: 3, trackers: ["tracker.example.org", "192.0.2.10:28000"] }, false)).toBe(
      "3\ntracker.example.org\n3\n192.0.2.10:28000\n",
    );
  });

  it("writes just the region line with no trackers", () => {
    expect(formatTrackerList({ region: 4, trackers: [] }, false)).toBe("4\n");
    expect(formatTrackerList({ region: 0, trackers: [] }, true)).toBe("0\n");
  });

  it("writes nothing for region 0 and no trackers when there is no file", () => {
    expect(formatTrackerList({ region: 0, trackers: [] }, false)).toBeNull();
  });

  it("writes what the parser reads back", () => {
    const list = { region: 11, trackers: ["tracker.example.org", "tracker.example.net:27901", "192.0.2.10"] };
    expect(parseTrackerList(formatTrackerList(list, false)!)).toEqual({ ...list, ignored: [] });
  });
});

describe("parseTracker", () => {
  it("takes a host name or an IPv4 address, with or without a port", () => {
    expect(parseTracker("tracker.example.org")).toEqual({ host: "tracker.example.org", port: 27900 });
    expect(parseTracker("tracker.example.org:28000")).toEqual({ host: "tracker.example.org", port: 28000 });
    expect(parseTracker("192.0.2.10")).toEqual({ host: "192.0.2.10", port: 27900 });
    expect(parseTracker("192.0.2.10:1")).toEqual({ host: "192.0.2.10", port: 1 });
    expect(parseTracker("localhost:65535")).toEqual({ host: "localhost", port: 65535 });
    expect(parseTracker("my-tracker.example.org")).toMatchObject({ port: 27900 });
  });

  it("refuses what the game could not use", () => {
    for (const bad of [
      "",
      "tracker.example.org ",
      "tracker example.org",
      ":27900",
      "tracker.example.org:",
      "tracker.example.org:0",
      "tracker.example.org:65536",
      "tracker.example.org:27900:1",
      "tracker.example.org:port",
      "192.0.2",
      "192.0.2.256",
      "5",
      "255.255.255.255",
      "-tracker.example.org",
      "tracker_one.example.org",
      "tracker..example.org",
      "tracker.example.org.",
      "[2001:db8::1]:27900",
    ]) {
      expect(parseTracker(bad), bad).toHaveProperty("error");
    }
  });

  it("takes a host of 253 characters and refuses a longer one", () => {
    const label = "a".repeat(63);
    const host253 = [label, label, label, "a".repeat(61)].join(".");
    expect(host253).toHaveLength(TRACKER_HOST_MAX);
    expect(parseTracker(`${host253}:27900`)).toEqual({ host: host253, port: 27900 });
    expect(parseTracker(`${host253}a`)).toHaveProperty("error");
  });
});

describe("validateTrackerList", () => {
  it("takes a region from 0 to 12 and up to five trackers", () => {
    const trackers = ["t1.example.org", "t2.example.org", "t3.example.org", "t4.example.org", "192.0.2.10:27901"];
    expect(validateTrackerList({ region: 12, trackers })).toEqual({ list: { region: 12, trackers }, errors: [] });
    expect(validateTrackerList({ region: 0, trackers: [] })).toEqual({ list: { region: 0, trackers: [] }, errors: [] });
    expect(validateTrackerList({ region: "7", trackers: [] }).list).toEqual({ region: 7, trackers: [] });
  });

  it("trims the trackers", () => {
    expect(validateTrackerList({ region: 0, trackers: ["  tracker.example.org "] }).list?.trackers).toEqual([
      "tracker.example.org",
    ]);
  });

  it("refuses a region outside 0 to 12 or not a whole number", () => {
    for (const region of [-1, 13, 1.5, "x", "", null, undefined, true]) {
      expect(validateTrackerList({ region, trackers: [] }).errors).toEqual([
        "The region must be a whole number from 0 to 12.",
      ]);
    }
  });

  it("refuses more than five trackers", () => {
    const trackers = Array.from({ length: MAX_TRACKERS + 1 }, (_, i) => `t${i}.example.org`);
    expect(validateTrackerList({ region: 0, trackers })).toEqual({
      list: null,
      errors: ["The game reads at most 5 trackers; this list has 6."],
    });
    expect(validateTrackerList({ region: 0, trackers: "tracker.example.org" }).errors).toEqual([
      "trackers must be a list of at most 5 trackers.",
    ]);
  });

  it("names each bad tracker", () => {
    expect(validateTrackerList({ region: 0, trackers: ["tracker.example.org", "bad host", 7, ""] }).errors).toEqual([
      "Tracker 2 has a space in it.",
      "Tracker 3 must be text.",
      "Tracker 4 is empty.",
    ]);
  });

  it("refuses a tracker twice: host without case, with the port the game would use", () => {
    expect(
      validateTrackerList({ region: 0, trackers: ["tracker.example.org", "TRACKER.example.org:27900"] }).errors,
    ).toEqual(["Tracker 2 repeats tracker 1 (tracker.example.org:27900)."]);
    expect(validateTrackerList({ region: 0, trackers: ["tracker.example.org", "tracker.example.org:27901"] }).errors).toEqual(
      [],
    );
  });

  it("reports the region and the trackers together", () => {
    expect(validateTrackerList({ region: 40, trackers: ["x y"] }).errors).toHaveLength(2);
    expect(validateTrackerList(null).errors).toHaveLength(2);
  });
});
