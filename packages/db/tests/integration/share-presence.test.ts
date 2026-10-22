import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type StudioDb, createDb } from "../../src/db.js";
import { DbError } from "../../src/errors-lite.js";
import { PRESENCE_TTL_MS } from "../../src/repos/presence.js";
import { migrateDatabase } from "../../src/migrate.js";
import { type Repos, createRepos } from "../../src/repos/index.js";
import * as schema from "../../src/schema.js";

/**
 * Integration tests — M7 share/persistence (BUILD_PLAN §M7 tasks 2/5):
 * share_tokens (issue → verify → revoke, hash-only storage, expiry, soft
 * revocation, tenant isolation §12.1) + presence heartbeats (upsert, TTL
 * sweep, viewers). Requires a real Postgres:
 *   `DATABASE_URL=postgres://… pnpm --filter @studio/db test`.
 * Skipped (not failed) when DATABASE_URL is not a postgres URL.
 *
 * These pin the M7-E repo surface M7-B (presence route/UI) and the share
 * page consume: beat/viewers semantics, issue/verifyByHash/list/revoke.
 */
const pgUrl = process.env.DATABASE_URL ?? "";
const hasDb = /^postgres(ql)?:/.test(pgUrl);

/** Mint a raw token + its sha256 hash the way the gateway route does. */
function mintToken(): { raw: string; hash: string } {
  const raw = randomUUID().replaceAll("-", "");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

describe.skipIf(!hasDb)("share + presence persistence (integration)", { timeout: 30_000 }, () => {
  let db: StudioDb;
  let repos: Repos;
  const wsA = `ws_test_${randomUUID().slice(0, 8)}`;
  const wsB = `ws_test_${randomUUID().slice(0, 8)}`;
  const userId = `usr_test_${randomUUID().slice(0, 8)}`;
  const userId2 = `usr_test_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL as string;
    db = createDb(url);
    await migrateDatabase(db);
    repos = createRepos(db);
    await db
      .insert(schema.organization)
      .values([
        { id: wsA, name: "A", slug: wsA },
        { id: wsB, name: "B", slug: wsB },
      ])
      .onConflictDoNothing();
    await db
      .insert(schema.user)
      .values([
        { id: userId, name: "Sharer", email: `${userId}@studio.test`, emailVerified: true },
        { id: userId2, name: "Viewer Two", email: `${userId2}@studio.test`, emailVerified: true },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  async function projectIn(ws: string, name: string): Promise<string> {
    const project = await repos.projects.create(ws, { name, createdBy: userId });
    return project.id;
  }

  // ── share_tokens: issue ────────────────────────────────────────────────────

  it("issue stores ONLY the sha256 hash — the raw token never lands in the row", async () => {
    const projectId = await projectIn(wsA, "Hash Pin");
    const { raw, hash } = mintToken();
    const token = await repos.shareTokens.issue(wsA, {
      projectId,
      createdBy: userId,
      tokenHash: hash,
    });
    expect(token.tokenHash).toBe(hash);
    expect(token.tokenHash).not.toBe(raw);
    expect(token.passwordHash).toBeNull();
    expect(token.revokedAt).toBeNull();
    expect(token.expiresAt).toBeNull();

    // Raw-row pin: the stored row is the hash, and the raw token appears
    // nowhere in the table (hash-only storage, §M7 task 5).
    const [row] = await db
      .select()
      .from(schema.shareTokens)
      .where(eq(schema.shareTokens.id, token.id));
    if (row === undefined) throw new Error("share_tokens row missing");
    expect(row.tokenHash).toBe(hash);
    const all = await db
      .select()
      .from(schema.shareTokens)
      .where(eq(schema.shareTokens.projectId, projectId));
    expect(all.some((entry) => entry.tokenHash === raw)).toBe(false);
  });

  it("issue cross-tenant project → NOT_FOUND (§12.1)", async () => {
    const projectId = await projectIn(wsA, "Foreign Issue");
    const { hash } = mintToken();
    await expect(
      repos.shareTokens.issue(wsB, { projectId, createdBy: userId, tokenHash: hash }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("issue with an unknown creator → NOT_FOUND; bad hash/password shapes → VALIDATION_FAILED", async () => {
    const projectId = await projectIn(wsA, "Validation");
    const { hash } = mintToken();
    await expect(
      repos.shareTokens.issue(wsA, { projectId, createdBy: "usr_missing", tokenHash: hash }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      repos.shareTokens.issue(wsA, {
        projectId,
        createdBy: userId,
        tokenHash: "not-a-sha256-hex",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      repos.shareTokens.issue(wsA, {
        projectId,
        createdBy: userId,
        tokenHash: hash,
        passwordHash: "bcrypt$nope",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      repos.shareTokens.issue(wsA, {
        projectId,
        createdBy: userId,
        tokenHash: hash,
        expiresInDays: 366,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("issue accepts a gateway-produced scrypt password hash + expiry", async () => {
    const projectId = await projectIn(wsA, "Gated Share");
    const { hash } = mintToken();
    const salt = "0123456789abcdef0123456789abcdef";
    const digest = "a".repeat(128);
    const token = await repos.shareTokens.issue(wsA, {
      projectId,
      createdBy: userId,
      tokenHash: hash,
      passwordHash: `scrypt$${salt}$${digest}`,
      expiresInDays: 7,
    });
    expect(token.passwordHash).toBe(`scrypt$${salt}$${digest}`);
    expect(token.expiresAt).not.toBeNull();
    expect(token.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
    expect(token.expiresAt!.getTime()).toBeLessThan(Date.now() + 8 * 24 * 3600 * 1000);
  });

  it("a duplicate token_hash is a typed CONFLICT (unique index through the wrap)", async () => {
    const projectId = await projectIn(wsA, "Duplicate Hash");
    const { hash } = mintToken();
    await repos.shareTokens.issue(wsA, { projectId, createdBy: userId, tokenHash: hash });
    await expect(
      repos.shareTokens.issue(wsA, { projectId, createdBy: userId, tokenHash: hash }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  // ── share_tokens: verify / list / revoke ─────────────────────────────────

  it("verifyByHash resolves the live token scoped to the project; wrong scope/hash → null", async () => {
    const projectId = await projectIn(wsA, "Verify");
    const { raw, hash } = mintToken();
    const token = await repos.shareTokens.issue(wsA, { projectId, createdBy: userId, tokenHash: hash });
    const verified = await repos.shareTokens.verifyByHash(projectId, hash);
    expect(verified?.id).toBe(token.id);
    // the RAW token can never verify (hash-only storage)
    expect(await repos.shareTokens.verifyByHash(projectId, createHash("sha256").update(raw).update("x").digest("hex"))).toBeNull();
    expect(await repos.shareTokens.verifyByHash(projectId, createHash("sha256").update("wrong").digest("hex"))).toBeNull();
    // a different project never sees the token
    const other = await projectIn(wsA, "Verify Other");
    expect(await repos.shareTokens.verifyByHash(other, hash)).toBeNull();

    const byHash = await repos.shareTokens.getByHash(hash);
    expect(byHash?.id).toBe(token.id);
  });

  it("verify/resolve return null once expired or revoked", async () => {
    const projectId = await projectIn(wsA, "Expiry");
    const { hash } = mintToken();
    const token = await repos.shareTokens.issue(wsA, {
      projectId,
      createdBy: userId,
      tokenHash: hash,
      expiresInDays: 1,
    });
    // force-expire via the row (time travel without waiting a day)
    await db
      .update(schema.shareTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.shareTokens.id, token.id));
    expect(await repos.shareTokens.verifyByHash(projectId, hash)).toBeNull();
    expect(await repos.shareTokens.resolveByHash(hash)).toBeNull();

    const { hash: hash2 } = mintToken();
    const token2 = await repos.shareTokens.issue(wsA, {
      projectId,
      createdBy: userId,
      tokenHash: hash2,
    });
    await repos.shareTokens.revoke(wsA, { id: token2.id, byUserId: userId });
    expect(await repos.shareTokens.getByHash(hash2)).toBeNull();
    expect(await repos.shareTokens.resolveByHash(hash2)).toBeNull();
  });

  it("resolveByHash carries the project + workspace context the public routes need", async () => {
    const projectId = await projectIn(wsA, "Resolve Context");
    const { hash } = mintToken();
    const token = await repos.shareTokens.issue(wsA, { projectId, createdBy: userId, tokenHash: hash });
    const resolved = await repos.shareTokens.resolveByHash(hash);
    expect(resolved?.token.id).toBe(token.id);
    expect(resolved?.projectId).toBe(projectId);
    expect(resolved?.workspaceId).toBe(wsA);
    expect(typeof resolved?.projectName).toBe("string");
  });

  it("list returns ACTIVE rows only, with NO hash/password on the shape", async () => {
    const projectId = await projectIn(wsA, "List");
    const live = await repos.shareTokens.issue(wsA, {
      projectId,
      createdBy: userId,
      tokenHash: mintToken().hash,
    });
    const gated = await repos.shareTokens.issue(wsA, {
      projectId,
      createdBy: userId,
      tokenHash: mintToken().hash,
      passwordHash: `scrypt$${"0f".repeat(16)}$${"aa".repeat(64)}`,
    });
    const revoked = await repos.shareTokens.issue(wsA, {
      projectId,
      createdBy: userId,
      tokenHash: mintToken().hash,
    });
    await repos.shareTokens.revoke(wsA, { id: revoked.id, byUserId: userId });
    const { hash: expiredHash } = mintToken();
    const expired = await repos.shareTokens.issue(wsA, {
      projectId,
      createdBy: userId,
      tokenHash: expiredHash,
    });
    await db
      .update(schema.shareTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.shareTokens.id, expired.id));

    const rows = await repos.shareTokens.list(wsA, projectId);
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([live.id, gated.id]));
    expect(rows.some((row) => row.id === revoked.id)).toBe(false);
    const shape = rows[0] as unknown as Record<string, unknown>;
    expect("tokenHash" in shape).toBe(false);
    expect("passwordHash" in shape).toBe(false);
    const gatedRow = rows.find((row) => row.id === gated.id);
    expect(gatedRow?.hasPassword).toBe(true);
    const liveRow = rows.find((row) => row.id === live.id);
    expect(liveRow?.hasPassword).toBe(false);

    // cross-tenant list reads nothing (§12.1)
    expect(await repos.shareTokens.list(wsB, projectId)).toEqual([]);
  });

  it("revoke is conditional + idempotent; unknown/cross-tenant ids 404", async () => {
    const projectId = await projectIn(wsA, "Revoke");
    const token = await repos.shareTokens.issue(wsA, {
      projectId,
      createdBy: userId,
      tokenHash: mintToken().hash,
    });
    const first = await repos.shareTokens.revoke(wsA, { id: token.id, byUserId: userId });
    expect(first.revokedAt).not.toBeNull();
    const again = await repos.shareTokens.revoke(wsA, { id: token.id, byUserId: userId });
    expect(again.revokedAt).toEqual(first.revokedAt); // same flip, never re-stamped

    await expect(
      repos.shareTokens.revoke(wsB, { id: token.id, byUserId: userId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      repos.shareTokens.revoke(wsA, { id: "shr_missing", byUserId: userId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // ── presence heartbeats ───────────────────────────────────────────────────

  it("beat upserts one row per (project, user) and returns live viewers", async () => {
    const projectId = await projectIn(wsA, "Presence");
    const first = await repos.presence.beat(wsA, {
      projectId,
      userId,
      displayName: "Sharer",
      compId: "comp-main",
      playheadTicks: 120,
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      userId,
      displayName: "Sharer",
      compId: "comp-main",
      playheadTicks: 120,
    });
    expect(typeof first[0]?.lastSeenAt).toBe("string");

    const second = await repos.presence.beat(wsA, {
      projectId,
      userId,
      displayName: "Sharer Renamed",
      compId: null,
      playheadTicks: 240,
    });
    expect(second).toHaveLength(1); // upsert, not a second row
    expect(second[0]?.displayName).toBe("Sharer Renamed");
    expect(second[0]?.compId).toBeNull();

    const both = await repos.presence.beat(wsA, {
      projectId,
      userId: userId2,
      displayName: "Viewer Two",
    });
    expect(both).toHaveLength(2);
    expect(new Set(both.map((viewer) => viewer.userId))).toEqual(new Set([userId, userId2]));
  });

  it("presence rows survive the default TTL sweep but vanish past a short one", async () => {
    const projectId = await projectIn(wsA, "Sweep");
    await repos.presence.beat(wsA, { projectId, userId, displayName: "Sweeper" });
    // Default TTL (240s) — the fresh row survives.
    const fresh = await repos.presence.viewers(wsA, projectId);
    expect(fresh.map((viewer) => viewer.userId)).toEqual([userId]);

    // ttlMs=100: after 150ms of real time the row is swept away.
    await repos.presence.beat(wsA, { projectId, userId, displayName: "Sweeper", ttlMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const gone = await repos.presence.viewers(wsA, projectId, { ttlMs: 100 });
    expect(gone).toEqual([]);

    // …but the sweep is per-project: a NEIGHBOR project's fresh row (beaten
    // just now, well inside the 100ms window) is untouched.
    const other = await projectIn(wsA, "Sweep Neighbor");
    await repos.presence.beat(wsA, { projectId: other, userId, displayName: "Neighbor" });
    const neighbor = await repos.presence.viewers(wsA, other, { ttlMs: 100 });
    expect(neighbor.map((viewer) => viewer.userId)).toEqual([userId]);
    // and the swept project stays empty.
    const stillGone = await repos.presence.viewers(wsA, projectId, { ttlMs: 100 });
    expect(stillGone).toEqual([]);
  });

  it("presence enforces tenant isolation + input bounds", async () => {
    const projectId = await projectIn(wsA, "Presence Bounds");
    await expect(
      repos.presence.beat(wsB, { projectId, userId, displayName: "Foreign" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      repos.presence.beat(wsA, { projectId, userId: "usr_missing", displayName: "Ghost" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      repos.presence.beat(wsA, { projectId, userId, displayName: "X", playheadTicks: -1 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      repos.presence.beat(wsA, {
        projectId,
        userId,
        displayName: "X",
        playheadTicks: 36_000_001, // contracts PRESENCE_PLAYHEAD_TICKS_MAX + 1
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      repos.presence.beat(wsA, { projectId, userId, displayName: "X", compId: "x".repeat(121) }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      repos.presence.viewers(wsB, projectId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("PRESENCE_TTL_MS matches the contracts pin (LEASE_HEARTBEAT_MS × 2 = 240s)", () => {
    expect(PRESENCE_TTL_MS).toBe(240_000);
  });

  it("DbError import is exercised (sanity)", () => {
    expect(DbError.notFound("x").code).toBe("NOT_FOUND");
  });
});
