/**
 * The bot roster file (bots.cfg, named by BotConfig= in dedicated.cfg).
 *
 * Key=Value lines, one per line, keys case-insensitive, comments (; or #) on
 * their own line. The keys the fork reads (bot.cpp BotLoadRosterFile):
 *
 *   BotCount=<n>            bots that join when the server starts, 0..16
 *   BotTargetPlayers=<n>    humans plus bots the population manager keeps in
 *                           the game; 0 (the default) leaves the manager off
 *   BotReservedSlots=<n>    seats always left free for humans; default 1, min 1
 *   BotDifficulty=<name>    the default difficulty
 *   BotName<n>=, BotShip<n>=, BotDifficulty<n>=, BotTeam<n>=   entry n, 1..16
 *
 * Entries above BotCount are the pool the population manager draws from, so
 * the roster can be longer than the number of bots that start. A save must
 * therefore never regenerate the file from a shorter model: `updateBotRoster`
 * edits the file in place and keeps every line it does not manage, comments
 * included. The Matcen sample roster round-trips byte for byte.
 */

export const MAX_ROSTER_BOTS = 16;

export interface BotEntry {
  name: string;
  ship?: string;       // pyro | phoenix | magnum | blackpyro
  difficulty?: string; // trainee | rookie | hotshot | ace | insane
  team?: number;       // 1-indexed (1–4), undefined = auto-balance
}

export interface BotRosterData {
  /** Bots that join when the server starts (BotCount), 0..16. May exceed the roster: the rest get built-in names. */
  botCount: number;
  /** BotDifficulty, the default for entries without their own. */
  defaultDifficulty?: string;
  /** BotTargetPlayers; 0 turns the population manager off. Undefined = not in the file. */
  targetPlayers?: number;
  /** BotReservedSlots; seats kept free for humans, at least 1. Undefined = not in the file. */
  reservedSlots?: number;
  /** Entries 1..N in file order. Those above botCount are the population manager's pool. */
  bots: BotEntry[];
}

const MANAGED_KEYS = ["botcount", "bottargetplayers", "botreservedslots", "botdifficulty"] as const;
type ManagedKey = (typeof MANAGED_KEYS)[number];
const MANAGED_CASING: Record<ManagedKey, string> = {
  botcount: "BotCount",
  bottargetplayers: "BotTargetPlayers",
  botreservedslots: "BotReservedSlots",
  botdifficulty: "BotDifficulty",
};

const ENTRY_RE = /^bot(name|ship|difficulty|team)(\d+)$/i;

interface CfgLine {
  raw: string;
  kind: "blank" | "comment" | "managed" | "entry" | "other";
  key?: string;      // as written, for kv lines
  lowerKey?: string;
  value?: string;
  entry?: { field: string; n: number };
}

function classify(raw: string): CfgLine {
  const trimmed = raw.trim();
  if (!trimmed) return { raw, kind: "blank" };
  if (trimmed.startsWith(";") || trimmed.startsWith("#")) return { raw, kind: "comment" };
  const eq = trimmed.indexOf("=");
  if (eq === -1) return { raw, kind: "other" };
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  const lowerKey = key.toLowerCase();
  const m = key.match(ENTRY_RE);
  if (m) {
    return { raw, kind: "entry", key, lowerKey, value, entry: { field: m[1].toLowerCase(), n: parseInt(m[2], 10) } };
  }
  if ((MANAGED_KEYS as readonly string[]).includes(lowerKey)) {
    return { raw, kind: "managed", key, lowerKey, value };
  }
  return { raw, kind: "other", key, lowerKey, value };
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampCount(n: number): number {
  return Math.max(0, Math.min(MAX_ROSTER_BOTS, Math.trunc(n)));
}

/**
 * Parse a bot roster file into structured data. Every numbered entry with a
 * name is kept, whatever BotCount says; a later duplicate of a key wins, as in
 * the engine.
 */
export function parseBotRoster(content: string): BotRosterData {
  const lines = content.split("\n").map(classify);
  const scalars = new Map<string, string>();
  const entries = new Map<number, Partial<Record<string, string>>>();

  for (const line of lines) {
    if (line.kind === "managed") {
      scalars.set(line.lowerKey!, line.value!);
    } else if (line.kind === "entry") {
      const { field, n } = line.entry!;
      if (n < 1 || n > MAX_ROSTER_BOTS) continue;
      const e = entries.get(n) ?? {};
      e[field] = line.value;
      entries.set(n, e);
    }
  }

  const bots: BotEntry[] = [];
  for (const n of [...entries.keys()].sort((a, b) => a - b)) {
    const e = entries.get(n)!;
    if (!e.name) continue;
    const team = e.team !== undefined ? parseInt(e.team, 10) : undefined;
    bots.push({
      name: e.name,
      ship: e.ship || undefined,
      difficulty: e.difficulty || undefined,
      team: team !== undefined && team >= 1 && team <= 4 ? team : undefined,
    });
  }

  const target = scalars.get("bottargetplayers");
  const reserve = scalars.get("botreservedslots");
  return {
    botCount: clampCount(parseIntOr(scalars.get("botcount"), 0)),
    defaultDifficulty: scalars.get("botdifficulty") || undefined,
    ...(target !== undefined ? { targetPlayers: Math.max(0, parseIntOr(target, 0)) } : {}),
    ...(reserve !== undefined ? { reservedSlots: Math.max(1, parseIntOr(reserve, 1)) } : {}),
    bots,
  };
}

/** Clamp a roster to what the file format can hold. */
export function normalizeBotRoster(data: BotRosterData): BotRosterData {
  const bots = (data.bots ?? [])
    .map((b) => ({
      name: String(b.name ?? "").trim(),
      ship: b.ship ? String(b.ship).trim() : undefined,
      difficulty: b.difficulty ? String(b.difficulty).trim() : undefined,
      team: typeof b.team === "number" && b.team >= 1 && b.team <= 4 ? Math.trunc(b.team) : undefined,
    }))
    .filter((b) => b.name.length > 0)
    .slice(0, MAX_ROSTER_BOTS);
  const out: BotRosterData = {
    botCount: clampCount(Number(data.botCount ?? bots.length)),
    bots,
  };
  if (data.defaultDifficulty !== undefined) out.defaultDifficulty = String(data.defaultDifficulty).trim();
  if (data.targetPlayers !== undefined) out.targetPlayers = Math.max(0, Math.trunc(Number(data.targetPlayers) || 0));
  if (data.reservedSlots !== undefined) out.reservedSlots = Math.max(1, Math.trunc(Number(data.reservedSlots) || 1));
  return out;
}

function entryLines(bots: BotEntry[]): string[] {
  const lines: string[] = [];
  bots.forEach((bot, i) => {
    const n = i + 1;
    lines.push(`BotName${n}=${bot.name}`);
    if (bot.ship) lines.push(`BotShip${n}=${bot.ship}`);
    if (bot.difficulty) lines.push(`BotDifficulty${n}=${bot.difficulty}`);
    if (bot.team !== undefined && bot.team >= 1 && bot.team <= 4) lines.push(`BotTeam${n}=${bot.team}`);
  });
  return lines;
}

/** Managed scalar lines in the order a new file lists them. */
function scalarValue(data: BotRosterData, key: ManagedKey): string | undefined {
  switch (key) {
    case "botcount": return String(data.botCount);
    case "bottargetplayers": return data.targetPlayers === undefined ? undefined : String(data.targetPlayers);
    case "botreservedslots": return data.reservedSlots === undefined ? undefined : String(data.reservedSlots);
    case "botdifficulty": return data.defaultDifficulty === undefined || data.defaultDifficulty === "" ? undefined : data.defaultDifficulty;
  }
}

/**
 * Generate a roster file from nothing. For an existing file use
 * `updateBotRoster`, which keeps what it does not manage.
 */
export function generateBotRoster(input: BotRosterData): string {
  const data = normalizeBotRoster(input);
  const lines: string[] = [];
  for (const key of MANAGED_KEYS) {
    const v = scalarValue(data, key);
    if (v !== undefined) lines.push(`${MANAGED_CASING[key]}=${v}`);
  }
  lines.push(...entryLines(data.bots));
  return lines.join("\n") + "\n";
}

/**
 * Write structured data into an existing roster file, in place:
 * - the managed scalars are replaced where they stand (the file's key casing
 *   kept, later duplicates dropped) or inserted after BotCount when missing;
 *   a scalar that is undefined in `data` leaves the file's line alone
 * - the entry block (first to last Bot<Field><n> line) is regenerated from
 *   `data.bots`, with the comments that sat inside it kept at its head
 * - every other line (comments, blank lines, unknown keys) stays where it is
 * - CRLF files stay CRLF
 */
export function updateBotRoster(existing: string, input: BotRosterData): string {
  const data = normalizeBotRoster(input);
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const body = existing.replace(/\r\n/g, "\n");
  const hadTrailingNewline = body.endsWith("\n") || body.length === 0;
  const lines = body.split("\n");
  if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const classified = lines.map(classify);

  // Entry region: first to last entry line.
  let first = -1;
  let last = -1;
  classified.forEach((l, i) => {
    if (l.kind === "entry") {
      if (first === -1) first = i;
      last = i;
    }
  });

  const out: string[] = [];
  const seenScalar = new Set<ManagedKey>();
  let botCountIndex = -1;

  const emitScalar = (line: CfgLine): void => {
    const key = line.lowerKey as ManagedKey;
    if (seenScalar.has(key)) return; // drop a later duplicate
    seenScalar.add(key);
    const v = scalarValue(data, key);
    out.push(v === undefined ? line.raw : `${line.key}=${v}`);
    if (key === "botcount") botCountIndex = out.length - 1;
  };

  const emitEntries = (): void => {
    if (first === -1) return;
    const innerComments = classified
      .slice(first, last + 1)
      .filter((l) => l.kind === "comment" || l.kind === "blank")
      .map((l) => l.raw);
    out.push(...innerComments, ...entryLines(data.bots));
  };

  for (let i = 0; i < classified.length; i++) {
    const line = classified[i];
    if (first !== -1 && i >= first && i <= last) {
      if (i === first) emitEntries();
      if (line.kind === "managed") emitScalar(line); // a scalar inside the block keeps working
      continue;
    }
    if (line.kind === "managed") emitScalar(line);
    else out.push(line.raw);
  }

  // Scalars the file lacked: after BotCount, in canonical order; BotCount
  // itself goes to the top when missing.
  const missing = MANAGED_KEYS.filter((k) => !seenScalar.has(k) && scalarValue(data, k) !== undefined);
  if (missing.length > 0) {
    const insert = missing.map((k) => `${MANAGED_CASING[k]}=${scalarValue(data, k)}`);
    if (!seenScalar.has("botcount")) {
      out.unshift(...insert);
    } else {
      out.splice(botCountIndex + 1, 0, ...insert);
    }
  }

  // No entry block yet: the entries go at the end.
  if (first === -1) out.push(...entryLines(data.bots));

  return out.join(eol) + eol;
}
