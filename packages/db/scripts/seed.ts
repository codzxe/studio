/**
 * scripts/seed.ts — idempotent demo seed for local/staging Postgres.
 *
 * Owner: W1-G (docs/AGENTS.md). Spec anchors:
 *   §12.1  content/billing table shapes (as actually landed in src/schema/*)
 *   §14.1  trial = one-time 30-credit grant, no card required
 *   §14.2  ledger entries are append-only; unique(idempotency_key, kind)
 *   §12.2  ledger writes are transactional; balance_after derives from the sum
 *
 * Creates (skips anything that already exists — safe to re-run), one transaction:
 *   1. demo user "Demo User" <demo@studio.test>            (table "user")
 *   2. demo organization "Demo Studio" (slug demo-studio)  (table "organization")
 *   3. owner membership row                                 (table "member")
 *   4. +30 credit trial grant ledger entry                  (table "credit_ledger",
 *      kind "grant", idempotency_key seed:trial-grant:demo-studio)
 *   5. two synthetic assets (sha256 checksum placeholders, no bytes)  (table "assets")
 *   6. demo document "Demo Flyer" + its first version row  (tables "documents",
 *      "document_versions"; revision 1, current_revision advanced to 1)
 *
 * Run it from packages/db (Node >= 22.6; no tsx/drizzle-kit needed):
 *   node --env-file=../../.env --experimental-strip-types scripts/seed.ts
 *
 * Why no imports from ../src: Node type-stripping does not remap `.js` specifiers
 * to `.ts` files, so relative imports of src/ would not resolve. The script is
 * deliberately standalone (bare specifiers only); the canonical connection-string
 * validator lives in src/client.ts and this copy stays in sync with it.
 *
 * Column names below were verified against the landed schema files (auth.ts,
 * billing.ts, content.ts, runs.ts) rather than the abbreviated §12.1 table —
 * e.g. the ledger uses `kind`/`created_by` (not reason/user_id), assets use
 * `checksum`/`storage_key`/`origin`, and there is no projects table: documents
 * hang off the organization directly (content.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";

// --- demo constants (all synthetic; the .test TLD has no real mailbox) -------
const DEMO_USER_NAME = "Demo User";
const DEMO_USER_EMAIL = "demo@studio.test";
const DEMO_ORG_NAME = "Demo Studio";
const DEMO_ORG_SLUG = "demo-studio";
const DEMO_DOC_NAME = "Demo Flyer";
/** §14.1 — trial is a one-time 30-credit grant. */
const TRIAL_CREDITS = 30;
/** §14.2 — every ledger write carries an idempotency key; duplicates are rejected. */
const TRIAL_GRANT_KEY = "seed:trial-grant:demo-studio";
const ASSET_STORAGE_KEY = (index: number): string =>
  `seed/${DEMO_ORG_SLUG}/demo-asset-${index}.png`;
const VERSION_STORAGE_KEY = `seed/${DEMO_ORG_SLUG}/demo-flyer-r1.pcraft`;
const DEMO_DOC_WIDTH_PX = 1080;
const DEMO_DOC_HEIGHT_PX = 1080;

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
  .refine((value) => /^postgres(?:ql)?:\/\//i.test(value), {
    message: "DATABASE_URL must start with postgres:// or postgresql://",
  })
  .refine((value) => hostOf(value) !== undefined, {
    message: `DATABASE_URL must include a host, e.g. ${EXAMPLE_URL}`,
  });

/** Print the failure + hint and stop the process — CLI fail fast (§4). */
function abortWith(reason: string): never {
  // biome-ignore lint/suspicious/noConsole: CLI script — stderr is its product
  console.error(`seed: ${reason}`);
  // biome-ignore lint/suspicious/noConsole: CLI script — stderr is its product
  console.error(`seed: hint: export DATABASE_URL or run with --env-file (example: ${EXAMPLE_URL})`);
  process.exit(1);
}

function readUrlOrAbort(): string {
  const raw = process.env.DATABASE_URL;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed === "") {
    abortWith("DATABASE_URL is not set");
  }
  const parsed = urlSchema.safeParse(trimmed);
  if (parsed.success) {
    return parsed.data;
  }
  abortWith(parsed.error.issues[0]?.message ?? "DATABASE_URL is unusable");
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

      // 4. trial credit grant (§14.1) — append-only ledger (billing.ts), with
      //    balance_after derived from the ledger sum (§12.2), not hardcoded:
      //    prior entries + 30, so the row stays consistent even on a re-seed of
      //    an organization that already had ledger activity. Idempotent via
      //    unique(idempotency_key, kind) (§14.2 rule 6).
      const ledgerInsert = await tx<{ id: string }[]>`
        insert into "credit_ledger"
          ("organization_id", "delta", "kind", "idempotency_key", "balance_after",
           "created_by", "note")
        values (
          ${orgId},
          ${TRIAL_CREDITS},
          "grant",
          ${TRIAL_GRANT_KEY},
          ${TRIAL_CREDITS} + (
            select coalesce(sum("delta"), 0) from "credit_ledger"
            where "organization_id" = ${orgId}
          ),
          ${userId},
          "Demo trial grant (seed)"
        )
        on conflict ("idempotency_key", "kind") do nothing
        returning "id"
      `;
      steps.push({
        entity: `trial grant (+${TRIAL_CREDITS} credits, kind "grant")`,
        action: ledgerInsert.length > 0 ? "created" : "skipped (already present)",
      });

      // 5. two synthetic assets — sha256 checksum placeholders (§12.1 dedupe key;
      //    dedupe is enforced by the service layer, so pre-check reads here).
      for (const index of [1, 2]) {
        const checksum = createHash("sha256")
          .update(`studio-seed:${DEMO_ORG_SLUG}:demo-asset-${index}`)
          .digest("hex");
        const storageKey = ASSET_STORAGE_KEY(index);
        const assetExisting = await tx<{ id: string }[]>`
          select "id" from "assets"
          where "organization_id" = ${orgId} and "checksum" = ${checksum}
          limit 1
        `;
        if (assetExisting.length > 0) {
          steps.push({
            entity: `asset ${storageKey}`,
            action: "skipped (already present)",
          });
          continue;
        }
        await tx`
          insert into "assets"
            ("organization_id", "uploader_id", "kind", "storage_key", "checksum",
             "bytes", "width_px", "height_px", "mime", "origin")
          values (
            ${orgId},
            ${userId},
            "image",
            ${storageKey},
            ${checksum},
            0,
            1024,
            1024,
            "image/png",
            "generated"
          )
        `;
        steps.push({ entity: `asset ${storageKey}`, action: "created" });
      }

      // 6. demo document + first version (content.ts: documents hang off the
      //    organization directly — there is no projects table).
      const docExisting = await tx<{ id: string }[]>`
        select "id" from "documents"
        where "organization_id" = ${orgId} and "name" = ${DEMO_DOC_NAME}
        limit 1
      `;
      let docId = docExisting[0]?.id;
      const docExisted = docId !== undefined;
      if (docId === undefined) {
        const inserted = await tx<{ id: string }[]>`
          insert into "documents"
            ("organization_id", "name", "width_px", "height_px", "created_by")
          values (
            ${orgId},
            ${DEMO_DOC_NAME},
            ${DEMO_DOC_WIDTH_PX},
            ${DEMO_DOC_HEIGHT_PX},
            ${userId}
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
        // checkpoint_ref stays null: the seed version carries no engine
        // snapshot; replay would build purely from the command log (§5.6).
        const versionInsert = await tx<{ id: string }[]>`
          insert into "document_versions"
            ("document_id", "organization_id", "label", "revision", "storage_key", "created_by")
          values (${docId}, ${orgId}, "Seed checkpoint", 1, ${VERSION_STORAGE_KEY}, ${userId})
          returning "id"
        `;
        const versionId = versionInsert[0]?.id;
        if (versionId !== undefined) {
          // Advance the document's monotonic counter to its first version.
          // Forward-only: the guard never rewrites a counter past this seed.
          await tx`
            update "documents"
            set "current_revision" = 1, "updated_at" = now()
            where "id" = ${docId} and "current_revision" = 0
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
      // biome-ignore lint/suspicious/noConsole: CLI script — stderr is its product
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
