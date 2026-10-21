// apps/web — Vitest config (W8-T).
//
// jsdom because this suite renders React components (tier cards, the run
// timeline); the pre-existing colocated pure-logic tests under src/ keep
// passing in the same environment (node globals stay available under jsdom).
//
// JSX: apps/web's tsconfig pins Next's required `jsx: "preserve"`, which the
// raw esbuild pipeline would honor and leave .tsx untransformed — so the
// transform is owned by @vitejs/plugin-react (tsconfig-independent babel).
//
// The `@` alias mirrors tsconfig `paths` (e.g. use-run-events imports
// "@/lib/api"). Include keeps BOTH this tests/ suite and the colocated
// src/**/*.test.ts files on CI (no test silently disappears).
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});
