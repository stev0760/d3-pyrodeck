import { serverEvents, type ServerEvents } from "../events/ServerEvents.js";
import { HangWatch, type HangWatchSnapshot } from "./HangWatch.js";
import { RelaunchBackoff, type RelaunchBackoffOptions } from "./RelaunchBackoff.js";
import { emptyRestartDecision, formatDuration } from "./emptyRestart.js";
import { humansIn, isBotCallsign, parsePlayersReply } from "./serverLines.js";
import type { StopReason } from "./ProcessManager.js";
import { DEFAULT_SUPERVISOR_SETTINGS, type SupervisorSettings } from "./supervisorSettings.js";

/**
 * Keeps a launched server up the way D3Server3 did (docs/D3SERVER3_AUDIT.md,
 * "Supervision"): relaunch it when the process dies on its own, kill and
 * relaunch it when its console stops answering, and restart it after an
 * uptime limit once nobody is on it.
 *
 * It leaves alone a server stopped on request (the Stop button, a playlist
 * rotation, the scheduler, a `quit` typed at the console), and a crash while a
 * playlist restart is still being health-checked: that relaunch belongs to the
 * rotation (RotationHealthMonitor), which retries once and then pauses the
 * playlist.
 *
 * The launcher reports what happens (processStarted via the bus, processDown,
 * console up/down/output) and supplies the actions; this class decides.
 */

/** The console command sent to a quiet server and to read who is on it. */
export const PROBE_COMMAND = "$players";

/** How often the restart-when-empty rule is checked (D3Server3's timer period). */
export const EMPTY_CHECK_MS = 15_000;

export type RelaunchCause = "crash" | "hang" | "empty-restart";

export interface SupervisorActions {
  /** Start the last launch again. Resolves once spawned; rejects if it could not be. */
  relaunch(): Promise<void>;
  /** Stop the running server on the supervisor's behalf. */
  stop(reason: "empty-restart" | "hang", options?: { kill?: boolean }): Promise<void>;
  /** Send a console command and return the reply; rejects when no console is connected. */
  command(cmd: string): Promise<string>;
  isRunning(): boolean;
  /** A playlist rotation is restarting the server right now. */
  rotationPending(): boolean;
  /** Tell the operator (a toast, the Pyrodeck log). */
  notify(message: string, level: "error" | "info"): void;
}

export interface ProcessDown {
  /** Exited without a request. */
  crashed: boolean;
  /** Why Pyrodeck stopped it, or "console" for a quit typed at the console; null for a crash. */
  stopReason: StopReason | "console" | null;
  /** A playlist restart was being health-checked when it went down. */
  rotationOwned: boolean;
  code: number | null;
  signal: string | null;
}

export interface SupervisorSnapshot {
  settings: SupervisorSettings;
  /** Any of the three rules is on. */
  enabled: boolean;
  /** Relaunches the supervisor made since Pyrodeck started. */
  relaunchCount: number;
  /** Relaunch failures inside the backoff window. */
  recentFailures: number;
  pendingRelaunch: { at: string; cause: RelaunchCause } | null;
  /** Set when it stopped relaunching; cleared by the next launch. */
  gaveUp: { at: string; reason: string } | null;
  lastCrash: { at: string; code: number | null; signal: string | null } | null;
  lastHang: { at: string; silentForMs: number } | null;
  hang: HangWatchSnapshot;
  /** Since the current process started (re-attached: since it started, before Pyrodeck's restart). */
  uptimeMs: number | null;
  /** Humans on the server; null when not known. */
  humans: number | null;
  emptySince: string | null;
  /** Restart-when-empty: why it has (not) happened yet. Null when the rule is off. */
  emptyRestart: string | null;
  /** The process was re-attached after Pyrodeck restarted (its output is not captured). */
  adopted: boolean;
}

interface Running {
  profileId: string;
  pid: number;
  startedAt: number;
  adopted: boolean;
}

export interface SupervisorOptions {
  events?: ServerEvents;
  backoff?: RelaunchBackoffOptions;
  hangTickMs?: number;
  loadAllowanceMs?: number;
  emptyCheckMs?: number;
}

export class Supervisor {
  private settings: SupervisorSettings = { ...DEFAULT_SUPERVISOR_SETTINGS };
  private readonly events: ServerEvents;
  private readonly backoff: RelaunchBackoff;
  private readonly hang: HangWatch;
  private running: Running | null = null;
  private relaunchCount = 0;
  private pending: { at: number; cause: RelaunchCause; timer: ReturnType<typeof setTimeout> } | null = null;
  private gaveUp: { at: number; reason: string } | null = null;
  private lastCrash: { at: number; code: number | null; signal: string | null } | null = null;
  private lastHang: { at: number; silentForMs: number } | null = null;
  /** Humans by callsign (a count, in case two share one); null = not known. */
  private humans: Map<string, number> | null = null;
  private emptySince: number | null = null;
  private emptyNote: string | null = null;
  private emptyCheckRunning = false;
  private readonly emptyTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly actions: SupervisorActions,
    options: SupervisorOptions = {},
  ) {
    this.events = options.events ?? serverEvents;
    this.backoff = new RelaunchBackoff(options.backoff);
    this.hang = new HangWatch({
      probeAfterMs: this.settings.hangProbeAfterSec * 1000,
      restartAfterMs: this.settings.hangRestartAfterSec * 1000,
      loadAllowanceMs: options.loadAllowanceMs,
      tickMs: options.hangTickMs,
    });
    this.hang.on("probe", () => this.probe());
    this.hang.on("hung", (silentForMs: number) => void this.onHung(silentForMs));

    this.events.onEvent("server.started", (p) => this.processStarted(p.profileId, p.pid, p.reason));
    this.events.onEvent("server.adopted", (p) => this.processAdopted(p.profileId, p.pid, Date.parse(p.startedAt)));
    this.events.onEvent("player.joined", (p) => this.playerJoined(p.name));
    this.events.onEvent("player.left", (p) => this.playerLeft(p.name));
    this.events.onEvent("level.started", () => this.hang.levelLoad());

    this.emptyTimer = setInterval(() => void this.checkEmptyRestart(), options.emptyCheckMs ?? EMPTY_CHECK_MS);
    this.emptyTimer.unref?.();
  }

  applySettings(settings: SupervisorSettings): void {
    this.settings = { ...settings };
    this.hang.configure(settings.hangProbeAfterSec * 1000, settings.hangRestartAfterSec * 1000);
    if (!settings.hangCheck) this.hang.stop();
    if (!settings.relaunchOnCrash && this.pending?.cause === "crash") this.cancelRelaunch();
    if (!settings.emptyRestart) this.emptyNote = null;
  }

  getSettings(): SupervisorSettings {
    return { ...this.settings };
  }

  // ---------------------------------------------------------------------------
  // What the launcher reports
  // ---------------------------------------------------------------------------

  /** A process was spawned (from `server.started`). */
  processStarted(profileId: string, pid: number, reason: string): void {
    this.cancelRelaunch();
    if (reason !== "relaunch") {
      // Someone started it on purpose: forget earlier failures.
      this.backoff.reset();
      this.gaveUp = null;
    }
    this.running = { profileId, pid, startedAt: Date.now(), adopted: false };
    // A fresh server is empty until someone joins.
    this.humans = new Map();
    this.emptySince = Date.now();
    this.emptyNote = null;
    this.hang.stop();
  }

  /** Pyrodeck re-attached to a process that kept running across its restart. */
  processAdopted(profileId: string, pid: number, startedAt: number): void {
    this.cancelRelaunch();
    this.running = { profileId, pid, startedAt, adopted: true };
    this.humans = null; // read with $players once the console is up
    this.emptySince = null;
    this.hang.stop();
  }

  /** The process is gone (stopped on request or crashed). */
  processDown(down: ProcessDown): void {
    this.hang.stop();
    this.running = null;
    this.humans = null;
    this.emptySince = null;
    this.emptyNote = null;

    if (down.crashed) {
      this.lastCrash = { at: Date.now(), code: down.code, signal: down.signal };
      if (down.rotationOwned) return; // the playlist restart retries or pauses
      if (this.settings.relaunchOnCrash) this.scheduleRelaunch("crash");
      return;
    }
    if (down.stopReason === "hang") {
      this.scheduleRelaunch("hang");
    } else if (down.stopReason === "empty-restart") {
      this.scheduleRelaunch("empty-restart");
    } else {
      // Stopped on request: stays down.
      this.cancelRelaunch();
    }
  }

  /** The remote console logged in. */
  consoleReady(): void {
    if (!this.running) return;
    if (this.settings.hangCheck) this.hang.start();
    // Who is on (needed when re-attached; a fresh server reads empty).
    this.probe();
  }

  /** Console output arrived. */
  consoleActivity(): void {
    this.hang.activity();
  }

  playerJoined(name: string): void {
    if (!this.humans || isBotCallsign(name)) return;
    this.humans.set(name, (this.humans.get(name) ?? 0) + 1);
    this.emptySince = null;
  }

  playerLeft(name: string): void {
    if (!this.humans || isBotCallsign(name)) return;
    const n = this.humans.get(name) ?? 0;
    if (n <= 1) this.humans.delete(name);
    else this.humans.set(name, n - 1);
    if (this.humanCount() === 0 && this.emptySince === null) this.emptySince = Date.now();
  }

  /** The operator does not want the pending relaunch. */
  cancelRelaunch(): boolean {
    if (!this.pending) return false;
    clearTimeout(this.pending.timer);
    this.pending = null;
    return true;
  }

  snapshot(): SupervisorSnapshot {
    const iso = (t: number) => new Date(t).toISOString();
    const s = this.settings;
    const now = Date.now();
    return {
      settings: { ...s },
      enabled: s.relaunchOnCrash || s.hangCheck || s.emptyRestart,
      relaunchCount: this.relaunchCount,
      recentFailures: this.backoff.count(now),
      pendingRelaunch: this.pending ? { at: iso(this.pending.at), cause: this.pending.cause } : null,
      gaveUp: this.gaveUp ? { at: iso(this.gaveUp.at), reason: this.gaveUp.reason } : null,
      lastCrash: this.lastCrash ? { ...this.lastCrash, at: iso(this.lastCrash.at) } : null,
      lastHang: this.lastHang ? { ...this.lastHang, at: iso(this.lastHang.at) } : null,
      hang: this.hang.snapshot(),
      uptimeMs: this.running ? now - this.running.startedAt : null,
      humans: this.humanCount(),
      emptySince: this.running && this.emptySince !== null ? iso(this.emptySince) : null,
      emptyRestart: s.emptyRestart ? this.emptyNote ?? this.decideEmpty(now).reason : null,
      adopted: this.running?.adopted ?? false,
    };
  }

  /** Stop the timers (tests, shutdown). */
  dispose(): void {
    this.cancelRelaunch();
    this.hang.stop();
    clearInterval(this.emptyTimer);
  }

  // ---------------------------------------------------------------------------
  // Relaunch
  // ---------------------------------------------------------------------------

  private scheduleRelaunch(cause: RelaunchCause): void {
    this.cancelRelaunch();
    const now = Date.now();
    let delayMs = 0;
    if (cause !== "empty-restart") {
      const step = this.backoff.next(now);
      if ("giveUp" in step) {
        const minutes = Math.round(this.backoff.windowMs / 60_000);
        const reason = `the server went down ${step.failures} times in ${minutes} minutes`;
        this.gaveUp = { at: now, reason };
        this.actions.notify(`Supervisor gave up: ${reason}. It stays down until you launch it.`, "error");
        return;
      }
      delayMs = step.delayMs;
      const what = cause === "hang" ? "was restarted after it stopped answering" : "crashed";
      this.actions.notify(`The server ${what}; relaunching in ${formatDuration(delayMs)}.`, "error");
    }
    const timer = setTimeout(() => void this.relaunchNow(cause), delayMs);
    this.pending = { at: now + delayMs, cause, timer };
  }

  private async relaunchNow(cause: RelaunchCause): Promise<void> {
    this.pending = null;
    if (this.actions.isRunning()) return; // launched by hand meanwhile
    if (this.actions.rotationPending()) return;
    try {
      await this.actions.relaunch();
      this.relaunchCount++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.actions.notify(`Relaunch failed: ${message}`, "error");
      this.scheduleRelaunch(cause === "empty-restart" ? "crash" : cause);
    }
  }

  // ---------------------------------------------------------------------------
  // Hang
  // ---------------------------------------------------------------------------

  private probe(): void {
    this.actions
      .command(PROBE_COMMAND)
      .then((reply) => {
        const entries = parsePlayersReply(reply);
        if (entries) this.setRoster(humansIn(entries));
      })
      .catch(() => {
        // No console: the silence keeps counting.
      });
  }

  private async onHung(silentForMs: number): Promise<void> {
    const running = this.running;
    if (!running || this.actions.rotationPending()) return;
    this.lastHang = { at: Date.now(), silentForMs };
    this.events.emitEvent("server.hung", { profileId: running.profileId, pid: running.pid, silentForMs });
    this.actions.notify(
      `The server's console has been silent for ${formatDuration(silentForMs)} and did not answer ${PROBE_COMMAND}; killing it.`,
      "error",
    );
    try {
      await this.actions.stop("hang", { kill: true });
    } catch {
      // processDown still arrives when the process is gone.
    }
  }

  // ---------------------------------------------------------------------------
  // Restart when empty
  // ---------------------------------------------------------------------------

  private humanCount(): number | null {
    if (!this.humans) return null;
    let n = 0;
    for (const c of this.humans.values()) n += c;
    return n;
  }

  private setRoster(names: string[]): void {
    const roster = new Map<string, number>();
    for (const name of names) roster.set(name, (roster.get(name) ?? 0) + 1);
    this.humans = roster;
    if (names.length > 0) this.emptySince = null;
    else if (this.emptySince === null) this.emptySince = Date.now();
  }

  private decideEmpty(now: number) {
    return emptyRestartDecision({
      now,
      startedAt: this.running?.startedAt ?? null,
      afterMs: this.settings.emptyRestartAfterHours * 3_600_000,
      graceMs: this.settings.emptyRestartGraceSec * 1000,
      humans: this.humanCount(),
      emptySince: this.emptySince,
    });
  }

  /** Runs every EMPTY_CHECK_MS. Exposed for tests. */
  async checkEmptyRestart(): Promise<void> {
    if (!this.settings.emptyRestart || this.emptyCheckRunning) return;
    if (!this.running || !this.actions.isRunning()) {
      this.emptyNote = null;
      return;
    }
    if (this.actions.rotationPending()) {
      this.emptyNote = "a playlist restart is in progress";
      return;
    }
    const first = this.decideEmpty(Date.now());
    this.emptyNote = first.reason;
    if (!first.due) return;

    // Confirm with the server itself before restarting: a join line in
    // another language would never have reached the roster.
    this.emptyCheckRunning = true;
    try {
      const entries = parsePlayersReply(await this.actions.command(PROBE_COMMAND));
      if (!entries) {
        this.emptyNote = `could not read ${PROBE_COMMAND}; not restarting`;
        return;
      }
      this.setRoster(humansIn(entries));
      const confirmed = this.decideEmpty(Date.now());
      this.emptyNote = confirmed.reason;
      if (!confirmed.due || !this.running) return;
      this.actions.notify(`Restarting the empty server: ${confirmed.reason}.`, "info");
      await this.actions.stop("empty-restart");
    } catch {
      this.emptyNote = "no console to confirm the server is empty";
    } finally {
      this.emptyCheckRunning = false;
    }
  }
}
