import type { ServerCapabilities } from "../parser/parsers/servercaps.js";
import { parsePlayers, parsePlayerinfo, type PlayerInfo, type PlayerSlot } from "../parser/parsers/players.js";

/** A console session that belongs to one server profile. */
export interface ConsoleLink {
  profileId: string;
  capabilities: ServerCapabilities;
  send(command: string): Promise<string>;
}

/** Returns the console session for a profile, or null when none is open. */
export type ConsoleProvider = (profileId: string) => ConsoleLink | null;

/** `$players`, or null when the reply did not parse. */
export async function listPlayers(link: ConsoleLink): Promise<PlayerSlot[] | null> {
  return parsePlayers(await link.send("$players"))?.players ?? null;
}

/** The slot a name is in, from `$players`: exact match first, then case-insensitive. */
export function findSlot(players: PlayerSlot[], name: string): number | null {
  const exact = players.find((p) => p.name === name && p.slot !== 0);
  if (exact) return exact.slot;
  const lower = name.toLowerCase();
  return players.find((p) => p.name.toLowerCase() === lower && p.slot !== 0)?.slot ?? null;
}

/**
 * `$playerinfo <slot>`, accepted only when the reply names that slot and
 * player (DMFC prints the previously shown player for a slot that left).
 */
export async function queryPlayerinfo(link: ConsoleLink, slot: number, name: string): Promise<PlayerInfo | null> {
  const info = parsePlayerinfo(await link.send(`$playerinfo ${slot}`));
  if (!info || info.slot !== slot || info.name !== name) return null;
  return info;
}

/**
 * Whether the server clears the text-command buffer DMFC's `$playerinfo` and
 * `$netgameinfo` write into. DMFCBase::DisplayPlayerInfo queues every line
 * with DLLgrtext_Printf even on a dedicated server (dmfcbase.cpp:1654-1680),
 * and `$playerinfo` calls it twice (dmfcmenu.cpp:1138 and
 * dmfcinputcommand.cpp:261), about 400 bytes per query into a 16 KB buffer
 * (GRTEXT_BUFLEN, grtext/grtext.h:115) that a dedicated server never flushes:
 * the server asserts or corrupts memory after roughly 40 queries. Matcen
 * clears the buffer every frame from 0.9.3 (GameLoop.cpp:2591, commit
 * 5b0f1255). No feature flag advertises the fix, so the version decides.
 */
export function engineClearsTextBuffer(caps: ServerCapabilities): boolean {
  if (caps.fork.toLowerCase() !== "matcen") return false;
  const [major, minor, patch] = caps.forkVersion.split(".").map((n) => parseInt(n, 10));
  if ([major, minor, patch].some((n) => Number.isNaN(n))) return false;
  if (major !== 0) return major > 0;
  if (minor !== 9) return minor > 9;
  return patch >= 3;
}

export interface IpLookupPolicy {
  enabled: boolean;
  /** `$playerinfo` queries allowed per server run on engines that keep the buffer. */
  budget: number;
}

export type IpLookupDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether to send `$playerinfo` for a joining player. One query per join,
 * never polled. A name with `%` is never queried: DisplayPlayerInfo passes
 * the callsign line to DLLgrtext_Printf as the format string
 * (dmfcbase.cpp:1654).
 */
export function decideIpLookup(
  policy: IpLookupPolicy,
  caps: ServerCapabilities,
  name: string,
  used: number,
): IpLookupDecision {
  if (!policy.enabled) return { allowed: false, reason: "address lookup is off" };
  if (name.includes("%")) return { allowed: false, reason: "the name contains %" };
  if (engineClearsTextBuffer(caps)) return { allowed: true };
  if (used >= policy.budget) {
    return {
      allowed: false,
      reason: `this server's text buffer is never cleared; the ${policy.budget} lookups allowed per run are used`,
    };
  }
  return { allowed: true };
}
