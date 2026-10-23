import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuth } from "../../src/auth.js";
import { createDb, getDialect } from "../../src/db.js";
import { type Repos, createRepos } from "../../src/repos/index.js";
import { tablesFor } from "../../src/tables.js";

/**
 * SQLite dev-server suite (W3-A) — the PG-FREE twin of
 * tests/integration/repos.test.ts: better-sqlite3 is an installed devDependency,
 * so these run everywhere (no Postgres, no DATABASE_URL gating).
 *
 * What this pins (the whole W1-02/W1-03/W3-A sqlite seam, end to end):
 *  - `createDb("file:…")` dialect switch + bootstrap twin DDL
 *  - better-auth on the sqlite branch (twin tables, transaction:false)
 *  - async-callback transactions: BEGIN/COMMIT/ROLLBACK + SAVEPOINT nesting
 *    (makeSqliteTransactionAsyncAware — better-sqlite3 rejects promise
 *    callbacks natively; every repo writes `db.transaction(async …)`)
 *  - repo dialect forks: advisory-lock skip (ledger), FOR UPDATE drop
 *    (lockProject/claimNext), now() → unixepoch ms (share-tokens
 *    activeFilter), count(*)::int drop, greatest → max
 *  - dialect-aware table resolution (tablesFor) — integer-ms timestamps and
 *    0/1 booleans round-trip as Date/boolean, never ISO strings
 */
describe("sqlite dev server (repos + auth + transactions)", { timeout: 30_000 }, () => {
  let db: ReturnType<typeof createDb>;
  let repos: Repos;
  let workspaceId: string;
  let userId: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "studio-sqlite-dev-"));
    db = createDb(`file:${join(tmpDir, "dev-server.test.db")}`);
    expect(getDialect(db)).toBe("sqlite");

    const auth = createAuth({
      databaseUrl: "file:", // unused — the handle below wins (AuthEnv.db)
      appUrl: "http://localhost:3000",
      secret: "sqlite-dev-server-test-secret-0123456789",
      db,
    });
    await auth.api.signUpEmail({
      body: {
        email: "sqlite-dev@studio.test",
        password: "sqlite-dev-password-12345",
        name: "Sqlite Dev",
      },
    });

    const t = tablesFor(db);
    const [user] = await db
      .select()
      .from(t.user)
      .where(eq(t.user.email, "sqlite-dev@studio.test"))
      .limit(1);
    if (!user) throw new Error("signUpEmail did not create the user on sqlite");
    userId = user.id;

    workspaceId = `ws_sqlite_${randomUUID().slice(0, 8)}`;
    await db
      .insert(t.organization)
      .values({ id: workspaceId, name: "Sqlite Dev Workspace", slug: workspaceId })
      .onConflictDoNothing();

    repos = createRepos(db);
  });

  afterAll(() => {
    (db.$client as unknown as { close: () => void }).close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips Date and boolean columns through the twin schema (tablesFor)", async () => {
    const t = tablesFor(db);
    const project = await repos.projects.create(workspaceId, {
      name: "Roundtrip",
      createdBy: userId,
    });
    const [row] = await db.select().from(t.projects).where(eq(t.projects.id, project.id)).limit(1);
    if (!row) throw new Error("select did not return the created project");
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(Number.isNaN(row.createdAt.getTime())).toBe(false);
    expect(row.archived).toBe(false); // 0/1 → boolean, never a bare number
  });

  it("ledger: grant → reserve → settle with correct balances (advisory-lock fork)", async () => {
    const grant = await repos.ledger.grant(workspaceId, {
      amount: 100,
      idempotencyKey: `sqlite:${workspaceId}:grant`,
    });
    expect(grant.entry.balanceAfter).toBe(100);
    expect(await repos.ledger.balance(workspaceId)).toBe(100);

    const project = await repos.projects.create(workspaceId, {
      name: "Ledgered",
      createdBy: userId,
    });
    const version = await repos.versions.upload(workspaceId, {
      projectId: project.id,
      expectedVersionId: null,
      objectKey: `workspaces/${workspaceId}/projects/${project.id}/versions/v1/project.ecproj`,
      sha256: "ab",
      sizeBytes: 8,
      createdBy: userId,
    });
    const render = await repos.renders.create(workspaceId, {
      projectId: project.id,
      versionId: version.version.id,
      compId: "comp_main",
      format: "mp4",
      createdBy: userId,
    });

    const reserve = await repos.ledger.reserve(workspaceId, {
      renderId: render.id,
      amount: 24,
      idempotencyKey: `sqlite:${workspaceId}:reserve`,
    });
    expect(reserve.entry.balanceAfter).toBe(76);

    const settle = await repos.ledger.settle(workspaceId, {
      renderId: render.id,
      actualCost: 18,
      idempotencyKey: `sqlite:${workspaceId}:settle`,
    });
    expect(settle.commit?.amount).toBe(-18);
    expect(settle.refund?.amount).toBe(24);
    expect(await repos.ledger.balance(workspaceId)).toBe(82);

    // claim + complete this render NOW so the claimNext test below starts
    // from an empty queue (claimNext is FIFO over ALL queued rows).
    const drained = await repos.renders.claimNext("worker-ledger-drain");
    const claimedRender = drained[0];
    expect(claimedRender).toBeDefined();
    if (!claimedRender) throw new Error("claimNext returned no render");
    await repos.renders.markCompleted(workspaceId, claimedRender.id, {
      objectKey: "workspaces/x/renders/ledger/output.mp4",
    });
  });

  it("renders: claimNext claims once, then empties (SKIP LOCKED fork)", async () => {
    const project = await repos.projects.create(workspaceId, {
      name: "Rendered",
      createdBy: userId,
    });
    const version = await repos.versions.upload(workspaceId, {
      projectId: project.id,
      expectedVersionId: null,
      objectKey: `workspaces/${workspaceId}/projects/${project.id}/versions/v1/project.ecproj`,
      sha256: "cd",
      sizeBytes: 8,
      createdBy: userId,
    });
    const render = await repos.renders.create(workspaceId, {
      projectId: project.id,
      versionId: version.version.id,
      compId: "comp_main",
      format: "mp4",
      createdBy: userId,
    });

    const first = await repos.renders.claimNext("worker-sqlite-test");
    expect(first.length).toBe(1);
    expect(first[0]?.id).toBe(render.id);
    expect(first[0]?.workspaceId).toBe(workspaceId);
    expect(first[0]?.status).toBe("running");

    // claimed once → the queue is empty for the next worker
    const second = await repos.renders.claimNext("worker-sqlite-test-2");
    expect(second.length).toBe(0);

    const done = await repos.renders.markCompleted(workspaceId, render.id, {
      objectKey: "workspaces/x/renders/r/output.mp4",
    });
    expect(done.status).toBe("completed");
  });

  it("share-tokens: issue/list/revoke with the now() → unixepoch-ms activeFilter fork", async () => {
    const project = await repos.projects.create(workspaceId, {
      name: "Shared",
      createdBy: userId,
    });
    const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
    const live = await repos.shareTokens.issue(workspaceId, {
      projectId: project.id,
      createdBy: userId,
      tokenHash: hashOf("live-token"),
      expiresInDays: 1,
    });
    await repos.shareTokens.issue(workspaceId, {
      projectId: project.id,
      createdBy: userId,
      tokenHash: hashOf("revoked-token"),
    });

    let listed = await repos.shareTokens.list(workspaceId, project.id);
    expect(listed.length).toBe(2);

    // revoked tokens drop out of the active list
    await repos.shareTokens.revoke(workspaceId, {
      id: live.id,
      byUserId: userId,
    });
    listed = await repos.shareTokens.list(workspaceId, project.id);
    expect(listed.length).toBe(1);

    // EXPIRY arm of the dialect fork: push the surviving token's expires_at
    // into the past directly (issue() enforces ≥ 1 day) — the unixepoch-ms
    // comparison in activeFilter must then filter it out on sqlite.
    const t = tablesFor(db);
    await db
      .update(t.shareTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(t.shareTokens.tokenHash, hashOf("revoked-token")));
    listed = await repos.shareTokens.list(workspaceId, project.id);
    expect(listed.length).toBe(0);
  });

  it("pg-flavored db.execute(sql) works on the sqlite handle (health-probe seam)", async () => {
    // The gateway's dbHealth writes `db.execute(sql`select 1`)` — a pg-dialect
    // API. The sqlite seam aliases it to drizzle-sqlite's .run() so the
    // signature-preserving handle answers every pg call (W3-A).
    const result = await db.execute(sql`select 1 as one`);
    expect(result).toBeDefined();
  });

  it("transaction rollback: an insert that throws leaves no row", async () => {
    const t = tablesFor(db);
    const ghostId = `prj_ghost_${randomUUID().slice(0, 8)}`;
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(t.projects).values({
          id: ghostId,
          workspaceId,
          name: "Ghost",
          slug: ghostId,
          createdBy: userId,
          currentVersionId: null,
        });
        throw new Error("boom — rollback");
      }),
    ).rejects.toThrow("boom — rollback");

    const [row] = await db.select().from(t.projects).where(eq(t.projects.id, ghostId)).limit(1);
    expect(row).toBeUndefined();

    // the connection is usable after the rollback (no dangling BEGIN)
    const project = await repos.projects.create(workspaceId, {
      name: "After Rollback",
      createdBy: userId,
    });
    expect(project.id).toBeTruthy();
  });

  it("nested transaction: savepoint rollback only unwinds to the savepoint", async () => {
    const t = tablesFor(db);
    const idOf = (name: string) => `prj_${name}_${randomUUID().slice(0, 8)}`;

    await db.transaction(async (tx) => {
      await tx.insert(t.projects).values({
        id: idOf("outer_a"),
        workspaceId,
        name: "Outer A",
        slug: idOf("outer_a"),
        createdBy: userId,
        currentVersionId: null,
      });

      // inner savepoint: its insert is rolled back, the outer transaction
      // survives and keeps going (pg savepoint semantics on sqlite).
      await expect(
        tx.transaction(async (tx2) => {
          await tx2.insert(t.projects).values({
            id: idOf("inner_b"),
            workspaceId,
            name: "Inner B",
            slug: idOf("inner_b"),
            createdBy: userId,
            currentVersionId: null,
          });
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");

      await tx.insert(t.projects).values({
        id: idOf("outer_c"),
        workspaceId,
        name: "Outer C",
        slug: idOf("outer_c"),
        createdBy: userId,
        currentVersionId: null,
      });
    });

    const names = (
      await db
        .select({ name: t.projects.name })
        .from(t.projects)
        .where(eq(t.projects.workspaceId, workspaceId))
    ).map((row) => row.name);
    expect(names).toContain("Outer A");
    expect(names).toContain("Outer C");
    expect(names).not.toContain("Inner B");
  });
});
