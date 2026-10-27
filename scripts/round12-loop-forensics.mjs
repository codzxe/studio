// Round 12 ops script — loop forensics: recent runs, non-terminal runs, step
// repeat counts, per-run tool sequences. READ-ONLY.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/home/z/my-project/packages/db/src/db.ts");
const postgres = require("postgres");

function dbUrl() {
  const candidates = [];
  for (const line of readFileSync("/home/z/my-project/.local/vercel.env", "utf8").split("\n")) {
    const m = /^DATABASE_URL=(.*)$/.exec(line.trim());
    if (m) candidates.push(m[1].replace(/^["']|["']$/g, ""));
  }
  const url = candidates.find((c) => c && c.startsWith("postgres"));
  if (!url) { console.error("no DATABASE_URL"); process.exit(1); }
  return url;
}

const sql = postgres(dbUrl(), { max: 1 });

const runs = await sql`
  select r.id, r.status, r.outcome_code, r.model, r.created_at, r.completed_at, r.credits_committed
  from agent_runs r
  order by r.created_at desc
  limit 15
`;
console.log("=== LAST 15 RUNS ===");
for (const r of runs) {
  const steps = await sql`select count(*)::int as n, step_index, tool_id, status from agent_steps where run_id = ${r.id} group by step_index, tool_id, status order by step_index`;
  const seq = steps.map((s) => `${s.step_index}:${s.tool_id}/${s.status}`).join(" ");
  console.log(`${r.id.slice(0,8)} | ${r.status} | ${r.outcome_code ?? ""} | ${r.model} | ${r.created_at.toISOString()} | credits:${r.credits_committed}`);
  console.log(`   steps(${steps.reduce((a,s)=>a+s.n,0)}): ${seq}`);
}

const stuck = await sql`
  select id, status, outcome_code, created_at
  from agent_runs
  where status not in ('completed','failed','cancelled')
  order by created_at desc
  limit 10
`;
console.log("\n=== NON-TERMINAL RUNS ===", stuck.length);
for (const r of stuck) console.log(r.id.slice(0,8), r.status, r.outcome_code ?? "", r.created_at.toISOString());

const repeat = await sql`
  select run_id, tool_id, count(*)::int as n
  from agent_steps
  where created_at > now() - interval '3 days'
  group by run_id, tool_id
  order by n desc
  limit 12
`;
console.log("\n=== TOOL REPEAT COUNTS (3d) ===");
for (const l of repeat) console.log(l.run_id.slice(0,8), l.tool_id, "x"+l.n);

const threads = await sql`
  select t.id, t.title, t.created_at, t.updated_at,
    (select count(*)::int from agent_messages m where m.thread_id = t.id) as msgs,
    (select count(*)::int from agent_runs r where r.thread_id = t.id) as runs
  from agent_threads t
  order by t.updated_at desc
  limit 10
`;
console.log("\n=== RECENT THREADS ===");
for (const t of threads) console.log(t.id.slice(0,8), `msgs:${t.msgs} runs:${t.runs}`, `"${t.title}"`, t.updated_at.toISOString());

await sql.end();
