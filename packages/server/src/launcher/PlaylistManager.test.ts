import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PlaylistManager, type PlaylistEntry } from "./PlaylistManager.js";

async function makeManager(): Promise<PlaylistManager> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-test-"));
  return new PlaylistManager(dir);
}

const sampleEntries: Omit<PlaylistEntry, "id">[] = [
  { label: "Mission A", missionName: "a.mn3" },
  { label: "Mission B", missionName: "b.mn3" },
  { label: "Mission C", missionName: "c.mn3" },
];

describe("PlaylistManager — rotation", () => {
  let mgr: PlaylistManager;

  beforeEach(async () => {
    mgr = await makeManager();
  });

  it("emits rotate with entry[1] after first 'Ending level.' (sequential, post-launch)", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);
    // Simulate the launcher's pre-launch consume — first level on disk is now entry[0]
    expect(mgr.consumeInitialSync()?.missionName).toBe("a.mn3");

    const rotated: PlaylistEntry[] = [];
    mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));

    mgr.onStdoutChunk("Ending level.\n");

    expect(rotated).toHaveLength(1);
    expect(rotated[0].missionName).toBe("b.mn3");
    expect(mgr.getStatus().status).toBe("restarting");
  });

  it("first 'Ending level.' loads entry[0] when activated mid-game (no consumeInitialSync)", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);
    // No consumeInitialSync call — server was already running on activate

    const rotated: PlaylistEntry[] = [];
    mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));

    mgr.onStdoutChunk("Ending level.\n");

    expect(rotated).toHaveLength(1);
    expect(rotated[0].missionName).toBe("a.mn3");
  });

  it("drops 'Ending level.' while restarting, then resumes after markRotationComplete", () => {
    return (async () => {
      const pl = await mgr.create("p", "sequential", sampleEntries);
      await mgr.activate(pl.id);
      mgr.consumeInitialSync();

      const rotated: PlaylistEntry[] = [];
      mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));

      mgr.onStdoutChunk("Ending level.\n");
      // Second signal during restart is dropped
      mgr.onStdoutChunk("Ending level.\n");
      expect(rotated).toHaveLength(1);

      // Simulate launcher finishing the restart
      mgr.markRotationComplete();
      expect(mgr.getStatus().status).toBe("active");

      // Now another level-end advances again
      mgr.onStdoutChunk("Ending level.\n");
      expect(rotated).toHaveLength(2);
      expect(rotated[1].missionName).toBe("c.mn3");
    })();
  });

  it("loops back to entry[0] after the last entry (sequential)", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();

    const rotated: PlaylistEntry[] = [];
    mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));

    for (let i = 0; i < 3; i++) {
      mgr.onStdoutChunk("Ending level.\n");
      mgr.markRotationComplete();
    }

    expect(rotated.map((e) => e.missionName)).toEqual(["b.mn3", "c.mn3", "a.mn3"]);
  });

  it("buffers partial stdout lines correctly", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();

    const rotated: PlaylistEntry[] = [];
    mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));

    mgr.onStdoutChunk("Ending ");
    expect(rotated).toHaveLength(0);
    mgr.onStdoutChunk("level.\n");
    expect(rotated).toHaveLength(1);
  });

  it("ignores 'Ending level.' when no playlist is active", () => {
    mgr.onStdoutChunk("Ending level.\n");
    expect(mgr.getStatus().status).toBe("inactive");
  });
});

describe("PlaylistManager — voting", () => {
  let mgr: PlaylistManager;

  beforeEach(async () => {
    mgr = await makeManager();
  });

  it("tallies vote chat lines and resolves to winner", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.update(pl.id, {
      voting: { enabled: true, preAnnounceSeconds: 60, voteOpenSeconds: 30, optionCount: 2 },
    });
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();

    // Anchor a timer with a long enough window that scheduling kicks in
    mgr.parseAndAnchorFromNetgameinfo(
      "Time Left: 1:00\nTime Limit: 5 minutes\nGoal: None\n",
    );

    // Voting won't open until the preAnnounce timer fires; force-open by
    // calling parseAndAnchorFromNetgameinfo with a short time-left so
    // scheduleVoting's "already inside the window" branch triggers.
    mgr.parseAndAnchorFromNetgameinfo(
      "Time Left: 0:30\nTime Limit: 5 minutes\nGoal: None\n",
    );

    expect(mgr.getStatus().status).toBe("voting");
    const opts = mgr.getStatus().voteOptions;
    expect(opts.length).toBeGreaterThan(0);

    // Players vote
    mgr.onStdoutChunk("*Alice says: 1\n");
    mgr.onStdoutChunk("*Bob says: 2\n");
    mgr.onStdoutChunk("*Carol says: 1\n");

    const results: Array<{ winner: PlaylistEntry; counts: number[] }> = [];
    mgr.on("voteResult", (winner: PlaylistEntry, counts: number[]) => {
      results.push({ winner, counts });
    });

    // Trigger end of level — should tally immediately
    mgr.onStdoutChunk("Ending level.\n");

    expect(results).toHaveLength(1);
    expect(results[0].counts[0]).toBe(2);
    expect(results[0].counts[1]).toBe(1);
    expect(results[0].winner.id).toBe(opts[0].id);
  });

  it("ignores chat numbers when not in voting state", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);

    // No timer anchored, no voting open
    mgr.onStdoutChunk("*Alice says: 1\n");

    expect(mgr.getStatus().voteOptions).toHaveLength(0);
  });
});
