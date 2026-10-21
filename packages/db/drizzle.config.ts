import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` is offline-safe: it only reads the schema file and
// writes SQL under ./drizzle. `migrate`/`push` are never run in this sandbox.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
