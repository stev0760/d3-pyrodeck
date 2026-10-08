/**
 * The address players type into Descent 3's Direct TCP/IP join screen to
 * reach a profile's server: a host and the game UDP port (-useport, default
 * 2092; launchOptions.ts).
 *
 * The host is the first of: the operator's Join Host setting; the profile's
 * -useip address when it is public; the host of the mission host's public
 * base URL (the address players already reach this machine at); the -useip
 * address when it is a LAN one. Without any of them Pyrodeck cannot know
 * the machine's public address and says so.
 */
import { isLocalHost } from "../gamefiles/missionHostSettings.js";
import { effectivePorts, type LaunchOptions } from "./launchOptions.js";

export type JoinHostSource = "setting" | "bind-address" | "mission-host";

export interface JoinAddress {
  /** Host or IPv4 address, or null when unknown. */
  host: string | null;
  /** Game UDP port. */
  port: number;
  /** `host:port`, or null when the host is unknown. */
  address: string | null;
  hostSource: JoinHostSource | null;
  /** The host is a loopback or private address: reachable on this network only. */
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

export function resolveJoinAddress(
  launchOptions: LaunchOptions | null | undefined,
  joinHost: string | null | undefined,
  missionHostPublicBaseUrl: string | null | undefined,
): JoinAddress {
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
    if (host) return { host, port, address: `${host}:${port}`, hostSource, lanOnly: isLocalHost(host) };
  }
  return { host: null, port, address: null, hostSource: null, lanOnly: false };
}
