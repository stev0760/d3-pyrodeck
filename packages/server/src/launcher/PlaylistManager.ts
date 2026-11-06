import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { sayToAll } from "../players/playerActions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlaylistEntry {
  id: string;
  label: string;
  /** MissionName= value (the .mn3 filename, without path) */
  missionName: string;
  /** Optional starting level within the mission (SetLevel=). Omit to use mission default. */
  startingLevel?: number;
  /** Relative weight for weighted-random mode (default: 1) */
  weight?: number;
}

export type PlaylistMode = "sequential" | "shuffle" | "weighted";

export interface PlaylistVoting {
  enabled: boolean;
  /** How many seconds before a level ends to open voting (default: 120) */
  preAnnounceSeconds: number;
  /** How many seconds to keep voting open after announcement (default: 60) */
  voteOpenSeconds: number;
  /** How many top options to offer (default: 3, max: 9) */
  optionCount: number;
}

export interface Playlist {
  id: string;
  name: string;
  mode: PlaylistMode;
  entries: PlaylistEntry[];
  voting: PlaylistVoting;
  /**
   * Seconds everyone is held in place (DMFC's `$wait on`, frozen with a countdown in chat) between a mission's end
   * and the restart into the next one, so players see the scores and can quit before the server goes. 0 turns it
   * off. Absent in playlists saved before 0.5.6: DEFAULT_HOLD_SECONDS. Skipped when no human is on.
   */
  holdSeconds?: number;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_HOLD_SECONDS = 30;
export const MAX_HOLD_SECONDS = 120;

export interface PlaylistState {
  activePlaylistId: string | null;
  currentIndex: number;
  shuffleOrder: number[] | null;
  /** Set while rotation is paused (e.g. a restart never came healthy). */
  paused?: { reason: string; at: number } | null;
}

// ---------------------------------------------------------------------------
// Vote tracking
// ---------------------------------------------------------------------------

interface VoteEntry {
  /** Option index (0-based into the offered options array) */
  optionIndex: number;
  /** The actual playlist entry this resolves to */
  playlistEntryId: string;
}

// ---------------------------------------------------------------------------
// Internal state machine states
// ---------------------------------------------------------------------------

// paused: rotation suspended after a failed restart; the operator resumes it.
// holding: the mission is over and everyone is held before the restart (holdSeconds).
type PlaylistStatus = "inactive" | "active" | "voting" | "holding" | "restarting" | "paused";

const PLAYLISTS_FILE = "playlists.json";
const STATE_FILE = "playlist-state.json";

// "Ending level." fires for BOTH mid-mission transitions and mission end.
// Mission end is confirmed by "Mission over." which D3 prints ~1s later;
// if neither "Mission over." nor "Opening level" arrives within this window,
// treat it as a mid-mission transition.
const LEVEL_END_WINDOW_MS = 5_000;

// How long after "Opening level" to wait before re-querying $netgameinfo.
// Level loads take ~1s on the dedicated server; 5s gives slow hosts headroom.
const LEVEL_LOAD_REANCHOR_DELAY_MS = 5_000;

// The hold. After "Mission over." the server loads the mission's first level again; the clients follow it into a
// live level, and the hold starts once that level is up: its "Opening level" line plus HOLD_LEVEL_SETTLE_MS. If the
// line never comes, the hold starts HOLD_LEVEL_WAIT_MS after the mission end anyway.
const HOLD_LEVEL_SETTLE_MS = 3_000;
const HOLD_LEVEL_WAIT_MS = 20_000;
// Countdown lines in chat during the hold, in seconds before the restart (the first line opens the hold).
const HOLD_ANNOUNCE_S = [20, 10, 5];

// ---------------------------------------------------------------------------
// PlaylistManager
// ---------------------------------------------------------------------------

/**
 * Manages server mission playlists.
 *
 * Events:
 *   rotate(entry: PlaylistEntry)   — time to stop the server, swap mission, restart
 *   voteAnnounce(options, timeoutMs)       — voting window just opened; announce options to players
 *   voteReminder(options, deadlineMs)      — periodic re-announce while voting is open
 *   voteReceived({playerName, option, …})  — a player cast or changed their vote
 *   voteResult(winner, counts)             — voting resolved; winner picked (does NOT imply rotation)
 *   timerUpdate(gameEndAt: number | null)  — epoch ms when current game ends, null if no timer
 *   levelChanged(level: string | null)      — a new level is loading (fires regardless of playlist state)
 *   serverInfoRaw(raw: string)              — raw $netgameinfo output from a server-side query (for client broadcast)
 *   statusChanged()                         — paused, resumed, or a hold began or ended (for a playlist_status
 *                                             broadcast)
 */
export class PlaylistManager extends EventEmitter {
  private configDir: string;

  /** Called to send a D3 console command (set by launcher.ts on telnet ready) */
  sendCommandFn: ((cmd: string) => Promise<string>) | null = null;

  private status: PlaylistStatus = "inactive";
  private activePlaylist: Playlist | null = null;
  private currentIndex = 0;
  private shuffleOrder: number[] | null = null;

  /**
   * True after activate() until the playlist's current entry has been applied
   * to a server (either via pre-launch config write or first rotation).
   * Prevents the first "Ending level." from skipping entry[0].
   */
  private needsInitialSync = false;

  /** Why rotation is paused, and since when (epoch ms). Null unless status is "paused". */
  private pausedReason: string | null = null;
  private pausedAt: number | null = null;

  // Timer tracking
  private gameEndAt: number | null = null; // epoch ms
  // Last-known full time limit (seconds) and kill goal, cached from the most
  // recent $netgameinfo. Used to re-anchor the timer on a mid-mission level
  // change WITHOUT re-querying — each $netgameinfo permanently leaks a
  // fixed-size engine text buffer on dedicated servers and crashes them after
  // ~30 calls, so we query at most once per activation/rotation and derive the
  // rest. Null until the first query.
  private cachedTimeLimitSec: number | null = null;
  private cachedKillGoal = 0;
  // Set when a fresh mission is loading (activation/rotation) so the next
  // "Opening level" re-queries $netgameinfo instead of deriving from a stale
  // cache. Mid-mission level transitions leave this false and derive locally.
  private requeryOnNextLevel = false;

  // Vote tracking
  private voteOptions: PlaylistEntry[] = [];
  private votes: Map<string, VoteEntry> = new Map(); // playerName → vote
  private voteDeadline: number | null = null;
  private voteTimer: ReturnType<typeof setTimeout> | null = null;
  private preAnnounceTimer: ReturnType<typeof setTimeout> | null = null;
  private voteReminderInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * Winner selected by a vote that closed BEFORE the level ended. We hold this
   * until "Ending level." fires so the rotation doesn't cut the level short.
   * Cleared on rotate, activate/deactivate, and when a new vote opens.
   */
  private pendingWinner: PlaylistEntry | null = null;

  // The hold (see Playlist.holdSeconds). holdEntry is the mission the hold ends in; holdEndsAt is set once the
  // countdown runs (null while waiting for the loop-back level). waitSent: `$wait on` went to this server, so a hold
  // or a rotation that is called off owes it a `$wait off`.
  private holdEntry: PlaylistEntry | null = null;
  private holdSecondsLeft = 0;
  private holdEndsAt: number | null = null;
  private holdAwaitingLevel = false;
  private holdTimers: ReturnType<typeof setTimeout>[] = [];
  private waitSent = false;

  /**
   * Humans on the server: a count, or null when not known. Set by the launcher (the supervisor's roster). With no
   * function set, nobody is assumed on and no hold runs.
   */
  humansFn: (() => number | null) | null = null;

  /** How often to re-announce the vote options in chat while voting is open. */
  private static readonly VOTE_REMINDER_INTERVAL_MS = 10_000;

  // Countdown announces (fire regardless of playlist state)
  private announceTimers: ReturnType<typeof setTimeout>[] = [];
  private static readonly ANNOUNCE_THRESHOLDS_S = [300, 120, 60, 30, 10];

  // Level transition tracking
  private levelEndWindowTimer: ReturnType<typeof setTimeout> | null = null;
  private reanchorTimer: ReturnType<typeof setTimeout> | null = null;
  // The level file currently loaded (e.g. "TheCore"), parsed from D3's
  // "Opening level 'x.d3l'" stdout. This is server state, not playlist state,
  // but it's tracked here because this is the stdout line parser. Null until
  // the first level loads, or in Connect mode (no stdout to observe).
  private currentLevel: string | null = null;

  // Stdout line buffering
  private stdoutLineBuffer = "";

  constructor(configDir: string) {
    super();
    this.configDir = configDir;
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  private get playlistsPath(): string {
    return path.join(this.configDir, PLAYLISTS_FILE);
  }

  private async loadPlaylists(): Promise<Playlist[]> {
    try {
      const raw = await fs.readFile(this.playlistsPath, "utf-8");
      return JSON.parse(raw) as Playlist[];
    } catch {
      return [];
    }
  }

  private async savePlaylists(playlists: Playlist[]): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    await fs.writeFile(this.playlistsPath, JSON.stringify(playlists, null, 2));
  }

  async list(): Promise<Playlist[]> {
    return this.loadPlaylists();
  }

  async read(id: string): Promise<Playlist> {
    const playlists = await this.loadPlaylists();
    const pl = playlists.find((p) => p.id === id);
    if (!pl) throw new Error(`Playlist not found: ${id}`);
    return pl;
  }

  async create(
    name: string,
    mode: PlaylistMode = "sequential",
    entries: Omit<PlaylistEntry, "id">[] = [],
  ): Promise<Playlist> {
    const playlists = await this.loadPlaylists();
    const now = new Date().toISOString();
    const playlist: Playlist = {
      id: crypto.randomUUID(),
      name,
      mode,
      entries: entries.map((e) => ({ ...e, id: crypto.randomUUID() })),
      voting: {
        enabled: false,
        preAnnounceSeconds: 120,
        voteOpenSeconds: 60,
        optionCount: 3,
      },
      holdSeconds: DEFAULT_HOLD_SECONDS,
      createdAt: now,
      updatedAt: now,
    };
    playlists.push(playlist);
    await this.savePlaylists(playlists);
    return playlist;
  }

  async update(
    id: string,
    updates: Partial<Omit<Playlist, "id" | "createdAt">>,
  ): Promise<Playlist> {
    const playlists = await this.loadPlaylists();
    const idx = playlists.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error(`Playlist not found: ${id}`);
    playlists[idx] = {
      ...playlists[idx],
      ...updates,
      id: playlists[idx].id,
      createdAt: playlists[idx].createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.savePlaylists(playlists);
    // If this is the active playlist, refresh our in-memory copy
    if (this.activePlaylist?.id === id) {
      this.activePlaylist = playlists[idx];
    }
    return playlists[idx];
  }

  async delete(id: string): Promise<void> {
    if (this.activePlaylist?.id === id) {
      this.deactivate();
    }
    const playlists = await this.loadPlaylists();
    const filtered = playlists.filter((p) => p.id !== id);
    if (filtered.length === playlists.length) throw new Error(`Playlist not found: ${id}`);
    await this.savePlaylists(filtered);
  }

  // ---------------------------------------------------------------------------
  // Activation / deactivation
  // ---------------------------------------------------------------------------

  /**
   * Activate a playlist. The next time the current level ends, the manager
   * will rotate to the first entry and trigger a server restart.
   *
   * Does NOT restart the server immediately — the current level plays out.
   * If the server is not yet running when activating, the rotation will begin
   * once the first "Ending level." signal is received.
   */
  async activate(id: string): Promise<void> {
    const playlist = await this.read(id);
    if (playlist.entries.length === 0) {
      throw new Error("Cannot activate playlist with no entries");
    }

    this.activePlaylist = playlist;
    this.currentIndex = 0;
    this.status = "active";
    this.shuffleOrder = null;
    this.needsInitialSync = true;
    this.pendingWinner = null;
    this.pausedReason = null;
    this.pausedAt = null;

    if (playlist.mode === "shuffle") {
      this.buildShuffleOrder();
    }

    // Cancel any pending timers from a previous activation
    this.clearTimers();

    // Query current game state once to anchor the timer (if server is running)
    // and cache the time limit for subsequent local re-anchoring.
    if (this.sendCommandFn) {
      this.anchorTimer().catch(() => {});
    }

    await this.saveState();
    this.emitTimerUpdate();
  }

  deactivate(): void {
    this.endHold(true);
    this.activePlaylist = null;
    this.status = "inactive";
    this.needsInitialSync = false;
    this.pendingWinner = null;
    this.pausedReason = null;
    this.pausedAt = null;
    this.clearTimers();
    this.gameEndAt = null;
    this.emitTimerUpdate();
    this.saveState().catch(() => {});
  }

  isActive(): boolean {
    return this.status !== "inactive";
  }

  /**
   * Called by the launcher after the server has successfully restarted post-rotation
   * and telnet is reconnected. Transitions status from "restarting" back to "active"
   * so the next "Ending level." signal isn't dropped.
   */
  markRotationComplete(): void {
    this.waitSent = false;
    if (this.status === "restarting") {
      this.status = "active";
      this.emitTimerUpdate();
    }
  }

  /**
   * Suspend rotation: no level end rotates and no vote opens until resume().
   * Used when a restarted server never came healthy, so the playlist doesn't
   * keep cycling behind a dead or broken server. The reason is kept for the UI
   * and survives a Pyrodeck restart.
   */
  pause(reason: string): void {
    if (!this.activePlaylist) return;
    this.endHold(true);
    this.status = "paused";
    this.pausedReason = reason;
    this.pausedAt = Date.now();
    this.pendingWinner = null;
    this.clearTimers();
    this.gameEndAt = null;
    this.emitTimerUpdate();
    this.saveState().catch(() => {});
    this.emit("statusChanged");
  }

  /** Resume a paused playlist: the next mission end rotates again. False if not paused. */
  resume(): boolean {
    if (this.status !== "paused" || !this.activePlaylist) return false;
    this.status = "active";
    this.pausedReason = null;
    this.pausedAt = null;
    this.saveState().catch(() => {});
    this.emit("statusChanged");
    return true;
  }

  getStatus(): {
    status: PlaylistStatus;
    activePlaylistId: string | null;
    currentIndex: number;
    currentEntry: PlaylistEntry | null;
    currentLevel: string | null;
    gameEndAt: number | null;
    voteOptions: PlaylistEntry[];
    voteDeadline: number | null;
    pausedReason: string | null;
    pausedAt: number | null;
    holdEntry: PlaylistEntry | null;
    holdEndsAt: number | null;
  } {
    return {
      status: this.status,
      activePlaylistId: this.activePlaylist?.id ?? null,
      currentIndex: this.currentIndex,
      currentEntry: this.currentEntryOrNull(),
      currentLevel: this.currentLevel,
      gameEndAt: this.gameEndAt,
      voteOptions: this.voteOptions,
      voteDeadline: this.voteDeadline,
      pausedReason: this.pausedReason,
      pausedAt: this.pausedAt,
      holdEntry: this.holdEntry,
      holdEndsAt: this.holdEndsAt,
    };
  }

  /** The level file currently loaded, or null. See {@link currentLevel}. */
  getCurrentLevel(): string | null {
    return this.currentLevel;
  }

  /** Forget the loaded level (call when the server process stops). */
  clearCurrentLevel(): void {
    this.currentLevel = null;
  }

  // ---------------------------------------------------------------------------
  // Stdout line feeding
  // ---------------------------------------------------------------------------

  /**
   * Feed a raw stdout chunk from ProcessManager.
   * Buffers partial lines and processes complete ones.
   */
  onStdoutChunk(chunk: string): void {
    this.stdoutLineBuffer += chunk;
    const lines = this.stdoutLineBuffer.split("\n");
    // Keep the incomplete last fragment in the buffer
    this.stdoutLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.onStdoutLine(line);
    }
  }

  private onStdoutLine(line: string): void {
    const trimmed = line.trim();

    // Chat lines start with "*Name says:" — handle them first so player chat
    // can never trigger the level-control markers below (e.g. someone typing
    // "Mission over." in chat must not restart the server).
    if (trimmed.startsWith("*")) {
      this.onChatLine(trimmed);
      return;
    }

    // Mission complete ("Mission over.  Looping back to first level...") —
    // confirms the "Ending level." that preceded it was a mission end.
    if (trimmed.includes("Mission over.")) {
      this.cancelLevelEndWindow();
      this.onMissionEnd();
      return;
    }

    // D3 prints "Ending level." WITHOUT a trailing newline, so the next log
    // line is concatenated onto it — match with includes(), never equality.
    // It fires for both mid-mission transitions and mission end; we don't
    // know which until "Mission over." does (or doesn't) follow.
    if (trimmed.includes("Ending level.")) {
      this.openLevelEndWindow();
      return;
    }

    // New level loading. If the level-end window is still open, no
    // "Mission over." arrived — this was a mid-mission transition.
    if (trimmed.includes("Opening level ")) {
      if (this.levelEndWindowTimer) {
        this.cancelLevelEndWindow();
        this.onLevelEnd();
      }
      // "Opening level 'TheCore.d3l'..." — capture the level file, sans .d3l.
      const m = trimmed.match(/Opening level '([^']+)'/);
      const level = m ? m[1].replace(/\.d3l$/i, "") : null;
      this.onLevelLoading(level);
      return;
    }
  }

  /** Handle a "*PlayerName says: message" chat line (vote detection). */
  private onChatLine(trimmed: string): void {
    if (this.status === "voting") {
      const voteMatch = trimmed.match(/^\*(.+?) says: (\d)$/);
      if (voteMatch) {
        const [, playerName, digit] = voteMatch;
        const optionIndex = parseInt(digit, 10) - 1; // "1" → index 0
        if (optionIndex >= 0 && optionIndex < this.voteOptions.length) {
          const previous = this.votes.get(playerName);
          this.votes.set(playerName, {
            optionIndex,
            playlistEntryId: this.voteOptions[optionIndex].id,
          });
          // Notify listeners so they can acknowledge in-chat. Emit only if
          // this is a new vote OR the player changed their pick — suppress
          // duplicate digits to avoid chat spam from repeated votes.
          if (!previous || previous.optionIndex !== optionIndex) {
            this.emit("voteReceived", {
              playerName,
              option: this.voteOptions[optionIndex],
              optionIndex,
              changed: !!previous,
              voterCount: this.votes.size,
            });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Timer anchoring
  // ---------------------------------------------------------------------------

  /**
   * Query $netgameinfo once and anchor the game end timer. Called on activation
   * and on mission rotation only — NEVER on a timer. $netgameinfo permanently
   * leaks a fixed-size engine text buffer on dedicated servers (it's never
   * flushed without rendering), so repeated polling crashes the server after
   * ~30 calls. Mid-mission level changes re-anchor from the cached limit
   * instead (see onLevelLoading). Runs without an active playlist too —
   * countdown announces are scheduled regardless.
   */
  async anchorTimer(): Promise<void> {
    if (!this.sendCommandFn) return;

    try {
      const raw = await this.sendCommandFn("$netgameinfo");
      // Push the fresh static config to connected web clients so they don't
      // have to poll $netgameinfo themselves.
      this.emit("serverInfoRaw", raw);
      this.parseAndAnchorFromNetgameinfo(raw);
    } catch {
      // Non-fatal — the next level load or rotation will retry.
    }
  }

  /**
   * Parse $netgameinfo output and update the gameEndAt timestamp.
   * Schedules end-of-game countdown announces unconditionally (no active playlist needed).
   * Also gates voting: only enabled when timeLimit > 0 and killGoal == 0.
   */
  parseAndAnchorFromNetgameinfo(raw: string): void {
    const lines = raw.split("\n").map((l) => l.trim());
    const get = (prefix: string): string | undefined =>
      lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim();

    const timeLeftStr = get("Time Left:");
    const timeLimitStr = get("Time Limit:");
    const goalStr = get("Goal:");

    const timeLimit = this.parseTimeLimit(timeLimitStr);
    const killGoal = goalStr && goalStr !== "None"
      ? (parseInt(goalStr.match(/^(\d+)/)?.[1] ?? "0", 10) || 0)
      : 0;

    const hasTimeLimit = !!(timeLeftStr && timeLimit > 0);
    const secondsLeft = hasTimeLimit ? this.parseTimeLeft(timeLeftStr!) : 0;

    // Cache the FULL limit (minutes → seconds) and goal so a mid-mission level
    // change can re-anchor without re-querying $netgameinfo.
    this.cachedTimeLimitSec = timeLimit > 0 ? timeLimit * 60 : null;
    this.cachedKillGoal = killGoal;

    this.applyTimerAnchor(secondsLeft, killGoal);
  }

  /**
   * Anchor the game-end timer and (re)schedule announces/voting from a known
   * seconds-left value. Shared by the $netgameinfo path (real "Time Left") and
   * the level-load path (cached full limit). Announces fire regardless of
   * playlist state; gameEndAt and voting only with an active playlist.
   */
  private applyTimerAnchor(secondsLeft: number, killGoal: number): void {
    if (secondsLeft > 0) {
      this.scheduleAnnounces(secondsLeft);
    } else {
      this.clearAnnounceTimers();
    }

    if (!this.activePlaylist) return;

    if (secondsLeft > 0) {
      this.gameEndAt = Date.now() + secondsLeft * 1000;
      // Schedule voting pre-announce if voting enabled and game has a time limit but no kill goal
      if (this.activePlaylist.voting.enabled && killGoal === 0 && this.status === "active") {
        this.scheduleVoting(secondsLeft);
      }
    } else {
      // No time limit — no timer, no voting
      this.gameEndAt = null;
      this.clearVoteTimers();
    }

    this.emitTimerUpdate();
  }

  /** Update timer anchor when admin changes time limit via $settimelimit */
  onTimelimitChanged(newLimitMinutes: number, timeLeftSeconds?: number): void {
    if (!this.activePlaylist) return;

    if (newLimitMinutes <= 0) {
      this.gameEndAt = null;
      this.clearVoteTimers();
    } else {
      const seconds = timeLeftSeconds ?? newLimitMinutes * 60;
      this.gameEndAt = Date.now() + seconds * 1000;

      if (this.activePlaylist.voting.enabled && this.status === "active") {
        this.scheduleVoting(seconds);
      }
    }
    this.emitTimerUpdate();
  }

  // ---------------------------------------------------------------------------
  // Level end handler
  // ---------------------------------------------------------------------------

  /**
   * "Ending level." was seen. Wait briefly to learn whether it's a mission
   * end ("Mission over." follows) or a mid-mission transition ("Opening
   * level" follows, or nothing). The timer is the fallback if neither
   * marker shows up.
   */
  private openLevelEndWindow(): void {
    this.cancelLevelEndWindow();
    this.levelEndWindowTimer = setTimeout(() => {
      this.levelEndWindowTimer = null;
      this.onLevelEnd();
    }, LEVEL_END_WINDOW_MS);
  }

  private cancelLevelEndWindow(): void {
    if (this.levelEndWindowTimer) {
      clearTimeout(this.levelEndWindowTimer);
      this.levelEndWindowTimer = null;
    }
  }

  /**
   * A new level is loading ("Opening level 'x.d3l'..."). The previous game's
   * timer is gone — clear the stale anchor immediately and re-query
   * $netgameinfo once the level is up. Fires regardless of playlist state so
   * countdown announces and UI timers reset on $warp/$endlevel too.
   *
   * @param level the loaded level name (".d3l" stripped), or null if unparsed
   */
  private onLevelLoading(level: string | null): void {
    if (level) this.currentLevel = level;
    this.emit("levelChanged", this.currentLevel);
    this.clearAnnounceTimers();
    if (this.gameEndAt !== null) {
      this.gameEndAt = null;
      this.emitTimerUpdate();
    }
    // The loop-back level of a held mission: no timer, announces or vote for a level the restart throws away, and
    // the re-query stays owed to the next mission's first level.
    if (this.status === "holding") {
      this.onHoldLevelLoading();
      return;
    }
    // No timer to maintain without an active playlist — clients derive their
    // own countdown locally, so we don't query $netgameinfo here.
    if (!this.activePlaylist) return;

    // A fresh mission (activation/rotation) may have a different time limit or
    // goal, so re-query $netgameinfo ONCE to refresh the cache. Mid-mission
    // level transitions keep the same config — re-anchor from the cache with
    // no query, which is what keeps long multi-level sessions under the
    // engine's ~30-call buffer budget.
    const requery = this.requeryOnNextLevel || this.cachedTimeLimitSec === null;
    this.requeryOnNextLevel = false;

    if (this.reanchorTimer) clearTimeout(this.reanchorTimer);
    this.reanchorTimer = setTimeout(() => {
      this.reanchorTimer = null;
      if (requery) {
        this.anchorTimer().catch(() => {});
      } else {
        this.applyTimerAnchor(this.cachedTimeLimitSec ?? 0, this.cachedKillGoal);
      }
    }, LEVEL_LOAD_REANCHOR_DELAY_MS);
  }

  /**
   * Mid-mission level transition ("Ending level." without "Mission over.").
   * D3 is advancing to the next level within the same mission — do NOT rotate.
   * Clear any stale vote/pendingWinner state so the next level gets a fresh window.
   */
  private onLevelEnd(): void {
    this.clearAnnounceTimers();
    if (!this.activePlaylist || this.status === "restarting" || this.status === "paused" || this.status === "holding")
      return;

    this.pendingWinner = null;
    this.clearVoteTimers();
  }

  /**
   * Mission complete ("Mission over.  Looping back to first level...").
   * The last level of the mission just ended — rotate to next playlist entry.
   */
  private onMissionEnd(): void {
    this.clearAnnounceTimers();
    if (!this.activePlaylist || this.status === "restarting" || this.status === "paused" || this.status === "holding")
      return;

    // Voting still open when the mission ended: tally and rotate together.
    if (this.status === "voting" && this.voteOptions.length > 0) {
      this.tallyVotes(true);
      return;
    }

    // Vote already closed before the mission ended: rotate to the winner now.
    if (this.pendingWinner) {
      const winner = this.pendingWinner;
      this.pendingWinner = null;
      this.triggerRotate(winner);
      return;
    }

    this.triggerRotate();
  }

  private triggerRotate(entry?: PlaylistEntry): void {
    if (!this.activePlaylist || this.status === "restarting" || this.status === "paused" || this.status === "holding")
      return;

    this.status = "restarting";
    this.clearTimers();

    let next: PlaylistEntry;
    if (entry) {
      next = entry;
    } else if (this.needsInitialSync) {
      // First rotation after activate-while-running: load entry[0] instead of
      // advancing past it.
      next = this.activePlaylist.entries[this.currentIndex];
    } else {
      next = this.advanceAndGetEntry();
    }
    this.needsInitialSync = false;

    const hold = this.holdSecondsOf(this.activePlaylist);
    if (hold > 0 && this.humansOn()) {
      this.startHold(next, hold);
      return;
    }
    this.rotateTo(next);
  }

  /** Hand the rotation to the launcher (stop, swap the mission, restart). */
  private rotateTo(next: PlaylistEntry): void {
    this.status = "restarting";
    // The next mission may change time limit/goal — refresh the cache once when
    // its first level opens.
    this.requeryOnNextLevel = true;
    this.emit("rotate", next);
  }

  // ---------------------------------------------------------------------------
  // The hold between a mission's end and the restart
  // ---------------------------------------------------------------------------

  private holdSecondsOf(playlist: Playlist): number {
    const raw = playlist.holdSeconds;
    const s = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_HOLD_SECONDS;
    return Math.max(0, Math.min(MAX_HOLD_SECONDS, Math.round(s)));
  }

  /** A human may be on: counted, or not known (a hold is the safe side then). */
  private humansOn(): boolean {
    if (!this.humansFn) return false;
    const n = this.humansFn();
    return n === null || n > 0;
  }

  /**
   * The mission is over (all rotations come from a mission end): wait for the server's loop-back level, then hold.
   * The clients follow the server into that level, so when the restart comes they are in a live game, where a
   * player can quit from the menu and where the server's `quit` reaches them, instead of loading a level from a
   * server that has gone.
   */
  private startHold(entry: PlaylistEntry, seconds: number): void {
    this.status = "holding";
    this.holdEntry = entry;
    this.holdSecondsLeft = seconds;
    this.holdEndsAt = null;
    this.holdAwaitingLevel = true;
    this.holdTimers.push(setTimeout(() => this.beginHoldCountdown(), HOLD_LEVEL_WAIT_MS));
    console.log(`[Playlist] Mission over: holding ${seconds}s before the restart into "${entry.label}"`);
    this.emit("statusChanged");
  }

  /** The loop-back level is loading: start the countdown once it is up. */
  private onHoldLevelLoading(): void {
    if (!this.holdAwaitingLevel) return;
    this.holdAwaitingLevel = false;
    this.clearHoldTimers();
    this.holdTimers.push(setTimeout(() => this.beginHoldCountdown(), HOLD_LEVEL_SETTLE_MS));
  }

  private beginHoldCountdown(): void {
    if (this.status !== "holding" || !this.holdEntry || this.holdEndsAt !== null) return;
    this.clearHoldTimers();
    this.holdAwaitingLevel = false;
    const entry = this.holdEntry;
    const seconds = this.holdSecondsLeft;
    this.holdEndsAt = Date.now() + seconds * 1000;

    const send = (cmd: string) => {
      this.sendCommandFn?.(cmd).catch(() => {});
    };
    send("$wait on");
    this.waitSent = true;
    send(sayToAll(`Mission over. The server restarts in ${seconds} seconds for ${entry.label}.`));
    send(sayToAll("To play on, quit now (Esc) and join again in a minute."));
    for (const s of HOLD_ANNOUNCE_S) {
      if (s >= seconds) continue;
      this.holdTimers.push(
        setTimeout(() => send(sayToAll(`Restarting into ${entry.label} in ${s} seconds.`)), (seconds - s) * 1000),
      );
    }
    this.holdTimers.push(setTimeout(() => this.finishHold(), seconds * 1000));
    this.emit("statusChanged");
  }

  private finishHold(): void {
    if (this.status !== "holding" || !this.holdEntry) return;
    const entry = this.holdEntry;
    this.endHold(false); // the server quits held; a rotation the launcher calls off releases it (rotationSkipped)
    this.rotateTo(entry);
    this.emit("statusChanged");
  }

  /** Clear the hold's timers and state; with `release`, let the players go again (`$wait off`). */
  private endHold(release: boolean): void {
    this.clearHoldTimers();
    this.holdEntry = null;
    this.holdEndsAt = null;
    this.holdAwaitingLevel = false;
    this.holdSecondsLeft = 0;
    if (release) this.releaseWait();
  }

  private releaseWait(): void {
    if (!this.waitSent) return;
    this.waitSent = false;
    this.sendCommandFn?.("$wait off").catch(() => {});
  }

  private clearHoldTimers(): void {
    for (const t of this.holdTimers) clearTimeout(t);
    this.holdTimers = [];
  }

  /**
   * The operator took over (a manual stop or start) during a hold: call it off and let the players go. The playlist
   * stays active; the next mission end rotates again.
   */
  cancelHold(): void {
    if (this.status !== "holding") return;
    console.log(`[Playlist] Hold before "${this.holdEntry?.label}" called off`);
    this.endHold(true);
    this.status = "active";
    this.emit("statusChanged");
  }

  /**
   * The launcher called a rotation off before stopping the server (an incompatible entry, a missing path): the
   * current mission keeps running, so let the held players go.
   */
  rotationSkipped(): void {
    this.releaseWait();
    this.markRotationComplete();
  }

  /**
   * Returns the playlist's current entry IF an initial sync is still pending,
   * and clears the pending flag. Called by the launcher's start handler so the
   * first level loaded matches the playlist instead of whatever's in the cfg.
   */
  consumeInitialSync(): PlaylistEntry | null {
    if (!this.needsInitialSync || !this.activePlaylist) return null;
    this.needsInitialSync = false;
    return this.activePlaylist.entries[this.currentIndex] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Voting
  // ---------------------------------------------------------------------------

  private scheduleVoting(secondsLeft: number): void {
    if (!this.activePlaylist) return;
    // A vote has already closed for the current level and we're waiting on
    // "Ending level." to rotate. Don't re-open voting mid-window.
    if (this.pendingWinner) return;
    const { preAnnounceSeconds, voteOpenSeconds } = this.activePlaylist.voting;

    this.clearVoteTimers();

    const announceIn = (secondsLeft - preAnnounceSeconds) * 1000;
    const closeAfter = voteOpenSeconds * 1000;

    if (announceIn > 0) {
      this.preAnnounceTimer = setTimeout(() => {
        this.openVoting(closeAfter);
      }, announceIn);
    } else if (secondsLeft > 10) {
      // We're already inside the announce window — open immediately
      this.openVoting(closeAfter);
    }
  }

  private openVoting(closeAfterMs: number): void {
    if (!this.activePlaylist || this.status !== "active") return;

    this.status = "voting";
    this.votes.clear();
    this.voteOptions = this.buildVoteOptions();
    this.voteDeadline = Date.now() + closeAfterMs;
    // Stale winner from a prior vote (e.g. after $settimelimit re-opens voting)
    // must not survive into the new round.
    this.pendingWinner = null;

    this.emit("voteAnnounce", this.voteOptions, closeAfterMs);

    // Re-announce periodically — D3 chat only shows the last ~2 lines, so a
    // reminder keeps the options visible for players joining mid-window.
    this.voteReminderInterval = setInterval(() => {
      if (this.status === "voting" && this.voteOptions.length > 0) {
        this.emit("voteReminder", this.voteOptions, this.voteDeadline);
      }
    }, PlaylistManager.VOTE_REMINDER_INTERVAL_MS);

    // Vote timer firing means the vote window CLOSED, not that the level ended.
    // Store the winner as pendingWinner; rotation happens when "Ending level." fires.
    this.voteTimer = setTimeout(() => {
      this.tallyVotes(false);
    }, closeAfterMs);
  }

  /**
   * Close the vote window and determine the winner.
   *
   * @param rotateNow
   *   - `true`: rotate immediately (vote was still open when the level ended;
   *     D3 already ended the level, so we should swap missions right away).
   *   - `false` (default): store the winner as `pendingWinner` and wait for
   *     "Ending level." to fire. Prevents cutting the level short when the
   *     vote window closes before the game timer expires.
   */
  private tallyVotes(rotateNow: boolean = false): void {
    if (!this.activePlaylist) return;

    // Snapshot before clearVoteTimers wipes voteOptions/votes
    const options = this.voteOptions.slice();
    const voteEntries = Array.from(this.votes.values());

    this.clearVoteTimers();

    if (options.length === 0) {
      if (rotateNow) this.triggerRotate();
      return;
    }

    const counts = new Array<number>(options.length).fill(0);
    for (const vote of voteEntries) {
      if (vote.optionIndex < counts.length) {
        counts[vote.optionIndex]++;
      }
    }

    // Winner: most votes; ties go to lowest index ("first option wins")
    let maxVotes = -1;
    let winnerIdx = 0;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > maxVotes) {
        maxVotes = counts[i];
        winnerIdx = i;
      }
    }

    const winner = options[winnerIdx];
    this.emit("voteResult", winner, counts);

    // Set currentIndex to the winner so the next natural advance moves past it.
    const entryIdx = this.activePlaylist.entries.findIndex((e) => e.id === winner.id);
    if (entryIdx !== -1) {
      this.currentIndex = entryIdx;
    }

    if (rotateNow) {
      this.triggerRotate(winner);
    } else {
      // Defer rotation until the level actually ends.
      this.pendingWinner = winner;
    }
  }

  /**
   * Build the vote options list — pick up to `optionCount` upcoming missions
   * (excluding the current one).
   */
  private buildVoteOptions(): PlaylistEntry[] {
    if (!this.activePlaylist) return [];

    const { entries, mode, voting } = this.activePlaylist;
    if (entries.length <= 1) return entries.slice();

    const count = Math.min(voting.optionCount, 9, entries.length - 1);
    const options: PlaylistEntry[] = [];

    if (mode === "sequential") {
      // Offer the next `count` entries after current
      for (let i = 1; i <= count && options.length < count; i++) {
        const idx = (this.currentIndex + i) % entries.length;
        options.push(entries[idx]);
      }
    } else {
      // Shuffle or weighted: pick `count` random distinct entries (excluding current)
      const pool = entries.filter((_, i) => i !== this.currentIndex);
      // Fisher-Yates partial shuffle
      for (let i = 0; i < Math.min(count, pool.length); i++) {
        const j = i + Math.floor(Math.random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
        options.push(pool[i]);
      }
    }

    return options;
  }

  // ---------------------------------------------------------------------------
  // Index advancement
  // ---------------------------------------------------------------------------

  private advanceAndGetEntry(): PlaylistEntry {
    if (!this.activePlaylist) throw new Error("No active playlist");
    const { entries, mode } = this.activePlaylist;

    if (mode === "sequential") {
      this.currentIndex = (this.currentIndex + 1) % entries.length;
      return entries[this.currentIndex];
    }

    if (mode === "shuffle") {
      if (!this.shuffleOrder || this.shuffleOrder.length === 0) {
        this.buildShuffleOrder();
      }
      const idx = this.shuffleOrder!.shift()!;
      if (this.shuffleOrder!.length === 0) {
        this.buildShuffleOrder();
      }
      this.currentIndex = idx;
      return entries[idx];
    }

    // weighted
    const entry = this.weightedDraw();
    this.currentIndex = this.activePlaylist.entries.indexOf(entry);
    return entry;
  }

  private buildShuffleOrder(): void {
    if (!this.activePlaylist) return;
    const n = this.activePlaylist.entries.length;
    const order = Array.from({ length: n }, (_, i) => i);
    // Fisher-Yates
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    this.shuffleOrder = order;
  }

  private weightedDraw(): PlaylistEntry {
    const entries = this.activePlaylist!.entries;
    const weights = entries.map((e) => Math.max(1, e.weight ?? 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < entries.length; i++) {
      r -= weights[i];
      if (r <= 0) return entries[i];
    }
    return entries[entries.length - 1];
  }

  private currentEntryOrNull(): PlaylistEntry | null {
    if (!this.activePlaylist) return null;
    return this.activePlaylist.entries[this.currentIndex] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Timer helpers
  // ---------------------------------------------------------------------------

  private clearAnnounceTimers(): void {
    for (const t of this.announceTimers) clearTimeout(t);
    this.announceTimers = [];
  }

  private scheduleAnnounces(secondsLeft: number): void {
    this.clearAnnounceTimers();
    for (const threshold of PlaylistManager.ANNOUNCE_THRESHOLDS_S) {
      const fireIn = (secondsLeft - threshold) * 1000;
      if (fireIn <= 0) continue;
      const label = threshold >= 60
        ? `${threshold / 60} minute${threshold === 60 ? "" : "s"}`
        : `${threshold} seconds`;
      const t = setTimeout(() => {
        this.sendCommandFn?.(`say Game ending in ${label}!`).catch(() => {});
      }, fireIn);
      this.announceTimers.push(t);
    }
  }

  private clearTimers(): void {
    this.clearHoldTimers();
    this.clearVoteTimers();
    this.clearAnnounceTimers();
    this.cancelLevelEndWindow();
    if (this.reanchorTimer) {
      clearTimeout(this.reanchorTimer);
      this.reanchorTimer = null;
    }
  }

  private clearVoteTimers(): void {
    if (this.preAnnounceTimer) {
      clearTimeout(this.preAnnounceTimer);
      this.preAnnounceTimer = null;
    }
    if (this.voteTimer) {
      clearTimeout(this.voteTimer);
      this.voteTimer = null;
    }
    if (this.voteReminderInterval) {
      clearInterval(this.voteReminderInterval);
      this.voteReminderInterval = null;
    }
    this.voteOptions = [];
    this.voteDeadline = null;
    this.votes.clear();
    if (this.status === "voting") this.status = "active";
  }

  private emitTimerUpdate(): void {
    this.emit("timerUpdate", this.gameEndAt);
  }

  // ---------------------------------------------------------------------------
  // Utility parsers
  // ---------------------------------------------------------------------------

  /** Parse "M:SS", "MM:SS", or "H:MM:SS" timeLeft string to total seconds. */
  private parseTimeLeft(str: string): number {
    const parts = str.split(":").map((p) => parseInt(p, 10));
    if (parts.some((n) => isNaN(n))) return 0;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  /** Parse "Time Limit:" value: "None" → 0, "N minute(s)" → N */
  private parseTimeLimit(str?: string): number {
    if (!str || str === "None") return 0;
    const m = str.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private async saveState(): Promise<void> {
    try {
      const state: PlaylistState = {
        activePlaylistId: this.activePlaylist?.id ?? null,
        currentIndex: this.currentIndex,
        shuffleOrder: this.shuffleOrder,
        paused:
          this.status === "paused" && this.pausedReason
            ? { reason: this.pausedReason, at: this.pausedAt ?? Date.now() }
            : null,
      };
      await fs.mkdir(this.configDir, { recursive: true });
      await fs.writeFile(
        path.join(this.configDir, STATE_FILE),
        JSON.stringify(state, null, 2),
      );
    } catch {
      // State persistence is best-effort
    }
  }

  async restoreState(): Promise<void> {
    try {
      const raw = await fs.readFile(path.join(this.configDir, STATE_FILE), "utf-8");
      const state = JSON.parse(raw) as PlaylistState;
      if (state.activePlaylistId) {
        try {
          const playlist = await this.read(state.activePlaylistId);
          this.activePlaylist = playlist;
          this.status = "active";
          this.currentIndex = state.currentIndex ?? 0;
          this.shuffleOrder = state.shuffleOrder ?? null;
          if (state.paused) {
            this.status = "paused";
            this.pausedReason = state.paused.reason;
            this.pausedAt = state.paused.at;
          }
        } catch {
          // Playlist was deleted — clear state
        }
      }
    } catch {
      // No saved state
    }
  }
}
