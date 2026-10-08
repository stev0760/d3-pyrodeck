/**
 * Powerup respawn time scaled by the number of human players: the longest
 * time with two players or fewer, falling linearly to the shortest at
 * `playersForMin` players, so a full server is not starved of powerups and a
 * near-empty one is not flooded.
 *
 * `$setrespawntime <seconds>` (netgames/dmfc/dmfcinputcommand.cpp:672-700)
 * sets Netgame.respawn_time, clamps values below 1 to 1, has no upper limit,
 * and syncs the netgame info to clients. A picked-up powerup comes back
 * respawn_time x its type's respawn_scalar seconds later, computed at the
 * pickup (Descent3/object.cpp:1917-1918), so a change applies to the next
 * pickups. The dedicated.cfg key RespawnTime takes 0..10000
 * (Descent3/dedicated_server.cpp:173); the server default is 60
 * (Descent3/multi_server.cpp:2841).
 */
import type { SendLine } from "./periodicCommands.js";

export const RESPAWN_SECONDS_MIN = 1;
export const RESPAWN_SECONDS_MAX = 10000;
/** MAX_NET_PLAYERS (Descent3/multi_external.h:133). */
export const PLAYERS_FOR_MIN_MAX = 32;
export const DEFAULT_PLAYERS_FOR_MIN = 8;
/** Wait this long after the last join or leave before recomputing. */
export const RESPAWN_DEBOUNCE_MS = 15_000;

export interface RespawnScaling {
  enabled: boolean;
  /** Respawn time with `playersForMin` or more human players. */
  minSeconds: number;
  /** Respawn time with two human players or fewer. */
  maxSeconds: number;
  /** Human player count at which the minimum applies (3..32). */
  playersForMin: number;
}

export interface RespawnScalingCheck {
  settings: RespawnScaling | null;
  errors: string[];
}

function int(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

/** Validate untrusted respawn-scaling settings from the profile form. */
export function validateRespawnScaling(raw: unknown): RespawnScalingCheck {
  if (!raw || typeof raw !== "object") return { settings: null, errors: [] };
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];
  const enabled = r.enabled === true;
  const blank = (v: unknown) => v === undefined || v === null || v === "";
  if (!enabled && blank(r.minSeconds) && blank(r.maxSeconds)) return { settings: null, errors };

  const minSeconds = int(r.minSeconds);
  const maxSeconds = int(r.maxSeconds);
  const playersForMin = blank(r.playersForMin) ? DEFAULT_PLAYERS_FOR_MIN : int(r.playersForMin);
  if (minSeconds === null || minSeconds < RESPAWN_SECONDS_MIN || minSeconds > RESPAWN_SECONDS_MAX) {
    errors.push(`The shortest respawn time must be ${RESPAWN_SECONDS_MIN} to ${RESPAWN_SECONDS_MAX} seconds.`);
  }
  if (maxSeconds === null || maxSeconds < RESPAWN_SECONDS_MIN || maxSeconds > RESPAWN_SECONDS_MAX) {
    errors.push(`The longest respawn time must be ${RESPAWN_SECONDS_MIN} to ${RESPAWN_SECONDS_MAX} seconds.`);
  }
  if (minSeconds !== null && maxSeconds !== null && minSeconds > maxSeconds) {
    errors.push("The shortest respawn time cannot be longer than the longest.");
  }
  if (playersForMin === null || playersForMin < 3 || playersForMin > PLAYERS_FOR_MIN_MAX) {
    errors.push(`"Shortest at" must be 3 to ${PLAYERS_FOR_MIN_MAX} players.`);
  }
  if (errors.length > 0) return { settings: null, errors };
  return {
    settings: {
      enabled,
      minSeconds: minSeconds as number,
      maxSeconds: maxSeconds as number,
      playersForMin: playersForMin as number,
    },
    errors,
  };
}

/** Settings as stored in profiles.json, made safe for use: anything invalid turns them off. */
export function sanitizeStoredRespawnScaling(raw: unknown): RespawnScaling | null {
  const check = validateRespawnScaling(raw);
  return check.errors.length === 0 ? check.settings : null;
}

/** The respawn time for `humans` human players. */
export function scaledRespawnSeconds(humans: number, s: RespawnScaling): number {
  if (humans <= 2) return s.maxSeconds;
  if (humans >= s.playersForMin) return s.minSeconds;
  const t = (humans - 2) / (s.playersForMin - 2);
  return Math.round(s.maxSeconds - t * (s.maxSeconds - s.minSeconds));
}

/** Bots carry a [BOT] suffix (Matcen prints "Name[BOT]"; builds before 0.9.9 "Name [BOT]"). */
export function isBotName(name: string): boolean {
  return /\[BOT\]$/i.test(name.trim());
}

export interface RespawnScalerOptions {
  debounceMs?: number;
  log?: (message: string) => void;
}

/**
 * Tracks the human players of one server run and sends `$setrespawntime`
 * when the scaled value changes: once when the console is ready, then a
 * debounce after each join or leave. A value equal to the last one sent is
 * not sent again.
 */
export class RespawnScaler {
  private settings: RespawnScaling | null = null;
  private send: SendLine | null = null;
  private humans = new Map<string, number>();
  private lastSent: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly log: (message: string) => void;

  constructor(options: RespawnScalerOptions = {}) {
    this.debounceMs = options.debounceMs ?? RESPAWN_DEBOUNCE_MS;
    this.log = options.log ?? ((m) => console.log(m));
  }

  /** A new server run: nobody is on it yet and nothing has been sent. */
  arm(settings: RespawnScaling | null): void {
    this.stop();
    this.settings = settings?.enabled ? settings : null;
  }

  consoleReady(send: SendLine): void {
    if (!this.settings) return;
    this.send = send;
    void this.apply();
  }

  consoleLost(): void {
    this.send = null;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.send = null;
    this.settings = null;
    this.humans.clear();
    this.lastSent = null;
  }

  humanCount(): number {
    let n = 0;
    for (const c of this.humans.values()) n += c;
    return n;
  }

  playerJoined(name: string): void {
    if (!this.settings || isBotName(name)) return;
    this.humans.set(name, (this.humans.get(name) ?? 0) + 1);
    this.schedule();
  }

  playerLeft(name: string): void {
    if (!this.settings || isBotName(name)) return;
    const c = this.humans.get(name);
    if (c === undefined) return;
    if (c <= 1) this.humans.delete(name);
    else this.humans.set(name, c - 1);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.apply();
    }, this.debounceMs);
  }

  private async apply(): Promise<void> {
    const s = this.settings;
    const send = this.send;
    if (!s || !send) return;
    const seconds = scaledRespawnSeconds(this.humanCount(), s);
    if (seconds === this.lastSent) return;
    const line = `$setrespawntime ${seconds}`;
    try {
      await send(line);
      this.lastSent = seconds;
      this.log(`[Pyrodeck] Respawn scaling (${this.humanCount()} players): ${line}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[Pyrodeck] Respawn scaling "${line}" not sent: ${message}`);
    }
  }
}
