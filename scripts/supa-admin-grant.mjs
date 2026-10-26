// Round 5 ops script — promote an account to platform admin + grant the TOP
// pricing tier (plan=studio, status=active) to every workspace that account
// belongs to.
//
// Usage:  node scripts/supa-admin-grant.mjs [email]   (default codzxe@gmail.com)
//
// Idempotent: safe to re-run any time (role update + ON CONFLICT upsert).
// The gateway ALSO enforces the top tier for role='admin' users at every plan
// seam (services/gateway/src/plan.ts) — this DB grant is the belt-and-braces
// half so the billing page/state shows a real active studio row.
//
// Credentials: .local/supabase.env (SUPA_REF + SUPA_DB_PASS; session pooler,
// same posture as scripts/supa-inspect.mjs). Never committed.
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

const email = (process.argv[2] ?? "codzxe@gmail.com").toLowerCase();
const FAR_FUTURE = new Date("2099-12-31T23:59:59.000Z");

// 1. Staff role (better-auth user.role — 'admin' gates the top tier in the
//    gateway's plan seam; see services/gateway/src/plan.ts isAdminRole).
const [user] = await sql`
  update "user"
  set role = 'admin', updated_at = now()
  where lower(email) = ${email}
  returning id, email, role`;
if (user === undefined) {
  console.error(`No user found with email ${email} — sign up first, then re-run.`);
  process.exit(1);
}
console.log(`user  ${user.email}  role -> ${user.role}`);

// 2. Top-tier subscription row for every workspace the admin belongs to.
const orgs = await sql`
  select o.id, o.slug, m.role as member_role
  from organization o
  join member m on m.organization_id = o.id
  join "user" u on u.id = m.user_id
  where u.id = ${user.id}
  order by o.slug`;

for (const org of orgs) {
  await sql`
    insert into subscriptions
      (id, organization_id, plan_id, status, stripe_subscription_id,
       current_period_end, trial_end, cancel_at_period_end, grace_end, updated_at)
    values
      (${"sub_admin_".concat(org.id)}, ${org.id}, 'studio', 'active', 'admin-grant',
       ${FAR_FUTURE}, null, false, null, now())
    on conflict (organization_id) do update set
      plan_id = 'studio',
      status = 'active',
      stripe_subscription_id = excluded.stripe_subscription_id,
      current_period_end = excluded.current_period_end,
      trial_end = null,
      cancel_at_period_end = false,
      grace_end = null,
      updated_at = now()`;
  console.log(`workspace  ${org.slug}  (${org.member_role})  -> plan=studio status=active`);
}

if (orgs.length === 0) {
  console.log(
    "No workspaces yet — the gateway's role-based override covers any workspace this admin creates later; re-run after creating one to also persist the subscription row.",
  );
}
await sql.end({ timeout: 3 }).catch(() => {});
