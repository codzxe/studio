// Supabase connectivity probe — tests which Postgres entry points are
// reachable from THIS network and print server_version + current tables.
// Usage: node scripts/supa-probe.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Resolve `postgres` from @studio/db's node_modules (pnpm workspace isolation)
const require = createRequire("/home/z/my-project/packages/db/src/db.ts");
const postgres = require("postgres");

const { SUPA_REF, SUPA_DB_PASS } = Object.fromEntries(
  readFileSync("/home/z/my-project/.local/supabase.env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)].map((s) => s.trim())),
);

const candidates = [
  {
    name: "session-pooler-5432",
    url: `postgres://postgres.${SUPA_REF}:${SUPA_DB_PASS}@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`,
  },
  {
    name: "direct-5432",
    url: `postgres://postgres:${SUPA_DB_PASS}@db.${SUPA_REF}.supabase.co:5432/postgres`,
  },
  {
    name: "transaction-pooler-6543",
    url: `postgres://postgres:${SUPA_DB_PASS}@db.${SUPA_REF}.supabase.co:6543/postgres`,
  },
  {
    name: "shared-tx-pooler-6543",
    url: `postgres://postgres.${SUPA_REF}:${SUPA_DB_PASS}@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres`,
  },
];

for (const c of candidates) {
  const sql = postgres(c.url, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    prepare: true,
  });
  try {
    const info = await sql`select version(), current_user, count(*)::int as n_tables
      from information_schema.tables where table_schema = 'public'`;
    console.log(`[OK]   ${c.name} → ${info[0].version.split(" ").slice(0, 2).join(" ")} | user=${info[0].current_user} | public tables=${info[0].n_tables}`);
  } catch (error) {
    console.log(`[FAIL] ${c.name} → ${String(error.message).slice(0, 140)}`);
  } finally {
    await sql.end({ timeout: 3 }).catch(() => {});
  }
}
