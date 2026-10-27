// M6-I — the reconciliation job test suite (BUILD_PLAN §M6 task 3:
// "Reconciliation job with LiteLLM spend and render usage"; D-12/D-19/D-20).
//
// DB-gated: real Postgres via bootServer (helpers pattern) — windowed sums
// (D-20 semantics), zombie holds, true-up idempotency, the D-12 negative
// guard, the external spend seam (fake fetch, redaction) and tenant
// isolation. No network: the LiteLLM source tests run against an injected
// fetch seam; createSpendSource gating never fetches.
//
// Clock notes: window bounds are half-open [sinceTs, uptoTs). Ledger rows get
// created_at from the DB clock; to stay deterministic the core-level tests
// pass a `now` seam 5s ahead and windows whose upto is 2s ahead — every
// seeded row (created between t0 and the call) is provably inside [t0−5s,
// now+2s) as long as DB↔JS clock skew stays under ~2s (same box). Route-level
// tests use upto = now+4s, inside the 5s skew the validator allows.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StudioError } from "@studio/config";
import { MODEL_CATALOG } from "@studio/contracts";

import type { LogFields, Logger } from "../src/logger.js";
import {
  type Discrepancy,
  LiteLLMSpendSource,
  RECONCILE_REQUEST_SCHEMA,
  type ReconcileOptions,
  type ReconcileReport,
  type ReconcileSources,
  type ReconcileWindow,
  type SpendSource,
  createRepoReconcileSources,
  createSpendSource,
  reconcileAdjustIdempotencyKey,
  reconcileWindowProblem,
  reconcileWorkspace,
  runReconciliationSweep,
  spendCreditsForModel,
} from "../src/reconciliation.js";

import {
  CookieJar,
  HAS_DATABASE,
  type RunningTestServer,
  api,
  bootServer,
  unique,
  uniqueEmail,
} from "./helpers.js";

const d = describe.skipIf(!HAS_DATABASE);

let server: RunningTestServer;

beforeAll(async () => {
  server = await bootServer();
}, 30_000);

afterAll(async () => {
  await server?.close();
});

// ───────────────────────────────────────────────────────────────────────────
// Harness
// ───────────────────────────────────────────────────────────────────────────

interface Workspace {
  readonly jar: CookieJar;
  readonly id: string;
  readonly userId: string;
}

async function newWorkspace(): Promise<Workspace> {
  const jar = new CookieJar();
  const email = uniqueEmail("recon");
  const signUp = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email, password: "Passw0rd!longenough", name: "Reconciler" },
  });
  expect(signUp.status).toBe(200);
  const wsResponse = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Recon WS"), slug: unique("recon-ws") },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };
  const me = (await (await api(server.base, "/v1/me", { jar })).json()) as {
    data: { user: { id: string } };
  };
  return { jar, id: ws.data.id, userId: me.data.user.id };
}

async function newFixture(ws: Workspace): Promise<{ projectId: string; threadId: string }> {
  const project = await server.deps.repos.projects.create(ws.id, {
    name: unique("Recon Project"),
    createdBy: ws.userId,
  });
  const thread = await server.deps.repos.threads.create(ws.id, {
    projectId: project.id,
    createdBy: ws.userId,
  });
  return { projectId: project.id, threadId: thread.id };
}

/** 1 credit = 1_000_000 µc (D-12) — the ledger-row multiplier in this file. */
const MICRO = 1_000_000;

async function grant(ws: Workspace, credits: number): Promise<void> {
  await server.deps.repos.ledger.grant(ws.id, {
    amount: credits * MICRO,
    idempotencyKey: unique("grant"),
  });
}

interface SeededRun {
  readonly runId: string;
  readonly committed: number;
}

/**
 * Seeds the chat.ts finalize LEDGER path (M4-K/apply-flow precedent):
 * reserve → settle (commit + full-hold refund, D-20) → run-row update.
 *
 * DIALECTS (W3-b02 — the fixture now seeds the REAL writers' dialects):
 * `reserve`/`actual` are RAW ledger magnitudes in integer µc (the grant /
 * reserve / settle calls below are exactly what routes/turn.ts writes),
 * while the run ROW is seeded in WHOLE CREDITS per the D-12 row ruling
 * (reservedCredits/committedCredits — routes/turn.ts heartbeats whole
 * credits). The pre-fix fixture wrote µc INTO the row to mask the core's
 * missing µc↔credits conversion (the M6-K finding the fixture's old
 * comment admitted); the fixed core multiplies rows by 1_000_000 before
 * folding them against the µc ledger sums, so the seeds must speak the
 * row's true dialect.
 * `setRow: false` simulates a finalize that crashed after the settle —
 * the exact drift reconciliation exists to catch.
 */
async function seedCompletedRun(
  ws: Workspace,
  fx: { projectId: string; threadId: string },
  input: { reserve: number; actual: number; setRow?: boolean },
): Promise<SeededRun> {
  const run = await server.deps.repos.runs.create(ws.id, {
    threadId: fx.threadId,
    projectId: fx.projectId,
    model: "studio-smart",
    reservedCredits: Math.round(input.reserve / MICRO), // whole credits (D-12 row)
  });
  await server.deps.repos.runs.update(ws.id, run.id, { status: "running" });
  await server.deps.repos.ledger.reserve(ws.id, {
    runId: run.id,
    amount: input.reserve,
    idempotencyKey: `chat:${run.id}:reserve`,
  });
  const settled = await server.deps.repos.ledger.settle(ws.id, {
    runId: run.id,
    actualCost: input.actual,
    idempotencyKey: `chat:${run.id}:settle`,
  });
  const committed = settled.commit !== null ? -settled.commit.amount : 0;
  if (input.setRow !== false) {
    await server.deps.repos.runs.update(ws.id, run.id, {
      status: "completed",
      committedCredits: Math.round(committed / MICRO), // whole credits (D-12 row)
    });
  }
  return { runId: run.id, committed };
}

/** A window that provably covers everything created since `t0`. */
function windowAround(t0: number): ReconcileWindow {
  return {
    sinceTs: new Date(t0 - 5_000),
    uptoTs: new Date(Date.now() + 2_000),
  };
}

/** The core reads its clock through this seam — 5s ahead keeps guards happy. */
const FUTURE_NOW = (): (() => Date) => () => new Date(Date.now() + 5_000);

function repoSources(): ReconcileSources {
  return createRepoReconcileSources(server.deps.repos);
}

async function coreReport(
  ws: Workspace,
  window: ReconcileWindow,
  options: ReconcileOptions & { spend?: SpendSource | null; logger?: Logger } = {},
): Promise<ReconcileReport> {
  return reconcileWorkspace(
    ws.id,
    window,
    { sources: repoSources(), spend: options.spend ?? null, logger: options.logger },
    { ...options, now: options.now ?? FUTURE_NOW() },
  );
}

async function adjustEntries(ws: Workspace): Promise<{ id: string; amount: number }[]> {
  const page = await server.deps.repos.ledger.list(ws.id, { kind: "adjust", limit: 100 });
  return page.items.map((entry) => ({ id: entry.id, amount: entry.amount }));
}

function codes(report: ReconcileReport): string[] {
  return report.discrepancies.map((entry) => entry.code);
}

/** Narrows a discrepancy by code (throws when absent — loud in tests). */
function discrepancyOf<T extends Discrepancy["code"]>(
  report: ReconcileReport,
  code: T,
): Extract<Discrepancy, { code: T }> {
  const found = report.discrepancies.find((entry) => entry.code === code);
  if (found === undefined) {
    throw new Error(`expected a "${code}" discrepancy, got: ${JSON.stringify(codes(report))}`);
  }
  return found as Extract<Discrepancy, { code: T }>;
}

// ───────────────────────────────────────────────────────────────────────────
// Windowed sums (D-20)
// ───────────────────────────────────────────────────────────────────────────

d("windowed sums are exact (D-20)", () => {
  it("folds grant/reserve/commit/refund exactly for a settled run and reports zero discrepancies", async () => {
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 100);
    const run = await seedCompletedRun(ws, fx, { reserve: 24 * MICRO, actual: 18 * MICRO });

    const report = await coreReport(ws, windowAround(t0));
    expect(report.ledger).toEqual({
      grants: 100 * MICRO,
      reserves: 24 * MICRO,
      outstandingReserves: 0,
      commits: 18 * MICRO,
      refunds: 24 * MICRO,
      adjusts: 0,
      entryCount: 4,
    });
    expect(report.usage).toEqual({
      runs: { discovered: 1, settledInWindow: 1, committedCredits: 18 * MICRO },
      renders: { count: 0, credits: 0 },
      usageSum: 18 * MICRO,
    });
    // D-20: the run nets exactly −actual (µc: reserve −24M, commit −18M,
    // refund +24M).
    expect(report.balance).toBe(82 * MICRO);
    expect(report.discrepancies).toEqual([]);
    expect(report.action).toMatchObject({ attempted: false, skippedReason: "no_mismatch" });
    expect(report.external).toMatchObject({ source: "none", spendCredits: null, error: null });
    expect(report.window.sinceTs).toBe(windowAround(t0).sinceTs.toISOString());
    void run;
  });

  it("treats the window as half-open [sinceTs, uptoTs) on both edges", async () => {
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 40);
    await seedCompletedRun(ws, fx, { reserve: 10 * MICRO, actual: 6 * MICRO });

    // Lower edge: everything was created before `since` → nothing in window.
    const after = await coreReport(ws, {
      sinceTs: new Date(Date.now() + 3_000),
      uptoTs: new Date(Date.now() + 4_000),
    });
    expect(after.ledger.entryCount).toBe(0);
    expect(after.usage.usageSum).toBe(0);
    expect(after.discrepancies).toEqual([]);

    // Upper edge: everything was created at/after `upto` → nothing in window.
    const before = await coreReport(ws, {
      sinceTs: new Date(t0 - 600_000),
      uptoTs: new Date(t0 - 1_000),
    });
    expect(before.ledger.entryCount).toBe(0);
    expect(before.usage.usageSum).toBe(0);
    expect(before.balance).toBe(34 * MICRO); // balance is window-independent (SUM)
    expect(before.discrepancies).toEqual([]);
  });

  it("validates window bounds with a shared, human-safe problem checker", () => {
    const now = new Date("2026-10-22T12:00:00.000Z");
    const iso = (value: string): string => new Date(value).toISOString();
    expect(
      reconcileWindowProblem(
        {
          sinceTs: new Date(iso("2026-10-22T10:00:00Z")),
          uptoTs: new Date(iso("2026-10-22T11:00:00Z")),
        },
        now,
      ),
    ).toBeNull();
    expect(
      reconcileWindowProblem(
        {
          sinceTs: new Date(iso("2026-10-22T11:00:00Z")),
          uptoTs: new Date(iso("2026-10-22T10:00:00Z")),
        },
        now,
      ),
    ).toBe("sinceTs must be strictly before uptoTs.");
    expect(
      reconcileWindowProblem(
        {
          sinceTs: new Date(iso("2026-06-01T00:00:00Z")),
          uptoTs: new Date(iso("2026-10-22T00:00:00Z")),
        },
        now,
      ),
    ).toBe("The reconciliation window must be at most 92 days.");
    expect(
      reconcileWindowProblem(
        {
          sinceTs: new Date(iso("2026-10-22T10:00:00Z")),
          uptoTs: new Date(iso("2026-10-22T12:00:10Z")),
        },
        now,
      ),
    ).toBe("uptoTs must not be in the future.");
    expect(new Date("invalid").getTime()).toBeNaN();
    expect(
      reconcileWindowProblem(
        { sinceTs: new Date("invalid"), uptoTs: new Date(iso("2026-10-22T11:00:00Z")) },
        now,
      ),
    ).toBe("Window bounds must be valid timestamps.");
  });

  it("rejects invalid windows at the core boundary with a typed error", async () => {
    const ws = await newWorkspace();
    await expect(
      reconcileWorkspace(
        ws.id,
        { sinceTs: new Date(Date.now() - 60_000), uptoTs: new Date(Date.now() + 60_000) },
        { sources: repoSources() },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("accepts the documented request schema shape and nothing else", () => {
    const good = RECONCILE_REQUEST_SCHEMA.safeParse({
      sinceTs: "2026-10-22T10:00:00.000Z",
      uptoTs: "2026-10-22T11:00:00.000Z",
      mode: "reconcile",
      note: "post-incident true-up",
    });
    expect(good.success).toBe(true);
    expect(
      RECONCILE_REQUEST_SCHEMA.safeParse({ sinceTs: "2026-10-22T10:00:00.000Z" }).success,
    ).toBe(false);
    expect(
      RECONCILE_REQUEST_SCHEMA.safeParse({ sinceTs: "nope", uptoTs: "2026-10-22T11:00:00.000Z" })
        .success,
    ).toBe(false);
    expect(
      RECONCILE_REQUEST_SCHEMA.safeParse({
        sinceTs: "2026-10-22T10:00:00.000Z",
        uptoTs: "2026-10-22T11:00:00.000Z",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      RECONCILE_REQUEST_SCHEMA.safeParse({
        sinceTs: "2026-10-22T10:00:00.000Z",
        uptoTs: "2026-10-22T11:00:00.000Z",
        mode: "nonsense",
      }).success,
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Zombie reserves (D-19)
// ───────────────────────────────────────────────────────────────────────────

d("zombie reserve detection (D-19)", () => {
  it("flags an unsettled hold older than the grace window and reports its run status", async () => {
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 50);
    const run = await server.deps.repos.runs.create(ws.id, {
      threadId: fx.threadId,
      projectId: fx.projectId,
      model: "studio-smart",
      reservedCredits: 10, // whole credits (D-12 row dialect — W3-b02)
    });
    await server.deps.repos.runs.update(ws.id, run.id, { status: "running" });
    await server.deps.repos.ledger.reserve(ws.id, {
      runId: run.id,
      amount: 10 * MICRO,
      idempotencyKey: `chat:${run.id}:reserve`,
    });

    // grace 0 → the hold is already stale
    const stale = await coreReport(ws, windowAround(t0), { zombieGraceMs: 0 });
    expect(codes(stale)).toEqual(["zombie_reserve"]);
    const zombie = stale.discrepancies[0];
    expect(zombie).toMatchObject({
      code: "zombie_reserve",
      runId: run.id,
      outstanding: 10 * MICRO,
      runStatus: "running",
    });
    expect(stale.ledger.outstandingReserves).toBe(10 * MICRO);
    expect(stale.balance).toBe(40 * MICRO);

    // default grace (30 min) → the same fresh hold is just live, not a zombie
    const fresh = await coreReport(ws, windowAround(t0));
    expect(codes(fresh)).toEqual([]);
    expect(fresh.ledger.outstandingReserves).toBe(10 * MICRO);

    // zombies are NEVER auto-released: reconcile mode adjusts nothing here
    const staleReconcile = await coreReport(ws, windowAround(t0), {
      zombieGraceMs: 0,
      mode: "reconcile",
    });
    expect(staleReconcile.action).toMatchObject({ attempted: false, skippedReason: "no_mismatch" });
    expect(await adjustEntries(ws)).toEqual([]);
  });

  it('reports a zombie whose run row is gone as status "missing"', async () => {
    const ws = await newWorkspace();
    const t0 = Date.now();
    await grant(ws, 20);
    // reserve accepts any runId (the ledger column has no FK) — the run row
    // simply does not exist, which is itself a reconciliation fact.
    const ghostRunId = `run_missing_${unique("ghost")}`;
    await server.deps.repos.ledger.reserve(ws.id, {
      runId: ghostRunId,
      amount: 5 * MICRO,
      idempotencyKey: unique("ghost-reserve"),
    });
    const report = await coreReport(ws, windowAround(t0), { zombieGraceMs: 0 });
    expect(codes(report)).toEqual(["zombie_reserve"]);
    expect(report.discrepancies[0]).toMatchObject({
      runId: ghostRunId,
      outstanding: 5 * MICRO,
      runStatus: "missing",
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Ledger-vs-usage mismatch + true-up (idempotent, D-12-safe)
// ───────────────────────────────────────────────────────────────────────────

d("ledger-vs-usage mismatch and the true-up action", () => {
  it("reports the drift (report mode never writes)", async () => {
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 100);
    const run = await seedCompletedRun(ws, fx, {
      reserve: 20 * MICRO,
      actual: 12 * MICRO,
      setRow: false,
    });

    const report = await coreReport(ws, windowAround(t0));
    expect(codes(report)).toEqual(["ledger_usage_mismatch"]);
    expect(discrepancyOf(report, "ledger_usage_mismatch")).toMatchObject({
      code: "ledger_usage_mismatch",
      ledgerCommitSum: 12 * MICRO,
      usageSum: 0,
      delta: -12 * MICRO,
      runsUsage: 0,
      rendersUsage: 0,
      runCount: 1,
      renderCount: 0,
    });
    expect(discrepancyOf(report, "ledger_usage_mismatch").runDrift).toEqual([
      { runId: run.runId, ledgerCommits: 12 * MICRO, rowCommitted: 0 },
    ]);
    expect(report.action).toMatchObject({ attempted: false, skippedReason: "report_only" });
    expect(await adjustEntries(ws)).toEqual([]);
  });

  it("W3-b02 regression pin: a turn-world run (whole-credit row vs µc ledger) is NOT a mismatch, and reconcile mode grants NOTHING back", async () => {
    // The w1-a27 S255 HIGH bug: the core folded the run row's WHOLE-CREDIT
    // committedCredits against µc ledger sums raw — every turn-world
    // workspace reported a spurious ledger_usage_mismatch, and a
    // reconcile-mode true-up adjustAmount ≈ +(commit − commit/10⁶) µc handed
    // the whole commit back as balance. The fixed core converts rows ×
    // 1_000_000 before folding (seedCompletedRun now seeds the row dialect
    // the real writers use, so this pin cannot be masked again).
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 100);
    await seedCompletedRun(ws, fx, { reserve: 20 * MICRO, actual: 12 * MICRO });

    const report = await coreReport(ws, windowAround(t0));
    expect(codes(report)).toEqual([]);
    expect(report.usage).toMatchObject({
      runs: { settledInWindow: 1, committedCredits: 12 * MICRO },
      usageSum: 12 * MICRO,
    });

    // Reconcile mode on a CLEAN window must be a no-op — the pre-fix core
    // would have "trued up" +(12M − 12) µc back into the balance.
    const reconcile = await coreReport(ws, windowAround(t0), { mode: "reconcile" });
    expect(reconcile.action).toMatchObject({ attempted: false, skippedReason: "no_mismatch" });
    expect(await adjustEntries(ws)).toEqual([]);
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(88 * MICRO);
  });

  it("true-ups once per (workspace, windowStart): same window replays, shifted window re-adjusts", async () => {
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 100);
    await seedCompletedRun(ws, fx, { reserve: 20 * MICRO, actual: 12 * MICRO, setRow: false });
    const window = windowAround(t0);

    const first = await coreReport(ws, window, { mode: "reconcile", note: "incident-42" });
    expect(first.action).toMatchObject({
      attempted: true,
      applied: true,
      replayed: false,
      adjustAmount: 12 * MICRO,
    });
    expect(first.action.balanceAfter).toBe(100 * MICRO); // 100M − 20M + 20M − 12M + 12M
    const adjusts = await adjustEntries(ws);
    expect(adjusts).toEqual([{ id: expect.any(String), amount: 12 * MICRO }]);

    // replaying the SAME window (same sinceTs ⇒ same idempotency key) is free
    const replay = await coreReport(ws, window, { mode: "reconcile" });
    expect(replay.action).toMatchObject({
      applied: true,
      replayed: true,
      adjustAmount: 12 * MICRO,
    });
    expect(await adjustEntries(ws)).toHaveLength(1);
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(100 * MICRO);

    // the true-up entry carries the reconciliation note + window metadata
    const listed = await server.deps.repos.ledger.list(ws.id, { kind: "adjust", limit: 100 });
    const metadata = listed.items[0]?.metadata as Record<string, unknown>;
    expect(metadata.kind).toBe("reconciliation_true_up");
    expect(metadata.note).toBe("incident-42");
    expect(metadata.windowStart).toBe(window.sinceTs.toISOString());
    expect(metadata.usageSum).toBe(0);
    expect(metadata.ledgerCommitSum).toBe(12 * MICRO);

    // a SHIFTED window start is a different idempotency key — the documented
    // operator-beware semantics (re-true-upping an overlapping window
    // double-adjusts the overlap; review before mode:"reconcile").
    const shifted = await coreReport(
      ws,
      {
        sinceTs: new Date(t0 - 3_600_000),
        uptoTs: new Date(Date.now() + 2_000),
      },
      { mode: "reconcile" },
    );
    expect(shifted.action).toMatchObject({ applied: true, replayed: false });
    expect(await adjustEntries(ws)).toHaveLength(2);
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(112 * MICRO);
  });

  it("the idempotency key is derived from (workspace, windowStart) only", () => {
    const since = new Date("2026-10-22T00:00:00.000Z");
    const a = reconcileAdjustIdempotencyKey("ws_alpha", since);
    expect(a).toBe(reconcileAdjustIdempotencyKey("ws_alpha", since));
    expect(a).not.toBe(reconcileAdjustIdempotencyKey("ws_beta", since));
    expect(a).not.toBe(reconcileAdjustIdempotencyKey("ws_alpha", new Date(since.getTime() + 1)));
    expect(a).toContain("recon:");
  });

  it("folds render usage into usageSum and charges the missing commit", async () => {
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 100);
    // M8-A/M8-G: a render row is pinned to a project version — seed one.
    const { version } = await server.deps.repos.versions.upload(ws.id, {
      projectId: fx.projectId,
      expectedVersionId: null,
      objectKey: `workspaces/${ws.id}/projects/${fx.projectId}/versions/seed/project.ecproj`,
      sha256: "seed",
      sizeBytes: 4,
      createdBy: ws.userId,
    });
    await server.deps.repos.renders.create(ws.id, {
      projectId: fx.projectId,
      versionId: version.id,
      compId: "comp-main",
      format: "mp4",
      credits: 3 * MICRO, // µc dialect — the usage side must match the ledger's
      createdBy: ws.userId,
    });

    const report = await coreReport(ws, windowAround(t0));
    expect(codes(report)).toEqual(["ledger_usage_mismatch"]);
    expect(report.discrepancies[0]).toMatchObject({
      ledgerCommitSum: 0,
      usageSum: 3 * MICRO,
      delta: 3 * MICRO,
      rendersUsage: 3 * MICRO,
      renderCount: 1,
    });

    const fixed = await coreReport(ws, windowAround(t0), { mode: "reconcile" });
    expect(fixed.action).toMatchObject({ applied: true, adjustAmount: -3 * MICRO });
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(97 * MICRO);
  });

  it("refuses a true-up that would make the balance negative (D-12)", async () => {
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 5);
    const run = await seedCompletedRun(ws, fx, {
      reserve: 3 * MICRO,
      actual: 2 * MICRO,
      setRow: false,
    });
    // the run row claims 12 credits committed (12M µc, D-12 row dialect)
    // while the ledger committed 2M µc → the true-up would charge 10M µc on
    // a balance of 3M µc → the ledger must refuse (D-12).
    await server.deps.repos.runs.update(ws.id, run.runId, { committedCredits: 12 });

    const report = await coreReport(ws, windowAround(t0), { mode: "reconcile" });
    expect(codes(report)).toEqual(["ledger_usage_mismatch"]);
    expect(report.discrepancies[0]).toMatchObject({ delta: 10 * MICRO });
    expect(report.action).toMatchObject({
      attempted: true,
      applied: false,
      adjustAmount: -10 * MICRO,
      skippedReason: "adjust_refused_by_ledger",
    });
    expect(await adjustEntries(ws)).toEqual([]);
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(3 * MICRO);
  });

  it("flags a negative balance as a critical discrepancy (D-12: must NEVER)", async () => {
    const ws = await newWorkspace();
    const t0 = Date.now();
    await grant(ws, 10);
    await server.deps.repos.ledger.adjust(ws.id, {
      amount: -15 * MICRO,
      idempotencyKey: unique("clawback"),
      allowNegativeBalance: true,
    });
    const report = await coreReport(ws, windowAround(t0));
    expect(codes(report)).toContain("negative_balance");
    expect(report.discrepancies[0]).toMatchObject({
      code: "negative_balance",
      balance: -5 * MICRO,
    });
    expect(report.balance).toBe(-5 * MICRO);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// External spend source (LiteLLM seam)
// ───────────────────────────────────────────────────────────────────────────

const SPEND_KEY = "sk-test-spend-credential-123456";
const SPEND_BASE_URL = "http://spend.invalid";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeSpendFetch(
  body: unknown,
  options: { status?: number; calls?: FetchCall[]; bodyText?: string } = {},
): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (options.calls !== undefined) {
      options.calls.push({ url: String(url), init: init ?? {} });
    }
    const text = options.bodyText ?? JSON.stringify(body);
    return new Response(text, { status: options.status ?? 200 });
  }) as typeof fetch;
}

function failingFetch(error: unknown, calls?: FetchCall[]): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (calls !== undefined) calls.push({ url: String(url), init: init ?? {} });
    throw error;
  }) as typeof fetch;
}

function spyLogger(): {
  logger: Logger;
  records: { msg: string; fields: Record<string, unknown> }[];
} {
  const records: { msg: string; fields: Record<string, unknown> }[] = [];
  const push = (msg: string, fields?: LogFields): void => {
    records.push({ msg, fields: (fields ?? {}) as Record<string, unknown> });
  };
  const logger: Logger = {
    debug: push,
    info: push,
    warn: push,
    error: push,
    child: () => logger,
  };
  return { logger, records };
}

/** Set LITELLM_SPEND_KEY for the duration of `run`, restoring the old value after. */
async function withSpendKey<T>(value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.LITELLM_SPEND_KEY;
  process.env.LITELLM_SPEND_KEY = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      // `delete` is the ONLY way to unset a process env var — assigning
      // undefined stores the STRING "undefined" (verified on this node),
      // which would pass the spend-key length check as a bogus credential.
      // biome-ignore lint/performance/noDelete: required for process.env
      delete process.env.LITELLM_SPEND_KEY;
    } else {
      process.env.LITELLM_SPEND_KEY = previous;
    }
  }
}

function litellmSource(fetchImpl: typeof fetch, logger?: Logger): LiteLLMSpendSource {
  return new LiteLLMSpendSource({
    baseUrl: SPEND_BASE_URL,
    spendApiKey: SPEND_KEY,
    fetchImpl,
    logger,
  });
}

// DIALECT NOTE (W3-b02, flipped): this section now seeds µc ledger
// magnitudes like every other section — the fixed core converts the
// credit-denominated spend (spendCreditsForModel, the M4-A math) to µc
// before comparing against the ledger commit sum, so a matching spend of
// 7 credits needs a 7_000_000 µc commit. The old RAW-credit seeds (grant
// 100 = 100 µc etc.) masked the unit mismatch the M6-K worklog flagged.

d("external spend source (LiteLLM seam)", () => {
  it("createSpendSource is null without a spend credential (the local reality)", async () => {
    await withSpendKey("", async () => {
      expect(
        createSpendSource({
          litellm: {
            baseUrl: SPEND_BASE_URL,
            apiKey: "x",
            virtualKey: undefined,
            modelMap: undefined,
          },
        }),
      ).toBeNull();
    });
    const previous = process.env.LITELLM_SPEND_KEY;
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets (see withSpendKey)
    delete process.env.LITELLM_SPEND_KEY;
    try {
      expect(
        createSpendSource({
          litellm: {
            baseUrl: SPEND_BASE_URL,
            apiKey: "x",
            virtualKey: undefined,
            modelMap: undefined,
          },
        }),
      ).toBeNull();
      expect(
        createSpendSource(
          {
            litellm: {
              baseUrl: SPEND_BASE_URL,
              apiKey: "x",
              virtualKey: undefined,
              modelMap: undefined,
            },
          },
          {
            spendApiKey: "sk-123",
          },
        ),
      ).toBeNull();
      expect(
        createSpendSource(
          {
            litellm: {
              baseUrl: SPEND_BASE_URL,
              apiKey: "x",
              virtualKey: undefined,
              modelMap: undefined,
            },
          },
          {
            spendApiKey: SPEND_KEY,
          },
        ),
      ).not.toBeNull();
    } finally {
      if (previous !== undefined) process.env.LITELLM_SPEND_KEY = previous;
    }
    await withSpendKey(SPEND_KEY, async () => {
      const source = createSpendSource({
        litellm: {
          baseUrl: SPEND_BASE_URL,
          apiKey: "x",
          virtualKey: undefined,
          modelMap: undefined,
        },
      });
      expect(source?.kind).toBe("litellm");
    });
  });

  it("converts per-model token totals with the catalog rates (the M4-A math)", () => {
    // 25k in × 0.1 + 9k out × 0.4 = 2.5 + 3.6 = 6.1 → ceil 7 (studio-smart)
    expect(spendCreditsForModel("studio-smart", 25_000, 9_000)).toBe(7);
    expect(spendCreditsForModel("studio-fast", 0, 0)).toBe(0);
    expect(spendCreditsForModel("studio-unknown-alias", 100_000, 100_000)).toBe(0);
    expect(MODEL_CATALOG["studio-smart"].creditsPer1kInput).toBe(0.1);
  });

  it("a matching external spend adds no discrepancy; the wire carries the key + window", async () => {
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 100);
    // µc ledger magnitudes (W3-b02): 7 credits committed = 7_000_000 µc —
    // what the fixed core compares the 7-credit spend against.
    await seedCompletedRun(ws, fx, { reserve: 12 * MICRO, actual: 7 * MICRO });
    const calls: FetchCall[] = [];
    const source = litellmSource(
      fakeSpendFetch(
        {
          data: [
            {
              model_name: "studio-smart",
              total_prompt_tokens: 25_000,
              total_completion_tokens: 9_000,
            },
          ],
        },
        { calls },
      ),
    );

    const window = windowAround(t0);
    const report = await coreReport(ws, window, { spend: source });
    expect(codes(report)).toEqual([]);
    expect(report.external).toMatchObject({ source: "litellm", spendCredits: 7, error: null });
    expect(report.external.perModel).toEqual([
      { model: "studio-smart", inputTokens: 25_000, outputTokens: 9_000, credits: 7 },
    ]);

    // the wire is real: admin route + ISO window bounds + bearer spend key
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/global/spend/models");
    expect(url.searchParams.get("start_date")).toBe(window.sinceTs.toISOString());
    expect(url.searchParams.get("end_date")).toBe(window.uptoTs.toISOString());
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${SPEND_KEY}`,
    );
  });

  it("detects a spend mismatch and leaks neither the key nor the URL", async () => {
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 100);
    await seedCompletedRun(ws, fx, { reserve: 12 * MICRO, actual: 7 * MICRO });
    const { logger, records } = spyLogger();
    const source = litellmSource(
      fakeSpendFetch({
        data: [
          {
            model_name: "studio-smart",
            total_prompt_tokens: 50_000,
            total_completion_tokens: 18_000,
          },
        ],
      }),
      logger,
    );

    const report = await coreReport(ws, windowAround(t0), { spend: source, logger });
    expect(codes(report)).toEqual(["external_spend_mismatch"]);
    expect(discrepancyOf(report, "external_spend_mismatch")).toMatchObject({
      code: "external_spend_mismatch",
      // µc ledger sum vs the 13-credit spend (13M µc) — delta in µc (W3-b02).
      ledgerCommitSum: 7 * MICRO,
      externalSpendCredits: 13,
      delta: 6 * MICRO,
    });
    expect(discrepancyOf(report, "external_spend_mismatch").byModel[0]).toMatchObject({
      model: "studio-smart",
      credits: 13,
    });

    // redaction (M4-A pattern): neither the report nor any log line carries
    // the spend credential or the upstream URL.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SPEND_KEY);
    expect(serialized).not.toContain(SPEND_BASE_URL);
    const serializedLogs = JSON.stringify(records);
    expect(serializedLogs).not.toContain(SPEND_KEY);
    expect(serializedLogs).not.toContain(SPEND_BASE_URL);
  });

  it("surfaces unmapped model aliases instead of silently billing them", async () => {
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 100);
    await seedCompletedRun(ws, fx, { reserve: 12 * MICRO, actual: 7 * MICRO });
    const source = litellmSource(
      fakeSpendFetch({
        data: [
          {
            model_name: "studio-smart-fallback",
            total_prompt_tokens: 1_000,
            total_completion_tokens: 0,
          },
        ],
      }),
    );
    const report = await coreReport(ws, windowAround(t0), { spend: source });
    expect(report.external.unknownModels).toEqual(["studio-smart-fallback"]);
    expect(report.external.spendCredits).toBe(0);
    expect(codes(report)).toEqual(["external_spend_mismatch"]);
  });

  it("maps every external failure to a typed, redacted reason and never throws", async () => {
    const window = windowAround(Date.now());
    const cases: { make: () => LiteLLMSpendSource; code: string }[] = [
      {
        make: () =>
          litellmSource(failingFetch(new TypeError("getaddrinfo ENOTFOUND spend.invalid"))),
        code: "unreachable",
      },
      {
        make: () =>
          litellmSource(
            failingFetch(
              new DOMException("The operation was aborted due to timeout", "TimeoutError"),
            ),
          ),
        code: "timeout",
      },
      {
        make: () => litellmSource(fakeSpendFetch({ data: [] }, { status: 401 })),
        code: "unauthorized",
      },
      {
        make: () => litellmSource(fakeSpendFetch({ data: [] }, { status: 500 })),
        code: "upstream_error",
      },
      {
        make: () =>
          litellmSource(
            fakeSpendFetch("<html>not json</html>", { bodyText: "<html>not json</html>" }),
          ),
        code: "bad_response",
      },
      {
        make: () => litellmSource(fakeSpendFetch({ unexpected: true })),
        code: "bad_response",
      },
    ];
    for (const testCase of cases) {
      const result = await testCase.make().spendForWindow(window);
      if (!result.ok) {
        expect(result.failure.code).toBe(testCase.code);
        expect(result.failure.reason.length).toBeGreaterThan(8);
        expect(JSON.stringify(result)).not.toContain(SPEND_KEY);
        expect(JSON.stringify(result)).not.toContain(SPEND_BASE_URL);
      } else {
        expect.unreachable("all cases must fail");
      }
    }
  });

  it("an absent source degrades the report to local-ledger-only", async () => {
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 30);
    await seedCompletedRun(ws, fx, { reserve: 5 * MICRO, actual: 4 * MICRO });
    const report = await coreReport(ws, windowAround(t0)); // no spend source
    expect(report.external).toEqual({
      source: "none",
      spendCredits: null,
      perModel: [],
      unknownModels: [],
      error: null,
    });
    expect(codes(report)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Route: POST /v1/credits/reconcile
// ───────────────────────────────────────────────────────────────────────────

interface RouteReport {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly replayHeader: string | null;
}

async function postReconcile(
  ws: Workspace | { jar: CookieJar; id: string },
  body: Record<string, unknown>,
  options: { key?: string; workspaceId?: string } = {},
): Promise<RouteReport> {
  const response = await api(server.base, "/v1/credits/reconcile", {
    method: "POST",
    jar: ws.jar,
    headers: {
      "x-workspace-id": options.workspaceId ?? ws.id,
      "idempotency-key": options.key ?? unique("reconcile"),
    },
    body,
  });
  const replayHeader = response.headers.get("x-idempotent-replay");
  const parsed = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: parsed, replayHeader };
}

function routeWindow(t0: number): { sinceTs: string; uptoTs: string } {
  return {
    sinceTs: new Date(t0 - 5_000).toISOString(),
    uptoTs: new Date(Date.now() + 4_000).toISOString(),
  };
}

d("route: POST /v1/credits/reconcile", () => {
  it("is admin-role gated, idempotency-key required, workspace-scoped", async () => {
    const ws = await newWorkspace();
    const t0 = Date.now();
    await grant(ws, 10);

    // no Idempotency-Key → the global POST middleware rejects
    const missing = await api(server.base, "/v1/credits/reconcile", {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
      body: routeWindow(t0),
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      "VALIDATION_FAILED",
    );

    // owner (= admin floor) reads the report
    const ok = await postReconcile(ws, routeWindow(t0));
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty("data");
    const report = ok.body.data as Record<string, unknown>;
    expect(report.workspaceId).toBe(ws.id);
    expect(report.external).toMatchObject({ source: "none" });

    // unauthenticated → 401
    const anonymous = await api(server.base, "/v1/credits/reconcile", {
      method: "POST",
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("anon") },
      body: routeWindow(t0),
    });
    expect(anonymous.status).toBe(401);
  });

  it("a viewer is FORBIDDEN; a stranger's workspace is NOT_FOUND (tenant isolation)", async () => {
    const owner = await newWorkspace();
    const t0 = Date.now();
    await grant(owner, 10);

    // invite a viewer (auth-workspace precedent) → within-workspace denial is 403
    const invitedEmail = uniqueEmail("viewer");
    const invite = await api(server.base, `/v1/workspaces/${owner.id}/invites`, {
      method: "POST",
      jar: owner.jar,
      headers: { "idempotency-key": unique("invite") },
      body: { email: invitedEmail, role: "viewer" },
    });
    expect(invite.status).toBe(201);
    const inviteBody = (await invite.json()) as { data: { id: string } };
    const viewerJar = new CookieJar();
    const signUp = await api(server.base, "/v1/auth/sign-up/email", {
      method: "POST",
      jar: viewerJar,
      body: { email: invitedEmail, password: "Passw0rd!longenough", name: "Viewer" },
    });
    expect(signUp.status).toBe(200);
    const accept = await api(server.base, `/v1/invites/${inviteBody.data.id}/accept`, {
      method: "POST",
      jar: viewerJar,
      headers: { "idempotency-key": unique("accept") },
      body: {},
    });
    expect(accept.status).toBe(200);
    const forbidden = await postReconcile({ jar: viewerJar, id: owner.id }, routeWindow(t0));
    expect(forbidden.status).toBe(403);
    expect((forbidden.body as { error: { code: string } }).error.code).toBe("FORBIDDEN");

    // another workspace's owner probing THIS workspace → 404, never 403 (law #3)
    const stranger = await newWorkspace();
    const cross = await postReconcile(stranger, routeWindow(t0), { workspaceId: owner.id });
    expect(cross.status).toBe(404);
    expect((cross.body as { error: { code: string } }).error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("replays byte-equal for the same Idempotency-Key", async () => {
    const ws = await newWorkspace();
    const t0 = Date.now();
    await grant(ws, 10);
    const key = unique("replay");
    const body = routeWindow(t0);
    const first = await postReconcile(ws, body, { key });
    const second = await postReconcile(ws, body, { key });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.replayHeader).toBe("true");
    expect(first.replayHeader).toBeNull();
  });

  it("validates the window bounds", async () => {
    const ws = await newWorkspace();
    const now = Date.now();
    const iso = (value: number): string => new Date(value).toISOString();
    const bad: (Record<string, unknown> | null)[] = [
      { sinceTs: iso(now), uptoTs: iso(now - 1_000) }, // unordered
      { sinceTs: iso(now - 1_000), uptoTs: iso(now + 60_000) }, // future
      { sinceTs: iso(now - 100 * 86_400_000), uptoTs: iso(now) }, // > 92 days
      { sinceTs: "nope", uptoTs: iso(now) }, // garbage
      { uptoTs: iso(now) }, // missing bound
      { sinceTs: iso(now - 60_000), uptoTs: iso(now), mode: "nonsense" }, // bad mode
      null, // no body at all
    ];
    for (const body of bad) {
      const result = await postReconcile(ws, body as Record<string, unknown>);
      expect(result.status).toBe(400);
      expect((result.body as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    }
  });

  it('serves a local-only report on this box (no spend credential, source "none")', async () => {
    const ws = await newWorkspace();
    const t0 = Date.now();
    await grant(ws, 10);
    const result = await postReconcile(ws, routeWindow(t0));
    expect(result.status).toBe(200);
    const report = result.body.data as ReconcileReport;
    expect(report.external.source).toBe("none");
    expect(report.mode).toBe("report");
    expect(report.ledger.grants).toBe(10 * MICRO);
  });

  it('writes the true-up only with mode "reconcile", ledger-idempotent per window', async () => {
    const ws = await newWorkspace();
    const fx = await newFixture(ws);
    const t0 = Date.now();
    await grant(ws, 100);
    await seedCompletedRun(ws, fx, {
      reserve: 20 * MICRO,
      actual: 12 * MICRO,
      setRow: false,
    });
    const body = { ...routeWindow(t0), mode: "reconcile" as const };

    // default report POST never writes
    const readOnly = await postReconcile(ws, { sinceTs: body.sinceTs, uptoTs: body.uptoTs });
    const readOnlyReport = readOnly.body.data as ReconcileReport;
    expect(readOnlyReport.action).toMatchObject({ attempted: false, skippedReason: "report_only" });
    expect(await adjustEntries(ws)).toEqual([]);

    // mode reconcile (fresh Idempotency-Key) → one adjust
    const applied = await postReconcile(ws, body);
    const appliedReport = applied.body.data as ReconcileReport;
    expect(appliedReport.action).toMatchObject({
      applied: true,
      replayed: false,
      adjustAmount: 12 * MICRO,
    });
    expect(await adjustEntries(ws)).toHaveLength(1);

    // same window, DIFFERENT route Idempotency-Key → the LEDGER-level key replays
    const replayed = await postReconcile(ws, body, { key: unique("reconcile-2") });
    const replayedReport = replayed.body.data as ReconcileReport;
    expect(replayedReport.action).toMatchObject({ applied: true, replayed: true });
    expect(await adjustEntries(ws)).toHaveLength(1);
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(100 * MICRO);
  });

  it("never leaks another workspace's rows into a report", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const t0 = Date.now();
    await grant(a, 100);
    await grant(b, 7);
    const bReport = (await postReconcile(b, routeWindow(t0))).body.data as ReconcileReport;
    expect(bReport.ledger).toMatchObject({ grants: 7 * MICRO, entryCount: 1, commits: 0 });
    expect(bReport.usage.usageSum).toBe(0);
    expect(JSON.stringify(bReport)).not.toContain(a.id);
    expect((await postReconcile(a, routeWindow(t0))).body.data as ReconcileReport).toMatchObject({
      ledger: { grants: 100 * MICRO },
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Sweep (cron/worker entry point)
// ───────────────────────────────────────────────────────────────────────────

d("runReconciliationSweep (operator cron entry point)", () => {
  it("sweeps every workspace serially, counts discrepancies and failures", async () => {
    const clean = await newWorkspace();
    const drifted = await newWorkspace();
    const fx = await newFixture(drifted);
    const t0 = Date.now();
    await grant(clean, 5);
    await grant(drifted, 100);
    await seedCompletedRun(drifted, fx, {
      reserve: 20 * MICRO,
      actual: 12 * MICRO,
      setRow: false,
    });

    const { logger, records } = spyLogger();
    const summary = await runReconciliationSweep({
      repos: server.deps.repos,
      workspaceIds: [clean.id, drifted.id, "ws_nonexistent"],
      window: windowAround(t0),
      zombieGraceMs: 0,
      logger,
    });
    expect(summary.workspacesChecked).toBe(3);
    expect(summary.workspacesWithDiscrepancies).toBe(1);
    expect(summary.workspacesFailed).toBe(0);
    const perWorkspace = new Map(summary.results.map((entry) => [entry.workspaceId, entry]));
    expect(perWorkspace.get(clean.id)?.failure).toBeNull();
    expect(perWorkspace.get(clean.id)?.report?.discrepancies).toEqual([]);
    const driftedReport = perWorkspace.get(drifted.id)?.report;
    expect(driftedReport).not.toBeNull();
    expect(driftedReport?.discrepancies[0]).toMatchObject({
      code: "ledger_usage_mismatch",
      delta: -12 * MICRO,
    });
    // an unknown workspace reconciles empty (repos read as empty/0), never throws
    expect(perWorkspace.get("ws_nonexistent")?.report?.ledger.entryCount).toBe(0);
    expect(records.filter((record) => record.msg === "reconcile_completed")).toHaveLength(3);
  });

  it("a failing workspace never aborts the sweep (typed failure entry)", async () => {
    const ok = await newWorkspace();
    const t0 = Date.now();
    await grant(ok, 5);
    const exploding: ReconcileSources = {
      ...repoSources(),
      ledgerScan: async () => {
        throw new StudioError("VALIDATION_FAILED", { message: "boom" });
      },
    };
    const summary = await runReconciliationSweep({
      repos: server.deps.repos,
      sources: exploding,
      workspaceIds: [ok.id, ok.id],
      window: windowAround(t0),
    });
    expect(summary.workspacesChecked).toBe(2);
    expect(summary.workspacesFailed).toBe(2);
    expect(summary.results[0]).toMatchObject({
      workspaceId: ok.id,
      report: null,
      failure: "workspace_reconcile_failed",
    });
  });
});
