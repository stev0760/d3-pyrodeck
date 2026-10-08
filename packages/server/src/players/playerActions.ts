import { findSlot, listPlayers, type ConsoleLink } from "./consoleLink.js";

/**
 * Kicking and banning over the console.
 *
 * - `$kick <slot>` and `$ban <slot>` take a player number and nothing else
 *   (DMFCInputCommand_Kick/_Ban, netgames/dmfc/dmfcinputcommand.cpp:330, :357),
 *   so the reason goes out first as chat. `$ban` also kicks, and keeps the
 *   address in an in-memory list that is freed with the game DLL
 *   (BanPlayerFromGame, dmfcbase.cpp:3088; ~DMFCBase frees it, :586): every
 *   restart, a playlist rotation included, forgets it.
 * - The dedicated console's chat command is the `Say` variable
 *   (dedicated_server.cpp:185, max 200 characters), sent as `say <text>`.
 *   Text before the first colon is read as a destination: a number is a
 *   player slot, a name prefix a player, "team" the team
 *   (GetMessageDestination, hudmessage.cpp:737). Public text therefore
 *   carries no colon, and `say <slot>: <text>` reaches one player only.
 */

/** Time between the chat line and the kick, so the reason reaches the player first. */
export const KICK_SAY_DELAY_MS = 2000;
const SAY_MAX = 150;

/**
 * Remove what the chat line must not carry: anything but printable ASCII
 * (the console reads bytes and the game's font draws no UTF-8), and `%`,
 * which the dedicated server's console output and some clients treat as a
 * format directive (PrintDedicatedMessage hands the text to con_Printf as
 * the format, dedicated_server.cpp:1388).
 */
function cleanChat(text: string): string {
  return text.replace(/[^\x20-\x7e]|%/g, "").trim();
}

/** A `say` command everyone sees. */
export function sayToAll(text: string): string {
  return `say ${cleanChat(text).replace(/:/g, " -").slice(0, SAY_MAX)}`;
}

/** A `say` command only the player in `slot` sees. */
export function sayToSlot(slot: number, text: string): string {
  return `say ${slot}: ${cleanChat(text).slice(0, SAY_MAX)}`;
}

/** A name fit to quote in chat: printable characters only, or a stand-in. */
export function chatName(name: string): string {
  const clean = cleanChat(name);
  return clean || "(no name)";
}

export interface KickRequest {
  name: string;
  /** Known slot; looked up with `$players` when missing. */
  slot?: number;
  /** Chat line sent before the kick (public). */
  announce: string;
  /** `$ban` instead of `$kick`. */
  ban?: boolean;
}

export type KickResult = { ok: true; slot: number } | { ok: false; error: string };

export interface ActionDeps {
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Say why, wait, check the slot still holds the player, then `$kick` or `$ban`.
 */
export async function removePlayer(link: ConsoleLink, req: KickRequest, deps: ActionDeps = {}): Promise<KickResult> {
  const sleep = deps.sleep ?? defaultSleep;
  let slot = req.slot;
  if (slot === undefined) {
    const players = await listPlayers(link);
    const found = players ? findSlot(players, req.name) : null;
    if (found === null) return { ok: false, error: `${chatName(req.name)} is not in the game.` };
    slot = found;
  }
  if (slot === 0) return { ok: false, error: "Slot 0 is the server itself." };
  await link.send(sayToAll(req.announce));
  await sleep(KICK_SAY_DELAY_MS);
  const players = await listPlayers(link);
  const current = players?.find((p) => p.slot === slot);
  if (!current || current.name !== req.name) {
    return { ok: false, error: `${chatName(req.name)} left before the ${req.ban ? "ban" : "kick"}.` };
  }
  await link.send(`${req.ban ? "$ban" : "$kick"} ${slot}`);
  return { ok: true, slot };
}
