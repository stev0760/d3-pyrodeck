/**
 * One process-wide bus for what happens to the game server, so that the parts
 * of Pyrodeck that react to it (supervision, bans, alerts, history) do not
 * each watch the process or the console on their own.
 *
 * Append-only: add event names and payload fields; never rename or remove
 * one, and never change a field's type. Emitters fill every field they know.
 */
import { EventEmitter } from "node:events";

export interface ServerEventMap {
  /** The game process was started (by hand, by a playlist or by the supervisor). */
  "server.started": { profileId: string; pid: number; args: string[]; reason: "manual" | "playlist" | "relaunch" | "schedule" };
  /** The game process stopped on request. */
  "server.stopped": { profileId: string; pid: number; reason: "manual" | "playlist" | "schedule" | "empty-restart" };
  /** The game process exited without a request: a crash or a kill from outside. */
  "server.crashed": { profileId: string; pid: number; code: number | null; signal: string | null };
  /** The console stopped answering for longer than the supervisor tolerates. */
  "server.hung": { profileId: string; pid: number; silentForMs: number };
  /** A new level started (first line of a level load seen on the console or in the log). */
  "level.started": { profileId: string; mission?: string; level?: string };
  "player.joined": { profileId: string; name: string; ip?: string; slot?: number };
  "player.left": { profileId: string; name: string; ip?: string; slot?: number };
  /** Pyrodeck kicked a player (a rule or an operator). */
  "player.kicked": { profileId: string; name: string; ip?: string; reason: string };
  /** Pyrodeck banned a player (name, address or both). */
  "player.banned": { profileId: string; name?: string; ip?: string; reason: string; until?: string };
  /** A chat line from a player, as the server printed it. */
  "player.chat": { profileId: string; name: string; text: string };
  /** A weekly-schedule start or stop did not happen; `reason` says why (ops/Scheduler.ts). */
  "schedule.skipped": { profileId: string; action: "start" | "stop"; reason: string };
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
