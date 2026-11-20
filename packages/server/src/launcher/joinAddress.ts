/**
 * The address players type into Descent 3's Direct TCP/IP join screen to
 * reach a profile's server: an IPv4 address and the game UDP port
 * (-useport, default 2092; launchOptions.ts).
 *
 * The host is the first of: the operator's Join Host setting; the profile's
 * -useip address when it is public; the host of the mission host's public
 * base URL (the address players already reach this machine at); the -useip
 * address when it is a LAN one. Without any of them Pyrodeck cannot know
 * the machine's public address and says so.
 *
 * The join screen passes what the player types to inet_addr, and so does
 * -directip (netcon/lanclient/lanclient.cpp): the game takes a dotted IPv4
 * address only and refuses a host name without a word to the player. A host
 * that is a name is looked up here, IPv4 only, and players are given the
 * address it resolves to.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { isLocalHost } from "../gamefiles/missionHostSettings.js";
import { effectivePorts, type LaunchOptions } from "./launchOptions.js";

export type JoinHostSource = "setting" | "bind-address" | "mission-host";

/** The host and port the join address is made from, the host as set (resolveJoinAddress). */
export interface JoinHostChoice {
  /** Host name or IPv4 address, or null when unknown. */
  host: string | null;
  /** Game UDP port. */
  port: number;
  hostSource: JoinHostSource | null;
}

/** What the host is: an IPv4 address, a host name, or an IPv6 address (the game cannot use one). */
export type JoinHostKind = "ipv4" | "name" | "ipv6";

export interface JoinAddress extends JoinHostChoice {
  /** Null when the host is unknown. */
  hostKind: JoinHostKind | null;
  /** The IPv4 address a host name resolved to; null for any other host, or when the name did not resolve. */
  resolved: string | null;
  /** `IPv4:port`, what the game's join screen takes; null when there is no IPv4 address. */
  address: string | null;
  /** The address is a loopback or private one: reachable on this network only. */
  lanOnly: boolean;
}

const HOST_MAX = 253;

/**
 * Check the Join Host setting: a host name or IPv4 address, no scheme, port
 * or path. Returns the normalized host or an error.
 */
export function checkJoinHost(raw: string): { host: string } | { error: string } {
  const host = raw.trim().toLowerCase();
  if (!host) return { error: "Enter the host name or IP address players join at." };
  if (host.includes("://") || /[/:@\s]/.test(host)) {
    return { error: "Give only the host name or IPv4 address (example: d3.example.org), without http://, a port or a path." };
  }
  if (/^[\d.]+$/.test(host) && !isIPv4(host)) {
    return { error: "Not a valid IPv4 address: four numbers from 0 to 255 (example: 192.0.2.10)." };
  }
  if (host.length > HOST_MAX || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    return { error: "Not a valid host name or IPv4 address." };
  }
  return { host };
}

function urlHost(publicBaseUrl: string | null | undefined): string | null {
  if (!publicBaseUrl) return null;
  try {
    return new URL(publicBaseUrl).hostname || null;
  } catch {
    return null;
  }
}

/** Pick the host and port players join at. No lookup: joinAddressFor turns the choice into the address. */
export function resolveJoinAddress(
  launchOptions: LaunchOptions | null | undefined,
  joinHost: string | null | undefined,
  missionHostPublicBaseUrl: string | null | undefined,
): JoinHostChoice {
  const port = effectivePorts(launchOptions).game;
  const bind = launchOptions?.bindIp && launchOptions.bindIp !== "0.0.0.0" ? launchOptions.bindIp : null;
  const fromUrl = urlHost(missionHostPublicBaseUrl);

  const candidates: [string | null, JoinHostSource][] = [
    [joinHost ?? null, "setting"],
    [bind && !isLocalHost(bind) ? bind : null, "bind-address"],
    [fromUrl, "mission-host"],
    [bind, "bind-address"],
  ];
  for (const [host, hostSource] of candidates) {
    if (host) return { host, port, hostSource };
  }
  return { host: null, port, hostSource: null };
}

/** A host name's IPv4 address, or null when it has none or the lookup takes too long. */
export type IPv4Lookup = (name: string) => Promise<string | null>;

/** How long the join address waits for a host name's lookup. */
export const JOIN_LOOKUP_TIMEOUT_MS = 2000;

/**
 * An IPv4Lookup over `lookup` (the system resolver, IPv4 only, by default)
 * that gives up after `timeoutMs`. The system resolver runs on Node's small
 * worker pool and cannot be cancelled, so while a lookup of a name is still
 * running, the next request for that name waits on it instead of starting
 * another.
 */
export function ipv4Lookup(
  timeoutMs = JOIN_LOOKUP_TIMEOUT_MS,
  lookup: (name: string) => Promise<{ address: string }> = (name) => dnsLookup(name, { family: 4 }),
): IPv4Lookup {
  const running = new Map<string, Promise<string | null>>();
  return (name) => {
    let pending = running.get(name);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => lookup(name))
        .then(
          (result) => (isIPv4(result.address) ? result.address : null),
          () => null,
        )
        .finally(() => running.delete(name));
      running.set(name, pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
  };
}

const systemIPv4Lookup = ipv4Lookup();

/**
 * The address players join at: an IPv4 host as it is, a host name's IPv4
 * address (looked up with `lookup`), and none for an IPv6 address or a name
 * that does not resolve.
 */
export async function joinAddressFor(
  choice: JoinHostChoice,
  lookup: IPv4Lookup = systemIPv4Lookup,
): Promise<JoinAddress> {
  const { host, port } = choice;
  const none = { resolved: null, address: null, lanOnly: false };
  if (!host) return { ...choice, hostKind: null, ...none };
  if (isIPv4(host)) {
    return { ...choice, hostKind: "ipv4", resolved: null, address: `${host}:${port}`, lanOnly: isLocalHost(host) };
  }
  if (isIPv6(host.replace(/^\[|\]$/g, ""))) return { ...choice, hostKind: "ipv6", ...none };
  const resolved = await lookup(host);
  if (!resolved) return { ...choice, hostKind: "name", ...none };
  return { ...choice, hostKind: "name", resolved, address: `${resolved}:${port}`, lanOnly: isLocalHost(resolved) };
}
