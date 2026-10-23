import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
    // Serial files, always: the integration suite's global queue sweeps
    // (requeueStale / claimNext / retention) need a quiet renders table across
    // files, exactly like packages/db (same reason, same fix).
    fileParallelism: false,
  },
});
