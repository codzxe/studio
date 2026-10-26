// Remove smoke-test probe rows (smoke-*.test.local) from Supabase.
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
const n = await sql`delete from "session" where "user_id" in (select id from "user" where email like 'smoke-%@test.local' or email like 'bundle-%@test.local' or email like 'route-%@test.local' or email = 'live-final@test.local' or email like '%@test.local')`;
console.log("sessions deleted:", n.count);
const n2 = await sql`delete from "account" where "user_id" in (select id from "user" where email like 'smoke-%@test.local' or email like 'bundle-%@test.local' or email like 'route-%@test.local' or email = 'live-final@test.local' or email like '%@test.local')`;
console.log("accounts deleted:", n2.count);
const n3 = await sql`delete from "user" where email like 'smoke-%@test.local' or email like 'bundle-%@test.local' or email like 'route-%@test.local' or email = 'live-final@test.local'`;
console.log("users deleted:", n3.count);
const left = await sql`select count(*)::int as n from "user"`;
console.log("remaining users:", left[0].n);
await sql.end({ timeout: 3 }).catch(() => {});
