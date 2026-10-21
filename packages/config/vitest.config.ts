import { defineConfig } from "vitest/config";

// Node-first package (env parsing, fs writes for .env.example). Plain node pool;
// no DOM needed. ESM ("type":"module") works with the default vitest resolution —
// tests import sources with explicit .js specifiers (NodeNext convention).
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["default"],
    passWithNoTests: false,
  },
});
