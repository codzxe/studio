import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    // JSX transform is driven by the package tsconfig (`jsx: react-jsx`), which the
    // Vite/esbuild pipeline picks up automatically.
  },
});
