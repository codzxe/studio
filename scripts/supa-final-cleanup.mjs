// Direct inspection + cleanup of any remaining test users.
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
const rows = await sql`select id, email, name from "user"`;
console.log("current users:", JSON.stringify(rows));
const del = await sql`delete from "user" where email like '%@test.local' or email like '%test.local%'`;
console.log("users deleted:", del.count);
const left = await sql`select id, email from "user"`;
console.log("remaining users:", JSON.stringify(left));
await sql.end({ timeout: 3 }).catch(() => {});
