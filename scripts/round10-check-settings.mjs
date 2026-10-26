// Round 10 ops — one-shot DB reads: user_settings rows + schema default.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/home/z/my-project/packages/db/src/db.ts");
const postgres = require("postgres");

function dbUrl() {
  const candidates = [process.env.DATABASE_URL];
  for (const line of readFileSync("/home/z/my-project/.local/vercel.env", "utf8").split("\n")) {
    const m = /^DATABASE_URL=(.*)$/.exec(line.trim());
    if (m) candidates.push(m[1].replace(/^["']|["']$/g, ""));
  }
  const url = candidates.find((c) => typeof c === "string" && c.startsWith("postgres"));
  if (url === undefined) throw new Error("no postgres DATABASE_URL found");
  return url;
}

const sql = postgres(dbUrl(), { max: 1, prepare: false });
try {
  const rows = await sql`
    SELECT u.email, s.user_id, s.auto_apply_enabled, s.updated_at
    FROM "user" u LEFT JOIN user_settings s ON s.user_id = u.id
    ORDER BY u.created_at
  `;
  console.log("users + settings:");
  for (const r of rows) {
    console.log(
      `  ${r.email}: settings=${r.user_id ? "ROW" : "none"} auto_apply=${r.auto_apply_enabled ?? "(default)"}`,
    );
  }
  const def = await sql`
    SELECT column_default FROM information_schema.columns
    WHERE table_name='user_settings' AND column_name='auto_apply_enabled'
  `;
  console.log("column default:", def[0]?.column_default);
} finally {
  await sql.end();
}
