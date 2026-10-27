// Round 10 ops script — inspect the user's REAL agent runs end-to-end:
// runs (status/model/plan/applied) -> steps (tool calls, args, results) ->
// messages (what the assistant actually said). READ-ONLY.
//
// Usage: node scripts/round10-inspect-runs.mjs [--limit 20] [--run <runId>]
// Credentials: DATABASE_URL (env, or .local/vercel.env fallback).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/home/z/my-project/packages/db/src/db.ts");
const postgres = require("postgres");

function dbUrl() {
  // The sandbox shell may carry a leftover LOCAL DATABASE_URL (file:/...);
  // production inspection always wants the Supabase URL from vercel.env.
  const candidates = [process.env.DATABASE_URL];
  for (const line of readFileSync("/home/z/my-project/.local/vercel.env", "utf8").split("\n")) {
    const m = /^DATABASE_URL=(.*)$/.exec(line.trim());
    if (m) candidates.push(m[1].replace(/^["']|["']$/g, ""));
  }
  const url = candidates.find((c) => typeof c === "string" && c.startsWith("postgres"));
  if (url === undefined) throw new Error("no postgres DATABASE_URL found");
  return url;
}

const args = process.argv.slice(2);
const limitArg = Number.parseInt(args[args.indexOf("--limit") + 1] ?? "20", 10);
const runIdx = args.indexOf("--run");
const onlyRunId = runIdx === -1 ? null : (args[runIdx + 1] ?? null);

const sql = postgres(dbUrl(), { max: 1, prepare: false });

const clip = (v, n = 260) => {
  if (v === null || v === undefined) return "∅";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…(${s.length})` : s;
};

try {
  const runs = await sql`
    SELECT r.id, r.thread_id, r.project_id, r.model, r.status, r.error_code,
           r.plan_json IS NOT NULL AS has_plan, r.applied_at, r.undone_at,
           r.reserved_credits, r.committed_credits, r.result_version_id,
           r.base_version_id, r.created_at,
           p.name AS project_name, p.slug AS project_slug
    FROM agent_runs r
    JOIN projects p ON p.id = r.project_id
    ${onlyRunId ? sql`WHERE r.id = ${onlyRunId}` : sql``}
    ORDER BY r.created_at DESC
    LIMIT ${Number.isFinite(limitArg) ? limitArg : 20}
  `;

  console.log(`=== agent_runs (${runs.length} most recent) ===`);
  for (const r of runs) {
    console.log(
      [
        `\nrun ${r.id} [${r.created_at.toISOString()}]`,
        `  project: ${r.project_name} (${r.project_slug})`,
        `  model=${r.model} status=${r.status} error=${r.error_code ?? "none"}`,
        `  plan=${r.has_plan ? "YES" : "no"} applied=${r.applied_at?.toISOString() ?? "never"} undone=${r.undone_at?.toISOString() ?? "no"}`,
        `  credits reserved=${r.reserved_credits} committed=${r.committed_credits}`,
        `  versions: base=${r.base_version_id ?? "none"} result=${r.result_version_id ?? "none"}`,
      ].join("\n"),
    );

    const steps = await sql`
      SELECT seq, tool, status, duration_ms, args_json, result_json, command_batch_json
      FROM agent_steps WHERE run_id = ${r.id} ORDER BY seq ASC
    `;
    console.log(`  steps (${steps.length}):`);
    for (const s of steps) {
      console.log(
        `    #${s.seq} ${s.tool} [${s.status}] ${s.duration_ms ?? "?"}ms args=${clip(s.args_json)} result=${clip(s.result_json)} batch=${s.command_batch_json ? "YES" : "no"}`,
      );
    }

    const msgs = await sql`
      SELECT role, content_json, created_at FROM agent_messages
      WHERE run_id = ${r.id} ORDER BY created_at ASC
    `;
    console.log(`  messages (${msgs.length}):`);
    for (const m of msgs) {
      console.log(`    ${m.role}: ${clip(m.content_json, 400)}`);
    }
  }

  console.log("\n=== totals by status ===");
  const totals = await sql`
    SELECT status, count(*)::int AS n FROM agent_runs GROUP BY status ORDER BY n DESC
  `;
  for (const t of totals) console.log(`  ${t.status}: ${t.n}`);
} finally {
  await sql.end();
}
