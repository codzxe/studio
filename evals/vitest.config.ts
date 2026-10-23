// evals — standalone vitest project (BUILD_PLAN §7.2 harness).
//
// NOT part of the pnpm workspace (pnpm-workspace.yaml globs apps/*, services/*,
// packages/* — evals/ is excluded on purpose), so `turbo run test` and root
// `pnpm test` never pick these up. Run from this directory:
//
//   corepack pnpm exec vitest run        # hermetic schema-integrity suite
//   EVALS_LIVE=1 corepack pnpm exec vitest run   # live scoring (requires LiteLLM)
//
// The vitest binary itself resolves from the repo root's node_modules/.bin —
// evals/ declares no dependencies of its own.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: __dirname,
    include: ["harness/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
