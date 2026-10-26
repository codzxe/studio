// Round 5 — production usage snapshot (Supabase DB): sizes + row counts.
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
const url = `postgres://postgres.${SUPA_REF}:${SUPA_DB_PASS}@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`;
const sql = postgres(url, { max: 1, connect_timeout: 10 });

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const [size] = await sql`select pg_database_size(current_database()) as bytes,
  (select count(*)::int from pg_stat_activity) as connections`;
console.log(`db size: ${mb(size.bytes)} | pg_stat_activity connections: ${size.connections}`);

const tables = await sql`
  select relname as table, n_live_tup as rows, pg_total_relation_size(relid) as bytes
  from pg_stat_user_tables where schemaname = 'public' order by pg_total_relation_size(relid) desc limit 12`;
console.log("\ntop tables (rows, size):");
for (const t of tables) console.log(`  ${t.table.padEnd(24)} ${String(t.rows).padStart(8)}  ${mb(t.bytes)}`);

const legacy = await sql`
  select count(*)::int as legacy_tables from pg_stat_user_tables where schemaname = 'legacy'`;
console.log(`\nlegacy schema tables preserved: ${legacy[0].legacy_tables}`);

const [users] = await sql`select count(*)::int as n, count(*) filter (where role = 'admin')::int as admins from "user"`;
console.log(`users: ${users.n} (admins: ${users.admins})`);
const [orgs] = await sql`select count(*)::int as n from organization`;
console.log(`workspaces: ${orgs.n}`);
await sql.end({ timeout: 3 }).catch(() => {});
