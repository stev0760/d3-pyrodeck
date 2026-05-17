/**
 * Parser for $servercaps response.
 *
 * Fork servers respond with:
 *   SERVERCAPS version=1 fork=Matcen fork_version=0.8.16 features=bots,roster,ships,difficulty
 *
 * Vanilla servers respond with "Unknown command" or nothing.
 */

export interface ServerCapabilities {
  version: number;
  fork: string;
  forkVersion: string;
  features: Set<string>;
}

export const VANILLA_CAPS: ServerCapabilities = {
  version: 0,
  fork: "",
  forkVersion: "",
  features: new Set(),
};

export function parseServercaps(raw: string): ServerCapabilities | null {
  // Look for the SERVERCAPS line in the response
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(
      /^SERVERCAPS version=(\d+) fork=(\S+) fork_version=(\S+) features=(.+)$/,
    );
    if (match) {
      return {
        version: parseInt(match[1], 10),
        fork: match[2],
        forkVersion: match[3],
        features: new Set(match[4].split(",")),
      };
    }
  }

  // "Unknown command" or empty response = vanilla server
  return null;
}
