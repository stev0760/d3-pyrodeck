import { describe, it, expect, beforeEach, vi } from "vitest";
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

  it("vote closing via timer does NOT rotate early; rotation waits for level end", async () => {
    vi.useFakeTimers();
    try {
      const pl = await mgr.create("p", "sequential", sampleEntries);
      await mgr.update(pl.id, {
        voting: { enabled: true, preAnnounceSeconds: 60, voteOpenSeconds: 30, optionCount: 2 },
      });
      await mgr.activate(pl.id);
      mgr.consumeInitialSync();

      const rotated: PlaylistEntry[] = [];
      mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));

      const results: Array<{ winner: PlaylistEntry; counts: number[] }> = [];
      mgr.on("voteResult", (winner: PlaylistEntry, counts: number[]) => {
        results.push({ winner, counts });
      });

      // preAnnounceSeconds=60 and timeLeft=60 triggers the "already inside
      // the window" branch → openVoting fires immediately.
      mgr.parseAndAnchorFromNetgameinfo(
        "Time Left: 1:00\nTime Limit: 5 minutes\nGoal: None\n",
      );
      expect(mgr.getStatus().status).toBe("voting");
      const opts = mgr.getStatus().voteOptions;
      expect(opts.length).toBeGreaterThan(0);

      // Players vote — option 1 wins
      mgr.onStdoutChunk("*Alice says: 1\n");
      mgr.onStdoutChunk("*Bob says: 1\n");
      mgr.onStdoutChunk("*Carol says: 2\n");

      // Vote window closes (voteOpenSeconds=30)
      await vi.advanceTimersByTimeAsync(30_000);

      // Winner is announced but NO rotation yet — level still has ~30s to play
      expect(results).toHaveLength(1);
      expect(results[0].counts[0]).toBe(2);
      expect(results[0].winner.id).toBe(opts[0].id);
      expect(rotated).toHaveLength(0);
      expect(mgr.getStatus().status).toBe("active");

      // Level finally ends — now we rotate to the stored winner
      mgr.onStdoutChunk("Ending level.\n");
      expect(rotated).toHaveLength(1);
      expect(rotated[0].id).toBe(opts[0].id);
      expect(mgr.getStatus().status).toBe("restarting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drift-correction re-anchor after vote close does not re-open voting", async () => {
    vi.useFakeTimers();
    try {
      const pl = await mgr.create("p", "sequential", sampleEntries);
      await mgr.update(pl.id, {
        voting: { enabled: true, preAnnounceSeconds: 60, voteOpenSeconds: 30, optionCount: 2 },
      });
      await mgr.activate(pl.id);
      mgr.consumeInitialSync();

      mgr.parseAndAnchorFromNetgameinfo(
        "Time Left: 1:00\nTime Limit: 5 minutes\nGoal: None\n",
      );
      expect(mgr.getStatus().status).toBe("voting");

      mgr.onStdoutChunk("*Alice says: 1\n");
      await vi.advanceTimersByTimeAsync(30_000);

      // Vote closed, pendingWinner is set, status is "active" again.
      expect(mgr.getStatus().status).toBe("active");

      // Simulate drift correction re-anchor with time still on the clock.
      // scheduleVoting() must NOT re-open voting while a winner is pending.
      mgr.parseAndAnchorFromNetgameinfo(
        "Time Left: 0:25\nTime Limit: 5 minutes\nGoal: None\n",
      );
      expect(mgr.getStatus().status).toBe("active");
      expect(mgr.getStatus().voteOptions).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits voteReceived on new vote and on vote change, suppresses duplicates", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.update(pl.id, {
      voting: { enabled: true, preAnnounceSeconds: 60, voteOpenSeconds: 30, optionCount: 2 },
    });
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();

    mgr.parseAndAnchorFromNetgameinfo(
      "Time Left: 1:00\nTime Limit: 5 minutes\nGoal: None\n",
    );
    expect(mgr.getStatus().status).toBe("voting");

    const received: Array<{
      playerName: string;
      changed: boolean;
      voterCount: number;
      optionIndex: number;
    }> = [];
    mgr.on("voteReceived", (p: typeof received[number]) => received.push(p));

    mgr.onStdoutChunk("*Alice says: 1\n");
    mgr.onStdoutChunk("*Alice says: 1\n"); // duplicate — should be suppressed
    mgr.onStdoutChunk("*Alice says: 2\n"); // changed vote
    mgr.onStdoutChunk("*Bob says: 1\n");

    expect(received).toHaveLength(3);
    expect(received[0].playerName).toBe("Alice");
    expect(received[0].changed).toBe(false);
    expect(received[1].playerName).toBe("Alice");
    expect(received[1].changed).toBe(true);
    expect(received[1].optionIndex).toBe(1);
    expect(received[2].playerName).toBe("Bob");
    expect(received[2].voterCount).toBe(2);
  });

  it("emits voteReminder periodically while voting is open", async () => {
    vi.useFakeTimers();
    try {
      const pl = await mgr.create("p", "sequential", sampleEntries);
      await mgr.update(pl.id, {
        voting: { enabled: true, preAnnounceSeconds: 60, voteOpenSeconds: 60, optionCount: 2 },
      });
      await mgr.activate(pl.id);
      mgr.consumeInitialSync();

      const reminders: PlaylistEntry[][] = [];
      mgr.on("voteReminder", (opts: PlaylistEntry[]) => reminders.push(opts));

      mgr.parseAndAnchorFromNetgameinfo(
        "Time Left: 1:00\nTime Limit: 5 minutes\nGoal: None\n",
      );
      expect(mgr.getStatus().status).toBe("voting");

      // 25s of voting → reminders should fire at 10s and 20s (two)
      await vi.advanceTimersByTimeAsync(25_000);
      expect(reminders.length).toBe(2);

      // Advance past vote close (voteOpenSeconds=60, so 60s total)
      await vi.advanceTimersByTimeAsync(40_000);
      expect(mgr.getStatus().status).toBe("active"); // vote closed
      const countAtClose = reminders.length;

      // After close, no more reminders
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reminders.length).toBe(countAtClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("level ends mid-vote: tally and rotate together (no deferral)", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.update(pl.id, {
      voting: { enabled: true, preAnnounceSeconds: 60, voteOpenSeconds: 30, optionCount: 2 },
    });
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();

    const rotated: PlaylistEntry[] = [];
    mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));

    mgr.parseAndAnchorFromNetgameinfo(
      "Time Left: 1:00\nTime Limit: 5 minutes\nGoal: None\n",
    );
    expect(mgr.getStatus().status).toBe("voting");

    mgr.onStdoutChunk("*Alice says: 1\n");
    // Level ends before the vote window closes — tally + rotate together.
    mgr.onStdoutChunk("Ending level.\n");

    expect(rotated).toHaveLength(1);
    expect(mgr.getStatus().status).toBe("restarting");
  });
});
