// Must match packages/server/package.json — version.test.ts enforces this.
// Kept as a constant (not read from disk) so the SEA-packaged binary, where
// package.json isn't on disk next to the bundle, reports the right version.
export const VERSION = "0.4.13";
