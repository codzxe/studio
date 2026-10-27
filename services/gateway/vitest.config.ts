import { defineConfig } from "vitest/config";

export default defineConfig({
  // Sandbox/CI repair (round-13, w3-b03): the repo-root postcss.config.mjs
  // (added by round-12 cd24d1d) uses the array-of-strings plugin form, which
  // vite 5's eager postcss-load-config walk-up rejects ("Invalid PostCSS
  // Plugin found at: plugins[0]") — killing every vitest boot in this package
  // BEFORE any test runs. An inline (empty) postcss config skips the file
  // search entirely; gateway tests import no CSS, so this is behavior-neutral.
  css: { postcss: { plugins: [] } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
  },
});
