// List existing public-schema tables + drizzle migration journal preview.
import { readFileSync, readdirSync } from "node:fs";
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

const tables = await sql`select table_name, column_name, data_type
  from information_schema.columns
  where table_schema = 'public'
  order by table_name, ordinal_position`;
const byTable = new Map();
for (const r of tables) {
  if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
  byTable.get(r.table_name).push(`${r.column_name}:${r.data_type}`);
}
console.log("=== EXISTING public tables ===");
for (const [t, cols] of byTable)
  console.log(`  ${t} (${cols.length} cols): ${cols.join(", ").slice(0, 180)}`);

console.log("\n=== drizzle migrations folder ===");
const dir = "/home/z/my-project/packages/db/drizzle";
try {
  const files = readdirSync(dir);
  for (const f of files) console.log("  ", f);
  const journal = readFileSync(`${dir}/meta/_journal.json`, "utf8");
  console.log(
    "journal entries:",
    JSON.parse(journal)
      .entries.map((e) => e.tag)
      .join(" → "),
  );
} catch (e) {
  console.log("  (none)", String(e.message).slice(0, 80));
}
await sql.end({ timeout: 3 }).catch(() => {});
