import net from "node:net";
import type { IncomingHttpHeaders } from "node:http";

/**
 * Where a request came from: the client address behind a reverse proxy,
 * whether the request is local, whether it came over HTTPS, and whether a
 * browser sent it from another site. requireAuth, the auth routes and index.ts
 * all decide these things here, so they cannot disagree.
 */

/** The parts of a Fastify request these checks read (plain objects in tests). */
export interface RequestLike {
  /** Client address: the TCP peer, or the right-most untrusted X-Forwarded-For entry under trustProxy. */
  ip: string;
  /** Host name the browser asked for, without the port (Fastify's request.hostname). */
  hostname: string;
  headers: IncomingHttpHeaders;
}

/** Names @fastify/proxy-addr accepts in place of an address. */
const PROXY_ADDR_NAMES = new Set(["loopback", "linklocal", "uniquelocal"]);

/**
 * Fastify's `trustProxy` from PYRODECK_TRUST_PROXY.
 *
 * - unset, "", "0", "false", "no", "off": false. X-Forwarded-* is ignored and
 *   request.ip is the TCP peer.
 * - "1", "true", "yes", "on": ["loopback"]. Only a proxy on this machine
 *   (127.0.0.0/8, ::1) is trusted, so request.ip is the right-most
 *   X-Forwarded-For entry that is not loopback: the address nginx's
 *   $proxy_add_x_forwarded_for appended. Whatever the client wrote further
 *   left is ignored, and a client that reaches Pyrodeck's port directly is
 *   read by its own address.
 * - anything else: a comma-separated list of addresses or CIDR blocks (and
 *   proxy-addr's names loopback, linklocal, uniquelocal), for a proxy on
 *   another host.
 *
 * Never `true`: Fastify then trusts every hop, and request.ip becomes the
 * left-most X-Forwarded-For entry, which the client writes. Throws on an entry
 * that is not an address, a block or a name, and on a /0 block (which trusts
 * every address, the same as `true`).
 */
export function parseTrustProxy(raw: string | undefined): false | string[] {
  const value = (raw ?? "").trim();
  const lower = value.toLowerCase();
  if (lower === "" || lower === "0" || lower === "false" || lower === "no" || lower === "off") return false;
  if (lower === "1" || lower === "true" || lower === "yes" || lower === "on") return ["loopback"];

  const entries = value.split(",").map((e) => e.trim()).filter(Boolean);
  const bad = entries.filter((e) => !isTrustEntry(e));
  if (entries.length === 0 || bad.length > 0) {
    throw new Error(
      `PYRODECK_TRUST_PROXY: ${bad.length ? `"${bad.join('", "')}" is not` : "the value is not"} ` +
        "1, an IP address or a CIDR block (example: 1, or 10.0.0.5, or 10.0.0.0/24,fd00::/8). " +
        "A /0 block would trust every client's X-Forwarded-For and is refused.",
    );
  }
  return entries;
}

function isTrustEntry(entry: string): boolean {
  if (PROXY_ADDR_NAMES.has(entry.toLowerCase())) return true;
  const slash = entry.indexOf("/");
  if (slash < 0) return net.isIP(entry) !== 0;
  const addr = entry.slice(0, slash);
  const prefix = entry.slice(slash + 1);
  const family = net.isIP(addr);
  if (family === 0 || !/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 1 && bits <= (family === 4 ? 32 : 128);
}

/** A loopback address: 127.0.0.0/8, ::1, or 127.x written as an IPv4-mapped IPv6 address. */
export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const addr = ip.toLowerCase().replace(/^::ffff:/, "");
  return addr === "::1" || (net.isIPv4(addr) && addr.startsWith("127."));
}

/** Headers a reverse proxy adds. Any one of them means the request was relayed. */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip"] as const;

/** Whether the request carries a header that only a proxy (or a client faking one) sends. */
export function isProxiedRequest(request: RequestLike): boolean {
  return PROXY_HEADERS.some((h) => request.headers[h] !== undefined);
}

/**
 * Whether a request comes from this machine and may use what Pyrodeck opens
 * to local users only (the API with no password set, first-run setup).
 *
 * A request is local when its client address is loopback, it carries no
 * proxy header, and its Host is a loopback name (localhost, 127.x, [::1]).
 *
 * - A relayed request is never local: behind nginx every request arrives from
 *   127.0.0.1, and with trustProxy off (or a client that wrote X-Forwarded-For
 *   itself) request.ip is the proxy, not the browser. A browser on this
 *   machine that goes through the proxy is not local either; open Pyrodeck's
 *   own port directly, or through an SSH tunnel, for that.
 * - The Host test stops DNS rebinding: a web page whose own name resolves to
 *   127.0.0.1 reaches Pyrodeck from loopback, but asks for its own name.
 */
export function isLocalRequest(request: RequestLike): boolean {
  return isLoopbackAddress(request.ip) && !isProxiedRequest(request) && isLoopbackName(request.hostname);
}

/**
 * The key the login rate limiter counts attempts under: the address itself
 * for IPv4 (an IPv4-mapped IPv6 address is read as IPv4), the /64 prefix for
 * IPv6. One IPv6 host usually holds a whole /64, so counting single addresses
 * would give it 2^64 tries.
 */
export function rateLimitKey(ip: string): string {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return mapped[1];
  if (!net.isIPv6(lower)) return lower;
  const groups = expandIPv6(lower);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : lower;
}

/** The eight groups of an IPv6 address, without leading zeros. Null when malformed. */
function expandIPv6(ip: string): string[] | null {
  let addr = ip.split("%")[0];
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    addr = `${addr.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16).toString(16));
}

/** PYRODECK_CORS_ORIGIN: comma-separated origins allowed to call the API from another site. */
export function parseOriginList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

/** localhost, a *.localhost name (browsers resolve these to loopback themselves), or a loopback address. */
export function isLoopbackName(hostname: string): boolean {
  const h = bareHost(hostname);
  return h === "localhost" || h.endsWith(".localhost") || isLoopbackAddress(h);
}

/**
 * Why a browser request must be refused as cross-site, or null when it may
 * proceed. Requests without an Origin header (same-origin GETs, curl, the
 * game's own tools) pass; browsers always send Origin on a WebSocket handshake
 * and on a cross-origin or non-GET fetch.
 *
 * An Origin passes when its host name is the request's own (`hostname`:
 * Fastify's request.hostname, the Host header, or X-Forwarded-Host from a
 * trusted proxy), when both are loopback names (the Vite dev proxy rewrites
 * Host to 127.0.0.1:3001), or when it is listed in PYRODECK_CORS_ORIGIN.
 * Ports are not compared: nginx's $host drops the port, and Vite serves the
 * page on 5173 while Pyrodeck answers on 3001.
 */
export function crossSiteRefusal(
  origin: string | undefined,
  hostname: string,
  allowedOrigins: readonly string[],
): string | null {
  if (origin === undefined) return null;
  if (allowedOrigins.includes(origin)) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    return `Cross-site request refused (Origin ${origin}).`;
  }
  if (!originHost) return `Cross-site request refused (Origin ${origin}).`;
  if (bareHost(originHost) === bareHost(hostname)) return null;
  if (isLoopbackName(originHost) && isLoopbackName(hostname)) return null;
  return (
    `Cross-site request refused: Origin ${origin} is not this host (${hostname || "no Host header"}). ` +
    "Behind a reverse proxy, pass the browser's Host header on (nginx: proxy_set_header Host $host)."
  );
}
