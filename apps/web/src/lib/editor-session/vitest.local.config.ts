// Local runner for editor-session tests (src/lib/editor-session/**).
// apps/web/vitest.config.ts only includes tests/** — until its `include` is
// widened (see worklog M3-B), run this suite explicitly:
//   cd apps/web && pnpm exec vitest run --config src/lib/editor-session/vitest.local.config.ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/lib/editor-session/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
