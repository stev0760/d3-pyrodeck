import { describe, it, expect } from "vitest";
import {
  regionProblem,
  trackerFormChanged,
  trackerFormFrom,
  trackerNotes,
  trackerPayload,
  trackerSummary,
  type TrackerListView,
} from "./trackerList.ts";

const view = (over: Partial<TrackerListView> = {}): TrackerListView => ({
  file: "gamespy.cfg",
  path: "/srv/d3/gamespy.cfg",
  exists: true,
  writable: true,
  writeError: null,
  region: 2,
  trackers: ["tracker.example.org", "tracker.example.net:27901"],
  ignored: [],
  sharedWith: [],
  gameSpyPort: { port: 20142, source: "default" },
  running: false,
  ...over,
});

describe("the tracker form", () => {
  it("starts from what the game reads", () => {
    expect(trackerFormFrom(view())).toEqual({ region: "2", trackers: ["tracker.example.org", "tracker.example.net:27901"] });
  });

  it("sends rows trimmed, drops empty ones, and reads an empty region as 0", () => {
    expect(trackerPayload({ region: " 7 ", trackers: [" tracker.example.org ", "", "   "] })).toEqual({
      region: 7,
      trackers: ["tracker.example.org"],
    });
    expect(trackerPayload({ region: "", trackers: [] })).toEqual({ region: 0, trackers: [] });
    // Left for the server to refuse with its message.
    expect(trackerPayload({ region: "west", trackers: [] }).region).toBe("west");
  });

  it("checks the typed region before a save", () => {
    for (const ok of ["0", "12", " 5 ", ""]) expect(regionProblem(ok), ok).toBeNull();
    for (const bad of ["13", "192", "-1", "1.5", "west"]) {
      expect(regionProblem(bad), bad).toBe("The region must be a whole number from 0 to 12.");
    }
  });

  it("is changed only when the region or a tracker would change", () => {
    const v = view();
    expect(trackerFormChanged(trackerFormFrom(v), v)).toBe(false);
    expect(trackerFormChanged({ region: "2", trackers: [...v.trackers, ""] }, v)).toBe(false);
    expect(trackerFormChanged({ region: "3", trackers: v.trackers }, v)).toBe(true);
    expect(trackerFormChanged({ region: "2", trackers: [...v.trackers].reverse() }, v)).toBe(true);
    expect(trackerFormChanged({ region: "2", trackers: ["tracker.example.org"] }, v)).toBe(true);
  });

  it("sums the list up when the block is closed", () => {
    expect(trackerSummary(null, null)).toBe("Loading...");
    expect(trackerSummary(null, "boom")).toBe("Cannot read");
    expect(trackerSummary(view(), null)).toBe("2 trackers");
    expect(trackerSummary(view({ trackers: ["tracker.example.org"] }), null)).toBe("1 tracker");
    expect(trackerSummary(view({ trackers: [] }), null)).toBe("Not listed");
  });
});

describe("trackerNotes", () => {
  const texts = (v: TrackerListView, n = v.trackers.length) => trackerNotes(v, n).map((note) => note.text);

  it("names the file, when the game reads it, and the port to open", () => {
    expect(texts(view({ gameSpyPort: { port: 20150, source: "profile" } }))).toEqual([
      "Saved to /srv/d3/gamespy.cfg, in the game directory, not in the profile: this block has its own Save.",
      "The game reads the list when the server starts.",
      "Trackers query the server back on UDP port 20150, which must be reachable from the internet.",
    ]);
  });

  it("says a missing file is not there yet", () => {
    expect(texts(view({ exists: false }))[0]).toMatch(/^Saved to \/srv\/d3\/gamespy\.cfg \(not there yet\), /);
  });

  it("warns about the other servers reading the same file", () => {
    const notes = trackerNotes(view({ sharedWith: ["CTF", "Co-op"] }), 2);
    expect(notes[1]).toEqual({
      text:
        'Also read by "CTF", "Co-op": servers of one game directory share the list unless a profile names its own ' +
        "GameSpy file (Launch Options).",
      tone: "warn",
    });
  });

  it("says a running server keeps its list until it restarts", () => {
    expect(texts(view({ running: true, gameSpyPort: { port: 20143, source: "running" } }))).toContain(
      "The game reads the list when the server starts. This server is running: it keeps the list it started with until it restarts.",
    );
  });

  it("says the default port can move, and how to keep it fixed", () => {
    expect(texts(view())[2]).toBe(
      "Trackers query the server back on UDP port 20142, which must be reachable from the internet. With no GameSpy " +
        "port set, Pyrodeck moves it to a free one when another server holds 20142; set one in Launch Options to keep it fixed.",
    );
  });

  it("says a server with no trackers is listed nowhere, following the form", () => {
    expect(texts(view(), 0)).toContain("With no trackers, the server is listed nowhere.");
    expect(texts(view({ trackers: [] }), 1)).not.toContain("With no trackers, the server is listed nowhere.");
  });
});
