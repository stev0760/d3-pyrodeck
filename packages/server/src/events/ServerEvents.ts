/**
 * One process-wide bus for what happens to the game server, so that the parts
 * of Pyrodeck that react to it (supervision, bans, alerts, history) do not
 * each watch the process or the console on their own.
 *
 * Append-only: add event names and payload fields; never rename or remove
 * one, and never change a field's type. Emitters fill every field they know.
 */
import { EventEmitter } from "node:events";

/** `profileId` of a server launched without a profile (the global `dedicated.cfg`). */
export const NO_PROFILE_ID = "launch";

/**
 * `profileId` names the server: the profile Pyrodeck launched,
 * NO_PROFILE_ID for a launch without one, "connect:<host>:<port>" for a
 * server Pyrodeck only connects to. Process events (server.*) are emitted
 * for servers Pyrodeck launched or re-attached to, not in Connect mode;
 * console events (level and player) for every console session.
 */
export interface ServerEventMap {
  /**
   * The game process was started: by hand, by a playlist restart, by the
   * supervisor, by the weekly schedule, or by autostart when Pyrodeck started.
   */
  "server.started": {
    profileId: string;
    pid: number;
    args: string[];
    reason: "manual" | "playlist" | "relaunch" | "schedule" | "autostart";
  };
  /**
   * The game process stopped on request. `via: "console"` when someone typed
   * `quit` on the server's remote console instead of using Pyrodeck (reason
   * is then "manual").
   */
  "server.stopped": {
    profileId: string;
    pid: number;
    reason: "manual" | "playlist" | "schedule" | "empty-restart";
    via?: "console";
  };
  /** The game process exited without a request: a crash or a kill from outside. */
  "server.crashed": { profileId: string; pid: number; code: number | null; signal: string | null };
  /**
   * The console stopped answering for longer than the supervisor tolerates.
   * The supervisor kills the process and relaunches it; no server.stopped or
   * server.crashed follows for that process.
   */
  "server.hung": { profileId: string; pid: number; silentForMs: number };
  /** A new level started (first line of a level load seen on the console or in the log). */
  "level.started": { profileId: string; mission?: string; level?: string };
  /**
   * A player entered the game; `bot` when the callsign carries the engine's
   * [BOT] tag. The join line repeats for every player at each level start, so
   * a join of a name already in the game is a re-entry, not a new player.
   */
  "player.joined": { profileId: string; name: string; ip?: string; slot?: number; bot?: boolean };
  /** `reason`: "left the game", "disconnected" (dropped), "kicked", "banned" or "bot removed". */
  "player.left": { profileId: string; name: string; ip?: string; slot?: number; bot?: boolean; reason?: string };
  /** Pyrodeck kicked a player (a rule or an operator). */
  "player.kicked": { profileId: string; name: string; ip?: string; reason: string };
  /** Pyrodeck banned a player (name, address or both). */
  "player.banned": { profileId: string; name?: string; ip?: string; reason: string; until?: string };
  /** A chat line from a player, as the server printed it. */
  "player.chat": { profileId: string; name: string; text: string };
  /**
   * Pyrodeck started and re-attached to a server it had launched before it
   * stopped (the process kept running). Its output is no longer captured.
   */
  "server.adopted": { profileId: string; pid: number; startedAt: string };
  /** A weekly-schedule start or stop did not happen; `reason` says why (ops/Scheduler.ts). */
  "schedule.skipped": { profileId: string; action: "start" | "stop"; reason: string };
  /**
   * A human player's new session, once Pyrodeck has looked up the slot
   * ($players) and, when allowed, the address ($playerinfo). Not sent for
   * bots or for level re-entries.
   */
  "player.identified": { profileId: string; name: string; slot?: number; ip?: string };
}

export type ServerEventName = keyof ServerEventMap;

/** Every event name, for code that relays all of them (scopedEvents). */
export const SERVER_EVENT_NAMES: readonly ServerEventName[] = [
  "server.started",
  "server.stopped",
  "server.crashed",
  "server.hung",
  "level.started",
  "player.joined",
  "player.left",
  "player.kicked",
  "player.banned",
  "player.chat",
  "server.adopted",
  "schedule.skipped",
  "player.identified",
];

export class ServerEvents extends EventEmitter {
  emitEvent<K extends ServerEventName>(name: K, payload: ServerEventMap[K]): boolean {
    return this.emit(name, payload);
  }

  onEvent<K extends ServerEventName>(name: K, listener: (payload: ServerEventMap[K]) => void): this {
    return this.on(name, listener);
  }

  offEvent<K extends ServerEventName>(name: K, listener: (payload: ServerEventMap[K]) => void): this {
    return this.off(name, listener);
  }
}

/**
 * One server's view of a shared bus: its listeners hear only the events whose
 * `profileId` is `scopeId`, and what it emits goes to the shared bus, where
 * every other listener (alerts, history, bans) hears it too and it comes back
 * to this view's listeners from there. The parts of a server instance that
 * watch "the server" (supervisor, autostart, quit watch, profile automation)
 * take one of these, so a join on another server is not a join on theirs.
 */
export class ScopedServerEvents extends ServerEvents {
  private readonly relays: Array<() => void> = [];

  constructor(
    readonly parent: ServerEvents,
    readonly scopeId: string,
  ) {
    super();
    this.setMaxListeners(50);
    for (const name of SERVER_EVENT_NAMES) {
      const relay = (payload: { profileId: string }) => {
        if (payload.profileId === scopeId) super.emit(name, payload);
      };
      parent.on(name, relay);
      this.relays.push(() => parent.off(name, relay));
    }
  }

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    // Server events go out through the shared bus, so every listener hears
    // them in the order they were added there; anything else stays local.
    if ((SERVER_EVENT_NAMES as readonly (string | symbol)[]).includes(eventName)) {
      return this.parent.emit(eventName, ...args);
    }
    return super.emit(eventName, ...args);
  }

  /** Stop relaying from the shared bus. */
  dispose(): void {
    for (const off of this.relays.splice(0)) off();
  }
}

/** A view of `bus` for the server whose events carry `profileId` `scopeId`. */
export function scopedEvents(bus: ServerEvents, scopeId: string): ScopedServerEvents {
  return new ScopedServerEvents(bus, scopeId);
}

/** The one instance; modules import this rather than passing it around. */
export const serverEvents = new ServerEvents();
// A relay per event name for each server (scopedEvents), on top of the global consumers.
serverEvents.setMaxListeners(100);
