import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    // Synthetic keyboard events + iframe handshake: keep everything on one worker.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
