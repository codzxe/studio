/**
 * scripts/seed.ts — idempotent demo seed for local/staging Postgres.
 *
 * Owner: W1-G (docs/AGENTS.md). Spec anchors:
 *   §12.1  table shapes seeded below (abbreviated columns)
 *   §14.1  trial = one-time 30-credit grant, no card required
 *   §14.2  ledger entries are append-only and idempotent by idempotency_key
 *   §12.2  ledger + cached balance change in one transaction (here: one seed tx)
 *
 * Creates (skips anything that already exists — safe to re-run):
 *   1. demo user "Demo User" <demo@studio.test>            (table "user")
 *   2. demo organization "Demo Studio" (slug demo-studio)  (table "organization")
 *   3. owner membership row                                 (table "member")
 *   4. +30 credit trial grant ledger entry                  (table "credit_ledger")
 *   5. demo project "Demo Project"                          (table "projects")
 *   6. two synthetic assets (sha256 placeholders, no bytes)
 *   7. demo document "Demo Flyer" + its first version row
 *
 * Run it from packages/db (Node >= 22.6; no tsx/drizzle-kit needed):
 *   node --env-file=../../.env --experimental-strip-types scripts/seed.ts
 *
 * Why no imports from ../src: Node type-stripping does not remap `.js` specifiers
 * to `.ts` files, so relative imports of src/ would not resolve. The script is
 * deliberately standalone (bare specifiers only); the canonical connection-string
 * validator lives in src/client.ts and this copy stays in sync with it.
 *
 * Table/column names follow spec §12.1 with the repo's org-is-workspace
 * mapping — src/schema/auth.ts names the tenant root `organization`, and
 * src/schema/runs.ts uses `organization_id` as the tenant column. The
 * content/billing schema files (other build agents) are expected to follow the
 * same §12.1 names; if one drifts, adjust the SQL below and the worklog note.
 */
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";

// --- demo constants (all synthetic; the .test TLD has no real mailbox) -------
const DEMO_USER_NAME = "Demo User";
const DEMO_USER_EMAIL = "demo@studio.test";
const DEMO_ORG_NAME = "Demo Studio";
const DEMO_ORG_SLUG = "demo-studio";
const DEMO_PROJECT_NAME = "Demo Project";
const DEMO_DOC_NAME = "Demo Flyer";
/** §14.1 — trial is a one-time 30-credit grant. */
const TRIAL_CREDITS = 30;
/** §14.2 — every ledger write carries an idempotency key; duplicates are rejected. */
const TRIAL_GRANT_KEY = "seed:trial-grant:demo-studio";
const ASSET_S3_KEY = (index: number): string => `seed/${DEMO_ORG_SLUG}/demo-asset-${index}.png`;
const DOC_PCRAFT_KEY = `seed/${DEMO_ORG_SLUG}/demo-flyer.pcraft`;
const VERSION_CHECKPOINT_KEY = `seed/${DEMO_ORG_SLUG}/demo-flyer-r1.pcraft`;
const VERSION_THUMBNAIL_KEY = `seed/${DEMO_ORG_SLUG}/demo-flyer-r1.png`;

// --- env (minimal local zod check; mirrors src/client.ts) --------------------
const EXAMPLE_URL = "postgres://studio:changeme@localhost:5432/studio";

/** Host token after optional userinfo — same rules as src/client.ts hostOf(). */
function hostOf(value: string): string | undefined {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd === -1) {
    return undefined;
  }
  const authority = (value.slice(schemeEnd + 3).split(/[/?#]/, 1)[0] ?? "").trim();
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  return /^[a-z0-9._-]+(:\d+)?$/i.test(host) || host.startsWith("[") ? host : undefined;
}

const urlSchema = z
  .string()
  .trim()
  .min(1, "DATABASE_URL is not set")
  .refine((value) => /^postgres(?:ql)?:\/\//i.test(value), {
    message: "DATABASE_URL must start with postgres:// or postgresql://",
  })
  .refine((value) => hostOf(value) !== undefined, {
    message: `DATABASE_URL must include a host, e.g. ${EXAMPLE_URL}`,
  });

function readUrlOrAbort(): string {
  const parsed = urlSchema.safeParse(process.env.DATABASE_URL);
  if (parsed.success) {
    return parsed.data;
  }
  // biome-ignore lint/suspicious/noConsole: CLI script — stderr is its product
  console.error(`seed: ${parsed.error.issues[0]?.message ?? "DATABASE_URL is unusable"}`);
  console.error(`seed: hint: export DATABASE_URL or run with --env-file (example: ${EXAMPLE_URL})`);
  process.exit(1);
}

// --- seed --------------------------------------------------------------------
type Step = { entity: string; action: string };
const steps: Step[] = [];

async function main(): Promise<void> {
  // A seed is a short sequential job: one connection, no pool competition.
  const sql = postgres(readUrlOrAbort(), { max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    await sql.begin(async (tx) => {
      // 1. demo user — src/schema/auth.ts pins table "user" with unique email.
      const userInsert = await tx<{ id: string }[]>`
        insert into "user" ("id", "name", "email", "email_verified")
        values (${randomUUID()}, ${DEMO_USER_NAME}, ${DEMO_USER_EMAIL}, true)
        on conflict ("email") do nothing
        returning "id"
      `;
      let userId = userInsert[0]?.id;
      if (userId === undefined) {
        const existing = await tx<{ id: string }[]>`
          select "id" from "user" where "email" = ${DEMO_USER_EMAIL} limit 1
        `;
        userId = existing[0]?.id;
      }
      if (userId === undefined) {
        throw new Error(`user ${DEMO_USER_EMAIL} conflicted but was not found`);
      }
      steps.push({
        entity: `user ${DEMO_USER_EMAIL}`,
        action: userInsert.length > 0 ? "created" : "skipped (already present)",
      });

      // 2. demo organization — §12.1 tenant root; auth.ts pins unique slug.
      //    metadata carries plan/trial fields until billing tables own them.
      const orgInsert = await tx<{ id: string }[]>`
        insert into "organization" ("id", "name", "slug", "metadata")
        values (
          ${randomUUID()},
          ${DEMO_ORG_NAME},
          ${DEMO_ORG_SLUG},
          ${JSON.stringify({ plan: "trial", trialCreditsGranted: true, seed: true })}
        )
        on conflict ("slug") do nothing
        returning "id"
      `;
      let orgId = orgInsert[0]?.id;
      if (orgId === undefined) {
        const existing = await tx<{ id: string }[]>`
          select "id" from "organization" where "slug" = ${DEMO_ORG_SLUG} limit 1
        `;
        orgId = existing[0]?.id;
      }
      if (orgId === undefined) {
        throw new Error(`organization ${DEMO_ORG_SLUG} conflicted but was not found`);
      }
      steps.push({
        entity: `organization ${DEMO_ORG_NAME} (${DEMO_ORG_SLUG})`,
        action: orgInsert.length > 0 ? "created" : "skipped (already present)",
      });

      // 3. owner membership — unique(organization_id, user_id) per auth.ts.
      const memberInsert = await tx<{ id: string }[]>`
        insert into "member" ("id", "organization_id", "user_id", "role")
        values (${randomUUID()}, ${orgId}, ${userId}, "owner")
        on conflict ("organization_id", "user_id") do nothing
        returning "id"
      `;
      steps.push({
        entity: "owner membership",
        action: memberInsert.length > 0 ? "created" : "skipped (already present)",
      });

      // 4. trial credit grant (§14.1) — append-only ledger, idempotent by key.
      const ledgerInsert = await tx<{ id: string }[]>`
        insert into "credit_ledger"
          ("organization_id", "user_id", "delta", "reason", "idempotency_key", "balance_after")
        values (${orgId}, ${userId}, ${TRIAL_CREDITS}, "grant", ${TRIAL_GRANT_KEY}, ${TRIAL_CREDITS})
        on conflict ("idempotency_key") do nothing
        returning "id"
      `;
      steps.push({
        entity: `trial grant (+${TRIAL_CREDITS} credits, reason "grant")`,
        action: ledgerInsert.length > 0 ? "created" : "skipped (already present)",
      });

      // 5. demo project — no unique key pinned in §12.1, so pre-check by name.
      const projectExisting = await tx<{ id: string }[]>`
        select "id" from "projects"
        where "organization_id" = ${orgId} and "name" = ${DEMO_PROJECT_NAME}
        limit 1
      `;
      let projectId = projectExisting[0]?.id;
      const projectExisted = projectId !== undefined;
      if (projectId === undefined) {
        const inserted = await tx<{ id: string }[]>`
          insert into "projects" ("organization_id", "name")
          values (${orgId}, ${DEMO_PROJECT_NAME})
          returning "id"
        `;
        projectId = inserted[0]?.id;
      }
      if (projectId === undefined) {
        throw new Error("demo project insert returned no id");
      }
      steps.push({
        entity: `project ${DEMO_PROJECT_NAME}`,
        action: projectExisted ? "skipped (already present)" : "created",
      });

      // 6. two synthetic assets — sha256 placeholders (§12.1 dedupe key).
      for (const index of [1, 2]) {
        const sha256 = createHash("sha256")
          .update(`studio-seed:${DEMO_ORG_SLUG}:demo-asset-${index}`)
          .digest("hex");
        const filename = `demo-asset-${index}.png`;
        const assetExisting = await tx<{ id: string }[]>`
          select "id" from "assets"
          where "organization_id" = ${orgId} and "sha256" = ${sha256}
          limit 1
        `;
        if (assetExisting.length > 0) {
          steps.push({ entity: `asset ${filename}`, action: "skipped (already present)" });
          continue;
        }
        await tx`
          insert into "assets"
            ("organization_id", "kind", "filename", "mime", "bytes", "width", "height", "sha256", "s3_key", "meta")
          values (
            ${orgId},
            "generated",
            ${filename},
            "image/png",
            0,
            1024,
            1024,
            ${sha256},
            ${ASSET_S3_KEY(index)},
            ${JSON.stringify({ seed: true, synthetic: true })}
          )
        `;
        steps.push({ entity: `asset ${filename}`, action: "created" });
      }

      // 7. demo document + first version (§12.1 documents/document_versions).
      const docExisting = await tx<{ id: string }[]>`
        select "id" from "documents"
        where "project_id" = ${projectId} and "name" = ${DEMO_DOC_NAME}
        limit 1
      `;
      let docId = docExisting[0]?.id;
      const docExisted = docId !== undefined;
      if (docId === undefined) {
        const inserted = await tx<{ id: string }[]>`
          insert into "documents"
            ("organization_id", "project_id", "name", "canvas", "size_bytes", "pcraft_key")
          values (
            ${orgId},
            ${projectId},
            ${DEMO_DOC_NAME},
            ${JSON.stringify({ seed: true })},
            0,
            ${DOC_PCRAFT_KEY}
          )
          returning "id"
        `;
        docId = inserted[0]?.id;
      }
      if (docId === undefined) {
        throw new Error("demo document insert returned no id");
      }
      steps.push({
        entity: `document ${DEMO_DOC_NAME}`,
        action: docExisted ? "skipped (already present)" : "created",
      });

      const versionExisting = await tx<{ id: string }[]>`
        select "id" from "document_versions"
        where "document_id" = ${docId} and "revision" = 1
        limit 1
      `;
      const versionExisted = versionExisting.length > 0;
      if (!versionExisted) {
        const versionInsert = await tx<{ id: string }[]>`
          insert into "document_versions"
            ("document_id", "label", "created_by", "command_log", "checkpoint_key", "thumbnail_key", "revision")
          values (
            ${docId},
            "Seed checkpoint",
            ${userId},
            ${JSON.stringify([])},
            ${VERSION_CHECKPOINT_KEY},
            ${VERSION_THUMBNAIL_KEY},
            1
          )
          returning "id"
        `;
        const versionId = versionInsert[0]?.id;
        if (versionId !== undefined) {
          // Point the current-document row at its first version. Forward-only:
          // the guard never rewrites a pointer a later version has already set.
          await tx`
            update "documents"
            set "latest_version_id" = ${versionId}, "updated_at" = now()
            where "id" = ${docId} and "latest_version_id" is null
          `;
        }
      }
      steps.push({
        entity: `document version r1 of ${DEMO_DOC_NAME}`,
        action: versionExisted ? "skipped (already present)" : "created",
      });
    });

    for (const step of steps) {
      // biome-ignore lint/suspicious/noConsole: CLI script — stdout is its product
      console.info(`seed: ${step.entity} — ${step.action}`);
    }
    // biome-ignore lint/suspicious/noConsole: CLI script — stdout is its product
    console.info("seed: done");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // biome-ignore lint/suspicious/noConsole: CLI script — stderr is its product
    console.error(`seed: aborted — ${message}`);
    if (/does not exist/i.test(message)) {
      console.error(
        "seed: hint: a table from the expected schema is missing — apply migrations first" +
          " (pnpm db:migrate in packages/db; see packages/db/migrations/README.md)",
      );
    }
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
