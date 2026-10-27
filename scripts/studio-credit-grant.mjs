// Round 9 ops script — grant ledger credits to a workspace (no payment path).
//
// The ledger (credit_ledger, D-12 integer µc) is the ONLY spendable balance:
// plan allowances are display-side entitlements, but chat's §8.8 gate reads
// SUM(amount). Fresh workspaces carry zero ledger credit until a Stripe
// trial/top-up lands — so ops grants are how this deployment (Stripe keys
// still placeholders) seeds usable balances:
//
//   * platform admin (codzxe@gmail.com): the studio allowance 10,000 credits
//     — the same number the billing page displays for the top tier.
//   * probe workspaces: the trial allowance 50 credits.
//
// Usage:
//   node scripts/studio-credit-grant.mjs --email codzxe@gmail.com --credits 10000
//   node scripts/studio-credit-grant.mjs --slug probe-r9-ws-<stamp> --credits 50
//
// Semantics follow packages/db/src/repos/ledger.ts + ledger-math.ts exactly:
// grant +N, balance_after = current SUM + N, inside the SAME per-workspace
// advisory lock the repo uses (pg_advisory_xact_lock(hashtext(workspace_id))).
// Idempotency key is unique per invocation (re-runs intentionally stack —
// the operator sees the before/after balances and decides).
//
// Credentials: DATABASE_URL (arg --url, env DATABASE_URL, or .local/vercel.env).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/home/z/my-project/packages/db/src/db.ts");
const postgres = require("postgres");

function databaseUrl() {
  const args = process.argv.slice(2);
  const urlArg = args.indexOf("--url");
  const candidates = [
    urlArg !== -1 ? args[urlArg + 1] : undefined,
    (() => {
      try {
        const env = readFileSync("/home/z/my-project/.local/vercel.env", "utf8");
        const match = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
        return match ? match[1] : undefined;
      } catch {
        return undefined;
      }
    })(),
    process.env.DATABASE_URL,
  ];
  const url = candidates.find(
    (value) => typeof value === "string" && /^postgres(ql)?:\/\//.test(value),
  );
  if (!url) {
    console.error(
      "No Postgres DATABASE_URL (--url, .local/vercel.env, or env — sqlite file URLs rejected).",
    );
    process.exit(1);
  }
  return url;
}

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : undefined;
}
const email = argValue("email");
const slug = argValue("slug");
const credits = Number(argValue("credits") ?? "0");
if (credits <= 0 || (!email && !slug)) {
  console.error("Usage: node scripts/studio-credit-grant.mjs (--email X | --slug X) --credits N");
  process.exit(1);
}
const MICRO = 1_000_000;
const amountUc = BigInt(Math.round(credits * MICRO));

const sql = postgres(databaseUrl(), { max: 1, connect_timeout: 10 });

let workspaces;
if (slug) {
  workspaces = await sql`select id, slug from organization where slug = ${slug}`;
} else {
  workspaces = await sql`
    select o.id, o.slug
    from organization o
    join member m on m.organization_id = o.id
    join "user" u on u.id = m.user_id
    where lower(u.email) = ${email.toLowerCase()}
    order by o.slug`;
}
if (workspaces.length === 0) {
  console.error("No matching workspace — sign up / create it first.");
  process.exit(1);
}

const key = `grant-ops-${Date.now()}`;
const metadata = { reason: "ops-grant", source: "round9-th-integration" };
for (const ws of workspaces) {
  const before = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${ws.id}))`;
    const [{ sum }] =
      await tx`select coalesce(sum(amount), 0) as sum from credit_ledger where workspace_id = ${ws.id}`;
    const balanceBefore = BigInt(sum);
    const balanceAfter = balanceBefore + amountUc;
    await tx`
      insert into credit_ledger (id, workspace_id, kind, amount, balance_after, idempotency_key, metadata)
      values (
        ${`led_${randomUUID().replaceAll("-", "")}`}, ${ws.id}, 'grant',
        ${amountUc.toString()}, ${balanceAfter.toString()},
        ${`${key}-${ws.id}`}, ${sql.json(metadata)}
      )`;
    return balanceBefore;
  });
  const fmt = (uc) => `${(Number(uc) / MICRO).toLocaleString()} credits (${uc} µc)`;
  console.log(
    `workspace  ${ws.slug}  balance ${fmt(before)} -> ${fmt(before + amountUc)} (+${credits} credits)`,
  );
}
await sql.end({ timeout: 3 }).catch(() => {});
