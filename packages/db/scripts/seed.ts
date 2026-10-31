import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { createAuth } from "../src/auth.js";
import { createDb, getDialect, isSqliteUrl } from "../src/db.js";
import { migrateDatabase } from "../src/migrate.js";
import { createRepos } from "../src/repos/index.js";
import { tablesFor } from "../src/tables.js";

/**
 * Idempotent demo seed — run with `pnpm --filter @studio/db seed`
 * (requires DATABASE_URL; applies migrations first).
 *
 * Creates:
 *  - demo user demo@studio.test (password documented below)
 *  - demo workspace (Better Auth organization) "Demo Workspace"
 *  - demo project with 3 versions of the empty .ecproj placeholder fixture
 *  - 1,000 granted credits = 1,000,000,000 µc (idempotency key
 *    seed:demo:grant:1000c — see GRANT_IDEMPOTENCY_KEY)
 *  - a thread with one greeting message
 *
 * Re-running is safe: every step checks for existing rows first, and the
 * credit grant is idempotency-keyed.
 *
 * Fixture note: DEMO_ECPROJ documents the placeholder .ecproj bytes for the
 * three versions. The seed does NOT upload those bytes to object storage —
 * object upload is the storage package's job in real deployments; here the
 * object keys + sha256 describe what the fixture content-addresses to (§9.2).
 */

const DEMO_EMAIL = "demo@studio.test";
/** Dev/demo credentials — never use in production; the seed is a dev fixture. */
const DEMO_PASSWORD = "demo-password-12345";

const ORG_ID = "org_demo";
const PROJECT_ID = "prj_demo";
const VERSION_IDS = ["ver_demo_1", "ver_demo_2", "ver_demo_3"] as const;
const THREAD_ID = "thr_demo";
const MESSAGE_ID = "msg_demo";
/** µc per credit (D-12: the ledger stores integer microcredits). */
const MICROCREDITS_PER_CREDIT = 1_000_000;
/** 1,000 demo credits, in µc — the mock chat run reserves ~2 credits per run. */
const DEMO_GRANT_CREDITS = 1_000;
const DEMO_GRANT_MICROCREDITS = DEMO_GRANT_CREDITS * MICROCREDITS_PER_CREDIT;
/**
 * Keyed "…:1000c" (credits, not raw µc): the pre-M6-E seed granted `amount:
 * 1000` when the ledger column was whole credits; M6-E widened the column to
 * µc and the seed's grant silently became 0.001 credits — every seeded chat
 * run then failed INSUFFICIENT_CREDITS. The new key re-grants correctly on
 * databases seeded by the old seed (grants are idempotency-keyed, replays
 * never re-add).
 */
const GRANT_IDEMPOTENCY_KEY = "seed:demo:grant:1000c";

/**
 * The demo .ecproj fixture bytes: the COMMITTED engine-generated project at
 * `apps/web/demo-project.ecproj` (the same bytes the e2e suite opens — a real
 * schema-2 EffectCraft project, sha256 aec54404…). The previous placeholder
 * (`{"format":"ecproj","version":1,"compositions":[]}`) was a fantasy shape
 * the pinned engine's parser rejects ("missing field `schema`") — the demo
 * project could never open, dead-ending the product at the front door.
 */
const DEMO_FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/web/demo-project.ecproj",
);
const DEMO_ECPROJ = await readFile(DEMO_FIXTURE_PATH);
const DEMO_ECPROJ_SHA256 = createHash("sha256").update(DEMO_ECPROJ).digest("hex");

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_URL: z.url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().min(8).default("studio-seed-dev-secret"),
});

function objectKeyFor(versionId: string): string {
  // §9.2 object storage layout
  return `workspaces/${ORG_ID}/projects/${PROJECT_ID}/versions/${versionId}/project.ecproj`;
}

/**
 * The local FS storage root the demo blobs are uploaded to, or null when the
 * seed must NOT touch the filesystem (S3/Postgres deployments upload through
 * the real storage APIs; Vercel bundles are read-only).
 *
 * Resolution mirrors the gateway's `defaultLocalFsRoot()` (services/gateway/
 * src/storage.ts): an explicit STORAGE_FS_ROOT pins an ABSOLUTE root shared by
 * every process — gateway, worker, seed — regardless of CWD; a SQLite dev
 * database (local-only dialect) falls back to the repo-local .local/storage,
 * anchored to the REPO root (three levels above this script) so the seed and
 * the gateway agree even when invoked from different CWDs.
 */
function localFsStorageRoot(databaseUrl: string): string | null {
  const pinned = process.env.STORAGE_FS_ROOT;
  if (pinned !== undefined && pinned.length > 0) return resolve(pinned);
  if (process.env.VERCEL === "1") return null;
  if (!isSqliteUrl(databaseUrl)) return null;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  return resolve(repoRoot, ".local/storage");
}

/**
 * Upload the demo version blobs to the local FS storage root (dev only).
 * The version ROWS describe content-addressed objects (§9.2); without the
 * bytes the editor's first download 404s — "The project could not open" —
 * and the whole demo dead-ends before chat. Idempotent: the same bytes are
 * rewritten to the same content-addressed keys on every seed run.
 */
async function seedLocalBlobs(root: string): Promise<number> {
  let written = 0;
  for (const versionId of VERSION_IDS) {
    const path = resolve(root, objectKeyFor(versionId));
    const contained = path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
    if (!contained) throw new Error(`seed blob path escapes storage root: ${path}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, DEMO_ECPROJ);
    written += 1;
  }
  return written;
}

async function main(): Promise<void> {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // biome-ignore lint/suspicious/noConsole: CLI seed script — reports invalid env to stderr before exit
    console.error(
      "Invalid seed environment:",
      parsed.error.issues.map((i) => `${String(i.path.join("."))}: ${i.message}`).join("; "),
    );
    process.exitCode = 1;
    return;
  }
  const env = parsed.data;

  const db = createDb(env.DATABASE_URL);
  const auth = createAuth({
    databaseUrl: env.DATABASE_URL,
    appUrl: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    db,
  });

  const t = tablesFor(db);

  try {
    // Postgres: apply the canonical forward-only migrations. SQLite dev
    // databases are THROWAWAY — their DDL source is the bootstrap twin
    // (sqlite-bootstrap.ts), already applied by createDb's sqlite branch;
    // running the pg migration folder against the twin would only collide.
    if (!isSqliteUrl(env.DATABASE_URL)) {
      await migrateDatabase(db);
    }

    // 1 — demo user (better-auth hashes the password properly)
    const existingUser = (
      await db.select().from(t.user).where(eq(t.user.email, DEMO_EMAIL)).limit(1)
    ).at(0);
    if (!existingUser) {
      await auth.api.signUpEmail({
        body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: "Demo User" },
      });
      // biome-ignore lint/suspicious/noConsole: CLI seed script — prints the created demo credentials (the script's whole point)
      console.info(`[seed] created user ${DEMO_EMAIL} (password: ${DEMO_PASSWORD})`);
    }
    const demoUser = (
      await db.select().from(t.user).where(eq(t.user.email, DEMO_EMAIL)).limit(1)
    ).at(0);
    if (!demoUser) throw new Error("demo user missing after sign-up");

    // 2 — demo workspace (organization) + owner membership
    await db
      .insert(t.organization)
      .values({ id: ORG_ID, name: "Demo Workspace", slug: "demo-workspace" })
      .onConflictDoNothing({ target: t.organization.id });
    const memberRows = await db.select().from(t.member).where(eq(t.member.organizationId, ORG_ID));
    const membership = memberRows.find((m) => m.userId === demoUser.id);
    if (!membership) {
      await db.insert(t.member).values({
        id: `member_demo_${demoUser.id.replaceAll("-", "").slice(0, 12)}`,
        organizationId: ORG_ID,
        userId: demoUser.id,
        role: "owner",
      });
      // biome-ignore lint/suspicious/noConsole: CLI seed script — reports the workspace owner grant
      console.info("[seed] demo user is owner of Demo Workspace");
    }

    // 3 — demo project + 3 placeholder versions (§9.3 immutable chain)
    await db
      .insert(t.projects)
      .values({
        id: PROJECT_ID,
        workspaceId: ORG_ID,
        name: "Demo Project",
        slug: "demo-project",
        description: "Seeded demo project with three versions of the empty .ecproj fixture.",
        createdBy: demoUser.id,
        currentVersionId: null,
      })
      .onConflictDoNothing({ target: t.projects.id });

    for (const [index, versionId] of VERSION_IDS.entries()) {
      await db
        .insert(t.projectVersions)
        .values({
          id: versionId,
          projectId: PROJECT_ID,
          version: index + 1,
          parentVersionId: index === 0 ? null : VERSION_IDS[index - 1],
          objectKey: objectKeyFor(versionId),
          sha256: DEMO_ECPROJ_SHA256,
          sizeBytes: DEMO_ECPROJ.length,
          label:
            index === 0
              ? "empty project"
              : index === 1
                ? "placeholder edit"
                : "another placeholder edit",
          createdBy: demoUser.id,
        })
        .onConflictDoNothing({ target: t.projectVersions.id });
    }
    const lastVersionId = VERSION_IDS[VERSION_IDS.length - 1];
    if (lastVersionId === undefined) throw new Error("unreachable: version ids fixed");
    await db
      .update(t.projects)
      .set({ currentVersionId: lastVersionId })
      .where(eq(t.projects.id, PROJECT_ID));

    // 3b — demo version blobs (local FS storage only; see the helper docs).
    // A WARNING, never fatal (the seed's contract: a failure must not break
    // the dev server) — but a missing blob is the "project could not open"
    // bug, so it is loudly reported.
    const storageRoot = localFsStorageRoot(env.DATABASE_URL);
    if (storageRoot !== null) {
      try {
        const blobs = await seedLocalBlobs(storageRoot);
        // biome-ignore lint/suspicious/noConsole: CLI seed script — reports the local blob upload
        console.info(`[seed] blobs: ${blobs} demo .ecproj objects under ${storageRoot}`);
      } catch (error) {
        // biome-ignore lint/suspicious/noConsole: CLI seed script — reports the blob upload failure
        console.warn(`[seed] WARNING: demo blob upload failed: ${String(error)}`);
      }
    }

    // 4 — 1,000 demo credits (idempotent grant via the ledger repo)
    const repos = createRepos(db);
    const grant = await repos.ledger.grant(ORG_ID, {
      amount: DEMO_GRANT_MICROCREDITS,
      idempotencyKey: GRANT_IDEMPOTENCY_KEY,
      metadata: { source: "seed" },
    });
    const balance = await repos.ledger.balance(ORG_ID);
    // biome-ignore lint/suspicious/noConsole: CLI seed script — reports the credit grant + resulting balance
    console.info(
      `[seed] credits: grant ${grant.replayed ? "(replayed)" : "created"}, balance=${balance}`,
    );

    // 5 — demo thread + greeting message
    await db
      .insert(t.agentThreads)
      .values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdBy: demoUser.id,
        title: "Getting started",
      })
      .onConflictDoNothing({ target: t.agentThreads.id });
    await db
      .insert(t.agentMessages)
      .values({
        id: MESSAGE_ID,
        threadId: THREAD_ID,
        role: "assistant",
        // v1 placeholder message shape: { text: string } — the chat layer owns
        // the real contentJson schema (AI SDK parts).
        contentJson: { text: "Welcome to Studio! Ask me to animate something." },
      })
      .onConflictDoNothing({ target: t.agentMessages.id });

    // biome-ignore lint/suspicious/noConsole: CLI seed script — prints the final summary line
    console.info(
      `[seed] done: workspace=${ORG_ID} project=${PROJECT_ID} currentVersion=${lastVersionId} thread=${THREAD_ID}`,
    );
  } finally {
    // Dialect-aware teardown: postgres.js pools end via .end(); a sqlite
    // handle is a better-sqlite3 client closed via .close().
    if (getDialect(db) === "sqlite") {
      (db.$client as unknown as { close: () => void }).close();
    } else {
      await db.$client.end({ timeout: 5 });
    }
  }
}

await main();
