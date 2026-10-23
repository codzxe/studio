import { createHash } from "node:crypto";
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
 *  - 1,000 granted credits (idempotency key seed:demo:grant:1000)
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
const GRANT_IDEMPOTENCY_KEY = "seed:demo:grant:1000";

/** Placeholder empty .ecproj fixture bytes (documented; see module docs). */
const DEMO_ECPROJ = Buffer.from(
  JSON.stringify({ format: "ecproj", version: 1, compositions: [] }),
  "utf8",
);
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

async function main(): Promise<void> {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
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

    // 4 — 1,000 demo credits (idempotent grant via the ledger repo)
    const repos = createRepos(db);
    const grant = await repos.ledger.grant(ORG_ID, {
      amount: 1000,
      idempotencyKey: GRANT_IDEMPOTENCY_KEY,
      metadata: { source: "seed" },
    });
    const balance = await repos.ledger.balance(ORG_ID);
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
