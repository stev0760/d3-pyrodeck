import fs from "node:fs/promises";
import path from "node:path";

/**
 * Join and leave history per server profile, with a name/IP index, kept in
 * `<config dir>/players/<profile>.json`. Rows roll over at MAX_ROWS (oldest
 * dropped first); the index keeps one entry per name and address pair, so an
 * address outlives the rows it came from.
 */

export const MAX_ROWS = 5000;
export const MAX_INDEX = 5000;
const SAVE_DELAY_MS = 2000;

export interface HistoryRow {
  id: number;
  /** ISO time. */
  time: string;
  event: "join" | "leave";
  name: string;
  slot?: number;
  ip?: string;
  bot?: boolean;
  /** Leave rows: why the session ended ("left the game", "disconnected", "server stopped", ...). */
  reason?: string;
}

export interface NameIpEntry {
  name: string;
  ip: string;
  firstSeen: string;
  lastSeen: string;
  /** Sessions seen with this name from this address. */
  count: number;
}

export interface PlayerSession {
  name: string;
  slot?: number;
  ip?: string;
  bot?: boolean;
  joinedAt: string | null;
  leftAt: string | null;
  reason?: string;
}

interface HistoryFile {
  version: 1;
  profileId: string;
  nextId: number;
  rows: HistoryRow[];
  index: NameIpEntry[];
}

/** File name for a profile id: UUIDs as they are, other ids with unsafe characters replaced. */
export function historyFileName(profileId: string): string {
  return `${profileId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
}

function matches(text: string | undefined, q: string): boolean {
  return !!text && text.toLowerCase().includes(q);
}

export class PlayerHistory {
  private data: HistoryFile;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    readonly profileId: string,
    private readonly filePath: string | null,
    data: HistoryFile | null,
  ) {
    this.data = data ?? { version: 1, profileId, nextId: 1, rows: [], index: [] };
  }

  /** Load a profile's history from `dir` (empty when missing or unreadable). `dir` null = memory only. */
  static async open(profileId: string, dir: string | null): Promise<PlayerHistory> {
    if (!dir) return new PlayerHistory(profileId, null, null);
    const filePath = path.join(dir, historyFileName(profileId));
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf-8")) as Partial<HistoryFile>;
      if (Array.isArray(parsed.rows) && Array.isArray(parsed.index)) {
        const nextId =
          typeof parsed.nextId === "number" ? parsed.nextId : parsed.rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
        return new PlayerHistory(profileId, filePath, {
          version: 1,
          profileId,
          nextId,
          rows: parsed.rows,
          index: parsed.index,
        });
      }
    } catch {
      // missing or unreadable: start empty
    }
    return new PlayerHistory(profileId, filePath, null);
  }

  get rowCount(): number {
    return this.data.rows.length;
  }

  get lastEventAt(): string | null {
    return this.data.rows.at(-1)?.time ?? null;
  }

  recordJoin(entry: { name: string; slot?: number; ip?: string; bot?: boolean; time?: Date }): HistoryRow {
    const row = this.append({ event: "join", ...entry });
    if (entry.ip) this.indexAddress(entry.name, entry.ip, row.time, true);
    return row;
  }

  recordLeave(entry: { name: string; slot?: number; ip?: string; bot?: boolean; reason?: string; time?: Date }): HistoryRow {
    return this.append({ event: "leave", ...entry });
  }

  /** Fill in a row's slot or address once it is known. */
  update(rowId: number, fields: { slot?: number; ip?: string }): void {
    const row = this.data.rows.find((r) => r.id === rowId);
    if (!row) return;
    if (fields.slot !== undefined) row.slot = fields.slot;
    if (fields.ip && row.ip !== fields.ip) {
      row.ip = fields.ip;
      this.indexAddress(row.name, fields.ip, row.time, row.event === "join");
    }
    this.scheduleSave();
  }

  /** Rows newest first, filtered by name or address (substring, case-insensitive). */
  search(opts: { q?: string; limit?: number; beforeId?: number } = {}): { rows: HistoryRow[]; total: number } {
    const q = opts.q?.trim().toLowerCase() ?? "";
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const hits = this.data.rows.filter(
      (r) => (!q || matches(r.name, q) || matches(r.ip, q)) && (opts.beforeId === undefined || r.id < opts.beforeId),
    );
    return { rows: hits.slice(-limit).reverse(), total: hits.length };
  }

  /**
   * Sessions (a join and the leave that ends it) that overlap [from, to],
   * newest first. A session still open has leftAt null; a leave whose join
   * rolled out of the history has joinedAt null.
   */
  sessions(opts: { from?: Date; to?: Date; q?: string } = {}): PlayerSession[] {
    const open = new Map<string, PlayerSession>();
    const all: PlayerSession[] = [];
    for (const r of this.data.rows) {
      const key = r.name.toLowerCase();
      if (r.event === "join") {
        const s: PlayerSession = { name: r.name, slot: r.slot, ip: r.ip, bot: r.bot, joinedAt: r.time, leftAt: null };
        open.set(key, s);
        all.push(s);
      } else {
        const s = open.get(key);
        if (s) {
          s.leftAt = r.time;
          s.reason = r.reason;
          if (!s.ip && r.ip) s.ip = r.ip;
          open.delete(key);
        } else {
          all.push({ name: r.name, slot: r.slot, ip: r.ip, bot: r.bot, joinedAt: null, leftAt: r.time, reason: r.reason });
        }
      }
    }
    const from = opts.from?.getTime() ?? -Infinity;
    const to = opts.to?.getTime() ?? Infinity;
    const q = opts.q?.trim().toLowerCase() ?? "";
    return all
      .filter((s) => {
        const start = s.joinedAt ? Date.parse(s.joinedAt) : -Infinity;
        const end = s.leftAt ? Date.parse(s.leftAt) : Infinity;
        return start <= to && end >= from && (!q || matches(s.name, q) || matches(s.ip, q));
      })
      .reverse();
  }

  /** Name/address pairs, most recently seen first, filtered by name or address. */
  addresses(q?: string): NameIpEntry[] {
    const needle = q?.trim().toLowerCase() ?? "";
    return this.data.index
      .filter((e) => !needle || matches(e.name, needle) || matches(e.ip, needle))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  /** Write any pending change now. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saving = this.saving.then(() => this.write());
    }
    await this.saving;
  }

  private append(entry: Omit<HistoryRow, "id" | "time"> & { time?: Date }): HistoryRow {
    const { time, ...fields } = entry;
    const row: HistoryRow = { id: this.data.nextId++, time: (time ?? new Date()).toISOString(), ...fields };
    for (const k of Object.keys(row) as (keyof HistoryRow)[]) {
      if (row[k] === undefined) delete row[k];
    }
    this.data.rows.push(row);
    if (this.data.rows.length > MAX_ROWS) this.data.rows.splice(0, this.data.rows.length - MAX_ROWS);
    this.scheduleSave();
    return row;
  }

  private indexAddress(name: string, ip: string, time: string, newSession: boolean): void {
    const existing = this.data.index.find((e) => e.ip === ip && e.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (time > existing.lastSeen) existing.lastSeen = time;
      if (newSession) existing.count++;
    } else {
      this.data.index.push({ name, ip, firstSeen: time, lastSeen: time, count: 1 });
      if (this.data.index.length > MAX_INDEX) {
        this.data.index.sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
        this.data.index.splice(0, this.data.index.length - MAX_INDEX);
      }
    }
  }

  private scheduleSave(): void {
    if (!this.filePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saving = this.saving.then(() => this.write());
    }, SAVE_DELAY_MS);
  }

  private async write(): Promise<void> {
    if (!this.filePath) return;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data));
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Players] Cannot save history to ${this.filePath}: ${message}`);
    }
  }
}
