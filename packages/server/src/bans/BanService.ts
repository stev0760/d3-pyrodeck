import fs from "node:fs/promises";
import path from "node:path";
import { serverEvents, type ServerEvents } from "../events/ServerEvents.js";
import { isBotName } from "../events/consoleLines.js";
import { findSlot, listPlayers, type ConsoleLink, type ConsoleProvider } from "../players/consoleLink.js";
import { chatName, removePlayer, type ActionDeps } from "../players/playerActions.js";
import { BanStore, checkNamePattern, type HostsDenySource, type NameBan } from "./BanStore.js";
import {
  addHostsEntry,
  normalizeEntryInput,
  parseHostsFile,
  removeHostsEntry,
  type HostsLine,
} from "./hostsFile.js";

/** 0.0.0.0 and 127.0.0.0/8: denying these would lock out players on the server machine itself. */
export function isLocalAddress(ip: string): boolean {
  return ip === "0.0.0.0" || ip.startsWith("127.");
}

export interface BanSettings {
  hostsDenyPath: string | null;
  rehashOnLevelStart: boolean;
}

export interface BanServiceDeps extends ActionDeps {
  store: BanStore;
  console: ConsoleProvider;
  /** The open console, whatever its profile (for `$rehash` after an edit). */
  openConsole: () => ConsoleLink | null;
  settings: () => BanSettings;
  /** A player's address, looked up if needed (rationed `$playerinfo`). */
  lookupAddress: (profileId: string, name: string, slot: number) => Promise<string | undefined>;
  bus?: ServerEvents;
  log?: (message: string) => void;
}

export interface HostsDenyView {
  path: string;
  source: HostsDenySource;
  exists: boolean;
  lines: Array<HostsLine & { reason?: string; addedAt?: string; name?: string }>;
  allow: { path: string; exists: boolean; entries: string[] };
  error: string | null;
}

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Bans that survive a restart: netgames/hosts.deny (with `$rehash`) for
 * addresses and a stored name list applied on join, on top of DMFC's
 * in-memory `$ban`.
 */
export class BanService {
  private readonly bus: ServerEvents;
  private readonly log: (message: string) => void;
  private readonly handlers: Array<() => void> = [];

  constructor(private readonly deps: BanServiceDeps) {
    this.bus = deps.bus ?? serverEvents;
    this.log = deps.log ?? ((m) => console.log(`[Bans] ${m}`));
  }

  get store(): BanStore {
    return this.deps.store;
  }

  start(): void {
    const onIdentified = (p: { profileId: string; name: string; slot?: number; ip?: string }) => {
      void this.applyNameBan(p.profileId, p.name, p.slot, p.ip).catch((err) =>
        this.log(`Name ban check failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    };
    const onLevel = (p: { profileId: string }) => {
      if (!this.deps.settings().rehashOnLevelStart) return;
      const link = this.deps.console(p.profileId);
      if (link) link.send("$rehash").catch(() => {});
    };
    this.bus.onEvent("player.identified", onIdentified);
    this.bus.onEvent("level.started", onLevel);
    this.handlers.push(
      () => this.bus.offEvent("player.identified", onIdentified),
      () => this.bus.offEvent("level.started", onLevel),
    );
  }

  stop(): void {
    for (const off of this.handlers.splice(0)) off();
  }

  hostsDenyPath(): { path: string; source: HostsDenySource } {
    return this.deps.store.hostsDenyPath(this.deps.settings().hostsDenyPath);
  }

  async readHostsDeny(): Promise<HostsDenyView> {
    const { path: file, source } = this.hostsDenyPath();
    const allowPath = path.join(path.dirname(file), "hosts.allow");
    let content = "";
    let exists = false;
    let error: string | null = null;
    try {
      content = await fs.readFile(file, "latin1");
      exists = true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") error = `Cannot read ${file}: ${e.message}`;
    }
    let allowContent: string | null = null;
    try {
      allowContent = await fs.readFile(allowPath, "latin1");
    } catch {
      // no allow list
    }
    const lines = parseHostsFile(content).map((l) => {
      const note = l.entry ? this.deps.store.hostsNote(l.entry) : null;
      return note ? { ...l, ...note } : l;
    });
    return {
      path: file,
      source,
      exists,
      lines,
      allow: {
        path: allowPath,
        exists: allowContent !== null,
        entries: allowContent === null ? [] : parseHostsFile(allowContent).flatMap((l) => (l.entry ? [l.entry] : [])),
      },
      error,
    };
  }

  /** Add an address or pattern to hosts.deny, note why, and `$rehash`. */
  async addHostsDeny(input: string, reason: string, name?: string): Promise<ActionResult & { entry?: string }> {
    const parsed = normalizeEntryInput(input);
    if (!parsed.ok) return { ok: false, error: `${input.trim() || "That"}: ${parsed.error}.` };
    const { path: file } = this.hostsDenyPath();
    let content = "";
    try {
      content = await fs.readFile(file, "latin1");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const next = addHostsEntry(content, parsed.entry);
    if (next.added) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, next.content, "latin1");
    }
    await this.deps.store.setHostsNote(parsed.entry, {
      reason: reason.trim(),
      addedAt: new Date().toISOString(),
      ...(name ? { name } : {}),
    });
    const rehashed = await this.rehash();
    const where = rehashed ? "and the server reloaded the list" : "the server reads it at its next game start";
    return {
      ok: true,
      entry: parsed.entry,
      message: next.added ? `${parsed.entry} added to hosts.deny, ${where}.` : `${parsed.entry} was already in hosts.deny.`,
    };
  }

  async removeHostsDeny(entry: string): Promise<ActionResult> {
    const { path: file } = this.hostsDenyPath();
    let content: string;
    try {
      content = await fs.readFile(file, "latin1");
    } catch {
      return { ok: false, error: `${file} does not exist.` };
    }
    const next = removeHostsEntry(content, entry);
    if (next.removed === 0) return { ok: false, error: `${entry} is not in hosts.deny.` };
    await fs.writeFile(file, next.content, "latin1");
    await this.deps.store.setHostsNote(entry, null);
    await this.rehash();
    return { ok: true, message: `${entry} removed from hosts.deny.` };
  }

  async addNameBan(rawPattern: unknown, reason: string): Promise<{ ban: NameBan } | { error: string }> {
    const check = checkNamePattern(rawPattern);
    if ("error" in check) return check;
    return { ban: await this.deps.store.addNameBan(check.pattern, reason.trim()) };
  }

  /** `$rehash` on the open console. Returns whether one was open. */
  async rehash(): Promise<boolean> {
    const link = this.deps.openConsole();
    if (!link) return false;
    await link.send("$rehash").catch(() => {});
    return true;
  }

  /** Kick a player, saying why first. */
  async kick(profileId: string, name: string, reason: string, slot?: number): Promise<ActionResult> {
    const link = this.deps.console(profileId);
    if (!link) return { ok: false, error: "No console session to that server." };
    const shown = reason.trim() || "kicked by the admin";
    const result = await removePlayer(link, { name, slot, announce: `${chatName(name)} kicked - ${shown}` }, this.deps);
    if (!result.ok) return result;
    this.bus.emitEvent("player.kicked", { profileId, name, reason: shown });
    return { ok: true, message: `Kicked ${chatName(name)}.` };
  }

  /**
   * Ban a player: DMFC's `$ban` (kicks, and refuses the address until the
   * server restarts), plus, as asked, the address in hosts.deny and the
   * name in the name-ban list.
   */
  async ban(
    profileId: string,
    name: string,
    reason: string,
    opts: { hostsDeny: boolean; nameBan: boolean; slot?: number },
  ): Promise<ActionResult & { ip?: string }> {
    if (isBotName(name)) {
      // A bot's "address" is the server's own (`$playerinfo` prints 127.0.1.1:0 for one).
      return { ok: false, error: "Bots have no address to ban; remove the bot instead." };
    }
    const link = this.deps.console(profileId);
    if (!link) return { ok: false, error: "No console session to that server." };
    const shown = reason.trim() || "banned by the admin";
    let slot = opts.slot;
    let ip: string | undefined;
    if (opts.hostsDeny) {
      if (slot === undefined) {
        const players = await listPlayers(link);
        slot = (players && findSlot(players, name)) ?? undefined;
      }
      if (slot !== undefined) ip = await this.deps.lookupAddress(profileId, name, slot);
    }
    const result = await removePlayer(
      link,
      { name, slot, announce: `${chatName(name)} banned - ${shown}`, ban: true },
      this.deps,
    );
    if (!result.ok) return result;
    const notes: string[] = [`Banned ${chatName(name)} until the server restarts.`];
    if (opts.hostsDeny) {
      if (ip && isLocalAddress(ip)) {
        notes.push(`${ip} is this machine's own address, so it was not added to hosts.deny.`);
      } else if (ip) {
        const added = await this.addHostsDeny(ip, shown, name);
        notes.push(added.ok ? added.message : added.error);
      } else {
        notes.push("Address unknown, so nothing was added to hosts.deny.");
      }
    }
    if (opts.nameBan) {
      const added = await this.addNameBan(name, shown);
      notes.push("ban" in added ? `Name ${added.ban.pattern} banned.` : added.error);
    }
    this.bus.emitEvent("player.banned", { profileId, name, ...(ip ? { ip } : {}), reason: shown });
    return { ok: true, message: notes.join(" "), ...(ip ? { ip } : {}) };
  }

  /** On a human's new session: kick a name on the ban list. */
  private async applyNameBan(profileId: string, name: string, slot?: number, ip?: string): Promise<void> {
    const ban = this.deps.store.findNameBan(name);
    if (!ban) return;
    const link = this.deps.console(profileId);
    if (!link) return;
    const reason = ban.reason || "this name is banned";
    const result = await removePlayer(
      link,
      { name, slot, announce: `${chatName(name)} kicked - ${reason}` },
      this.deps,
    );
    if (!result.ok) {
      this.log(`Name ban on ${JSON.stringify(name)} not applied: ${result.error}`);
      return;
    }
    this.log(`Kicked ${JSON.stringify(name)} (name ban ${ban.pattern})`);
    this.bus.emitEvent("player.kicked", { profileId, name, ...(ip ? { ip } : {}), reason: `name ban: ${reason}` });
  }
}
