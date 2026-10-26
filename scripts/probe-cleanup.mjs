// Round 9 ops script — list / delete probe-generated rows so production holds
// only real data. Targets ONLY the probe marker patterns created by
// scripts/th-live-probe.mjs (probe-r9-<stamp>@test.local + probe-r9-ws-<stamp>),
// the round-6 leftovers (probe-check-<stamp>@test.local + probe-ws-<stamp>),
// and the round-10 auto-apply probes (probe-r10[-ap]-<stamp>@test.local +
// probe-r10[-ap]-ws-<stamp> — scripts/round10-live-probe.mjs / -apply-probe.mjs).
//
// USAGE:
//   node scripts/probe-cleanup.mjs --list        # dry-run: show every marker row
//   node scripts/probe-cleanup.mjs --delete     # delete ALL marker rows
//
// Deletion mechanics (packages/db/src/schema.ts FK rules):
//   DELETE FROM organization → cascades member, projects → agent_threads →
//   agent_messages/agent_runs → agent_steps, credit_ledger, audit_log.
//   DELETE FROM user → cascades session/account/verification/user_settings.
//   agent_threads.created_by and projects.created_by RESTRICT — but those rows
//   die with the organization cascade first, so order is: orgs, then users.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/home/z/my-project/packages/db/src/db.ts");
const postgres = require("postgres");

function databaseUrl() {
  try {
    const env = readFileSync("/home/z/my-project/.local/vercel.env", "utf8");
    const match = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
    if (match) return match[1];
  } catch {
    /* fallthrough */
  }
  return process.env.DATABASE_URL;
}

const url = databaseUrl();
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  console.error("No Postgres DATABASE_URL (.local/vercel.env or env).");
  process.exit(1);
}

const PROBE_EMAIL = /^probe-(r9-(dbg-)?\d+|r10-(ap-)?\d+|check-\d+)@test\.local$/;
const PROBE_SLUG = /^probe-(r9-ws-|r10-(ap-)?ws-|ws-)\d+$/;

const args = process.argv.slice(2);
const list = args.includes("--list");
const del = args.includes("--delete");
if (list === del) {
  console.error("Pass exactly one of --list or --delete.");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", max: 1 });

// Marker rows. email like 'probe-%@test.local' also catches historical variants
// (probe-check-…); slug like 'probe-ws-%' / 'probe-r9-ws-%' catches the orgs.
const users = await sql`
  select id, email, created_at from "user"
  where email like 'probe-%@test.local'
  order by created_at`;
const orgs = await sql`
  select o.id, o.slug, u.email as owner_email
  from organization o
  left join member m on m.organization_id = o.id
  left join "user" u on u.id = m.user_id
  where o.slug like 'probe-ws-%' or o.slug like 'probe-r9-ws-%'
    or o.slug like 'probe-r10-ws-%' or o.slug like 'probe-r10-ap-ws-%'
  order by o.created_at`;

// Guard: every candidate must match the strict marker patterns (never touch
// anything the probes did not create).
const safeUsers = users.filter((u) => PROBE_EMAIL.test(u.email));
const safeOrgs = orgs.filter((o) => PROBE_SLUG.test(o.slug));

if (list) {
  console.log("== probe users ==");
  for (const u of safeUsers) console.log(`  ${u.email}  ${u.id}  ${u.created_at.toISOString()}`);
  console.log("== probe organizations ==");
  for (const o of safeOrgs) console.log(`  ${o.slug}  ${o.id}  owner=${o.owner_email ?? "(none)"}`);
  console.log(`\nusers=${safeUsers.length} orgs=${safeOrgs.length}`);
  console.log(
    users.length !== safeUsers.length || orgs.length !== safeOrgs.length
      ? "WARNING: some rows matched the loose like-pattern but NOT the strict marker regex — they are SKIPPED."
      : "No loose-only matches — all candidates are strict marker rows.",
  );
  await sql.end();
  process.exit(0);
}

const report = { orgs: 0, users: 0, threads: 0, messages: 0, runs: 0, steps: 0, ledger: 0 };

// 1) Orgs (and any marker org whose owning user is outside the marker set —
//    probes always create both, but be exhaustive on the org side).
for (const o of safeOrgs) {
  const [{ threads, messages, runs, steps, ledger }] = await sql`
    select
      (select count(*) from agent_threads t join projects p on p.id = t.project_id
        where p.workspace_id = ${o.id}) as threads,
      (select count(*) from agent_messages g join agent_threads t on t.id = g.thread_id
        join projects p on p.id = t.project_id where p.workspace_id = ${o.id}) as messages,
      (select count(*) from agent_runs r where r.project_id in
        (select id from projects where workspace_id = ${o.id})) as runs,
      (select count(*) from agent_steps s join agent_runs r on r.id = s.run_id
        where r.project_id in (select id from projects where workspace_id = ${o.id})) as steps,
      (select count(*) from credit_ledger where workspace_id = ${o.id}) as ledger`;
  await sql`delete from organization where id = ${o.id}`;
  report.orgs += 1;
  report.threads += Number(threads);
  report.messages += Number(messages);
  report.runs += Number(runs);
  report.steps += Number(steps);
  report.ledger += Number(ledger);
  console.log(
    `org ${o.slug}: cascaded -${threads} threads, -${messages} messages, -${runs} runs, -${steps} steps, -${ledger} ledger`,
  );
}

// 2) Users (auth rows cascade). member rows referencing deleted orgs are gone;
//    any member row still left (user in a NON-probe org) would block deletion —
//    but markers only ever join their own org, so delete by id is safe.
for (const u of safeUsers) {
  const rows = await sql`delete from "user" where id = ${u.id} returning id`;
  if (rows.length > 0) {
    report.users += 1;
    console.log(`user ${u.email}: deleted`);
  }
}

console.log(`\n== summary == ${JSON.stringify(report)}`);
await sql.end();
