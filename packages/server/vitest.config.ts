import { defineConfig } from "vitest/config";

// Run the TypeScript sources only. `tsc` also emits compiled copies of every
// test into dist/, which would otherwise run a second, possibly stale time.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
