/**
 * Parser for $servercaps response (Matcen contract, PYRODECK_CONTRACT §2).
 *
 * Fork servers respond with one line:
 *   SERVERCAPS version=1 fork=Matcen fork_version=0.9.16 features=bots,roster,ships,difficulty
 *
 * Vanilla servers respond with "Unknown command" or nothing.
 *
 * The line is read as space-separated key=value fields after the SERVERCAPS
 * tag, so a field the fork adds later is ignored rather than breaking the
 * match. `features=` is kept whole: every flag lands in the set, including
 * flags this build has no UI for. Gate UI on features, never on fork_version.
 */

export interface ServerCapabilities {
  version: number;
  fork: string;
  forkVersion: string;
  features: Set<string>;
}

/**
 * Feature flags the fork advertises, as of Matcen 0.9.17. Informational: the
 * parser keeps every flag it sees, known or not.
 *
 * - bots          the $ bot commands exist (Bots tab)
 * - roster        bots come from a config-file roster (BotConfig=)
 * - ships         $addbot takes a ship argument
 * - difficulty    $addbot takes a difficulty argument; $botdifficulty exists
 * - teams         $addbot takes a team argument (1-4)
 * - squad_orders  the in-game `!` chat orders exist
 * - population    $botpopulation exists and the server keeps seats free for humans (population card)
 */
export const KNOWN_FEATURES = [
  "bots",
  "roster",
  "ships",
  "difficulty",
  "teams",
  "squad_orders",
  "population",
] as const;

export const VANILLA_CAPS: ServerCapabilities = {
  version: 0,
  fork: "",
  forkVersion: "",
  features: new Set(),
};

/** Serialize capabilities for JSON (Set -> array). */
export function serializeCaps(caps: ServerCapabilities) {
  return {
    version: caps.version,
    fork: caps.fork,
    forkVersion: caps.forkVersion,
    features: [...caps.features],
  };
}

/** Parse one SERVERCAPS line into its key=value fields, or null if it isn't one. */
function parseCapsLine(line: string): ServerCapabilities | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== "SERVERCAPS") return null;

  const fields = new Map<string, string>();
  for (const token of tokens.slice(1)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    fields.set(token.slice(0, eq), token.slice(eq + 1));
  }

  const version = Number.parseInt(fields.get("version") ?? "", 10);
  const fork = fields.get("fork");
  const features = fields.get("features");
  if (!Number.isFinite(version) || !fork || features === undefined) return null;

  return {
    version,
    fork,
    forkVersion: fields.get("fork_version") ?? "",
    features: new Set(
      features
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean),
    ),
  };
}

export function parseServercaps(raw: string): ServerCapabilities | null {
  for (const line of raw.split("\n")) {
    const caps = parseCapsLine(line);
    if (caps) return caps;
  }
  // "Unknown command" or empty response = vanilla server
  return null;
}
