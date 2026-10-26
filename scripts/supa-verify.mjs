// Verify Studio tables after migration.
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
const tables = await sql`select table_name from information_schema.tables where table_schema='public' order by table_name`;
console.log(`public tables (${tables.length}):`, tables.map((t) => t.table_name).join(", "));
const mig = await sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at`;
console.log(`drizzle journal entries: ${mig.length}`);
const user = await sql`select count(*)::int as n from "user"`;
console.log(`"user" rows: ${user[0].n}`);
const org = await sql`select count(*)::int as n from "organization"`;
console.log(`"organization" rows: ${org[0].n}`);
await sql.end({ timeout: 3 }).catch(() => {});
