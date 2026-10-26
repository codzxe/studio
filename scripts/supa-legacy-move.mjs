// Move the previous experiment's tables + enums into a `legacy` schema,
// leaving `public` empty for the Studio drizzle migrations.
// Metadata-only (ALTER ... SET SCHEMA), zero data loss, reversible.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/home/z/my-project/packages/db/src/db.ts");
const postgres = require("postgres");
const { SUPA_REF, SUPA_DB_PASS } = Object.fromEntries(
  readFileSync("/home/z/my-project/.local/supabase.env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)].map((s) => s.trim())),
);
const sql = postgres(
  `postgres://postgres.${SUPA_REF}:${SUPA_DB_PASS}@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`,
  { max: 1, connect_timeout: 10 },
);

await sql.unsafe(`create schema if not exists "legacy"`);

const tables = await sql`
  select c.relname as name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'`;
const enums = await sql`
  select t.typname as name
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typtype = 'e'`;

console.log("moving tables:", tables.map((t) => t.name).join(", "));
console.log("moving enums:  ", enums.map((t) => t.name).join(", ") || "(none)");

for (const t of tables) {
  await sql.unsafe(`alter table public."${t.name}" set schema "legacy"`);
}
for (const e of enums) {
  await sql.unsafe(`alter type public."${e.name}" set schema "legacy"`);
}

const after = await sql`
  select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','e')`;
console.log("\npublic after move:", after.length === 0 ? "(EMPTY — ready for Studio)" : after.map((t) => t.name).join(", "));

const legacyCount = await sql`
  select count(*)::int as n from pg_tables where schemaname = 'legacy'`;
console.log(`legacy schema now holds ${legacyCount[0].n} tables (data preserved)`);
await sql.end({ timeout: 3 }).catch(() => {});
