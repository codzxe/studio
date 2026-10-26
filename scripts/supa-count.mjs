// Row counts of pre-existing tables (decide drop vs keep).
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
for (const t of [
  "_prisma_migrations",
  "agent_run",
  "agent_step",
  "audit_log",
  "call_log",
  "document",
  "knowledge_chunk",
  "session",
]) {
  const n = await sql.unsafe(`select count(*)::int as n from public."${t}"`);
  console.log(`  ${t}: ${n[0].n} rows`);
}
await sql.end({ timeout: 3 }).catch(() => {});
