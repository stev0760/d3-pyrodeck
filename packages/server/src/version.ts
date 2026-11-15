// Must match packages/server/package.json — version.test.ts enforces this.
// Kept as a constant (not read from disk) so the SEA-packaged binary, where
// package.json isn't on disk next to the bundle, reports the right version.
export const VERSION = "0.5.7";

// Must match "repository" in the root package.json (version.test.ts enforces
// it), for the same reason. The update check asks this repository's GitHub
// releases for the latest version.
export const REPOSITORY_URL = "https://github.com/stev0760/d3-pyrodeck.git";
