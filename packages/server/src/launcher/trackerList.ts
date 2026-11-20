/**
 * The tracker list a dedicated server reads at startup: the file named with
 * -gspyfile, else gamespy.cfg, under the game directory (Matcen tree,
 * Descent3/gamespy.cpp gspy_Init, :109-227).
 *
 * gspy_Init reads at most MAX_GAMESPY_SERVERS (5) pairs of lines with
 * cf_ReadString (cfile/cfile.cpp:783): first a region line, then a tracker
 * line. A region line read with any characters sets the region to atoi() of
 * it, so the last one read wins and a line that is not a number gives 0. A
 * tracker line is `host` or `host:port` (port 27900 when left out), the host
 * a DNS name or an IPv4 address. An empty line (or the end of the file) leaves
 * the region alone and that tracker slot unused. Every line is a region or a
 * tracker: the file has no comments.
 *
 * So a hand-written file of one region line and then several tracker lines
 * loses every second tracker: the game reads it as a region.
 *
 * cf_ReadString in a text file ends a line at LF, CR or CR LF (cfgetc), keeps
 * the first LINE_KEEP characters of a line and drops the rest of it. The
 * game reads bytes; this module reads characters, which differ only for
 * non-ASCII text, never valid in a tracker line.
 */

/** Pairs the game reads (MAX_GAMESPY_SERVERS, Descent3/gamespy.cpp). */
export const MAX_TRACKERS = 5;
/** A tracker's port when the line gives none (GAMESPY_PORT, Descent3/gamespy.cpp). */
export const DEFAULT_TRACKER_PORT = 27900;
/** The list's file when -gspyfile is not given. */
export const DEFAULT_GAMESPY_FILE = "gamespy.cfg";
/** Region numbers run from 0 (the game's default) to 12. */
export const REGION_MAX = 12;
/** Longest host name accepted (the DNS limit). */
export const TRACKER_HOST_MAX = 253;
/**
 * Characters of a line the game keeps: gspy_Init passes a buffer of
 * MAX_HOSTNAMELEN - 1 = 299 bytes, and cf_ReadString keeps n - 1 bytes less
 * one more for the terminator, so 298.
 */
export const LINE_KEEP = 298;

export interface TrackerList {
  /** 0 to 12 when saved; what the game takes from a hand-written file may be any number. */
  region: number;
  /** `host` or `host:port`, in the order the game reads them. */
  trackers: string[];
}

export interface TrackerListRead extends TrackerList {
  /**
   * Non-empty lines the game does not use as a tracker that are not plain
   * numbers in a region position: a host where the game expects a region (a
   * one-region-then-hosts file), a line of spaces, and anything after the
   * fifth pair.
   */
  ignored: string[];
}

/** The lines as cf_ReadString returns them, each cut to what the game keeps. */
function gameLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).map((line) => {
    // A NUL ends the string the game then parses.
    const nul = line.indexOf("\0");
    const kept = nul === -1 ? line : line.slice(0, nul);
    return kept.slice(0, LINE_KEEP);
  });
}

/** C's atoi: leading white space, an optional sign, the digits up to the first other character; 0 when none. */
function atoi(s: string): number {
  const m = /^[ \t\v\f]*([+-]?\d+)/.exec(s);
  return m ? Number.parseInt(m[1], 10) : 0;
}

const PLAIN_NUMBER = /^[ \t\v\f]*[+-]?\d+[ \t\v\f]*$/;

/** What the game takes from a tracker list file: the region, the trackers, and the lines it does not use. */
export function parseTrackerList(text: string): TrackerListRead {
  const lines = gameLines(text);
  let region = 0;
  const trackers: string[] = [];
  const ignored: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // cf_ReadString returns the line's length; gspy_Init skips a line of length 0.
    if (line === "") continue;
    if (i >= MAX_TRACKERS * 2) {
      ignored.push(line);
    } else if (i % 2 === 0) {
      region = atoi(line);
      if (!PLAIN_NUMBER.test(line)) ignored.push(line);
    } else if (line.trim() === "") {
      // Read as a host the game cannot resolve: no heartbeat goes anywhere.
      ignored.push(line);
    } else {
      trackers.push(line);
    }
  }
  return { region, trackers, ignored };
}

/**
 * The file's text: one region line and one tracker line per tracker, LF line
 * ends, nothing else. With no trackers, the region line alone. Null (write
 * nothing) for region 0 and no trackers when there is no file yet: the game
 * reads that as no list at all.
 */
export function formatTrackerList(list: TrackerList, fileExists: boolean): string | null {
  if (list.trackers.length === 0) {
    return list.region === 0 && !fileExists ? null : `${list.region}\n`;
  }
  return list.trackers.map((tracker) => `${list.region}\n${tracker}\n`).join("");
}

const IPV4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** A tracker line's host and port, or why the game could not use it. */
export function parseTracker(text: string): { host: string; port: number } | { error: string } {
  if (text === "") return { error: "is empty" };
  if (/\s/.test(text)) return { error: "has a space in it" };
  const colon = text.indexOf(":");
  const host = colon === -1 ? text : text.slice(0, colon);
  const portText = colon === -1 ? null : text.slice(colon + 1);
  if (host === "") return { error: "has no host before the colon" };
  if (host.length > TRACKER_HOST_MAX) return { error: `has a host longer than ${TRACKER_HOST_MAX} characters` };
  let port = DEFAULT_TRACKER_PORT;
  if (portText !== null) {
    if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
      return { error: "needs a port from 1 to 65535 after the colon" };
    }
    port = Number(portText);
  }
  if (/^[\d.]+$/.test(host)) {
    // inet_addr reads it as an address: it must be a whole dotted IPv4 one.
    if (!IPV4_RE.test(host)) return { error: "is not a valid IPv4 address" };
    // inet_addr gives INADDR_NONE for it, and the game leaves that slot unused.
    if (host === "255.255.255.255") return { error: "is the broadcast address, which the game cannot use" };
    return { host, port };
  }
  const labels = host.split(".");
  if (!labels.every((label) => DNS_LABEL.test(label)) || /^\d+$/.test(labels[labels.length - 1])) {
    return { error: "is not a host name or an IPv4 address (letters, digits, - and . only)" };
  }
  return { host, port };
}

export interface TrackerListCheck {
  /** The list to save; null when `errors` is not empty. */
  list: TrackerList | null;
  errors: string[];
}

/**
 * Validate a tracker list from the panel: region a whole number from 0 to
 * 12; at most five trackers, each a host name or IPv4 address with an
 * optional port, no white space inside, none twice (host names compared
 * without case, with the port the game would use).
 */
export function validateTrackerList(raw: unknown): TrackerListCheck {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];

  const regionValue = typeof r.region === "string" && r.region.trim() !== "" ? Number(r.region.trim()) : r.region;
  const region =
    typeof regionValue === "number" && Number.isInteger(regionValue) && regionValue >= 0 && regionValue <= REGION_MAX
      ? regionValue
      : null;
  if (region === null) errors.push(`The region must be a whole number from 0 to ${REGION_MAX}.`);

  const trackers: string[] = [];
  if (!Array.isArray(r.trackers)) {
    errors.push(`trackers must be a list of at most ${MAX_TRACKERS} trackers.`);
  } else if (r.trackers.length > MAX_TRACKERS) {
    errors.push(`The game reads at most ${MAX_TRACKERS} trackers; this list has ${r.trackers.length}.`);
  } else {
    const seen = new Map<string, number>();
    r.trackers.forEach((value, i) => {
      const n = i + 1;
      if (typeof value !== "string") {
        errors.push(`Tracker ${n} must be text.`);
        return;
      }
      const text = value.trim();
      const parsed = parseTracker(text);
      if ("error" in parsed) {
        errors.push(`Tracker ${n} ${parsed.error}.`);
        return;
      }
      const key = `${parsed.host.toLowerCase()}:${parsed.port}`;
      const first = seen.get(key);
      if (first !== undefined) {
        errors.push(`Tracker ${n} repeats tracker ${first} (${key}).`);
        return;
      }
      seen.set(key, n);
      trackers.push(text);
    });
  }

  if (errors.length > 0 || region === null) return { list: null, errors };
  return { list: { region, trackers }, errors };
}
