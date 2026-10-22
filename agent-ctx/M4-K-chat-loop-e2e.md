# M4-K — gateway chat-loop E2E (full-route proof)

Task ID: M4-K · Agent: M4-K (gateway chat-loop E2E) · Status: COMPLETE

## Deliverable

`services/gateway/tests/chat-loop.test.ts` (NEW, the only owned path) — 10 tests,
all green: the gateway's full-route chat-loop proof. Real `buildApp` over real
Postgres (`bootServer` harness), the REAL LiteLLM runner selected via
`createRunnerForEnv(testEnv({MOCK_MODEL:"false", LITELLM_BASE_URL:<fake>}))`
(production wiring, no injectable-fetch shortcut at the route level), against a
REAL in-process fake OpenAI-compatible SSE server on an ephemeral 127.0.0.1
port (sanctioned loopback, not a dev server), the real SSE wire parsed by a
hand-rolled incremental frame reader, and real client tool-result POSTs to
`/v1/runs/:id/events`.

## Scenarios covered (test names are the evidence)

1. `1. happy loop…` — sign-up → workspace → grant(100) → project → version →
   thread → chat POST → run.started(studio-fast) → tool.started(get_context) →
   bogus toolCallId POST → 400 (§7.4 rule) → real `POST /v1/runs/:id/events
   {type:"tool.result"}` → fake server's 2nd round answers FROM the posted
   result (`"The comp Main has 1 layer."` — the tool result provably reached
   the model conversation) → message.deltas → credits → run.completed.
   Asserts: SSE headers, exact event type-sequence, ledger entries
   (reserve −2 / commit −1 / refund +1), credits event, run row
   (completed, committedCredits 1, baseVersionId = the uploaded version,
   studio-fast), assistant message persisted via GET /v1/threads/:id/messages
   (+user turn), tool step rows exist (tolerant — see QUIRK below), and the
   runner's registered tools === exactly the 5 READ tools (M4.6 no-write-path
   proof at the provider-wire level) + bearer shape.
2. `2. replay…` — same idempotencyKey re-POST after completion → the SAME run
   replays (deep-equal event list, seq from 0), exactly 1 run row, 1 reserve.
3. `3a. reconnect…` — same body + `Last-Event-ID: <tool.started seq>` posted
   while the run is LIVE (first segment still open): second segment replays
   strictly after the cursor, the tool result POSTed mid-reconnect lands once
   per stream, both segments get the same tail + terminal, 1 run row.
4. `3b. client abort mid-run…` — ACTUAL-BEHAVIOR PIN: aborting the SSE request
   mid-run CANCELS the live run server-side (run row cancelled, full refund,
   replay shows [run.started, tool.started, run.cancelled], late tool.result →
   409 RUN_NOT_ACTIVE, no assistant message row). See DEVIATIONS.
5. (SKIPPED by PIN — documented in the file header) tool-timeout →
   EDITOR_DISCONNECTED at E2E: TOOL_RESULT_TIMEOUT_MS is a 30_000ms constant
   wired directly in chat.ts (not env-injectable); a real-time E2E sleeps 30s.
   Unit-proof exists in M4-A's litellm-runner.test.ts (waitMode "timeout").
   Cancel-path full refund (test 4) covers the same ledger refundAll path.
6. `4. cancel…` — POST /v1/runs/:id/cancel → 200 {cancelled:true} →
   run.cancelled on the wire (single terminal) → run row cancelled,
   errorCode RUN_CANCELLED, committed 0, balance back to the pre-run grant
   (reserve + refund entries, no commit).
7. `6. model entitlements…` — model "studio-smart" on trial (resolvePlan stub)
   → 403 MODEL_NOT_ENTITLED envelope (exact message), ZERO model calls, no run
   row, no ledger movement, no user-message row (fires before persistence).
8. `7. insufficient credits…` — grant 5 then ledger.adjust −5 → POST → 402
   INSUFFICIENT_CREDITS before any run.started (JSON envelope, not a stream),
   no run, no user message, balance still 0.
9. `8. invalid tool…` — fake server demands unknown tool
   `studio.delete_everything` twice → ONE repair turn (the model provably saw
   `VALIDATION_FAILED` + `Unknown tool` as the tool result on round 2) →
   run.failed RUN_INVALID_TOOL (non-retryable), full refund, 0 steps, user
   message only.
10. `9. SSE contract…` — every frame is byte-exact `id: <seq>\ndata: <json>`
    (raw === re-serialization), seq contiguous from 0, first event
    run.started, exactly one terminal event as the last frame, every event
    parses against `STUDIO_STREAM_EVENT_SCHEMA`, one runId per stream,
    headers text/event-stream + no-store + x-accel-buffering:no.
11. `10. cross-tenant…` — a different workspace's member POSTs chat on this
    thread → 404 THREAD_NOT_FOUND (never FORBIDDEN — law #3), no model call,
    no run row.

## THE QUIRK VERDICT (M4-A's double-step-row flag — CONFIRMED, precise)

Observed `agent_steps` rows for ONE `studio.get_context` client-tool call in a
completed run (live DB evidence, deterministic across all runs):

| seq | status    | args_json                 | result_json                 | writer |
|-----|-----------|---------------------------|-----------------------------|--------|
| 0   | success   | null                      | {activeComp:{name:"Main"}}  | runs.ts events sink (`nextSeq = steps.length` at POST time) |
| 1   | running   | {include:["activeComp"]}  | null                        | chat.ts finalize `recordSteps` (log event seq) |
| 2   | success   | null                      | {activeComp:{name:"Main"}}  | chat.ts finalize `recordSteps` (log event seq) |

- One tool call ⇒ 3 step rows (duplicate result rows at seq 0 and 2; a stale
  `running` row at seq 1). The `(run_id, seq)` UNIQUE index prevents exact-seq
  duplicates, so no 23505 collisions in the happy path; replays after
  terminal do collide and recordSteps swallows the error (as designed).
- Cancelled runs keep the orphaned `running` step row forever.
- Test assertion is tolerant per the brief: asserts ≥2 rows, all tool
  `studio.get_context`, unique seqs, ≥1 row with args, ≥1 row with the
  client result JSON. NOT pinned: exact row count/status.
- Suggested fix for M4 closeout (NOT applied — law #12): either drop the
  addStep in runs.ts's tool.result branch (let finalize's recordSteps own step
  rows) or make finalize skip tool.result events already recorded by the sink
  (dedupe on the runs.ts writer's key). One writer must own agent_steps.

## Additional src/ observations (reported, never fixed)

1. **LEDGER SETTLE DOUBLE-DEDUCTION (pre-existing, real bug)**: a completed
   run nets `−2×commit` instead of `−commit`. planSettlement refunds
   `outstanding − commit` while the commit −M deducts ON TOP of the hold:
   grant 100 → reserve −2 → commit −1 → refund +1 → balance 98 (should be 99
   per §8.8 "refund the difference on success" — i.e. refund the full hold
   `outstanding` keeping commit −M, or equivalent). Evidence: this E2E's
   credits event {reserved:2, committed:1, balance:98}; AND
   `packages/db/tests/integration/repos.test.ts` "ledger: grant → reserve →
   settle" expects 82 and observes 64 — that test is RED whenever
   DATABASE_URL is a postgres URL (the fleet gates never ran the db package's
   integration suite with postgres; the sandbox shell usually carries the
   stale non-postgres DATABASE_URL). My test pins the OBSERVED entry
   arithmetic with a loud LEDGER BUG PIN comment so a fix updates the pin.
2. **Run-status vocabulary mismatch**: step writers emit statuses
   `running`/`success` (db StepStatus vocabulary pending|running|success|
   failed), but runs.ts `toRecord` maps only started|succeeded|failed and
   renders everything else as `"skipped"` — so every chat-loop step surfaces
   as `skipped` in GET /v1/runs/:id. Code-verified (not test-pinned).
3. **Disconnect-cancels semantics** (see 3b): chat.ts wires hono's request
   abort signal + the SSE ReadableStream cancel() to cancelRun(), and
   @hono/node-server 2.1.5 aborts the request signal on premature client
   disconnect — so a mid-run network flap CANCELS the run (refund +
   run.cancelled) rather than keeping it alive for §8.4 Last-Event-ID resume.
   The api-client's reconnect loop (backoff 1/2/4/8s, pause after 3) can
   therefore only ever replay a TERMINAL log — the "live run survives a
   transport drop" reading of §8.4 is not what the gateway implements. If
   that's not the intent, the fix belongs in chat.ts (drop the abort→cancel
   wiring for the request signal, keep POST /runs/:id/cancel as the only
   cancel path) — M4 closeout should rule on it.
4. run.completed is emitted on the wire BEFORE the run-row update / assistant
   message insert / step rows (finalize ordering) — consumers reading the
   DB right after the terminal frame see stale state; my harness polls
   (waitFor) before asserting rows. Worth knowing for M4-M's Playwright.

## Environment findings (not mine, evidence recorded)

`pnpm --filter @studio/db test` with
`DATABASE_URL=postgres://studio:studio@127.0.0.1:5432/studio`:
122/124 — 2 PRE-EXISTING reds, both unrelated to M4-K (I touched only the
gateway tests): (a) the ledger settle arithmetic above; (b)
"leases: single writer…" fails on a 23503 FK violation — the test inserts a
lease for `usr_other` without creating that user row.

## Gates

- `DATABASE_URL=postgres://… pnpm --filter @studio/gateway typecheck` → 0 errors.
- `DATABASE_URL=postgres://… pnpm --filter @studio/gateway test` → 10 files,
  **124/124 green** (114 pre-existing — 91 at wave-1 close + 23 from M4-N's
  injection.test.ts which landed mid-flight via peer commits — + my 10).
- `biome check services/gateway/tests/chat-loop.test.ts` → clean.
- My file: ~2.2–7s wall depending on DB warmth (10 scenarios; sign-up scrypt
  is the bulk; no fake timers, no real sleeps, deterministic).

## Fleet protocol notes

My in-flight file states were carried by peers' git-sync add -A sweeps
(M4-L 0ea72cb, M4-M 59111cf — verified via git log --all -- <file>); the final
post-format state is what HEAD carries; my own commit lands the worklog +
agent-ctx record.
