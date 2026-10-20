import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    // .tsx suites rely on the automatic JSX runtime (matches tsconfig `jsx: react-jsx`)
    esbuild: { jsx: "automatic" },
  },
});
