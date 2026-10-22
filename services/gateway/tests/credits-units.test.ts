// M6-K — the µc UNIFICATION journey proof (F-J1 fix, DECISIONS D-12).
//
// THE BUG THIS FILE PINS AS FIXED: the chat/run path used to write
// WHOLE-CREDIT magnitudes into the MICROcredit ledger (reserve −2, commit −1,
// refund +2 while billing grants are µc: 100 credits = 100_000_000). A run on
// a µc-granted workspace therefore undercharged ~1,000,000× — a 7-credit
// commit charged 7 µc. The route now converts at the ledger boundary
// (credits-display.ts): reserve/commit/refund are whole credits × 1_000_000,
// while the run ROW and the §7.4 SSE `credits` event stay whole credits
// (display units, per the D-12 row + display rulings).
//
// The unit-conservation chain proven here (topup/billing scale → the wire):
//   µc grant (100_000_000) → chat run completes →
//   ledger entries are EXACT µc (reserve −2_000_000, commit −1_000_000,
//   refund +2_000_000; the run nets −1_000_000 µc) →
//   the SSE `credits` event is whole-credit EXACT (reserved 2, committed 1,
//   balance 99 — the D-12 2-decimal display conversion of the µc balance) →
//   the raw ledger balance is 99_000_000 µc → GET /v1/credits surfaces the
//   SAME µc number (the documented raw-µc wire contract, "the same units as
//   GET /v1/billing/state"), whose D-12 display conversion equals the SSE
//   event's balance — the two display surfaces cannot disagree.
//
// Also pinned: the odd-µc balance (3_999_999 µc) displays rounded to 2
// decimals (4) while every ledger row stays the exact integer; a cancelled run
// refunds the FULL µc hold and nets exactly 0.
//
// Boot: the full gateway (buildApp + real Postgres + Better Auth) with the
// DEFAULT MockRunner (MOCK_MODEL=true — deterministic, no fake model server
// needed): a short message estimates 1.5 credits → the §8.8 reserve is
// ceil(1.5 × 1.2) = 2 credits; the MockRunner commits ceil(2 / 2) = 1 credit.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { STUDIO_STREAM_EVENT_SCHEMA, type StudioStreamEvent } from "@studio/contracts";

import {
  MICROCREDITS_PER_CREDIT,
  creditsToLedgerMicrocredits,
  microcreditsToDisplayCredits,
  microcreditsToWholeCredits,
} from "../src/credits-display.js";
import {
  CookieJar,
  HAS_DATABASE,
  type RunningTestServer,
  TEST_APP_ORIGIN,
  api,
  bootServer,
  readSse,
  unique,
  uniqueEmail,
} from "./helpers.js";

const d = describe.skipIf(!HAS_DATABASE);

// ---------------------------------------------------------------------------
// Pure unit pins — the D-12 boundary conversion dialect (no DB)
// ---------------------------------------------------------------------------

describe("credits-display — the D-12 route-boundary conversions", () => {
  it("MICROCREDITS_PER_CREDIT is the ruling's 1 credit = 1_000_000 µc", () => {
    expect(MICROCREDITS_PER_CREDIT).toBe(1_000_000);
  });

  it("creditsToLedgerMicrocredits converts whole credits to exact integer µc", () => {
    expect(creditsToLedgerMicrocredits(1)).toBe(1_000_000);
    expect(creditsToLedgerMicrocredits(2)).toBe(2_000_000);
    expect(creditsToLedgerMicrocredits(0)).toBe(0);
    expect(creditsToLedgerMicrocredits(10_000)).toBe(10_000_000_000); // Studio-scale, safe integer
  });

  it("creditsToLedgerMicrocredits refuses sub-µc/unsafe magnitudes loudly", () => {
    expect(() => creditsToLedgerMicrocredits(0.0000005)).toThrow(RangeError); // sub-µc
    expect(() => creditsToLedgerMicrocredits(-1)).toThrow(RangeError); // negative
    expect(() => creditsToLedgerMicrocredits(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => creditsToLedgerMicrocredits(2 ** 53 / 1_000_000)).toThrow(RangeError); // unsafe
  });

  it("microcreditsToWholeCredits is the exact inverse for credit multiples", () => {
    expect(microcreditsToWholeCredits(1_000_000)).toBe(1);
    expect(microcreditsToWholeCredits(-1_000_000)).toBe(-1); // commit sign convention
    expect(microcreditsToWholeCredits(0)).toBe(0);
    expect(microcreditsToWholeCredits(999_999)).toBe(1); // rounds, never throws
  });

  it("microcreditsToDisplayCredits applies the D-12 2-decimal display rule", () => {
    expect(microcreditsToDisplayCredits(99_000_000)).toBe(99);
    expect(microcreditsToDisplayCredits(100_000_000)).toBe(100);
    expect(microcreditsToDisplayCredits(3_999_999)).toBe(4); // 3.999999 credits → 4.00
    expect(microcreditsToDisplayCredits(4_999_999)).toBe(5); // 4.999999 credits → 5.00
    expect(microcreditsToDisplayCredits(1_500_000)).toBe(1.5); // 1.50 credits
    expect(microcreditsToDisplayCredits(10_000)).toBe(0.01); // the cent floor
    // total (never throws — an SSE finalize must not die on a display conversion)
    expect(microcreditsToDisplayCredits(Number.NaN)).toBe(0);
    expect(microcreditsToDisplayCredits(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("round-trips: credits → µc → credits is the identity for whole credits", () => {
    for (const credits of [1, 2, 7, 99, 100, 2000, 10_000]) {
      expect(microcreditsToWholeCredits(creditsToLedgerMicrocredits(credits))).toBe(credits);
    }
  });
});

// ---------------------------------------------------------------------------
// The mixed-unit journey (real app + real Postgres + MockRunner)
// ---------------------------------------------------------------------------

interface Fixture {
  readonly jar: CookieJar;
  readonly workspaceId: string;
  readonly threadId: string;
}

let server: RunningTestServer;

beforeAll(async () => {
  server = await bootServer();
}, 30_000);

afterAll(async () => {
  await server?.close();
});

async function newWorkspace(): Promise<{ jar: CookieJar; id: string }> {
  const jar = new CookieJar();
  const signup = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email: uniqueEmail("units"), password: "Passw0rd!longenough", name: "Units Tester" },
  });
  expect(signup.status).toBe(200);
  const wsResponse = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Units WS"), slug: unique("units") },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };
  return { jar, id: ws.data.id };
}

/**
 * Seeds a µc grant at TOPUP/BILLING scale through the real ledger repo — the
 * same writer class the billing webhook grants ride (M6-C/M6-J precedent:
 * 100 credits = exactly 100_000_000 integer µc, D-12).
 */
async function grantMicrocredits(workspaceId: string, microcredits: number): Promise<void> {
  const seeded = await server.deps.repos.ledger.grant(workspaceId, {
    amount: microcredits,
    idempotencyKey: unique("grant"),
  });
  expect(seeded.entry.amount).toBe(microcredits);
  expect(seeded.entry.balanceAfter).toBe(microcredits);
}

async function newFixture(microcredits: number): Promise<Fixture> {
  const ws = await newWorkspace();
  await grantMicrocredits(ws.id, microcredits);
  const projectResponse = await api(server.base, "/v1/projects", {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name: unique("Units Project") },
  });
  expect(projectResponse.status).toBe(201);
  const project = (await projectResponse.json()) as { data: { id: string } };
  const bytes = Buffer.from(`{"units":"${unique("fx")}"}`, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const versionResponse = await api(
    server.base,
    `/v1/projects/${project.data.id}/versions?sha256=${sha256}&sizeBytes=${bytes.byteLength}`,
    {
      method: "POST",
      jar: ws.jar,
      headers: {
        "x-workspace-id": ws.id,
        "idempotency-key": unique("ver"),
        "content-type": "application/octet-stream",
      },
      rawBody: new Uint8Array(bytes),
    },
  );
  expect(versionResponse.status).toBe(201);
  const version = (await versionResponse.json()) as { data: { id: string } };
  const threadResponse = await api(server.base, `/v1/projects/${project.data.id}/threads`, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("thr") },
    body: { title: "Units journey thread" },
  });
  expect(threadResponse.status).toBe(201);
  const thread = (await threadResponse.json()) as { data: { id: string } };
  return { jar: ws.jar, workspaceId: ws.id, threadId: thread.data.id };
}

/** POST /v1/threads/:id/chat and read the whole SSE stream (MockRunner is fast). */
async function chatToCompletion(
  fx: Fixture,
  message: string,
): Promise<readonly StudioStreamEvent[]> {
  const response = await fetch(`${server.base}/v1/threads/${fx.threadId}/chat`, {
    method: "POST",
    headers: {
      origin: TEST_APP_ORIGIN,
      "content-type": "application/json",
      accept: "text/event-stream",
      cookie: fx.jar.header,
      "x-workspace-id": fx.workspaceId,
    },
    body: JSON.stringify({ message, context: {}, idempotencyKey: unique("chat"), pinned: [] }),
    redirect: "manual",
  });
  expect(response.status).toBe(200);
  const frames = await readSse(response);
  const events = frames.map((frame) => STUDIO_STREAM_EVENT_SCHEMA.parse(frame.data));
  // Every event parses against the §7.4 wire schema (law #1/#2) and the stream
  // is terminal.
  const last = events.at(-1);
  if (last === undefined || last.type !== "run.completed") {
    throw new Error(`expected a completed run, got: ${JSON.stringify(events.map((e) => e.type))}`);
  }
  return events;
}

function ledgerOfRun(workspaceId: string, runId: string) {
  return server.deps.repos.ledger
    .list(workspaceId, { runId, limit: 100 })
    .then((page) => page.items);
}

function kindsOf(entries: readonly { kind: string; amount: number }[]): Record<string, number[]> {
  const byKind: Record<string, number[]> = {};
  for (const entry of entries) {
    byKind[entry.kind] = [...(byKind[entry.kind] ?? []), entry.amount];
  }
  return byKind;
}

function creditsEventOf(events: readonly StudioStreamEvent[]): StudioStreamEvent & {
  type: "credits";
} {
  const found = events.find(
    (event): event is Extract<StudioStreamEvent, { type: "credits" }> => event.type === "credits",
  );
  if (found === undefined) throw new Error("no credits event on the wire");
  return found;
}

d("M6-K mixed-unit journey — µc ledger, whole-credit display, exact conservation", () => {
  it("a topup-scale µc grant funds a run whose ledger rows are EXACT µc while every display surface stays whole credits", async () => {
    const GRANT = 100_000_000; // 100 credits, integer µc (D-12, topup scale)
    const fx = await newFixture(GRANT);
    const events = await chatToCompletion(fx, "rename the headline");

    // The run row first: WHOLE CREDITS (the D-12 row ruling — M6-E).
    const runId = events[0]?.runId;
    if (runId === undefined) throw new Error("no run.started");
    const runResponse = await api(server.base, `/v1/runs/${runId}`, {
      jar: fx.jar,
      headers: { "x-workspace-id": fx.workspaceId },
    });
    const record = (
      (await runResponse.json()) as { data: { reservedCredits: number; committedCredits: number } }
    ).data;
    expect(record.reservedCredits).toBe(2); // ceil(1.5 × 1.2), whole credits
    expect(record.committedCredits).toBe(1); // MockRunner: ceil(reserve / 2)

    // LEDGER ROWS: exact integer MICROcredits (the F-J1 fix) — reserve
    // −2_000_000, commit −1_000_000, refund +2_000_000 (D-20: full hold
    // released), run nets exactly −1_000_000 µc. A pre-fix whole-credit
    // commit of "1" would have charged 1 µc — the ~1,000,000× undercharge.
    const entries = await ledgerOfRun(fx.workspaceId, runId);
    const byKind = kindsOf(entries);
    expect(byKind.reserve).toEqual([-2 * 1_000_000]);
    expect(byKind.commit).toEqual([-1 * 1_000_000]);
    expect(byKind.refund).toEqual([2 * 1_000_000]);
    expect(entries.reduce((total, entry) => total + entry.amount, 0)).toBe(-1_000_000);
    for (const entry of entries) {
      expect(Number.isInteger(entry.amount)).toBe(true); // D-12: no floats
      expect(entry.balanceAfter).toBeGreaterThanOrEqual(0);
    }

    // SSE `credits` event: WHOLE-CREDIT EXACT display units (reserved 2,
    // committed 1) and the balance is the D-12 2-decimal display conversion
    // of the µc ledger balance: 99_000_000 µc → exactly 99 credits.
    const credits = creditsEventOf(events);
    expect(credits).toEqual({
      type: "credits",
      runId,
      seq: credits.seq,
      reserved: 2,
      committed: 1,
      balance: 99,
    });

    // The raw µc balance — what the ledger actually holds.
    const balance = await server.deps.repos.ledger.balance(fx.workspaceId);
    expect(balance).toBe(GRANT - 1_000_000);

    // GET /v1/credits surfaces the SAME raw µc number (the documented
    // wire contract: "integer MICROcredits … the same units GET
    // /v1/billing/state reports") with zero live holds after the settle.
    const creditsSummaryResponse = await api(server.base, "/v1/credits", {
      jar: fx.jar,
      headers: { "x-workspace-id": fx.workspaceId },
    });
    expect(creditsSummaryResponse.status).toBe(200);
    const summary = (
      (await creditsSummaryResponse.json()) as { data: { balance: number; reserved: number } }
    ).data;
    expect(summary.balance).toBe(balance);
    expect(summary.reserved).toBe(0); // D-20: no live holds after settle

    // THE UNIT-CONSERVATION PROOF: the D-12 display conversion of the raw µc
    // balance equals the SSE event's balance — the two surfaces cannot
    // disagree, and both are derived from the SAME µc ledger row.
    expect(microcreditsToDisplayCredits(summary.balance)).toBe(credits.balance);
    expect(microcreditsToDisplayCredits(balance)).toBe(99);
  });

  it("an odd-µc balance displays rounded to 2 decimals while the ledger keeps the exact integer", async () => {
    // 5 credits minus 1 µc — enough for the 2-credit hold, NOT a whole credit.
    const GRANT = 5_000_000 - 1;
    const fx = await newFixture(GRANT);
    const events = await chatToCompletion(fx, "tweak the sub");
    const runId = events[0]?.runId;
    if (runId === undefined) throw new Error("no run.started");

    // Exact µc rows again (D-12 integers).
    const entries = await ledgerOfRun(fx.workspaceId, runId);
    const byKind = kindsOf(entries);
    expect(byKind.reserve).toEqual([-2 * 1_000_000]);
    expect(byKind.commit).toEqual([-1 * 1_000_000]);
    expect(byKind.refund).toEqual([2 * 1_000_000]);

    // The raw balance keeps every µc; the DISPLAY converts at 2 decimals:
    // 3_999_999 µc = 3.999999 credits → 4.00 on the wire event.
    const balance = await server.deps.repos.ledger.balance(fx.workspaceId);
    expect(balance).toBe(3_999_999);
    const credits = creditsEventOf(events);
    expect(credits.reserved).toBe(2);
    expect(credits.committed).toBe(1);
    expect(credits.balance).toBe(4);
    expect(microcreditsToDisplayCredits(balance)).toBe(credits.balance);

    // /v1/credits keeps the exact integer µc — no rounding on the raw wire.
    const creditsSummaryResponse = await api(server.base, "/v1/credits", {
      jar: fx.jar,
      headers: { "x-workspace-id": fx.workspaceId },
    });
    const summary = ((await creditsSummaryResponse.json()) as { data: { balance: number } }).data;
    expect(summary.balance).toBe(3_999_999);
  });

  it("N sequential runs each release the FULL µc hold — the balance conserved across the whole journey", async () => {
    const GRANT = 5_000_000; // 5 credits, µc — three runs at 1 credit each
    const fx = await newFixture(GRANT);
    for (const message of ["first tweak", "second tweak", "third tweak"]) {
      const events = await chatToCompletion(fx, message);
      const runId = events[0]?.runId;
      if (runId === undefined) throw new Error("no run.started");
      const entries = await ledgerOfRun(fx.workspaceId, runId);
      const byKind = kindsOf(entries);
      expect(byKind.reserve).toEqual([-2 * 1_000_000]);
      expect(byKind.commit).toEqual([-1 * 1_000_000]);
      expect(byKind.refund).toEqual([2 * 1_000_000]); // the FULL hold, every time
      // D-12: every row an exact integer, the chain never negative.
      for (const entry of entries) {
        expect(Number.isInteger(entry.amount)).toBe(true);
        expect(entry.balanceAfter).toBeGreaterThanOrEqual(0);
      }
    }

    // Three completed runs charged EXACTLY 3_000_000 µc (3 credits). Under
    // the pre-fix whole-credit ledger writes the same journey would have
    // charged 3 µc total — the ~1,000,000× undercharge F-J1 pinned. (The
    // cancelled-run µc refund is pinned in chat-loop test 4 and billing-e2e
    // journey 3 against the LiteLLM fake, where a mid-run cancel is reachable.)
    expect(await server.deps.repos.ledger.balance(fx.workspaceId)).toBe(GRANT - 3 * 1_000_000);
  });
});
