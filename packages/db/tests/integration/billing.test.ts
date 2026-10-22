import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type StudioDb, createDb } from "../../src/db.js";
import { migrateDatabase } from "../../src/migrate.js";
import { type Repos, createRepos } from "../../src/repos/index.js";
import * as schema from "../../src/schema.js";

/**
 * Integration tests — M6 billing persistence (BUILD_PLAN §M6 tasks 1/2/5:
 * plans/entitlements persistence, Stripe webhook idempotency, abuse controls).
 * Requires a real Postgres: `DATABASE_URL=postgres://… pnpm --filter @studio/db test`.
 * Skipped (not failed) when DATABASE_URL is not a postgres URL.
 *
 * Covers: D-4 trial-on-Starter-row, guarded subscription transitions incl.
 * exactly-one-wins races, one-row-per-workspace upserts, unique-customer
 * constraint, one-trial-per-card fingerprint lookups (cross-workspace by
 * design), invoice idempotency (re-record + concurrent first-record), cursor
 * pagination, auto-apply default-OFF (M5-O seam), webhook seen/record
 * idempotency, and cross-tenant isolation (§12.1: other workspace = not found).
 */
const pgUrl = process.env.DATABASE_URL ?? "";
const hasDb = /^postgres(ql)?:/.test(pgUrl);

describe.skipIf(!hasDb)("billing persistence (integration)", { timeout: 30_000 }, () => {
  let db: StudioDb;
  let repos: Repos;
  const wsA = `ws_test_${randomUUID().slice(0, 8)}`;
  const wsB = `ws_test_${randomUUID().slice(0, 8)}`;
  const wsFresh = `ws_test_${randomUUID().slice(0, 8)}`; // used only for race tests
  const userId = `usr_test_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL as string;
    db = createDb(url);
    await migrateDatabase(db);
    repos = createRepos(db);
    // fixture: three workspaces + a member user (cross-tenant reads as 404)
    await db
      .insert(schema.organization)
      .values([
        { id: wsA, name: "A", slug: wsA },
        { id: wsB, name: "B", slug: wsB },
        { id: wsFresh, name: "C", slug: wsFresh },
      ])
      .onConflictDoNothing();
    await db
      .insert(schema.user)
      .values({ id: userId, name: "T", email: `${userId}@studio.test`, emailVerified: true })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  // ── subscriptions ─────────────────────────────────────────────────────────

  it("trial is a subscription state on the Starter row (D-4): upsertState inserts", async () => {
    const trialEnd = new Date(Date.now() + 14 * 24 * 3600 * 1000);
    const sub = await repos.subscriptions.upsertState(wsA, {
      planId: "starter",
      status: "trialing",
      trialEnd,
    });
    expect(sub.organizationId).toBe(wsA);
    expect(sub.planId).toBe("starter");
    expect(sub.status).toBe("trialing");
    expect(sub.trialEnd).toEqual(trialEnd);
    expect(sub.cancelAtPeriodEnd).toBe(false); // default
    expect(sub.graceEnd).toBeNull();
    expect(sub.stripeSubscriptionId).toBeNull();

    const read = await repos.subscriptions.getByOrganization(wsA);
    expect(read?.id).toBe(sub.id);
  });

  it("upsertState updates the SAME row — one live subscription per workspace", async () => {
    const before = await repos.subscriptions.getByOrganization(wsA);
    expect(before).not.toBeNull();
    const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const after = await repos.subscriptions.upsertState(wsA, {
      planId: "pro",
      status: "active",
      stripeSubscriptionId: "sub_stripe_1",
      currentPeriodEnd: periodEnd,
    });
    expect(after.id).toBe(before?.id); // same row, never a second one
    expect(after.planId).toBe("pro");
    expect(after.status).toBe("active");
    expect(after.stripeSubscriptionId).toBe("sub_stripe_1");
    expect(after.currentPeriodEnd).toEqual(periodEnd);
  });

  it("transitionStatus moves status and pins optional fields (webhook path)", async () => {
    await repos.subscriptions.upsertState(wsA, { planId: "starter", status: "trialing" });
    const active = await repos.subscriptions.transitionStatus(wsA, {
      from: ["trialing"],
      to: "active",
    });
    expect(active.status).toBe("active");
    expect(active.updatedAt).toBeInstanceOf(Date);

    // past_due → grace carries the grace window
    await repos.subscriptions.transitionStatus(wsA, { from: ["active"], to: "past_due" });
    const graceEnd = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const grace = await repos.subscriptions.transitionStatus(wsA, {
      from: ["past_due"],
      to: "grace",
      graceEnd,
    });
    expect(grace.status).toBe("grace");
    expect(grace.graceEnd).toEqual(graceEnd);
  });

  it("transitionStatus rejects when the current status is not in `from` (typed CONFLICT)", async () => {
    await repos.subscriptions.upsertState(wsA, { planId: "starter", status: "active" });
    await expect(
      repos.subscriptions.transitionStatus(wsA, { from: ["trialing"], to: "canceled" }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    // row untouched
    expect((await repos.subscriptions.getByOrganization(wsA))?.status).toBe("active");
  });

  it("concurrent transitions of the same status: EXACTLY ONE wins, loser typed CONFLICT", async () => {
    await repos.subscriptions.upsertState(wsA, { planId: "starter", status: "trialing" });
    const results = await Promise.allSettled([
      repos.subscriptions.transitionStatus(wsA, { from: ["trialing"], to: "active" }),
      repos.subscriptions.transitionStatus(wsA, { from: ["trialing"], to: "past_due" }),
    ]);
    const winners = results.filter(
      (r): r is PromiseFulfilledResult<schema.Subscription> => r.status === "fulfilled",
    );
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.reason).toMatchObject({ code: "CONFLICT" });

    const final = await repos.subscriptions.getByOrganization(wsA);
    expect(winners[0]?.value.status).toBeDefined();
    expect(final?.status).toBe(winners[0]?.value.status);
    // the lost transition can never be re-applied from its stale `from`
    await expect(
      repos.subscriptions.transitionStatus(wsA, { from: ["trialing"], to: "canceled" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("concurrent upserts for a new workspace: both succeed, exactly ONE row lands", async () => {
    const results = await Promise.allSettled([
      repos.subscriptions.upsertState(wsFresh, { planId: "starter", status: "trialing" }),
      repos.subscriptions.upsertState(wsFresh, { planId: "pro", status: "active" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const rows = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.organizationId, wsFresh));
    expect(rows).toHaveLength(1);
    expect(["trialing", "active"]).toContain(rows[0]?.status);
  });

  it("cross-tenant isolation (§12.1): another workspace's billing reads as not found", async () => {
    // wsA has a subscription + customer; wsB has none — reads see NOTHING of wsA
    await repos.subscriptions.upsertState(wsA, { planId: "starter", status: "active" });
    await repos.subscriptions.ensureStripeCustomer(wsA, { stripeCustomerId: "cus_A" });

    expect(await repos.subscriptions.getByOrganization(wsB)).toBeNull();
    expect(await repos.subscriptions.findStripeCustomer(wsB)).toBeNull();
    // mutations for a workspace without a subscription are NOT_FOUND, never 403
    await expect(
      repos.subscriptions.transitionStatus(wsB, { from: ["trialing"], to: "active" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    // unknown workspace likewise
    await expect(
      repos.subscriptions.upsertState("ws_does_not_exist", {
        planId: "starter",
        status: "trialing",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // ── stripe customers / abuse controls (BP M6 task 5) ───────────────────────

  it("ensureStripeCustomer upserts: id refresh keeps the fingerprint, new card overwrites", async () => {
    const first = await repos.subscriptions.ensureStripeCustomer(wsA, {
      stripeCustomerId: "cus_A",
      cardFingerprint: "fp_card_1",
    });
    expect(first.cardFingerprint).toBe("fp_card_1");

    // re-ensure without a fingerprint: mapping may refresh, fingerprint kept
    const again = await repos.subscriptions.ensureStripeCustomer(wsA, {
      stripeCustomerId: "cus_A2",
    });
    expect(again.id).toBe(first.id);
    expect(again.stripeCustomerId).toBe("cus_A2");
    expect(again.cardFingerprint).toBe("fp_card_1");

    // a new card overwrites the fingerprint
    const swapped = await repos.subscriptions.ensureStripeCustomer(wsA, {
      stripeCustomerId: "cus_A2",
      cardFingerprint: "fp_card_2",
    });
    expect(swapped.cardFingerprint).toBe("fp_card_2");
  });

  it("unique-customer constraint: a second customer row per workspace violates the DB unique (23505)", async () => {
    // wsB currently has no customer row — insert one via the repo, then prove
    // the DATABASE rejects a second raw row for the same organization.
    await repos.subscriptions.ensureStripeCustomer(wsB, { stripeCustomerId: "cus_B" });
    await expect(
      db
        .insert(schema.stripeCustomers)
        .values({
          id: `sc_raw_${randomUUID().slice(0, 8)}`,
          organizationId: wsB,
          stripeCustomerId: "cus_B_other",
        })
        .returning(),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    // ensureStripeCustomer still resolves to the single row (no duplicate made)
    const rows = await db
      .select()
      .from(schema.stripeCustomers)
      .where(eq(schema.stripeCustomers.organizationId, wsB));
    expect(rows).toHaveLength(1);
  });

  it("cardFingerprintUsed: cross-workspace lookup for the one-trial-per-card rule", async () => {
    // run-unique fingerprint (dev DB keeps rows from earlier test runs)
    const fp = `fp_${randomUUID().slice(0, 8)}`;
    await repos.subscriptions.ensureStripeCustomer(wsB, {
      stripeCustomerId: `cus_${randomUUID().slice(0, 8)}`,
      cardFingerprint: fp,
    });
    // a DIFFERENT workspace asking about that fingerprint must learn which
    // workspace already used it (the lookup is cross-workspace BY DESIGN).
    const used = await repos.subscriptions.cardFingerprintUsed(fp);
    expect(used).toEqual({ organizationId: wsB });

    // an unused fingerprint is null (card may start a trial)
    expect(
      await repos.subscriptions.cardFingerprintUsed(`fp_unused_${randomUUID().slice(0, 8)}`),
    ).toBeNull();
  });

  it("boundary validation: bad plan/status/currency/fingerprint are typed VALIDATION_FAILED", async () => {
    await expect(
      repos.subscriptions.upsertState(wsA, {
        planId: "enterprise" as schema.PlanId,
        status: "trialing",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
    await expect(
      repos.subscriptions.upsertState(wsA, {
        planId: "starter",
        status: "paused" as schema.SubscriptionStatus,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      repos.subscriptions.transitionStatus(wsA, { from: [], to: "active" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(repos.subscriptions.cardFingerprintUsed("   ")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      repos.invoices.record(wsA, {
        stripeInvoiceId: "in_x",
        amountCents: -1,
        currency: "usd",
        status: "paid",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      repos.invoices.record(wsA, {
        stripeInvoiceId: "in_x",
        amountCents: 100,
        currency: "dollars",
        status: "paid",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  // ── invoices ───────────────────────────────────────────────────────────────

  it("invoice record is idempotent on stripeInvoiceId: re-record returns the existing row", async () => {
    const periodStart = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const first = await repos.invoices.record(wsA, {
      stripeInvoiceId: `in_${randomUUID().slice(0, 8)}`,
      amountCents: 1900,
      currency: "usd",
      status: "draft",
      periodStart,
    });
    expect(first.replayed).toBe(false);
    expect(first.invoice.status).toBe("draft");

    // the payment webhook re-records the SAME stripe invoice id with new state
    const replay = await repos.invoices.record(wsA, {
      stripeInvoiceId: first.invoice.stripeInvoiceId,
      amountCents: 1900,
      currency: "usd",
      status: "paid",
      periodEnd: new Date(),
      hostedUrl: "https://invoice.stripe.com/i/abc",
      pdfUrl: "https://pay.stripe.com/invoices/abc/pdf",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.invoice.id).toBe(first.invoice.id); // SAME row, never a second one
    expect(replay.invoice.status).toBe("paid"); // progressed in place
    expect(replay.invoice.hostedUrl).toBe("https://invoice.stripe.com/i/abc");

    const rows = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.organizationId, wsA));
    const mine = rows.filter((r) => r.stripeInvoiceId === first.invoice.stripeInvoiceId);
    expect(mine).toHaveLength(1);
  });

  it("invoice record across workspaces: a stripeInvoiceId of another workspace is a CONFLICT", async () => {
    const stripeInvoiceId = `in_${randomUUID().slice(0, 8)}`;
    await repos.invoices.record(wsA, {
      stripeInvoiceId,
      amountCents: 500,
      currency: "usd",
      status: "open",
    });
    await expect(
      repos.invoices.record(wsB, {
        stripeInvoiceId,
        amountCents: 500,
        currency: "usd",
        status: "open",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  });

  it("concurrent first-records of one invoice id: both resolve, exactly ONE row lands", async () => {
    const stripeInvoiceId = `in_${randomUUID().slice(0, 8)}`;
    const results = await Promise.allSettled([
      repos.invoices.record(wsB, {
        stripeInvoiceId,
        amountCents: 1200,
        currency: "usd",
        status: "draft",
      }),
      repos.invoices.record(wsB, {
        stripeInvoiceId,
        amountCents: 1200,
        currency: "usd",
        status: "paid",
      }),
    ]);
    // both calls resolve (one is the winner, the other replays the winner's row)
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ invoice: schema.Invoice; replayed: boolean }> =>
        r.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(2);
    expect(fulfilled.filter((r) => r.value.replayed)).toHaveLength(1);
    const rows = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.organizationId, wsB));
    const mine = rows.filter((r) => r.stripeInvoiceId === stripeInvoiceId);
    expect(mine).toHaveLength(1);
  });

  it("invoice list: cursor pagination walks every row exactly once, tenant-isolated", async () => {
    const existing = await db
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(eq(schema.invoices.organizationId, wsB));
    const n = 3;
    for (let i = 0; i < n; i++) {
      await repos.invoices.record(wsB, {
        stripeInvoiceId: `in_page_${randomUUID().slice(0, 8)}`,
        amountCents: 100 * (i + 1),
        currency: "usd",
        status: "paid",
      });
    }
    const total = existing.length + n;

    // walk with limit 2 until exhausted (cursor style per src/cursor.ts)
    const ids: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = await repos.invoices.list(wsB, { limit: 2, cursor });
      ids.push(...page.items.map((invoice) => invoice.id));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor !== null && guard < 20);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total); // no dupes/misses across cursor boundaries
    // wsA never sees wsB's invoices
    const foreign = await repos.invoices.list(wsA, { limit: 100 });
    expect(foreign.items.filter((invoice) => ids.includes(invoice.id))).toHaveLength(0);
  });

  // ── user settings (M5-O auto-apply seam) ───────────────────────────────────

  it("auto-apply defaults OFF when absent; setUserAutoApply toggles it", async () => {
    expect(await repos.settings.getUserAutoApply(userId)).toBe(false); // default
    const off = await repos.settings.setUserAutoApply(userId, true);
    expect(off.autoApplyEnabled).toBe(true);
    expect(await repos.settings.getUserAutoApply(userId)).toBe(true);
    const row = await repos.settings.setUserAutoApply(userId, false);
    expect(row.autoApplyEnabled).toBe(false);
    expect(await repos.settings.getUserAutoApply(userId)).toBe(false);
  });

  it("setUserAutoApply for an unknown user reads as NOT_FOUND", async () => {
    await expect(repos.settings.setUserAutoApply("usr_missing", true)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  // ── webhook idempotency store ─────────────────────────────────────────────

  it("webhook seenOrRecord: first delivery records, replays are seen, provider-scoped", async () => {
    const eventId = `evt_${randomUUID().slice(0, 8)}`;
    const payload = { id: eventId, type: "invoice.payment_succeeded", data: { amount: 1900 } };
    const first = await repos.webhookEvents.seenOrRecord("stripe", eventId, {
      type: "invoice.payment_succeeded",
      payload,
    });
    expect(first).toEqual({ seen: false });
    // replayed delivery: seen
    expect(await repos.webhookEvents.seenOrRecord("stripe", eventId, payload)).toEqual({
      seen: true,
    });
    // same event id under ANOTHER provider namespace is a different event
    expect(await repos.webhookEvents.seenOrRecord("other", eventId, payload)).toEqual({
      seen: false,
    });
    // exactly one row for (stripe, eventId), carrying type + payload
    const rows = await db.select().from(schema.webhookEvents);
    const mine = rows.filter((r) => r.provider === "stripe" && r.eventId === eventId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.eventType).toBe("invoice.payment_succeeded");
    expect(mine[0]?.payloadJson).toEqual(payload);
    expect(mine[0]?.processedAt).toBeInstanceOf(Date);
  });

  it("concurrent deliveries of one webhook: EXACTLY ONE records, the other is seen", async () => {
    const eventId = `evt_${randomUUID().slice(0, 8)}`;
    const results = await Promise.all([
      repos.webhookEvents.seenOrRecord("stripe", eventId, {
        type: "customer.subscription.updated",
      }),
      repos.webhookEvents.seenOrRecord("stripe", eventId, {
        type: "customer.subscription.updated",
      }),
    ]);
    expect(results.filter((r) => !r.seen)).toHaveLength(1);
    expect(results.filter((r) => r.seen)).toHaveLength(1);
  });

  it("webhook validation: empty provider/eventId are typed VALIDATION_FAILED", async () => {
    await expect(repos.webhookEvents.seenOrRecord("", "evt_x")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 400,
    });
    await expect(repos.webhookEvents.seenOrRecord("stripe", "  ")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});
