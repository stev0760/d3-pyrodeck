import { defineConfig } from "vitest/config";

// The client's tests cover its pure modules (line buffer, hash routes, the
// command table); the UI itself is checked with screenshots (scripts/ui-shots.mjs).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
