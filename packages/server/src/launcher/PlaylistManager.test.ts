import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  // Fake timers keep the suite hermetic: production code schedules real
  // setTimeouts (level-end window, post-load re-anchor, countdown announces)
  // that would otherwise dangle past each test. Enable after makeManager so
  // its temp-dir I/O runs on the real clock; useRealTimers discards anything
  // still pending.
  beforeEach(async () => {
    mgr = await makeManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits rotate on 'Mission over.' (sequential, post-launch)", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);
    expect(mgr.consumeInitialSync()?.missionName).toBe("a.mn3");

    const rotated: PlaylistEntry[] = [];
    mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));

    mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");

    expect(rotated).toHaveLength(1);
    expect(rotated[0].missionName).toBe("b.mn3");
    expect(mgr.getStatus().status).toBe("restarting");
  });

  it("first 'Mission over.' loads entry[0] when activated mid-game (no consumeInitialSync)", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);

    const rotated: PlaylistEntry[] = [];
    mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));

    mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");

    expect(rotated).toHaveLength(1);
    expect(rotated[0].missionName).toBe("a.mn3");
  });

  it("'Ending level.' does NOT rotate (mid-mission level transition)", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();

    const rotated: PlaylistEntry[] = [];
    mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));

    mgr.onStdoutChunk("Ending level.\n");
    expect(rotated).toHaveLength(0);
    expect(mgr.getStatus().status).toBe("active");
  });

  it("mid-mission transition ('Ending level.' then 'Opening level') clears pendingWinner", async () => {
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
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mgr.getStatus().status).toBe("active");

    // Mid-mission level end: "Opening level" follows without "Mission
    // over." — clears the pending winner, no rotation.
    mgr.onStdoutChunk("Ending level.\n");
    mgr.onStdoutChunk("Opening level 'b.d3l'...\n");
    expect(rotated).toHaveLength(0);

    // Mission finally ends — stale winner was cleared, so default advancement
    // from currentIndex=1 (set by tallyVotes) gives c.mn3
    mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");
    expect(rotated).toHaveLength(1);
    expect(rotated[0].missionName).toBe("c.mn3");
  });

  it("mission end ('Ending level.' then 'Mission over.') keeps pendingWinner", async () => {
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
    const opts = mgr.getStatus().voteOptions;
    mgr.onStdoutChunk("*Alice says: 1\n");
    await vi.advanceTimersByTimeAsync(30_000);

    // Real D3 prints these without trailing newlines, so debug output gets
    // concatenated onto the same line — matching must tolerate that.
    mgr.onStdoutChunk(
      "Ending level.2026-04-10 22:22:15.311 DEBUG [276084] [MultiSendLevelEnded@3587] Sending level ended!\n",
    );
    expect(rotated).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    mgr.onStdoutChunk(
      "Mission over.  Looping back to first level in mission file.2026-04-10 22:22:16.312 DEBUG [276084] [CheckHogfile@1288] Checking\n",
    );

    // Vote winner is honored, not the natural next entry
    expect(rotated).toHaveLength(1);
    expect(rotated[0].id).toBe(opts[0].id);
  });

  it("player chat cannot trigger rotation or level-end handling", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();

    const rotated: PlaylistEntry[] = [];
    mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));

    mgr.onStdoutChunk("*Griefer says: Mission over.  Looping back to first level in mission file.\n");
    mgr.onStdoutChunk("*Griefer says: Ending level.\n");

    expect(rotated).toHaveLength(0);
    expect(mgr.getStatus().status).toBe("active");
  });

  it("emits levelChanged and clears the timer when a new level loads", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();

    mgr.parseAndAnchorFromNetgameinfo(
      "Time Left: 5:00\nTime Limit: 5 minutes\nGoal: None\n",
    );
    expect(mgr.getStatus().gameEndAt).not.toBeNull();

    const levels: Array<string | null> = [];
    const timerUpdates: Array<number | null> = [];
    mgr.on("levelChanged", (l: string | null) => levels.push(l));
    mgr.on("timerUpdate", (t: number | null) => timerUpdates.push(t));

    mgr.onStdoutChunk("Opening level 'b.d3l'...some concatenated debug output\n");

    expect(levels).toEqual(["b"]); // ".d3l" stripped
    expect(mgr.getStatus().currentLevel).toBe("b");
    expect(mgr.getCurrentLevel()).toBe("b");
    expect(mgr.getStatus().gameEndAt).toBeNull();
    expect(timerUpdates).toContain(null);
  });

  it("re-anchors a mid-mission level from cache WITHOUT re-querying $netgameinfo", async () => {
    // $netgameinfo permanently leaks a fixed-size engine buffer on dedicated
    // servers (~30-call budget), so mid-mission level changes must derive the
    // timer from the cached limit rather than polling.
    const pl = await mgr.create("p", "sequential", sampleEntries);
    const send = vi.fn(
      async (_cmd: string) => "Time Left: 5:00\nTime Limit: 5 minutes\nGoal: None\n",
    );
    mgr.sendCommandFn = send;
    await mgr.activate(pl.id); // activation → one $netgameinfo
    mgr.consumeInitialSync();
    await vi.advanceTimersByTimeAsync(1); // flush activate's anchorTimer
    const netCalls = () =>
      send.mock.calls.filter((c) => c[0] === "$netgameinfo").length;
    expect(netCalls()).toBe(1);

    mgr.onStdoutChunk("Opening level 'b.d3l'...\n");
    await vi.advanceTimersByTimeAsync(5_000); // LEVEL_LOAD_REANCHOR_DELAY_MS
    expect(netCalls()).toBe(1); // still one — re-anchored from cache
    expect(mgr.getStatus().gameEndAt).toBeGreaterThan(Date.now() + 290_000);
  });

  it("re-queries $netgameinfo once when a new mission opens after rotation", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    const send = vi.fn(
      async (_cmd: string) => "Time Left: 5:00\nTime Limit: 5 minutes\nGoal: None\n",
    );
    mgr.sendCommandFn = send;
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();
    await vi.advanceTimersByTimeAsync(1);
    const netCalls = () =>
      send.mock.calls.filter((c) => c[0] === "$netgameinfo").length;
    expect(netCalls()).toBe(1);

    // Mission end → rotate; the next mission's config may differ, so its first
    // level load refreshes the cache with exactly one query.
    mgr.onStdoutChunk(
      "Mission over.  Looping back to first level in mission file.\n",
    );
    mgr.onStdoutChunk("Opening level 'b.d3l'...\n");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(netCalls()).toBe(2);
  });

  it("parses the level name from real D3 'Opening level' output", () => {
    // D3 prints the .d3l filename with debug text concatenated, no newline.
    mgr.onStdoutChunk(
      "Opening level 'TheCore.d3l'...2026-04-03 18:46:16.868 DEBUG [563532] [FreeAllRooms@715]\n",
    );
    expect(mgr.getCurrentLevel()).toBe("TheCore");
  });

  it("clearCurrentLevel forgets the loaded level", () => {
    mgr.onStdoutChunk("Opening level 'TheCore.d3l'...\n");
    expect(mgr.getCurrentLevel()).toBe("TheCore");
    mgr.clearCurrentLevel();
    expect(mgr.getCurrentLevel()).toBeNull();
  });

  it("anchors the timer from an H:MM:SS Time Left", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();

    const before = Date.now();
    // 1:05:00 = 3900s remaining, 90-minute limit
    mgr.parseAndAnchorFromNetgameinfo(
      "Time Left: 1:05:00\nTime Limit: 90 minutes\nGoal: None\n",
    );
    const gameEndAt = mgr.getStatus().gameEndAt;
    expect(gameEndAt).not.toBeNull();
    const secondsLeft = (gameEndAt! - before) / 1000;
    expect(secondsLeft).toBeGreaterThan(3895);
    expect(secondsLeft).toBeLessThan(3905);
  });

  it("drops 'Mission over.' while restarting, then resumes after markRotationComplete", () => {
    return (async () => {
      const pl = await mgr.create("p", "sequential", sampleEntries);
      await mgr.activate(pl.id);
      mgr.consumeInitialSync();

      const rotated: PlaylistEntry[] = [];
      mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));

      mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");
      mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");
      expect(rotated).toHaveLength(1);

      mgr.markRotationComplete();
      expect(mgr.getStatus().status).toBe("active");

      mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");
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
      mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");
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

    mgr.onStdoutChunk("Mission over.  Looping back to first ");
    expect(rotated).toHaveLength(0);
    mgr.onStdoutChunk("level in mission file.\n");
    expect(rotated).toHaveLength(1);
  });

  it("ignores 'Mission over.' when no playlist is active", () => {
    mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");
    expect(mgr.getStatus().status).toBe("inactive");
  });
});

describe("PlaylistManager — pause after a failed restart", () => {
  const missionOver = "Mission over.  Looping back to first level in mission file.\n";

  it("pause stops rotation until resume; markRotationComplete does not unpause", async () => {
    const mgr = await makeManager();
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();
    const rotated: PlaylistEntry[] = [];
    mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));
    let statusEvents = 0;
    mgr.on("statusChanged", () => statusEvents++);

    mgr.onStdoutChunk(missionOver);
    expect(rotated.map((e) => e.missionName)).toEqual(["b.mn3"]);

    mgr.pause('Rotation to "Mission B" failed: server exited during startup');
    expect(mgr.getStatus()).toMatchObject({
      status: "paused",
      pausedReason: 'Rotation to "Mission B" failed: server exited during startup',
    });
    expect(mgr.getStatus().pausedAt).toEqual(expect.any(Number));
    expect(statusEvents).toBe(1);

    mgr.markRotationComplete();
    mgr.onStdoutChunk(missionOver);
    expect(mgr.getStatus().status).toBe("paused");
    expect(rotated).toHaveLength(1);

    expect(mgr.resume()).toBe(true);
    expect(mgr.getStatus()).toMatchObject({ status: "active", pausedReason: null, pausedAt: null });
    expect(statusEvents).toBe(2);
    mgr.onStdoutChunk(missionOver);
    expect(rotated.map((e) => e.missionName)).toEqual(["b.mn3", "c.mn3"]);
    expect(mgr.resume()).toBe(false); // not paused any more
  });

  it("keeps the pause across a Pyrodeck restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-test-"));
    const mgr = new PlaylistManager(dir);
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);
    mgr.pause("restart never answered");
    await vi.waitFor(async () => {
      const raw = await fs.readFile(path.join(dir, "playlist-state.json"), "utf-8");
      expect(JSON.parse(raw).paused?.reason).toBe("restart never answered");
    });

    const again = new PlaylistManager(dir);
    await again.restoreState();
    expect(again.getStatus()).toMatchObject({
      status: "paused",
      activePlaylistId: pl.id,
      pausedReason: "restart never answered",
    });
  });

  it("activating or deactivating clears a pause; pause without a playlist is a no-op", async () => {
    const mgr = await makeManager();
    mgr.pause("nothing active");
    expect(mgr.getStatus().status).toBe("inactive");

    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.activate(pl.id);
    mgr.pause("x");
    await mgr.activate(pl.id);
    expect(mgr.getStatus()).toMatchObject({ status: "active", pausedReason: null });
    mgr.pause("y");
    mgr.deactivate();
    expect(mgr.getStatus()).toMatchObject({ status: "inactive", pausedReason: null });
  });
});

describe("PlaylistManager — voting", () => {
  let mgr: PlaylistManager;

  beforeEach(async () => {
    mgr = await makeManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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

    // Trigger mission end — should tally immediately
    mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");

    expect(results).toHaveLength(1);
    expect(results[0].counts[0]).toBe(2);
    expect(results[0].counts[1]).toBe(1);
    expect(results[0].winner.id).toBe(opts[0].id);
  });

  it("vote ties resolve to the first option", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.update(pl.id, {
      voting: { enabled: true, preAnnounceSeconds: 60, voteOpenSeconds: 30, optionCount: 2 },
    });
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();

    mgr.parseAndAnchorFromNetgameinfo(
      "Time Left: 1:00\nTime Limit: 5 minutes\nGoal: None\n",
    );
    const opts = mgr.getStatus().voteOptions;

    mgr.onStdoutChunk("*Alice says: 1\n");
    mgr.onStdoutChunk("*Bob says: 2\n");

    const results: Array<{ winner: PlaylistEntry }> = [];
    mgr.on("voteResult", (winner: PlaylistEntry) => results.push({ winner }));

    mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");
    expect(results).toHaveLength(1);
    expect(results[0].winner.id).toBe(opts[0].id);
  });

  it("zero votes resolve to the first option", async () => {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    await mgr.update(pl.id, {
      voting: { enabled: true, preAnnounceSeconds: 60, voteOpenSeconds: 30, optionCount: 2 },
    });
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();

    mgr.parseAndAnchorFromNetgameinfo(
      "Time Left: 1:00\nTime Limit: 5 minutes\nGoal: None\n",
    );
    const opts = mgr.getStatus().voteOptions;

    const results: Array<{ winner: PlaylistEntry }> = [];
    mgr.on("voteResult", (winner: PlaylistEntry) => results.push({ winner }));

    mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");
    expect(results).toHaveLength(1);
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

    // Mission finally ends — now we rotate to the stored winner
    mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");
    expect(rotated).toHaveLength(1);
    expect(rotated[0].id).toBe(opts[0].id);
    expect(mgr.getStatus().status).toBe("restarting");
  });

  it("drift-correction re-anchor after vote close does not re-open voting", async () => {
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
    // Mission ends before the vote window closes — tally + rotate together.
    mgr.onStdoutChunk("Mission over.  Looping back to first level in mission file.\n");

    expect(rotated).toHaveLength(1);
    expect(mgr.getStatus().status).toBe("restarting");
  });
});

describe("PlaylistManager — the hold before a restart", () => {
  const missionOver = "Mission over.  Looping back to first level in mission file.\n";
  let mgr: PlaylistManager;
  let sent: string[];
  let rotated: PlaylistEntry[];

  beforeEach(async () => {
    mgr = await makeManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** An active playlist past its initial sync, a console that records each line, `humans` on the server. */
  async function activeWith(humans: number | null, holdSeconds?: number): Promise<void> {
    const pl = await mgr.create("p", "sequential", sampleEntries);
    if (holdSeconds !== undefined) await mgr.update(pl.id, { holdSeconds });
    await mgr.activate(pl.id);
    mgr.consumeInitialSync();
    mgr.humansFn = () => humans;
    sent = [];
    mgr.sendCommandFn = async (cmd: string) => {
      sent.push(cmd);
      return "";
    };
    rotated = [];
    mgr.on("rotate", (e: PlaylistEntry) => rotated.push(e));
  }

  it("holds after the loop-back level opens, counts down, then rotates", async () => {
    await activeWith(1);
    mgr.onStdoutChunk(missionOver);
    expect(mgr.getStatus().status).toBe("holding");
    expect(mgr.getStatus().holdEntry?.missionName).toBe("b.mn3");
    expect(mgr.getStatus().holdEndsAt).toBeNull(); // waiting for the loop-back level
    expect(rotated).toHaveLength(0);

    mgr.onStdoutChunk("Opening level 'a.d3l'...\n");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["$wait on"]); // held, and waiting for a human to be back in the level
    expect(mgr.getStatus().holdEndsAt).toBeNull();

    await vi.advanceTimersByTimeAsync(20_000); // the client's score screen and level load
    mgr.onStdoutChunk("*Reaper[BOT] has joined the Anarchy\n");
    expect(sent).toEqual(["$wait on"]); // a bot is not a player coming back
    mgr.onStdoutChunk("*Bob has joined the Anarchy\n");
    expect(sent.some((c) => c.startsWith("say ") && c.includes("Mission B") && c.includes("30 seconds"))).toBe(true);
    expect(mgr.getStatus().holdEndsAt).not.toBeNull();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(rotated).toHaveLength(0);
    expect(sent.filter((c) => c.includes("Restarting into Mission B"))).toHaveLength(3); // 20, 10, 5
    await vi.advanceTimersByTimeAsync(1);
    expect(rotated.map((e) => e.missionName)).toEqual(["b.mn3"]);
    expect(mgr.getStatus().status).toBe("restarting");
    expect(sent).not.toContain("$wait off"); // the server quits held
    expect(sent).not.toContain("$netgameinfo"); // no timer for the level the restart throws away
  });

  it("starts the countdown anyway when the loop-back level never opens", async () => {
    await activeWith(2);
    mgr.onStdoutChunk(missionOver);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent[0]).toBe("$wait on");
    await vi.advanceTimersByTimeAsync(45_000); // no join line either: the countdown starts at the cap
    expect(sent.some((c) => c.includes("30 seconds"))).toBe(true);
    expect(rotated).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rotated).toHaveLength(1);
  });

  it("restarts at once when the server has emptied by the time the wait for players runs out", async () => {
    let humans = 1;
    await activeWith(1);
    mgr.humansFn = () => humans;
    mgr.onStdoutChunk(missionOver);
    mgr.onStdoutChunk("Opening level 'a.d3l'...\n");
    await vi.advanceTimersByTimeAsync(3_000);
    humans = 0;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(rotated).toHaveLength(1);
    expect(sent.filter((c) => c.startsWith("say "))).toHaveLength(0);
  });

  it("repeats the opening lines, with the time left, for a player who arrives during the countdown", async () => {
    await activeWith(2);
    mgr.onStdoutChunk(missionOver);
    mgr.onStdoutChunk("Opening level 'a.d3l'...\n");
    await vi.advanceTimersByTimeAsync(3_000);
    mgr.onStdoutChunk("*Bob has joined the Anarchy\n");
    await vi.advanceTimersByTimeAsync(12_000);
    mgr.onStdoutChunk("Downloading mission data...100 Percent Complete*Ann has joined the Anarchy\n");
    expect(sent.filter((c) => c.includes("Mission over.")).map((c) => /(\d+) seconds/.exec(c)?.[1])).toEqual(["30", "18"]);
    await vi.advanceTimersByTimeAsync(14_000);
    mgr.onStdoutChunk("*Cy has joined the Anarchy\n"); // 4 s left: the countdown line is enough
    expect(sent.filter((c) => c.includes("Mission over."))).toHaveLength(2);
  });

  it("a chat line that quotes a join does not start the countdown", async () => {
    await activeWith(1);
    mgr.onStdoutChunk(missionOver);
    mgr.onStdoutChunk("Opening level 'a.d3l'...\n");
    await vi.advanceTimersByTimeAsync(3_000);
    mgr.onStdoutChunk("*Bob says: *Ann has joined the Anarchy\n");
    expect(sent).toEqual(["$wait on"]);
  });

  it("holds when who is on is not known yet", async () => {
    await activeWith(null);
    mgr.onStdoutChunk(missionOver);
    expect(mgr.getStatus().status).toBe("holding");
  });

  it("rotates at once with nobody on", async () => {
    await activeWith(0);
    mgr.onStdoutChunk(missionOver);
    expect(rotated).toHaveLength(1);
    expect(mgr.getStatus().status).toBe("restarting");
    expect(sent).toHaveLength(0);
  });

  it("rotates at once when the playlist's hold is 0", async () => {
    await activeWith(3, 0);
    mgr.onStdoutChunk(missionOver);
    expect(rotated).toHaveLength(1);
  });

  it("uses the playlist's own hold length", async () => {
    await activeWith(1, 12);
    mgr.onStdoutChunk(missionOver);
    mgr.onStdoutChunk("Opening level 'a.d3l'...\n");
    await vi.advanceTimersByTimeAsync(3_000);
    mgr.onStdoutChunk("*Bob has joined the Anarchy\n");
    expect(sent.some((c) => c.includes("12 seconds"))).toBe(true);
    expect(sent.filter((c) => c.includes("Restarting into"))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(sent.filter((c) => c.includes("Restarting into"))).toHaveLength(2); // 10, 5
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rotated).toHaveLength(1);
  });

  it("lets the players go and does not rotate when the playlist is deactivated mid-hold", async () => {
    await activeWith(1);
    mgr.onStdoutChunk(missionOver);
    mgr.onStdoutChunk("Opening level 'a.d3l'...\n");
    await vi.advanceTimersByTimeAsync(3_000);
    mgr.deactivate();
    expect(sent).toContain("$wait off");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rotated).toHaveLength(0);
  });

  it("cancelHold (the operator took over) lets the players go and stays active", async () => {
    await activeWith(1);
    mgr.onStdoutChunk(missionOver);
    mgr.onStdoutChunk("Opening level 'a.d3l'...\n");
    await vi.advanceTimersByTimeAsync(3_000);
    mgr.cancelHold();
    expect(sent).toContain("$wait off");
    expect(mgr.getStatus().status).toBe("active");
    expect(mgr.getStatus().holdEntry).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rotated).toHaveLength(0);
  });

  it("a cancel before the countdown sends no $wait off (nothing was held)", async () => {
    await activeWith(1);
    mgr.onStdoutChunk(missionOver);
    mgr.cancelHold();
    expect(sent).toHaveLength(0);
  });

  it("rotationSkipped after a hold releases the held server", async () => {
    await activeWith(1);
    mgr.onStdoutChunk(missionOver);
    mgr.onStdoutChunk("Opening level 'a.d3l'...\n");
    await vi.advanceTimersByTimeAsync(3_000);
    mgr.onStdoutChunk("*Bob has joined the Anarchy\n");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rotated).toHaveLength(1);
    mgr.rotationSkipped();
    expect(sent).toContain("$wait off");
    expect(mgr.getStatus().status).toBe("active");
  });

  it("a healthy restart forgets the wait: a later skip sends no $wait off", async () => {
    await activeWith(1);
    mgr.onStdoutChunk(missionOver);
    mgr.onStdoutChunk("Opening level 'a.d3l'...\n");
    await vi.advanceTimersByTimeAsync(3_000);
    mgr.onStdoutChunk("*Bob has joined the Anarchy\n");
    await vi.advanceTimersByTimeAsync(30_000);
    mgr.markRotationComplete();
    mgr.rotationSkipped();
    expect(sent).not.toContain("$wait off");
  });

  it("ignores a second 'Mission over.' during the hold", async () => {
    await activeWith(1);
    mgr.onStdoutChunk(missionOver);
    mgr.onStdoutChunk(missionOver);
    mgr.onStdoutChunk("Opening level 'a.d3l'...\n");
    await vi.advanceTimersByTimeAsync(3_000);
    mgr.onStdoutChunk("*Bob has joined the Anarchy\n");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rotated.map((e) => e.missionName)).toEqual(["b.mn3"]);
  });
});
