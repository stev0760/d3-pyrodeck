/**
 * A profile's join address, as GET /api/profiles/:id/join-address sends it
 * (server: launcher/joinAddress.ts), and what the Launch panel's Join row
 * says about it. The game's Direct TCP/IP join screen takes an IPv4 address
 * only, so a host name comes with the address it resolves to.
 */
export interface JoinAddress {
  /** The host as set: a host name or IPv4 address; null when unknown. */
  host: string | null;
  port: number;
  hostSource: "setting" | "bind-address" | "mission-host" | null;
  hostKind: "ipv4" | "name" | "ipv6" | null;
  /** The IPv4 address a host name resolved to. */
  resolved: string | null;
  /** `IPv4:port` to copy; null when there is no IPv4 address. */
  address: string | null;
  /** A loopback or private address: reachable on this network only. */
  lanOnly: boolean;
}

const SOURCE_LABEL: Record<NonNullable<JoinAddress["hostSource"]>, string> = {
  setting: "Join Host setting",
  "bind-address": "bind address",
  "mission-host": "mission host URL",
};

const LOCAL = "a local address, so only players on this network can use it";
const ENTER = "Players enter it under Multiplayer → Direct TCP/IP.";
const NEEDS_IPV4 =
  "The game's join screen takes only an IPv4 address. Set the Join Host to the IPv4 address players reach this machine at.";

/** What the row shows: the address to copy, or `?:port` when there is none. */
export function joinAddressText(join: JoinAddress): string {
  return join.address ?? `?:${join.port}`;
}

export interface JoinNote {
  text: string;
  tone: "info" | "warn";
}

/** The line under the row. */
export function joinAddressNote(join: JoinAddress): JoinNote {
  if (!join.host) {
    return { text: "Pyrodeck doesn't know the address players reach this machine at. Set the Join Host.", tone: "info" };
  }
  const from = `Host from the ${SOURCE_LABEL[join.hostSource ?? "setting"]}`;
  if (join.hostKind === "ipv6") {
    return { text: `${from}: ${join.host} is an IPv6 address. ${NEEDS_IPV4}`, tone: "warn" };
  }
  if (join.hostKind === "name") {
    if (!join.resolved) {
      return { text: `${from}: ${join.host} does not resolve to an IPv4 address from this machine. ${NEEDS_IPV4}`, tone: "warn" };
    }
    return {
      text:
        `${from}: ${join.host} is ${join.resolved}${join.lanOnly ? `, ${LOCAL}` : ""}. ` +
        `The game's join screen takes the number, not the name. ${ENTER}`,
      tone: "info",
    };
  }
  return { text: `${from}${join.lanOnly ? `; ${LOCAL}` : ""}. ${ENTER}`, tone: "info" };
}
