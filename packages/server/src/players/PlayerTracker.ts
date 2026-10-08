import { serverEvents, type ServerEventMap, type ServerEvents } from "../events/ServerEvents.js";
import { PlayerHistory } from "./PlayerHistory.js";
import {
  decideIpLookup,
  findSlot,
  listPlayers,
  queryPlayerinfo,
  type ConsoleProvider,
  type IpLookupPolicy,
} from "./consoleLink.js";

/**
 * After a level starts, how long a player has to re-enter before their
 * session is checked against `$players`. Every player re-enters each level
 * (the join line repeats), so one who neither re-entered nor is listed left
 * during the level change without a leave line. A player still loading is
 * not in `$players` either (CheckPlayerNum wants NETSEQ_PLAYING), hence the
 * generous wait.
 */
export const LEVEL_REJOIN_GRACE_MS = 120_000;

interface Present {
  name: string;
  rowId: number;
  bot: boolean;
  slot?: number;
  ip?: string;
  lastEntered: number;
}

interface ProfileState {
  present: Map<string, Present>;
  /** `$playerinfo` queries sent during this server run. */
  lookups: number;
  reconcileTimer: ReturnType<typeof setTimeout> | null;
  /** Bus events for a profile are handled one at a time, in order. */
  events: Promise<void>;
  /** Lookups run one at a time per profile, apart from the event order. */
  queue: Promise<void>;
}

export interface PlayerTrackerOptions {
  /** Where history files live; null keeps history in memory (tests). */
  historyDir: string | null;
  console: ConsoleProvider;
  ipLookup: () => IpLookupPolicy;
  bus?: ServerEvents;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Keeps the join/leave history: one row per session start and end (level
 * re-entries are not new sessions), the slot from `$players` and the address
 * from one rationed `$playerinfo` per human join. Announces each identified
 * human join as player.identified for the join rules.
 */
export class PlayerTracker {
  private readonly histories = new Map<string, Promise<PlayerHistory>>();
  private readonly profiles = new Map<string, ProfileState>();
  private readonly bus: ServerEvents;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly handlers: Array<() => void> = [];

  constructor(private readonly opts: PlayerTrackerOptions) {
    this.bus = opts.bus ?? serverEvents;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[Players] ${m}`));
  }

  start(): void {
    const on = <K extends keyof ServerEventMap>(name: K, fn: (p: ServerEventMap[K]) => Promise<void> | void) => {
      const wrapped = (p: ServerEventMap[K]) => {
        const s = this.state(p.profileId);
        s.events = s.events
          .then(() => fn(p))
          .catch((err) => this.log(`${name} handler failed: ${err instanceof Error ? err.message : String(err)}`));
      };
      this.bus.onEvent(name, wrapped);
      this.handlers.push(() => this.bus.offEvent(name, wrapped));
    };
    on("player.joined", (p) => this.onJoined(p));
    on("player.left", (p) => this.onLeft(p));
    on("level.started", (p) => this.onLevelStarted(p.profileId));
    on("server.started", (p) => this.closeAll(p.profileId, "server restarted", true));
    on("server.stopped", (p) => this.closeAll(p.profileId, "server stopped", true));
    on("server.crashed", (p) => this.closeAll(p.profileId, "server crashed", true));
  }

  stop(): void {
    for (const off of this.handlers.splice(0)) off();
    for (const s of this.profiles.values()) if (s.reconcileTimer) clearTimeout(s.reconcileTimer);
  }

  history(profileId: string): Promise<PlayerHistory> {
    let h = this.histories.get(profileId);
    if (!h) {
      h = PlayerHistory.open(profileId, this.opts.historyDir);
      this.histories.set(profileId, h);
    }
    return h;
  }

  /** Players in the game as the tracker knows them. */
  present(profileId: string): Array<{ name: string; slot?: number; ip?: string; bot: boolean }> {
    return [...(this.profiles.get(profileId)?.present.values() ?? [])].map(({ name, slot, ip, bot }) => ({
      name,
      slot,
      ip,
      bot,
    }));
  }

  /** The address last seen for a player in the game, if known. */
  addressOf(profileId: string, name: string): string | undefined {
    return this.profiles.get(profileId)?.present.get(name.toLowerCase())?.ip;
  }

  /**
   * The address of a player in the game: the one already known, else one
   * `$playerinfo` if the rationing allows it. Recorded in the history.
   */
  async lookupAddress(profileId: string, name: string, slot: number): Promise<string | undefined> {
    const s = this.state(profileId);
    const entry = s.present.get(name.toLowerCase());
    if (entry?.ip) return entry.ip;
    const link = this.opts.console(profileId);
    if (!link) return undefined;
    const decision = decideIpLookup(this.opts.ipLookup(), link.capabilities, name, s.lookups);
    if (!decision.allowed) {
      this.log(`No address lookup for ${JSON.stringify(name)}: ${decision.reason}`);
      return undefined;
    }
    s.lookups++;
    const info = await queryPlayerinfo(link, slot, name).catch(() => null);
    if (!info?.ip) return undefined;
    if (entry) {
      entry.ip = info.ip;
      entry.slot = slot;
      (await this.history(profileId)).update(entry.rowId, { slot, ip: info.ip });
    }
    return info.ip;
  }

  /** Lookups used this run, for the settings page. */
  lookupsUsed(profileId: string): number {
    return this.profiles.get(profileId)?.lookups ?? 0;
  }

  /** Wait until queued events and lookups for a profile are done (tests, shutdown). */
  async idle(profileId: string): Promise<void> {
    const s = this.profiles.get(profileId);
    if (!s) return;
    await s.events;
    await s.queue;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.histories.values()].map(async (h) => (await h).flush()));
  }

  private state(profileId: string): ProfileState {
    let s = this.profiles.get(profileId);
    if (!s) {
      s = { present: new Map(), lookups: 0, reconcileTimer: null, events: Promise.resolve(), queue: Promise.resolve() };
      this.profiles.set(profileId, s);
    }
    return s;
  }

  private async onJoined(p: ServerEventMap["player.joined"]): Promise<void> {
    const s = this.state(p.profileId);
    const key = p.name.toLowerCase();
    const known = s.present.get(key);
    if (known) {
      known.lastEntered = this.now();
      if (p.slot !== undefined) known.slot = p.slot;
      return;
    }
    const bot = p.bot === true;
    const history = await this.history(p.profileId);
    const row = history.recordJoin({ name: p.name, slot: p.slot, ip: p.ip, bot, time: new Date(this.now()) });
    const entry: Present = { name: p.name, rowId: row.id, bot, slot: p.slot, ip: p.ip, lastEntered: this.now() };
    s.present.set(key, entry);
    if (bot) return;
    s.queue = s.queue.then(() => this.identify(p.profileId, entry)).catch(() => {});
  }

  /** Slot from `$players`, address from `$playerinfo` (rationed), then player.identified. */
  private async identify(profileId: string, entry: Present): Promise<void> {
    const s = this.state(profileId);
    if (s.present.get(entry.name.toLowerCase()) !== entry) return; // left already
    const link = this.opts.console(profileId);
    if (link) {
      const players = await listPlayers(link).catch(() => null);
      const slot = players ? findSlot(players, entry.name) : null;
      if (slot !== null) entry.slot = slot;

      if (slot !== null && !entry.ip) {
        const decision = decideIpLookup(this.opts.ipLookup(), link.capabilities, entry.name, s.lookups);
        if (decision.allowed) {
          s.lookups++;
          const info = await queryPlayerinfo(link, slot, entry.name).catch(() => null);
          if (info?.ip) entry.ip = info.ip;
        } else {
          this.log(`No address lookup for ${JSON.stringify(entry.name)}: ${decision.reason}`);
        }
      }
      (await this.history(profileId)).update(entry.rowId, { slot: entry.slot, ip: entry.ip });
    }
    this.bus.emitEvent("player.identified", {
      profileId,
      name: entry.name,
      ...(entry.slot !== undefined ? { slot: entry.slot } : {}),
      ...(entry.ip ? { ip: entry.ip } : {}),
    });
  }

  private async onLeft(p: ServerEventMap["player.left"]): Promise<void> {
    const s = this.state(p.profileId);
    const key = p.name.toLowerCase();
    const known = s.present.get(key);
    s.present.delete(key);
    const history = await this.history(p.profileId);
    history.recordLeave({
      name: known?.name ?? p.name,
      slot: p.slot ?? known?.slot,
      ip: p.ip ?? known?.ip,
      bot: p.bot ?? known?.bot,
      reason: p.reason,
      time: new Date(this.now()),
    });
  }

  private onLevelStarted(profileId: string): void {
    const s = this.state(profileId);
    const startedAt = this.now();
    if (s.reconcileTimer) clearTimeout(s.reconcileTimer);
    s.reconcileTimer = setTimeout(() => {
      s.reconcileTimer = null;
      s.queue = s.queue.then(() => this.reconcile(profileId, startedAt)).catch(() => {});
    }, LEVEL_REJOIN_GRACE_MS);
  }

  /** Close the sessions of players who did not come back after a level change. */
  private async reconcile(profileId: string, levelStartedAt: number): Promise<void> {
    const s = this.state(profileId);
    const stale = [...s.present.values()].filter((p) => p.lastEntered < levelStartedAt);
    if (stale.length === 0) return;
    const link = this.opts.console(profileId);
    if (!link) return;
    const players = await listPlayers(link).catch(() => null);
    if (!players) return;
    const listed = new Set(players.map((p) => p.name.toLowerCase()));
    const history = await this.history(profileId);
    for (const p of stale) {
      const key = p.name.toLowerCase();
      if (s.present.get(key) !== p) continue; // left or re-entered meanwhile
      if (listed.has(key)) {
        p.lastEntered = this.now();
        continue;
      }
      s.present.delete(key);
      history.recordLeave({
        name: p.name,
        slot: p.slot,
        ip: p.ip,
        bot: p.bot,
        reason: "not back after a level change",
        time: new Date(this.now()),
      });
    }
  }

  /** End every open session of a profile (the server went away). */
  private async closeAll(profileId: string, reason: string, resetLookups: boolean): Promise<void> {
    const s = this.state(profileId);
    if (resetLookups) s.lookups = 0;
    if (s.reconcileTimer) {
      clearTimeout(s.reconcileTimer);
      s.reconcileTimer = null;
    }
    if (s.present.size === 0) return;
    const history = await this.history(profileId);
    for (const p of s.present.values()) {
      history.recordLeave({ name: p.name, slot: p.slot, ip: p.ip, bot: p.bot, reason, time: new Date(this.now()) });
    }
    s.present.clear();
  }
}
