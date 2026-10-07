import path from "node:path";
import { MISSION_URL_MAX, RETAIL_MISSIONS, checkMissionFilename, validateMissionUrl } from "./Mn3UrlRewriter.js";

/**
 * Mission host settings, the hosted-link builder, and the file allowlist.
 * The listener itself is MissionHost.ts; the engine facts behind these rules
 * are listed there.
 */

export interface MissionHostSettings {
  /** Serve mission downloads. Off by default. */
  enabled: boolean;
  /** TCP port the download listener binds (all interfaces). */
  port: number;
  /**
   * The address players' clients use to reach the listener, as
   * "http://host[:port]" with no path. Required to enable.
   */
  publicBaseUrl: string | null;
}

export const DEFAULT_MISSION_HOST_SETTINGS: MissionHostSettings = {
  enabled: false,
  port: 3002,
  publicBaseUrl: null,
};

export interface PublicBaseUrlCheck {
  /** Normalized "http://host[:port]", or null when the input was refused. */
  url: string | null;
  errors: string[];
  warnings: string[];
}

/** Hosts players outside the local network cannot reach. */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".lan")) return true;
  if (h.includes(":")) return h === "::1" || /^f[cd]/.test(h) || h.startsWith("fe80:");
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/**
 * Check and normalize the public base URL. The engine's HTTP client speaks
 * plain http only and matches the scheme in lower case, so the result is
 * always "http://" + the lower-cased host, with the port only when it is not 80.
 */
export function checkPublicBaseUrl(raw: string): PublicBaseUrlCheck {
  const input = raw.trim();
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!input) {
    return { url: null, errors: ["Enter the public base URL players reach this machine at."], warnings };
  }
  if (!/^[\x21-\x7e]+$/.test(input)) {
    return { url: null, errors: ["The public base URL must be plain ASCII with no spaces."], warnings };
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { url: null, errors: ["Not a valid URL (example: http://example.org:3002)."], warnings };
  }
  if (parsed.protocol === "https:") {
    errors.push(
      "Descent 3 clients download over plain http only (the engine's HTTP client has no TLS). Use http://.",
    );
  } else if (parsed.protocol !== "http:") {
    errors.push("The public base URL must start with http://.");
  }
  if (!parsed.hostname) errors.push("The public base URL has no host.");
  if (parsed.username || parsed.password) errors.push("The public base URL cannot carry a user name or password.");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    errors.push("Give only the scheme, host and port (example: http://example.org:3002); Pyrodeck adds /missions/<file>.");
  }
  if (errors.length > 0) return { url: null, errors, warnings };

  if (isLocalHost(parsed.hostname)) {
    warnings.push(
      `${parsed.hostname} is a local address: players outside this network cannot reach it. Fine for a LAN game.`,
    );
  }
  return { url: `http://${parsed.host}`, errors, warnings };
}

export interface MissionHostSettingsCheck {
  settings: MissionHostSettings;
  errors: string[];
  warnings: string[];
}

/** Validate untrusted settings input. On errors, `settings` is not to be saved. */
export function validateMissionHostSettings(raw: unknown): MissionHostSettingsCheck {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const warnings: string[] = [];

  const enabled = r.enabled === true;
  let port = DEFAULT_MISSION_HOST_SETTINGS.port;
  if (r.port !== undefined) {
    const n = typeof r.port === "string" ? Number(r.port) : r.port;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535) {
      port = n;
    } else {
      errors.push("The port must be a whole number from 1 to 65535.");
    }
  }

  let publicBaseUrl: string | null = null;
  if (typeof r.publicBaseUrl === "string" && r.publicBaseUrl.trim()) {
    const check = checkPublicBaseUrl(r.publicBaseUrl);
    errors.push(...check.errors);
    warnings.push(...check.warnings);
    publicBaseUrl = check.url;
  } else if (enabled) {
    errors.push("Set the public base URL before turning the mission host on.");
  }

  return { settings: { enabled, port, publicBaseUrl }, errors, warnings };
}

/** Settings as stored in pyrodeck.json, made safe for use (bad values fall back to defaults, never enabled). */
export function sanitizeStoredMissionHost(raw: unknown): MissionHostSettings {
  const check = validateMissionHostSettings(raw);
  if (check.errors.length === 0) return check.settings;
  return { ...check.settings, enabled: false };
}

/**
 * The link the host serves `file` at: `<base>/missions/<file>`, the name
 * percent-encoded. Refused for retail missions, non-.mn3 names, and links too
 * long for the client (MISSION_URL_MAX).
 */
export function buildHostedMissionUrl(publicBaseUrl: string, file: string): { url: string } | { error: string } {
  const nameError = checkMissionFilename(file);
  if (nameError) return { error: nameError };
  const url = `${publicBaseUrl}/missions/${encodeURIComponent(file)}`;
  if (url.length > MISSION_URL_MAX) {
    return {
      error: `The hosted link would be ${url.length} characters (${url}); clients handle at most ${MISSION_URL_MAX}. A shorter host name or mission file name fixes it.`,
    };
  }
  const v = validateMissionUrl(url);
  if (!v.valid) return { error: v.errors.join(" ") };
  return { url };
}

/**
 * Whether the listener may serve `name` from a missions directory listing
 * `entries`: a plain basename ending in .mn3, not retail, listed exactly
 * (case included). Pure, so the allowlist is testable without a server.
 */
export function isServableMission(name: string, entries: readonly string[]): boolean {
  if (!name || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name !== path.basename(name)) return false;
  if (!/\.mn3$/i.test(name)) return false;
  if (RETAIL_MISSIONS.has(name.toLowerCase())) return false;
  return entries.includes(name);
}
