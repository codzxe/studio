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
// ROUND-12 RE-POINT (12-w7-r1): the server chat loop is DELETED — the
// billing unit is now the TURN (POST /v1/threads/:id/turn, MOCK_MODEL: every
// turn reserves its own hold and settles it at turn end). Each journey here
// is the proposal-less single-turn run shape (turn step 0 → the client's
// {end:true} end marker on POST /v1/runs/:id/plan), which is the SAME money
// shape the retired single chat run had: reserve −R → commit −1_000_000 →
// refund +R (the FULL hold released, D-20) → the run nets exactly −1 µc
// credit. The executed two-turn carrier loop (step 0 → step 1 → plan) has a
// DIFFERENT multi-turn ledger fingerprint (the run-scoped hold fold — pinned
// honestly in tests/apply-flow.test.ts test 1); this file pins the clean
// per-turn conservation the D-12/D-20 exit criteria describe. The per-turn
// reserve R is prompt-size-derived (routes/turn.ts §8.8: clamp(1..12,
// ceil(prompt JSON / 4000)) credits → ceil(estimate × 1.2)); the tests compute
// it with the SAME formula (buildTurnMessages + reserveAmountFor) so the µc
// magnitudes stay exact, not magic numbers. The MockRunner's fixed usage
// commits exactly 1 credit per turn.
//
// Boot: the full gateway (buildApp + real Postgres + Better Auth) with the
// DEFAULT mock model (MOCK_MODEL=true — deterministic, no fake model server
// needed).

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { STUDIO_STREAM_EVENT_SCHEMA, type StudioStreamEvent } from "@studio/contracts";

import {
  MICROCREDITS_PER_CREDIT,
  creditsToLedgerMicrocredits,
  microcreditsToDisplayCredits,
  microcreditsToWholeCredits,
} from "../src/credits-display.js";
import { buildTurnMessages } from "../src/litellm/turn-engine.js";
import { reserveAmountFor } from "../src/runner.js";
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

/**
 * The exact §8.8 per-turn reserve the route will take for a turn-0 POST whose
 * history is `history` (mirrors routes/turn.ts:231-246 — the same formula, so
 * the µc magnitudes below are exact rather than magic numbers).
 */
function expectedTurnReserve(
  history: Parameters<typeof buildTurnMessages>[0]["history"],
  runId: string,
  message: string,
): number {
  const prompt = buildTurnMessages({
    history,
    transcript: [{ role: "user", text: message }],
    canvas: null,
    currentRunId: runId,
  });
  const estimate = Math.max(1, Math.min(12, Math.ceil(JSON.stringify(prompt).length / 4000)));
  return creditsToLedgerMicrocredits(reserveAmountFor(estimate));
}

/**
 * POST /v1/threads/:id/turn (step 0) and read the whole SSE stream (the mock
 * model is fast). The wire is TURN-terminal: one turn.completed at the end.
 */
async function postTurn(
  fx: Fixture,
  runId: string,
  message: string,
): Promise<readonly StudioStreamEvent[]> {
  const response = await fetch(`${server.base}/v1/threads/${fx.threadId}/turn`, {
    method: "POST",
    headers: {
      origin: TEST_APP_ORIGIN,
      "content-type": "application/json",
      accept: "text/event-stream",
      cookie: fx.jar.header,
      "x-workspace-id": fx.workspaceId,
      "idempotency-key": `${runId}:0`,
    },
    body: JSON.stringify({
      runId,
      stepIndex: 0,
      messages: [{ role: "user", text: message }],
    }),
    redirect: "manual",
  });
  expect(response.status).toBe(200);
  const frames = await readSse(response);
  const events = frames.map((frame) => STUDIO_STREAM_EVENT_SCHEMA.parse(frame.data));
  // Every event parses against the §7.4 wire schema (law #1/#2) and the turn
  // stream is terminal in turn.completed.
  const last = events.at(-1);
  if (last === undefined || last.type !== "turn.completed") {
    throw new Error(`expected a completed turn, got: ${JSON.stringify(events.map((e) => e.type))}`);
  }
  return events;
}

/**
 * The client's proposal-less stop gesture: the {end:true} end marker on
 * POST /v1/runs/:id/plan (routes/turn.ts) — lands the run row completed.
 */
async function endRun(fx: Fixture, runId: string): Promise<void> {
  const response = await api(server.base, `/v1/runs/${runId}/plan`, {
    method: "POST",
    jar: fx.jar,
    headers: { "x-workspace-id": fx.workspaceId, "idempotency-key": unique("end") },
    body: { end: true },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ runId, ended: true });
  await waitFor("the run row to complete", async () => {
    const runResponse = await api(server.base, `/v1/runs/${runId}`, {
      jar: fx.jar,
      headers: { "x-workspace-id": fx.workspaceId },
    });
    return ((await runResponse.json()) as { data: { status: string } }).data.status === "completed";
  });
}

/**
 * One single-turn journey: history snapshot → the exact expected reserve →
 * POST the turn (the mock proposes its carriers) → end the run with the
 * marker. Returns the wire events + the computed reserve (µc).
 */
async function singleTurnJourney(
  fx: Fixture,
  message: string,
): Promise<{ runId: string; events: readonly StudioStreamEvent[]; reserve: number }> {
  const history = await server.deps.repos.threads.loadThreadHistory(fx.threadId);
  const runId = unique("run");
  const reserve = expectedTurnReserve(history, runId, message);
  const events = await postTurn(fx, runId, message);
  await endRun(fx, runId);
  return { runId, events, reserve };
}

/** Poll until probe() is true (the end marker writes the run row after 200). */
async function waitFor(
  description: string,
  probe: () => Promise<boolean>,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
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

d("M6-K mixed-unit journey — µc ledger, whole-credit display, exact conservation", () => {
  it("a topup-scale µc grant funds a run whose ledger rows are EXACT µc while every display surface stays whole credits", async () => {
    const GRANT = 100_000_000; // 100 credits, integer µc (D-12, topup scale)
    const fx = await newFixture(GRANT);
    const { runId, events, reserve } = await singleTurnJourney(fx, "rename the headline");

    // The run row first: WHOLE CREDITS (the D-12 row ruling — M6-E). The
    // reserve no longer rides the row (round-12: the hold is per-TURN in the
    // ledger); the committed usage is the mock turn's fixed 1 credit.
    const runResponse = await api(server.base, `/v1/runs/${runId}`, {
      jar: fx.jar,
      headers: { "x-workspace-id": fx.workspaceId },
    });
    const record = (
      (await runResponse.json()) as { data: { reservedCredits: number; committedCredits: number } }
    ).data;
    expect(record.reservedCredits).toBe(0); // per-turn holds live in the ledger
    expect(record.committedCredits).toBe(1); // the mock turn's fixed usage commit

    // LEDGER ROWS: exact integer MICROcredits (the F-J1 fix) — reserve −R,
    // commit −1_000_000, refund +R (D-20: the FULL hold released), the run
    // nets exactly −1_000_000 µc. A pre-fix whole-credit commit of "1" would
    // have charged 1 µc — the ~1,000,000× undercharge. R is the exact §8.8
    // per-turn reserve computed with the route's own formula.
    const entries = await ledgerOfRun(fx.workspaceId, runId);
    const byKind = kindsOf(entries);
    expect(byKind.reserve).toEqual([-reserve]);
    expect(byKind.commit).toEqual([-1 * 1_000_000]);
    expect(byKind.refund).toEqual([reserve]);
    expect(entries.reduce((total, entry) => total + entry.amount, 0)).toBe(-1_000_000);
    for (const entry of entries) {
      expect(Number.isInteger(entry.amount)).toBe(true); // D-12: no floats
      expect(entry.balanceAfter).toBeGreaterThanOrEqual(0);
    }

    // Turn-wire display surface: WHOLE-CREDIT display units — the terminal
    // turn.completed carries the turn's committed 1 credit (the retired
    // single-`credits`-event surface is gone with the server loop).
    const terminal = events.at(-1);
    if (terminal === undefined || terminal.type !== "turn.completed") {
      throw new Error("no turn.completed on the wire");
    }
    expect(terminal.credits).toEqual({ committed: 1 });

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
    // balance is the whole-credit view every display surface shows — the two
    // display surfaces cannot disagree, and both derive from the SAME µc row.
    expect(microcreditsToDisplayCredits(summary.balance)).toBe(99);
    expect(microcreditsToDisplayCredits(balance)).toBe(99);
  });

  it("an odd-µc balance displays rounded to 2 decimals while the ledger keeps the exact integer", async () => {
    // 5 credits minus 1 µc — enough for the 3-credit hold, NOT a whole credit.
    const GRANT = 5_000_000 - 1;
    const fx = await newFixture(GRANT);
    const { runId } = await singleTurnJourney(fx, "tweak the sub");

    // Exact µc rows again (D-12 integers).
    const entries = await ledgerOfRun(fx.workspaceId, runId);
    const byKind = kindsOf(entries);
    const reserveRows = byKind.reserve ?? [];
    expect(reserveRows).toHaveLength(1);
    expect(byKind.commit).toEqual([-1 * 1_000_000]);
    expect(byKind.refund).toEqual(reserveRows.map((amount) => -amount));

    // The raw balance keeps every µc; the DISPLAY converts at 2 decimals:
    // 3_999_999 µc = 3.999999 credits → 4.00 on the whole-credit surface.
    const balance = await server.deps.repos.ledger.balance(fx.workspaceId);
    expect(balance).toBe(3_999_999);
    expect(microcreditsToDisplayCredits(balance)).toBe(4);

    // /v1/credits keeps the exact integer µc — no rounding on the raw wire.
    const creditsSummaryResponse = await api(server.base, "/v1/credits", {
      jar: fx.jar,
      headers: { "x-workspace-id": fx.workspaceId },
    });
    const summary = ((await creditsSummaryResponse.json()) as { data: { balance: number } }).data;
    expect(summary.balance).toBe(3_999_999);
  });

  it("N sequential runs each release the FULL µc hold — the balance conserved across the whole journey", async () => {
    // 10 credits, µc — three single-turn runs at 1 committed credit each; sized
    // so every per-turn hold (which grows with the thread history) still
    // clears the §8.8 reserve gate without ever dipping below zero.
    const GRANT = 10_000_000;
    const fx = await newFixture(GRANT);
    for (const message of ["first tweak", "second tweak", "third tweak"]) {
      const { runId, reserve } = await singleTurnJourney(fx, message);
      const entries = await ledgerOfRun(fx.workspaceId, runId);
      const byKind = kindsOf(entries);
      expect(byKind.reserve).toEqual([-reserve]);
      expect(byKind.commit).toEqual([-1 * 1_000_000]);
      expect(byKind.refund).toEqual([reserve]); // the FULL hold, every time
      // D-12: every row an exact integer, the chain never negative.
      for (const entry of entries) {
        expect(Number.isInteger(entry.amount)).toBe(true);
        expect(entry.balanceAfter).toBeGreaterThanOrEqual(0);
      }
    }

    // Three completed turns charged EXACTLY 3_000_000 µc (3 credits) — Σ rows
    // = balance, the run nets = its commit, the FULL hold released every
    // time. Under the pre-fix whole-credit ledger writes the same journey
    // would have charged 3 µc total — the ~1,000,000× undercharge F-J1
    // pinned. (The multi-turn carrier loop's ledger fingerprint — the
    // run-scoped hold fold — is apply-flow test 1's subject; the cancelled-run
    // µc refund is pinned in billing-e2e journey 3 and chat-loop test 4.)
    expect(await server.deps.repos.ledger.balance(fx.workspaceId)).toBe(GRANT - 3 * 1_000_000);
  });
});
