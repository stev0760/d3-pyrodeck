/**
 * `netgames/hosts.deny` (and `hosts.allow`) as DMFC reads them:
 * ParseHostsFile, netgames/dmfc/dmfcbase.cpp:4688.
 *
 * - The file is read line by line (cf_ReadString, 255 characters kept; CR,
 *   LF and CR LF all end a line, cfile/cfile.cpp:640).
 * - Leading spaces and tabs are skipped. What remains must be only digits,
 *   dots and `*`, with exactly three dots and at most 15 characters, else the
 *   line is ignored (with a debug message only). Trailing spaces, comments
 *   and CIDR suffixes therefore make a line ignored.
 * - Each of the four parts is 1-3 characters. A one-character part may be a
 *   digit or `*`; a longer one must be all digits, 0-255 (so `1*` is invalid).
 * - `*` matches any value in that position; a number must match exactly
 *   (mask 0 or 255 per octet). Leading zeros are read as decimal (atoi).
 * - A connecting TCP/IP address is denied when it matches a hosts.deny line
 *   and no hosts.allow line (allow is checked first; IsAddressBanned,
 *   dmfcbase.cpp:3215). The lists are read at game start and by `$rehash`.
 */

export type Octets = [number | null, number | null, number | null, number | null];

export type HostsEntryCheck = { ok: true; octets: Octets } | { ok: false; error: string };

/** Parse one line the way ParseHostsFile does. Blank lines are "not an entry" (ok false, error ""). */
export function checkHostsLine(line: string): HostsEntryCheck {
  const text = line.slice(0, 255).replace(/^[ \t]+/, "");
  if (!text) return { ok: false, error: "" };
  if (/[^0-9.*]/.test(text)) {
    return { ok: false, error: "only digits, dots and * are allowed (no spaces, comments or /prefix)" };
  }
  const parts = text.split(".");
  if (parts.length !== 4) return { ok: false, error: "an address needs exactly four parts" };
  if (text.length > 15) return { ok: false, error: "longer than 15 characters" };
  const octets: (number | null)[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return { ok: false, error: "each part is 1 to 3 characters" };
    if (part === "*") {
      octets.push(null);
      continue;
    }
    if (!/^\d+$/.test(part)) return { ok: false, error: "* stands alone in its part (1* is not allowed)" };
    const value = parseInt(part, 10);
    if (value > 255) return { ok: false, error: "a part is greater than 255" };
    octets.push(value);
  }
  return { ok: true, octets: octets as Octets };
}

export function formatOctets(octets: Octets): string {
  return octets.map((o) => (o === null ? "*" : String(o))).join(".");
}

/** Whether an IPv4 address matches an entry. */
export function matchesEntry(octets: Octets, ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  return octets.every((o, i) => o === null || o === parts[i]);
}

export type EntryInput = { ok: true; entry: string; octets: Octets } | { ok: false; error: string };

/**
 * Turn what an operator typed into a line the engine reads: an address, a
 * wildcard pattern, or a /8, /16, /24 or /32 prefix (converted to `*` parts;
 * the engine matches whole octets only). Refuses `*.*.*.*`, which denies
 * everyone.
 */
export function normalizeEntryInput(input: string): EntryInput {
  let text = input.trim();
  const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(text);
  if (cidr) {
    const bits = Number(cidr[2]);
    if (![8, 16, 24, 32].includes(bits)) {
      return { ok: false, error: "the server matches whole parts only: use /8, /16, /24 or /32, or * parts" };
    }
    const keep = bits / 8;
    text = cidr[1]
      .split(".")
      .map((p, i) => (i < keep ? p : "*"))
      .join(".");
  }
  const check = checkHostsLine(text);
  if (!check.ok) return { ok: false, error: check.error || "enter an address" };
  if (check.octets.every((o) => o === null)) return { ok: false, error: "*.*.*.* would deny every player" };
  return { ok: true, entry: formatOctets(check.octets), octets: check.octets };
}

export interface HostsLine {
  /** Line number, from 1. */
  line: number;
  text: string;
  /** The entry as the engine reads it, or null when the engine ignores the line. */
  entry: string | null;
  /** Why the engine ignores a non-blank line. */
  error: string | null;
}

export function parseHostsFile(content: string): HostsLine[] {
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((text, i) => {
    const check = checkHostsLine(text);
    return {
      line: i + 1,
      text,
      entry: check.ok ? formatOctets(check.octets) : null,
      error: check.ok || !check.error ? null : check.error,
    };
  });
}

/** Lines back to file content: LF line ends and a final newline. */
export function serializeHostsFile(lines: Array<Pick<HostsLine, "text">>): string {
  return lines.length === 0 ? "" : `${lines.map((l) => l.text).join("\n")}\n`;
}

/** The file with `entry` appended, unless an equal entry is already in it. */
export function addHostsEntry(content: string, entry: string): { content: string; added: boolean } {
  const lines = parseHostsFile(content);
  if (lines.some((l) => l.entry === entry)) return { content: serializeHostsFile(lines), added: false };
  return { content: serializeHostsFile([...lines, { text: entry }]), added: true };
}

/** The file without the lines the engine reads as `entry`; other lines are kept as they are. */
export function removeHostsEntry(content: string, entry: string): { content: string; removed: number } {
  const lines = parseHostsFile(content);
  const kept = lines.filter((l) => l.entry !== entry);
  return { content: serializeHostsFile(kept), removed: lines.length - kept.length };
}
