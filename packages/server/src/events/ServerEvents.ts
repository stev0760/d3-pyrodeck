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
  /** The game process was started (by hand, by a playlist or by the supervisor). */
  "server.started": { profileId: string; pid: number; args: string[]; reason: "manual" | "playlist" | "relaunch" | "schedule" };
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

/** The one instance; modules import this rather than passing it around. */
export const serverEvents = new ServerEvents();
serverEvents.setMaxListeners(50);
