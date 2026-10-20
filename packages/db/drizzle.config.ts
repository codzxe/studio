/**
 * drizzle-kit config for packages/db (task W1-G).
 *
 * Spec anchors:
 *   §4     forward-only, reviewable SQL migrations — no manual prod edits
 *   §12.2  every migration is tested against a restore of the latest prod backup
 *
 * Run from the package root: `pnpm db:generate` (create SQL) / `pnpm db:migrate`
 * (apply). Both need DATABASE_URL in the environment — drizzle-kit does not
 * load .env on its own; export it or use Node's --env-file when invoking.
 */
import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (typeof url !== "string" || url.trim() === "") {
  throw new Error(
    "DATABASE_URL is not set — drizzle-kit needs it to generate and apply migrations. " +
      "Export it (see .env.example: postgres://studio:changeme@localhost:5432/studio).",
  );
}

export default defineConfig({
  // The barrel re-exports src/schema/*.ts (auth, content, runs, billing, audit);
  // pointing at the barrel keeps every schema agent's tables in one migration stream.
  schema: "./src/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  // Only the public schema is managed; extensions land elsewhere.
  schemaFilter: ["public"],
  dbCredentials: { url: url.trim() },
  // push() guardrails: print every statement, ask before applying (§4 reviewable).
  strict: true,
  verbose: true,
});
