import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

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
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistState {
  activePlaylistId: string | null;
  currentIndex: number;
  shuffleOrder: number[] | null;
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

type PlaylistStatus = "inactive" | "active" | "voting" | "restarting";

const PLAYLISTS_FILE = "playlists.json";
const STATE_FILE = "playlist-state.json";

// How often (ms) to query $netgameinfo to correct timer drift
const DRIFT_CORRECTION_INTERVAL_MS = 60_000;

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

  // Timer tracking
  private gameEndAt: number | null = null; // epoch ms
  private driftCorrectionInterval: ReturnType<typeof setInterval> | null = null;

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

  /** How often to re-announce the vote options in chat while voting is open. */
  private static readonly VOTE_REMINDER_INTERVAL_MS = 10_000;

  // Countdown announces (fire regardless of playlist state)
  private announceTimers: ReturnType<typeof setTimeout>[] = [];
  private static readonly ANNOUNCE_THRESHOLDS_S = [300, 120, 60, 30, 10];

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

    if (playlist.mode === "shuffle") {
      this.buildShuffleOrder();
    }

    // Cancel any pending timers from a previous activation
    this.clearTimers();

    // Query current game state to anchor timer (if server is running)
    if (this.sendCommandFn) {
      this.anchorTimer().catch(() => {});
      this.startDriftCorrection();
    }

    await this.saveState();
    this.emitTimerUpdate();
  }

  deactivate(): void {
    this.activePlaylist = null;
    this.status = "inactive";
    this.needsInitialSync = false;
    this.pendingWinner = null;
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
    if (this.status === "restarting") {
      this.status = "active";
      this.emitTimerUpdate();
    }
  }

  getStatus(): {
    status: PlaylistStatus;
    activePlaylistId: string | null;
    currentIndex: number;
    currentEntry: PlaylistEntry | null;
    gameEndAt: number | null;
    voteOptions: PlaylistEntry[];
    voteDeadline: number | null;
  } {
    return {
      status: this.status,
      activePlaylistId: this.activePlaylist?.id ?? null,
      currentIndex: this.currentIndex,
      currentEntry: this.currentEntryOrNull(),
      gameEndAt: this.gameEndAt,
      voteOptions: this.voteOptions,
      voteDeadline: this.voteDeadline,
    };
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

    // Level end signal — always authoritative regardless of timer state
    if (trimmed === "Ending level." || trimmed.includes("Mission over.")) {
      this.onLevelEnd();
      return;
    }

    // Chat message — check for vote
    if (this.status === "voting") {
      // D3 dedicated stdout format: "*PlayerName says: message"
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
   * Query $netgameinfo and anchor the game end timer.
   * Called on activation and periodically for drift correction.
   */
  async anchorTimer(): Promise<void> {
    if (!this.sendCommandFn || !this.activePlaylist) return;

    try {
      const raw = await this.sendCommandFn("$netgameinfo");
      this.parseAndAnchorFromNetgameinfo(raw);
    } catch {
      // Non-fatal — we'll try again on next drift correction
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

    // Always schedule end-of-game announces regardless of playlist state
    if (hasTimeLimit) {
      this.scheduleAnnounces(secondsLeft);
    } else {
      this.clearAnnounceTimers();
    }

    if (!this.activePlaylist) return;

    if (hasTimeLimit) {
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

  private onLevelEnd(): void {
    this.clearAnnounceTimers();
    if (!this.activePlaylist || this.status === "restarting") return;

    // Voting still open when the level ended: tally and rotate together.
    if (this.status === "voting" && this.voteOptions.length > 0) {
      this.tallyVotes(true);
      return;
    }

    // Vote already closed before the level ended: rotate to the winner now.
    if (this.pendingWinner) {
      const winner = this.pendingWinner;
      this.pendingWinner = null;
      this.triggerRotate(winner);
      return;
    }

    this.triggerRotate();
  }

  private triggerRotate(entry?: PlaylistEntry): void {
    if (!this.activePlaylist || this.status === "restarting") return;

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
    this.emit("rotate", next);
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

  private startDriftCorrection(): void {
    this.driftCorrectionInterval = setInterval(() => {
      if (this.status === "active" || this.status === "voting") {
        this.anchorTimer().catch(() => {});
      }
    }, DRIFT_CORRECTION_INTERVAL_MS);
  }

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
    this.clearVoteTimers();
    this.clearAnnounceTimers();
    if (this.driftCorrectionInterval) {
      clearInterval(this.driftCorrectionInterval);
      this.driftCorrectionInterval = null;
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

  /** Parse "M:SS" or "MM:SS" timeLeft string to total seconds. */
  private parseTimeLeft(str: string): number {
    const parts = str.split(":").map((p) => parseInt(p, 10));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return parts[0] * 60 + parts[1];
    }
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
        } catch {
          // Playlist was deleted — clear state
        }
      }
    } catch {
      // No saved state
    }
  }
}
