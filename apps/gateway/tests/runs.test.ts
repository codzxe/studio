// Runs routes tests — deterministic fakes, no network, no DB (AGENTS.md test
// rules). Covers the §3.3 create lifecycle, §3.4 idempotency (replay, unique-
// violation race, cross-org key), §14.2 402 gate, §3.4 cancel (happy, terminal
// reject, event resilience) and §15.1 tenant scoping.
//
// The billing fake is the REAL @studio/billing domain over an in-memory
// LedgerStore (billingFromLedger), so reserve/release semantics — including
// the `${runId}:phase` idempotency keys — are exercised, not stubbed.

import { isTerminal } from "@studio/agent";
import type { CreditLedgerEntry, CreditLedgerKind, LedgerStore } from "@studio/billing";
import { err, ok, type Result } from "@studio/config";
import type { AgentRun, AgentStep, NewAgentRun, RunError, RunStatus } from "@studio/db";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { gatewayTransportSchema } from "../src/env.js";
import { mountRunRoutes } from "../src/routes/runs.js";
import {
  billingFromLedger,
  type AuthLike,
  type DocumentRef,
  type EnqueueLike,
  type EventBusLike,
  type RunCaller,
  type RunEnqueuePayload,
  type RunPage,
  type RunPageCursor,
  type RunsDeps,
  type RunsStore,
} from "../src/services/runs.js";

// --- fixtures ------------------------------------------------------------------

const ORG_A = "org-a";
const ORG_B = "org-b";
const DOC_A = "doc-a";
const DOC_B = "doc-b";
const TOKEN_A = "token-a";
const TOKEN_B = "token-b";
const USER_A = "user-a";
const USER_B = "user-b";

/** §13.3 flat error envelope (W1-H error mapper shape). */
interface Envelope {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
}

/** Postgres unique-violation stand-in (23505) — walks the same cause chain. */
class UniqueViolationError extends Error {
  readonly code = "23505";

  constructor(message: string) {
    super(message);
    this.name = "UniqueViolationError";
  }
}

class FakeLedgerStore implements LedgerStore {
  private readonly rows: CreditLedgerEntry[] = [];
  private readonly seen = new Set<string>();

  async append(entry: CreditLedgerEntry): Promise<void> {
    if (!Number.isSafeInteger(entry.delta)) {
      throw new Error(`fake ledger: bad delta ${entry.delta}`);
    }
    const composite = `${entry.idempotencyKey}\u0000${entry.kind}`;
    if (this.seen.has(composite)) {
      // Mirrors the DB unique(idempotency_key, kind) index — §14.2 rule 6.
      throw new Error(`fake ledger: duplicate append (${composite})`);
    }
    this.seen.add(composite);
    this.rows.push({ ...entry });
  }

  async balanceAfter(organizationId: string): Promise<number> {
    let sum = 0;
    for (const row of this.rows) {
      if (row.organizationId === organizationId) {
        sum += row.delta;
      }
    }
    return sum;
  }

  async findByIdempotency(idempotencyKey: string, kind: CreditLedgerKind): Promise<boolean> {
    return this.seen.has(`${idempotencyKey}\u0000${kind}`);
  }

  entriesOfKind(kind: CreditLedgerKind, organizationId?: string): readonly CreditLedgerEntry[] {
    return this.rows.filter(
      (row) =>
        row.kind === kind && (organizationId === undefined || row.organizationId === organizationId),
    );
  }
}

class FakeAuth implements AuthLike {
  constructor(private readonly callers: ReadonlyMap<string, RunCaller>) {}

  async authenticate(request: Request): Promise<Result<RunCaller>> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const caller = this.callers.get(token);
    if (caller === undefined) {
      return err("unauthorized", "Missing or invalid credentials.", {
        hint: "Send Authorization: Bearer <token>.",
      });
    }
    return ok(caller);
  }
}

class FakeEnqueue implements EnqueueLike {
  readonly calls: { queue: string; payload: RunEnqueuePayload; jobId: string }[] = [];
  failNext = false;

  async enqueue(
    queue: string,
    payload: RunEnqueuePayload,
    options: { readonly jobId: string },
  ): Promise<Result<{ readonly jobId: string }>> {
    this.calls.push({ queue, payload, jobId: options.jobId });
    if (this.failNext) {
      this.failNext = false;
      return err("engine_unavailable", "The queue broker is unavailable.", { retryable: true });
    }
    return ok({ jobId: options.jobId });
  }
}

class FakeEvents implements EventBusLike {
  readonly cancelled: { organizationId: string; runId: string; reason: string }[] = [];
  failNext = false;

  async runCancelled(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly reason: string;
  }): Promise<Result<{ readonly seq: number }>> {
    this.cancelled.push({ ...input });
    if (this.failNext) {
      this.failNext = false;
      return err("storage_error", "The event store is unavailable.", { retryable: true });
    }
    return ok({ seq: this.cancelled.length });
  }
}

class FakeRunsStore implements RunsStore {
  private readonly runs: AgentRun[] = [];
  private readonly steps: AgentStep[] = [];
  private readonly documents = new Map<string, DocumentRef>();
  missIdempotencyLookups = 0;

  seedDocument(organizationId: string, documentId: string, currentRevision: number): void {
    this.documents.set(`${organizationId}:${documentId}`, { currentRevision, archived: false });
  }

  allRuns(): readonly AgentRun[] {
    return [...this.runs];
  }

  async findDocument(organizationId: string, documentId: string): Promise<DocumentRef | null> {
    return this.documents.get(`${organizationId}:${documentId}`) ?? null;
  }

  async findByIdempotency(organizationId: string, idempotencyKey: string): Promise<AgentRun | null> {
    if (this.missIdempotencyLookups > 0) {
      this.missIdempotencyLookups -= 1;
      return null;
    }
    return (
      this.runs.find(
        (run) => run.organizationId === organizationId && run.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async insertRun(row: NewAgentRun): Promise<AgentRun> {
    const run = FakeRunsStore.materialize(row);
    // Mirrors the agent_runs.idempotency_key UNIQUE index (W1-E) — global,
    // the §3.4 backstop under concurrency.
    if (this.runs.some((existing) => existing.idempotencyKey === run.idempotencyKey)) {
      throw new UniqueViolationError(`idempotency_key already taken`);
    }
    this.runs.push(run);
    return run;
  }

  async getRun(organizationId: string, runId: string): Promise<AgentRun | null> {
    return this.runs.find((run) => run.organizationId === organizationId && run.id === runId) ?? null;
  }

  async listRuns(query: {
    readonly organizationId: string;
    readonly documentId?: string;
    readonly limit: number;
    readonly before?: RunPageCursor;
  }): Promise<RunPage> {
    let rows = this.runs.filter((run) => run.organizationId === query.organizationId);
    if (query.documentId !== undefined) {
      rows = rows.filter((run) => run.documentId === query.documentId);
    }
    rows.sort((left, right) => {
      const delta = right.createdAt.getTime() - left.createdAt.getTime();
      return delta !== 0 ? delta : left.id < right.id ? 1 : -1;
    });
    const before = query.before;
    if (before !== undefined) {
      rows = rows.filter(
        (run) =>
          run.createdAt.getTime() < before.createdAt.getTime() ||
          (run.createdAt.getTime() === before.createdAt.getTime() && run.id < before.id),
      );
    }
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      rows: page,
      ...(rows.length > query.limit && last !== undefined
        ? { next: { createdAt: last.createdAt, id: last.id } }
        : {}),
    };
  }

  async listSteps(organizationId: string, runId: string): Promise<readonly AgentStep[]> {
    return this.steps
      .filter((step) => step.organizationId === organizationId && step.runId === runId)
      .sort((left, right) => left.seq - right.seq);
  }

  async transitionStatus(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly from: readonly RunStatus[];
    readonly to: RunStatus;
    readonly error?: RunError;
  }): Promise<AgentRun | null> {
    const index = this.runs.findIndex(
      (run) => run.organizationId === input.organizationId && run.id === input.runId,
    );
    const current = index === -1 ? undefined : this.runs[index];
    if (current === undefined || !input.from.includes(current.status)) {
      return null;
    }
    const updated: AgentRun = {
      ...current,
      status: input.to,
      ...(isTerminal(input.to) ? { finishedAt: new Date() } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };
    this.runs[index] = updated;
    return updated;
  }

  /** Fills the DB defaults a real insert would apply (W1-E schema). */
  private static materialize(row: NewAgentRun): AgentRun {
    const now = new Date();
    return {
      id: row.id ?? `run-${randomUUID()}`,
      organizationId: row.organizationId,
      documentId: row.documentId,
      userId: row.userId,
      prompt: row.prompt,
      tier: row.tier,
      status: row.status ?? "queued",
      idempotencyKey: row.idempotencyKey,
      plan: row.plan ?? null,
      revisionBefore: row.revisionBefore,
      revisionAfter: row.revisionAfter ?? null,
      creditsReserved: row.creditsReserved ?? 0,
      creditsCharged: row.creditsCharged ?? 0,
      tokensIn: row.tokensIn ?? 0,
      tokensOut: row.tokensOut ?? 0,
      cacheHits: row.cacheHits ?? 0,
      modelCalls: row.modelCalls ?? {},
      costMicroUsd: row.costMicroUsd ?? 0,
      error: row.error ?? null,
      startedAt: row.startedAt ?? null,
      finishedAt: row.finishedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }
}

interface Harness {
  readonly ledger: FakeLedgerStore;
  readonly store: FakeRunsStore;
  readonly enqueue: FakeEnqueue;
  readonly events: FakeEvents;
  readonly app: ReturnType<typeof buildApp>;
}

function makeHarness(): Harness {
  const ledger = new FakeLedgerStore();
  const store = new FakeRunsStore();
  store.seedDocument(ORG_A, DOC_A, 7);
  store.seedDocument(ORG_B, DOC_B, 3);
  const auth = new FakeAuth(
    new Map<string, RunCaller>([
      [TOKEN_A, { userId: USER_A, organizationId: ORG_A }],
      [TOKEN_B, { userId: USER_B, organizationId: ORG_B }],
    ]),
  );
  const enqueue = new FakeEnqueue();
  const events = new FakeEvents();
  const deps: RunsDeps = {
    auth,
    billing: billingFromLedger(ledger),
    store,
    enqueue,
    events,
  };
  const app = buildApp({
    env: gatewayTransportSchema.parse({}),
    logger: pino({ enabled: false }),
    version: "0.0.0-test",
    probes: [],
    startedAt: Date.now(),
    mount: (root) => {
      mountRunRoutes(root, deps);
    },
  });
  return { ledger, store, enqueue, events, app };
}

async function seed(harness: Harness, organizationId: string, credits: number): Promise<void> {
  await harness.ledger.append({
    organizationId,
    delta: credits,
    kind: "grant",
    idempotencyKey: `grant:${organizationId}:${randomUUID()}`,
  });
}

function jsonHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra };
}

async function createRun(
  harness: Harness,
  body: Record<string, unknown>,
  options: { token?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return harness.app.request("/v1/runs", {
    method: "POST",
    headers: jsonHeaders(options.token ?? TOKEN_A, options.headers ?? {}),
    body: JSON.stringify(body),
  });
}

async function authed(
  harness: Harness,
  path: string,
  init: { method: string; token?: string; body?: string } = { method: "GET" },
): Promise<Response> {
  return harness.app.request(path, {
    method: init.method,
    headers: jsonHeaders(init.token ?? TOKEN_A, init.body === undefined ? {} : {}),
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

// --- §3.3 create -------------------------------------------------------------

describe("POST /v1/runs (§3.3 lifecycle)", () => {
  it("reserves, inserts queued with revision_before, enqueues with jobId=runId", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);

    const res = await createRun(
      harness,
      {
        documentId: DOC_A,
        prompt: "Make the badge red and tighten the headline",
        tier: "standard",
        templateId: "instagram-post@3",
        assetIds: ["asset-1"],
      },
      { headers: { "idempotency-key": "key-1" } },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      run_id: string;
      status: string;
      credits_reserved: number;
    };
    expect(body.status).toBe("queued");
    expect(body.credits_reserved).toBe(2); // §5.2 standard tier

    // §14.2 rule 1: one reserve hold of the tier base.
    const reserves = harness.ledger.entriesOfKind("reserve", ORG_A);
    expect(reserves).toHaveLength(1);
    expect(reserves[0]?.delta).toBe(-2);
    expect(reserves[0]?.runId).toBe(body.run_id);

    // Enqueue contract (apps/worker/src/queues.ts): runs:<tier>, jobId=runId.
    expect(harness.enqueue.calls).toHaveLength(1);
    expect(harness.enqueue.calls[0]?.queue).toBe("runs:standard");
    expect(harness.enqueue.calls[0]?.jobId).toBe(body.run_id);
    expect(harness.enqueue.calls[0]?.payload.runId).toBe(body.run_id);
    expect(harness.enqueue.calls[0]?.payload.organizationId).toBe(ORG_A);
    expect(harness.enqueue.calls[0]?.payload.tier).toBe("standard");
    expect(harness.enqueue.calls[0]?.payload.templateId).toBe("instagram-post@3");
    expect(harness.enqueue.calls[0]?.payload.assetIds).toEqual(["asset-1"]);

    // §5.6: the run row pins the document's current revision.
    const run = await harness.store.getRun(ORG_A, body.run_id);
    expect(run?.status).toBe("queued");
    expect(run?.revisionBefore).toBe(7);
    expect(run?.userId).toBe(USER_A);
  });

  it("premium tier maps to the premium queue and ×2 standard credits", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const res = await createRun(
      harness,
      { documentId: DOC_A, prompt: "Rework the hero", tier: "premium" },
      { headers: { "idempotency-key": "key-premium" } },
    );
    const body = (await res.json()) as { credits_reserved: number };
    expect(res.status).toBe(201);
    expect(body.credits_reserved).toBe(4); // §14.4: premium = standard ×2
    expect(harness.enqueue.calls[0]?.queue).toBe("runs:premium");
  });

  it("same idempotency key returns the SAME run and never double-charges (§3.4)", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);

    const first = await createRun(
      harness,
      { documentId: DOC_A, prompt: "first attempt", tier: "standard" },
      { headers: { "idempotency-key": "replay-key" } },
    );
    const firstBody = (await first.json()) as { run_id: string };
    expect(first.status).toBe(201);

    const second = await createRun(
      harness,
      { documentId: DOC_A, prompt: "first attempt", tier: "standard" },
      { headers: { "idempotency-key": "replay-key" } },
    );
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { run_id: string };
    expect(secondBody.run_id).toBe(firstBody.run_id);

    expect(harness.ledger.entriesOfKind("reserve")).toHaveLength(1);
    expect(harness.enqueue.calls).toHaveLength(1);
    expect(harness.store.allRuns()).toHaveLength(1);
  });

  it("body idempotencyKey and Idempotency-Key header must agree", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const res = await createRun(
      harness,
      { documentId: DOC_A, prompt: "x", tier: "quick", idempotencyKey: "from-body" },
      { headers: { "idempotency-key": "from-header" } },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("validation_failed");
    expect(harness.store.allRuns()).toHaveLength(0);
  });

  it("idempotency key in the body alone is accepted", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const res = await createRun(harness, {
      documentId: DOC_A,
      prompt: "x",
      tier: "quick",
      idempotencyKey: "body-only-key",
    });
    expect(res.status).toBe(201);
  });

  it("missing idempotency key → 422 before anything is charged", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const res = await createRun(harness, { documentId: DOC_A, prompt: "x", tier: "quick" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("validation_failed");
    expect(body.hint).toContain("Idempotency-Key");
    expect(harness.ledger.entriesOfKind("reserve")).toHaveLength(0);
    expect(harness.store.allRuns()).toHaveLength(0);
  });

  it("concurrent same-key create: the loser releases its hold and replays the winner (§3.4)", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);

    const first = await createRun(
      harness,
      { documentId: DOC_A, prompt: "race", tier: "standard" },
      { headers: { "idempotency-key": "race-key" } },
    );
    const firstBody = (await first.json()) as { run_id: string };

    // Simulate the pre-check missing the winner (a concurrent request in flight).
    harness.store.missIdempotencyLookups = 1;
    const second = await createRun(
      harness,
      { documentId: DOC_A, prompt: "race", tier: "standard" },
      { headers: { "idempotency-key": "race-key" } },
    );
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { run_id: string };
    expect(secondBody.run_id).toBe(firstBody.run_id);

    // Two reserve attempts, exactly one refund compensation, net hold = 2.
    expect(harness.ledger.entriesOfKind("reserve", ORG_A)).toHaveLength(2);
    expect(harness.ledger.entriesOfKind("refund", ORG_A)).toHaveLength(1);
    expect(await harness.ledger.balanceAfter(ORG_A)).toBe(28);
    expect(harness.store.allRuns()).toHaveLength(1);
    expect(harness.enqueue.calls).toHaveLength(1);
  });

  it("another org holding the same key → 409, both orgs' holds settled", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    await seed(harness, ORG_B, 30);

    const first = await createRun(
      harness,
      { documentId: DOC_A, prompt: "mine", tier: "quick" },
      { headers: { "idempotency-key": "shared-key" } },
    );
    expect(first.status).toBe(201);

    harness.store.missIdempotencyLookups = 1;
    const second = await createRun(
      harness,
      { documentId: DOC_B, prompt: "theirs", tier: "quick" },
      { token: TOKEN_B, headers: { "idempotency-key": "shared-key" } },
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as Envelope;
    expect(body.code).toBe("conflict");

    // Org B's loser hold was released in full; org A still holds its run.
    expect(harness.ledger.entriesOfKind("refund", ORG_B)).toHaveLength(1);
    expect(await harness.ledger.balanceAfter(ORG_B)).toBe(30);
    expect(await harness.ledger.balanceAfter(ORG_A)).toBe(29);
  });

  it("insufficient credits → 402 typed envelope and the run never starts (§14.2 rule 1)", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 1); // standard run needs 2

    const res = await createRun(
      harness,
      { documentId: DOC_A, prompt: "x", tier: "standard" },
      { headers: { "idempotency-key": "broke-key" } },
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("insufficient_credits");
    expect(body.hint).toContain("Top up");

    expect(harness.ledger.entriesOfKind("reserve")).toHaveLength(0);
    expect(harness.enqueue.calls).toHaveLength(0);
    expect(harness.store.allRuns()).toHaveLength(0);
  });

  it("enqueue failure → 503, run flips to failed with a typed error, hold released", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    harness.enqueue.failNext = true;

    const res = await createRun(
      harness,
      { documentId: DOC_A, prompt: "x", tier: "standard" },
      { headers: { "idempotency-key": "queue-down" } },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("engine_unavailable");
    expect(body.retryable).toBe(true);

    const runs = harness.store.allRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error?.code).toBe("queue_unavailable");
    expect(harness.ledger.entriesOfKind("refund", ORG_A)).toHaveLength(1);
    expect(await harness.ledger.balanceAfter(ORG_A)).toBe(30);
  });

  it("malformed JSON body → 400 validation envelope", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const res = harness.app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(TOKEN_A, { "idempotency-key": "k" }),
      body: "{not json",
    });
    const awaited = await res;
    expect(awaited.status).toBe(400);
    const body = (await awaited.json()) as Envelope;
    expect(body.code).toBe("validation_failed");
  });

  it("schema violations → 422 (oversized prompt, unknown tier, unknown field)", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const oversized = await createRun(
      harness,
      { documentId: DOC_A, prompt: "x".repeat(8001), tier: "quick" },
      { headers: { "idempotency-key": "k1" } },
    );
    expect(oversized.status).toBe(422);

    // image_gen tiers are image-queue jobs, not agent runs (§5.2) — rejected.
    const badTier = await createRun(
      harness,
      { documentId: DOC_A, prompt: "x", tier: "image_gen" },
      { headers: { "idempotency-key": "k2" } },
    );
    expect(badTier.status).toBe(422);

    const unknownField = await createRun(
      harness,
      { documentId: DOC_A, prompt: "x", tier: "quick", model: "gpt-9" },
      { headers: { "idempotency-key": "k3" } },
    );
    expect(unknownField.status).toBe(422);
    expect(harness.store.allRuns()).toHaveLength(0);
  });
});

// --- GET detail + list -------------------------------------------------------

describe("GET /v1/runs (§13.1)", () => {
  it("returns status, plan, cost and steps summary for one run", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const create = await createRun(
      harness,
      { documentId: DOC_A, prompt: "detail me", tier: "standard" },
      { headers: { "idempotency-key": "detail-key" } },
    );
    const created = (await create.json()) as { run_id: string };

    const res = await authed(harness, `/v1/runs/${created.run_id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run_id: string;
      status: string;
      tier: string;
      document_id: string;
      revision_before: number;
      revision_after: number | null;
      plan: unknown;
      error: { code: string } | null;
      cost: { credits_reserved: number; credits_charged: number };
      steps: readonly unknown[];
    };
    expect(body.run_id).toBe(created.run_id);
    expect(body.status).toBe("queued");
    expect(body.tier).toBe("standard");
    expect(body.document_id).toBe(DOC_A);
    expect(body.revision_before).toBe(7);
    expect(body.revision_after).toBeNull();
    expect(body.plan).toBeNull();
    expect(body.error).toBeNull();
    expect(body.cost.credits_reserved).toBe(2);
    expect(body.cost.credits_charged).toBe(0);
    expect(body.steps).toEqual([]);
  });

  it("unknown run id → 404 typed envelope", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const res = await authed(harness, "/v1/runs/run-does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("not_found");
  });

  it("pages org-scoped runs by keyset cursor and filters by document_id", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    for (const key of ["page-1", "page-2", "page-3"]) {
      const res = await createRun(
        harness,
        { documentId: DOC_A, prompt: `run ${key}`, tier: "quick" },
        { headers: { "idempotency-key": key } },
      );
      expect(res.status).toBe(201);
    }

    const firstPage = (await (
      await authed(harness, "/v1/runs?limit=2")
    ).json()) as { runs: { run_id: string }[]; next_cursor?: string };
    expect(firstPage.runs).toHaveLength(2);
    expect(firstPage.next_cursor).toBeDefined();

    const secondPage = (await (
      await authed(harness, `/v1/runs?limit=2&cursor=${firstPage.next_cursor}`)
    ).json()) as { runs: { run_id: string }[]; next_cursor?: string };
    expect(secondPage.runs).toHaveLength(1);
    expect(secondPage.next_cursor).toBeUndefined();

    const firstIds = new Set(firstPage.runs.map((run) => run.run_id));
    expect(secondPage.runs.every((run) => !firstIds.has(run.run_id))).toBe(true);

    const filtered = (await (
      await authed(harness, `/v1/runs?document_id=${DOC_B}`)
    ).json()) as { runs: unknown[] };
    expect(filtered.runs).toHaveLength(0);

    const otherOrg = (await (
      await authed(harness, "/v1/runs", { method: "GET", token: TOKEN_B })
    ).json()) as { runs: unknown[] };
    expect(otherOrg.runs).toHaveLength(0);
  });

  it("malformed cursor → 422 validation envelope", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const res = await authed(harness, "/v1/runs?cursor=%2A%2A%2A");
    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("validation_failed");
  });
});

// --- cancel ------------------------------------------------------------------

describe("POST /v1/runs/:id/cancel (§3.4)", () => {
  async function createQueuedRun(harness: Harness): Promise<string> {
    const res = await createRun(
      harness,
      { documentId: DOC_A, prompt: "cancel target", tier: "standard" },
      { headers: { "idempotency-key": `cancel-${randomUUID()}` } },
    );
    const body = (await res.json()) as { run_id: string };
    return body.run_id;
  }

  it("flips queued → cancelled, releases the full reservation, emits run.cancelled", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const runId = await createQueuedRun(harness);

    const res = await authed(harness, `/v1/runs/${runId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run_id: string;
      status: string;
      credits_refunded: number;
    };
    expect(body.run_id).toBe(runId);
    expect(body.status).toBe("cancelled");
    expect(body.credits_refunded).toBe(2); // §14.2 rule 3: full release

    const run = await harness.store.getRun(ORG_A, runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.finishedAt).not.toBeNull();

    const refunds = harness.ledger.entriesOfKind("refund", ORG_A);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.runId).toBe(runId);
    expect(await harness.ledger.balanceAfter(ORG_A)).toBe(30);

    expect(harness.events.cancelled).toEqual([
      { organizationId: ORG_A, runId, reason: "user_cancel" },
    ]);
  });

  it("accepts an explicit reason and carries it on the run.cancelled event", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const runId = await createQueuedRun(harness);
    const res = await authed(harness, `/v1/runs/${runId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "too slow" }),
    });
    expect(res.status).toBe(200);
    expect(harness.events.cancelled[0]?.reason).toBe("too slow");
  });

  it("a terminal run cannot be cancelled again → 409 conflict (§5.1)", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const runId = await createQueuedRun(harness);

    const first = await authed(harness, `/v1/runs/${runId}/cancel`, { method: "POST" });
    expect(first.status).toBe(200);

    const second = await authed(harness, `/v1/runs/${runId}/cancel`, { method: "POST" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as Envelope;
    expect(body.code).toBe("conflict");

    // Still exactly one release, one event — §3.4 idempotency end to end.
    expect(harness.ledger.entriesOfKind("refund", ORG_A)).toHaveLength(1);
    expect(harness.events.cancelled).toHaveLength(1);
  });

  it("a failed event append never fails the cancel (§22 durable, retryable)", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const runId = await createQueuedRun(harness);
    harness.events.failNext = true;

    const res = await authed(harness, `/v1/runs/${runId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credits_refunded: number };
    expect(body.credits_refunded).toBe(2);
    expect((await harness.store.getRun(ORG_A, runId))?.status).toBe("cancelled");
  });

  it("unknown run id → 404", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const res = await authed(harness, "/v1/runs/run-nope/cancel", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// --- auth + tenant guards (§15.1) -------------------------------------------

describe("auth and tenant guards", () => {
  it("no credentials → 401 typed envelope", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const res = harness.app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k" },
      body: JSON.stringify({ documentId: DOC_A, prompt: "x", tier: "quick" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("unauthorized");
  });

  it("org B cannot read, list or cancel org A's run — cross-tenant is 404 (§12.2)", async () => {
    const harness = makeHarness();
    await seed(harness, ORG_A, 30);
    const create = await createRun(
      harness,
      { documentId: DOC_A, prompt: "secret", tier: "quick" },
      { headers: { "idempotency-key": "tenant-key" } },
    );
    const created = (await create.json()) as { run_id: string };

    const read = await authed(harness, `/v1/runs/${created.run_id}`, {
      method: "GET",
      token: TOKEN_B,
    });
    expect(read.status).toBe(404);

    const cancel = await authed(harness, `/v1/runs/${created.run_id}/cancel`, {
      method: "POST",
      token: TOKEN_B,
    });
    expect(cancel.status).toBe(404);
    expect(harness.events.cancelled).toHaveLength(0);
    expect(harness.ledger.entriesOfKind("refund", ORG_A)).toHaveLength(0);

    // A foreign document id is indistinguishable from a missing one.
    const foreignDoc = await createRun(
      harness,
      { documentId: DOC_A, prompt: "hijack", tier: "quick" },
      { token: TOKEN_B, headers: { "idempotency-key": "tenant-2" } },
    );
    expect(foreignDoc.status).toBe(404);
    expect(harness.store.allRuns()).toHaveLength(1);
  });
});
