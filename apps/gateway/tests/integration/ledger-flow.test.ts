// W4-P — §20 #10: "The credit ledger shows reserve/commit entries; balances
// match; a failed run refunds; the same idempotency key never charges twice."
//
// Everything money-critical here is the REAL domain: the runs route reserves
// through `billingFromLedger` (the same adapter the composition root ships),
// and the worker's settlement step (Wave 6) is driven through the public
// @studio/billing functions over the SAME in-memory ledger — commitReservation
// / releaseReservation are exactly what the worker will call, so the ledger
// invariants this suite pins are the ones production enforces (§14.2):
//   reserve row  delta −A        key `${runId}:reserve`
//   commit row   delta A − charge key `${runId}:commit`
//   refund row   delta A − p     key `${runId}:refund`
// The only fake is the LedgerStore itself (unique(idempotency_key, kind)
// index mirrored in memory — the same job the real credit_ledger index does).

import { commitReservation, releaseReservation, reserveKey, refundKey, commitKey } from "@studio/billing";
import { describe, expect, it } from "vitest";
import { buildGateway, ORG_A, ORG_B, postJson, TOKENS, type ErrorEnvelope, type GatewayHarness } from "./harness.js";

const STANDARD_TIER_CREDITS = 2; // §14.4/§5.2: standard = 2 credits (W4-G pinned)
const TRIAL_CREDITS = 30; // §14.1

interface CreateRunResponse {
  readonly run_id: string;
  readonly status: string;
  readonly credits_reserved: number;
}

async function createStandardRun(
  h: GatewayHarness,
  token: string,
  key: string,
): Promise<{ res: Response; body: CreateRunResponse }> {
  const res = await postJson(
    h,
    "/v1/runs",
    {
      documentId: await ownDocumentId(h),
      prompt: "Coffee shop promo post, warm and cozy",
      tier: "standard",
    },
    token,
    { "idempotency-key": key },
  );
  const body = (await res.json()) as CreateRunResponse;
  return { res, body };
}

/** Creates (or reuses) org A's document so runs have a legal target. */
async function ownDocumentId(h: GatewayHarness): Promise<string> {
  const existing = h.docsStore.documents.find((d) => d.organizationId === ORG_A);
  if (existing !== undefined) {
    return existing.id;
  }
  const res = await postJson(
    h,
    "/v1/documents",
    { name: "Ledger flow doc", width: 1080, height: 1080 },
    TOKENS.editorA,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { document: { id: string } };
  return body.document.id;
}

describe("§20 #10 ledger flow — reserve→commit matches, refunds, no double charges", () => {
  it("reserve→commit entries match and the balance settles to grant − charge", async () => {
    const h = buildGateway();
    const { res, body } = await createStandardRun(h, TOKENS.editorA, "ledger-commit-1");
    expect(res.status).toBe(201);
    expect(body.status).toBe("queued");
    expect(body.credits_reserved).toBe(STANDARD_TIER_CREDITS);

    const runId = body.run_id;

    // Phase 1 — the hold (§14.2 rule 1): one reserve row keyed by run+phase.
    const reserves = h.ledger.entriesOfKind("reserve", ORG_A);
    expect(reserves).toHaveLength(1);
    expect(reserves[0]?.delta).toBe(-STANDARD_TIER_CREDITS);
    expect(reserves[0]?.idempotencyKey).toBe(reserveKey(runId));
    expect(reserves[0]?.runId).toBe(runId);
    expect(await h.ledger.balanceAfter(ORG_A)).toBe(TRIAL_CREDITS - STANDARD_TIER_CREDITS);

    // Phase 2 — the worker's settlement (§3.3 step 6): commit over the SAME
    // ledger, exactly as the worker will (Wave 6 owns the call site).
    const commit = await commitReservation(h.ledger, {
      organizationId: ORG_A,
      runId,
      amount: STANDARD_TIER_CREDITS,
    });
    expect(commit.ok).toBe(true);
    if (commit.ok) {
      expect(commit.value.amountCharged).toBe(STANDARD_TIER_CREDITS);
      expect(commit.value.duplicate).toBe(false);
    }

    const commits = h.ledger.entriesOfKind("commit", ORG_A);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.delta).toBe(0); // amount − amountCharged: full charge
    expect(commits[0]?.idempotencyKey).toBe(commitKey(runId));
    expect(commits[0]?.runId).toBe(runId);

    // Balances match (§20 #10): grant − hold + settlement = grant − charge.
    expect(await h.ledger.balanceAfter(ORG_A)).toBe(TRIAL_CREDITS - STANDARD_TIER_CREDITS);

    // The ledger is append-only and tells the whole story in order (org A's
    // rows only — org B's seeded trial is a different tenant's pot).
    expect(
      h.ledger
        .all()
        .filter((row) => row.organizationId === ORG_A)
        .map((row) => row.kind),
    ).toEqual(["grant", "reserve", "commit"]);
  });

  it("a §5.2 budget-stop partial commit returns the uncharged remainder", async () => {
    const h = buildGateway();
    const { body } = await createStandardRun(h, TOKENS.editorA, "ledger-commit-partial");
    const commit = await commitReservation(h.ledger, {
      organizationId: ORG_A,
      runId: body.run_id,
      amount: STANDARD_TIER_CREDITS,
      amountCharged: 1,
    });
    expect(commit.ok).toBe(true);
    if (commit.ok) {
      expect(commit.value.amountCharged).toBe(1);
    }

    const commits = h.ledger.entriesOfKind("commit", ORG_A);
    expect(commits[0]?.delta).toBe(1); // release 2, charge 1 (§14.2 rule 2)
    expect(await h.ledger.balanceAfter(ORG_A)).toBe(TRIAL_CREDITS - 1);
  });

  it("a failed run refunds the full reservation (§3.3 step 7 / §14.2 rule 3)", async () => {
    const h = buildGateway();
    h.enqueue.failNext = true; // the queue is down — the run must fail cleanly

    const { res, body } = await createStandardRun(h, TOKENS.editorA, "ledger-fail-refund");
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorEnvelope).code).toBe("engine_unavailable");

    const refunds = h.ledger.entriesOfKind("refund", ORG_A);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.delta).toBe(STANDARD_TIER_CREDITS); // FULL release
    expect(refunds[0]?.idempotencyKey).toBe(refundKey(body.run_id));
    expect(refunds[0]?.runId).toBe(body.run_id);

    // Balance restored, run marked failed with the typed error.
    expect(await h.ledger.balanceAfter(ORG_A)).toBe(TRIAL_CREDITS);
    const run = await h.runsStore.getRun(ORG_A, body.run_id);
    expect(run?.status).toBe("failed");
    expect(run?.error?.code).toBe("queue_unavailable");
  });

  it("the same idempotency key never charges twice (§3.4) — one reservation per run", async () => {
    const h = buildGateway();
    const first = await createStandardRun(h, TOKENS.editorA, "replay-key-once");
    expect(first.res.status).toBe(201);

    // A retried create with the SAME key replays the SAME run: no second
    // reserve, no second enqueue, no second row.
    const second = await createStandardRun(h, TOKENS.editorA, "replay-key-once");
    expect(second.res.status).toBe(201);
    expect(second.body.run_id).toBe(first.body.run_id);

    expect(h.ledger.entriesOfKind("reserve", ORG_A)).toHaveLength(1);
    expect(h.enqueue.calls).toHaveLength(1);
    expect(h.runsStore.all()).toHaveLength(1);
    expect(await h.ledger.balanceAfter(ORG_A)).toBe(TRIAL_CREDITS - STANDARD_TIER_CREDITS);

    // And the worker's commit replay is idempotent too: the second call is a
    // duplicate that appends nothing (§3.4 retries never double-charge).
    const commit = await commitReservation(h.ledger, {
      organizationId: ORG_A,
      runId: first.body.run_id,
      amount: STANDARD_TIER_CREDITS,
    });
    expect(commit.ok).toBe(true);
    const replay = await commitReservation(h.ledger, {
      organizationId: ORG_A,
      runId: first.body.run_id,
      amount: STANDARD_TIER_CREDITS,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.duplicate).toBe(true);
    }
    expect(h.ledger.entriesOfKind("commit", ORG_A)).toHaveLength(1);
    expect(await h.ledger.balanceAfter(ORG_A)).toBe(TRIAL_CREDITS - STANDARD_TIER_CREDITS);
  });

  it("cancelling refunds the full hold, stays refunded, and commit/refund stay exclusive", async () => {
    const h = buildGateway();
    const { body } = await createStandardRun(h, TOKENS.editorA, "ledger-cancel-refund");

    const cancel = await h.app.request(`/v1/runs/${body.run_id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.editorA}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cancel.status).toBe(200);
    const cancelBody = (await cancel.json()) as { status: string; credits_refunded: number };
    expect(cancelBody.status).toBe("cancelled");
    expect(cancelBody.credits_refunded).toBe(STANDARD_TIER_CREDITS);

    const refunds = h.ledger.entriesOfKind("refund", ORG_A);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.delta).toBe(STANDARD_TIER_CREDITS);
    expect(await h.ledger.balanceAfter(ORG_A)).toBe(TRIAL_CREDITS);
    expect((await h.runsStore.getRun(ORG_A, body.run_id))?.status).toBe("cancelled");

    // Re-cancel is a 409 and never a second refund.
    const reCancel = await h.app.request(`/v1/runs/${body.run_id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.editorA}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(reCancel.status).toBe(409);
    expect(h.ledger.entriesOfKind("refund", ORG_A)).toHaveLength(1);
    expect(await h.ledger.balanceAfter(ORG_A)).toBe(TRIAL_CREDITS);

    // Money terminals are mutually exclusive: commit-after-refund conflicts.
    const commitAfterRefund = await commitReservation(h.ledger, {
      organizationId: ORG_A,
      runId: body.run_id,
      amount: STANDARD_TIER_CREDITS,
    });
    expect(commitAfterRefund.ok).toBe(false);
    if (!commitAfterRefund.ok) {
      expect(commitAfterRefund.code).toBe("conflict");
    }
    expect(h.ledger.entriesOfKind("commit", ORG_A)).toHaveLength(0);

    // …and refund-after-commit conflicts the other way (§14.2 ledger model).
    const run2 = await createStandardRun(h, TOKENS.editorA, "ledger-commit-then-release");
    const committed = await commitReservation(h.ledger, {
      organizationId: ORG_A,
      runId: run2.body.run_id,
      amount: STANDARD_TIER_CREDITS,
    });
    expect(committed.ok).toBe(true);
    const releaseAfterCommit = await releaseReservation(h.ledger, {
      organizationId: ORG_A,
      runId: run2.body.run_id,
      amount: STANDARD_TIER_CREDITS,
    });
    expect(releaseAfterCommit.ok).toBe(false);
    if (!releaseAfterCommit.ok) {
      expect(releaseAfterCommit.code).toBe("conflict");
    }
    expect(h.ledger.entriesOfKind("refund", ORG_A)).toHaveLength(1); // still only run #1's
  });

  it("insufficient credits charge nothing — the run never starts (§14.2 rule 1)", async () => {
    const h = buildGateway();
    // Drain org B to zero with an admin adjustment (a §12.1 ledger kind), so
    // its balance is provably below the standard tier base.
    await h.ledger.append({
      organizationId: ORG_B,
      delta: -TRIAL_CREDITS,
      kind: "adjustment",
      idempotencyKey: "drain-org-b-for-402",
    });
    expect(await h.ledger.balanceAfter(ORG_B)).toBe(0);

    const docRes = await postJson(
      h,
      "/v1/documents",
      { name: "Broke doc", width: 800, height: 600 },
      TOKENS.editorB,
    );
    expect(docRes.status).toBe(201);
    const doc = (await docRes.json()) as { document: { id: string } };

    const res = await postJson(
      h,
      "/v1/runs",
      { documentId: doc.document.id, prompt: "no funds", tier: "standard" },
      TOKENS.editorB,
      { "idempotency-key": "broke-key" },
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.code).toBe("insufficient_credits");
    expect(body.hint).toContain("Top up");

    // Nothing was charged, inserted or enqueued (§14.2 rule 1).
    expect(h.ledger.entriesOfKind("reserve", ORG_B)).toHaveLength(0);
    expect(h.runsStore.all().filter((run) => run.organizationId === ORG_B)).toHaveLength(0);
    expect(h.enqueue.calls.filter((call) => call.payload.organizationId === ORG_B)).toHaveLength(0);
    expect(await h.ledger.balanceAfter(ORG_B)).toBe(0);
  });
});
