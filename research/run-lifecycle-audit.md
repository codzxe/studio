# Run lifecycle & SSE replay audit — Task 12-w2-a3

Scope: `services/gateway` (chat SSE, idempotency, runner, runs/events seam), `packages/api-client` (sse.ts reconnect), `apps/web` Vercel mount. Audit-only; no product code changed.

## 1. Exact lifecycle: POST /v1/chat → SSE → terminal → close

All refs `services/gateway/src/routes/chat.ts` unless noted.

1. `requireAuth` (L201) → `requireWorkspace("editor")` (L205) → `CHAT_REQUEST_SCHEMA` parse (L211) → thread+project tenant reads (L218–219).
2. Ledger balance `< 1` → `INSUFFICIENT_CREDITS` before anything (L224–227).
3. **Replay check** (L229–234): `replayKey = ${workspace.id}:${threadId}:${body.idempotencyKey}` → `deps.chatReplay.lookup(replayKey)`; hit ⇒ **return `sseResponse(c, existing.log, Last-Event-ID)` — NO model re-execution, no new run, no new reserve** (the generic Idempotency-Key middleware is *excluded* for chat: `middleware.ts:114–122`).
4. Miss ⇒ new run: model entitlements (L239–242) → history load (L246) → **`threads.addMessage` persists the user turn (L249–253)** → `runs.create` (L255–261) → `ledger.reserve` (L278–282, µc) → run row `running` (L291–294) → `runs.register(runId)` in-memory `RunLog` (L301; `runner.ts:249–277`) → `chatReplay.store` (L302).
5. SSE transport (L465–525): `ReadableStream.start` replays missed events after the `Last-Event-ID` cursor (L469–478), then an async IIFE does `Promise.race([deps.runner.start(agentRun, streamApi), 120s timer])` (L480–505). **The model loop runs INSIDE the HTTP request lifetime — not detached.**
6. Events flow through `RunLog.emit` (seq assigned, terminal latched, listeners fanned out — `runner.ts:135–164`) → subscriber enqueues `id: seq\ndata: {...}\n\n` frames (chat.ts:413–423, 607–609).
7. Terminal: finalize (L321–405) settles/refunds the ledger, emits `credits` + `run.completed`/`run.failed`/`run.cancelled`, updates the run row, `recordSteps` (L572–596) writes `agent_steps` **only now**, then `closeStream()` (L513–521). Replay path closes the stream on the terminal event (L642–660).

Client side (`packages/api-client/src/sse.ts`): `streamChat` → `runLoop` for(;;) (L717–811) → POST with `Idempotency-Key` + `Last-Event-ID` (L596–606) → `pump` reads frames (L645–688) → normalizer folds events; terminal event ⇒ `terminalSeen` ⇒ `finish("terminal")` (L792–795). Clean EOF without terminal ⇒ treated as a dropped stream ⇒ backoff ⇒ re-POST (L801–809).

## 2. Idempotent replay semantics — the three cases

**Where state lives:** `chatReplay` = `createInMemoryChatReplayStore` — a **plain in-memory `Map`, no TTL, no eviction** (`context.ts:33–44`), built once **per serverless isolate** (`handler.ts:32–65` memoizes the app per process). The `RunLog` (event log) is likewise in-memory (`runner.ts:120–242`); the DB gets the run row, ledger rows, and steps-at-finalize — never the SSE event log. `idempotency.ts` (generic store, 10-min TTL, L10) is **not used by chat**.

- **(a) Completed run, process alive:** replay hit → full log replayed from the Last-Event-ID cursor (default = all frames) and the stream closes immediately (`chat.ts:657–659`). No re-execution. Idempotent + cheap. Client drops seq-dupes (`sse.ts:295–297`).
- **(b) In-flight run, process alive (same isolate):** replay hit → missed frames replayed, then it subscribes to the live log and streams until the terminal event (`chat.ts:630–660`). The run is NOT re-executed; the tool-result seam still resolves (POST /v1/runs/:id/events emits into the same log — `routes/runs.ts:207`). Proven by `tests/chat-loop.test.ts:877` ("3a. reconnect: a live run resumes after Last-Event-ID; the tool result posted mid-reconnect lands once") and `:835` (replay creates no second run / no double reserve).
- **(c) Dead mid-run (process/isolate gone — maxDuration kill, cold recycle, different isolate):** `chatReplay` lookup MISSES ⇒ the route takes the **brand-new-run path**: the user turn is persisted AGAIN (duplicate thread message, `chat.ts:249–253`), a new runId + new reserve are created, and the **model re-executes from scratch** (chat.ts:255–505). There is no resume and no partial-log replay — the partial log died with the process. The DB run row from the dead run stays `status="running"` forever (finalize never ran), its ledger hold leaks (refund happens only in finalize or POST /runs/:id/cancel — `routes/runs.ts:116–129`; reconciliation's `zombie_reserve` is REPORT-ONLY, `reconciliation.ts:29–30`).

**Client consequence of (c):** the client is still bound to the OLD runId; `StreamEventNormalizer.emitServerEvent` **silently drops every event whose runId differs** (`sse.ts:291–294` "foreign run — §7.4 events are per-run"). A replacement run spawned by the server can therefore NEVER be adopted: the client sees a stream that opens, sends frames it ignores, and closes with no terminal ⇒ "closed" ⇒ backoff ⇒ re-POST ⇒ (warm isolate now replays the new run's terminal log — still foreign) ⇒ dropped again ⇒ 3 attempts ⇒ `onPause` ⇒ **RUN_PAUSED**. Retry calls `handle.reconnect()` (attempts reset to 0, `sse.ts:925–932`; the paused handle is kept — `chat-controller.ts:288–292`) ⇒ 3 more ⇒ pause again — a pause↔reconnect cycle that can never terminate, while every re-POST that lands on a cold isolate spawns yet another duplicate run + duplicate DeepSeek call + leaked hold.

## 3. Where the model loop executes

**Inside the streaming HTTP request** (`chat.ts:480–505` races `deps.runner.start` against `CHAT_TIMEOUT_MS = 120_000`, L64). No detached job/queue exists. On Vercel this means the whole multi-round agent loop (DeepSeek tool rounds, plan side-calls, client tool waits) must finish inside the function's `maxDuration`.

## 4. Unbounded waits / loops found

Server (`services/gateway`):
- **No wall-clock timeout on the model call**: `streamChatCompletion` (3 attempts, 1s/2s backoff, only before first event — `litellm/openai.ts:155–156, 194–224`, SDK `maxRetries: 0` L442) has **no fetch timeout**; the only abort is the run signal. A hung Token Harbor stream parks until the platform kills the function.
- `CHAT_TIMEOUT_MS = 120s` (chat.ts:64) **exceeds Vercel's 60s `maxDuration`** — it can never fire in production; the platform kill fires first (and skips finalize ⇒ no refund, no terminal).
- **No SSE heartbeat/keep-alive frames anywhere** (only the `connection: keep-alive` header, chat.ts:617; no heartbeat emitter in the gateway SSE paths). DeepSeek thinking 5–60s + TH 429 backoff (1s/2s×3 per round) ⇒ minute-long zero-byte gaps.
- Model round cap only: `maxSteps = CHAT_MAX_STEPS` (required env, example 50; `.env.example:177` = 50; `litellm/runner.ts:783–787` → `RUN_STEP_LIMIT`). 50 rounds × 5–60s each is far beyond any platform budget — bounded in steps, unbounded in wall clock.
- Client tool wait bounded at `TOOL_RESULT_TIMEOUT_MS = 30_000` (`litellm/runner.ts:87`, wired chat.ts:441) → `EDITOR_DISCONNECTED` (retryable).
- `chatReplay` map never evicts (context.ts:33–44) — unbounded memory + stale entries replayed forever on late re-POSTs (same key).
- **Duplicate-run spawn on every cold re-POST** (case (c)): unbounded run/message/hold duplication across isolates.

Client (`packages/api-client/src/sse.ts` + `apps/web/src/lib/chat/chat-controller.ts`):
- `runLoop` for(;;) (L717–811): bounded per cycle at `RECONNECT_MAX_AUTO_ATTEMPTS = 3` (L406) with 1s/2s/4s/8s→30s backoff (L402–404, 636–643), **but `reconnect()` resets attempts (L929)** and the paused handle survives (chat-controller.ts:288–292) ⇒ manual retry ⇒ infinite pause↔reconnect cycles against a dead/foreign run.
- **`pump` has no read timeout** (L670–685): a silent-but-open connection parks forever in `reader.read()` ⇒ **`onDone` is never fired** ⇒ the UI stays "streaming" indefinitely (stuck-wait, not loop). Combined with no server heartbeat, one stalled TH response = frozen chat with no error.
- Foreign-run drop (L291–294) guarantees a replacement run can never terminate the client's loop — the direct amplifier of case (c).
- Compounding: chat rate limit is **20/min per IP** (`route-class.ts:9`, `rate-limit.ts:18`) — retry storms flip to `RATE_LIMITED` 429 (retryable) and add more backoff churn.

## 5. Vercel function maxDuration

- `apps/web/src/app/v1/[...path]/route.ts:20` — `export const maxDuration = 60;` (runtime nodejs; the gateway is mounted inline via `api/gateway.mjs`). **No `vercel.json` exists** (root or apps/web) — nothing overrides it. 60s is also the documented Hobby-plan ceiling for Node functions, so **every /v1 chat invocation is hard-killed at 60 seconds**. With real DeepSeek (5–60s per round; runs regularly need multiple rounds + plan side-calls) the 60s wall is hit mid-run routinely.

## 6. Verdict: which loop is production-possible

**Top hypothesis (rank 1) — the 60s kill cascade.** A real-model run exceeding 60s gets hard-killed mid-stream (no terminal, no refund, log destroyed) → client backoff → re-POST with same key → cold/other isolate misses `chatReplay` → server silently starts a **second** run (duplicate user message, duplicate DeepSeek call, new hold) → client drops all its events (foreign runId, sse.ts:291–294) → no terminal ever → 3 attempts → RUN_PAUSED → user Retry → 3 more → pause… forever, spawning a duplicate run on every cold re-POST. The user sees endless "reconnecting / run paused" — literally stuck in a loop — while the DB fills with `running` runs and leaked holds.

**Rank 2 — silent-stream park.** No heartbeat + no client read timeout: a stalled (but open) TH stream freezes the chat in "streaming" with no `onDone` (stuck-wait manifestation).

**Rank 3 — TH 429 churn.** `server_busy` 429s → runner retries 1s/2s then `RUN_MODEL_UNAVAILABLE` (retryable) → short failed runs; each user Retry uses a fresh key (chat-controller.ts:344–360) → re-executes the whole prompt against a throttled provider — rapid failed-run cycling the user reads as looping.

### One-line loop reproducers
1. Send any prompt needing ≥2 DeepSeek tool rounds (>60s total): function killed at 60s → re-POST spawns run #2 with a duplicate user message → client drops its events → pause/retry cycle never terminates.
2. Force a transport drop 10s into a run (devtools offline 5s): warm isolate replays+resumes fine, but a cold isolate re-POST creates a new run → foreign-run drop → RUN_PAUSED loop.
3. Reconnect while TH is throttling: the replacement run fails fast `RUN_MODEL_UNAVAILABLE`; its terminal replay is foreign → the client loops pause↔reconnect instead of ever surfacing the error.

## 7. Fix directions (for the next agent — not applied)

- Persist the event log / replay cursor in Postgres keyed by idempotency key (or move run execution to a detached job + polling stream) so case (c) becomes replayable instead of spawn-new.
- Cap chat runs inside the platform budget (e.g. in-run wall-clock deadline ~50s that finalizes cleanly: terminal `run.failed RUN_TIMEOUT` + refund) and/or raise `maxDuration` (Pro) / split the loop across invocations.
- Add an SSE heartbeat comment frame every ~15s so silent model gaps don't read as dead streams; add a client-side read timeout to `pump`.
- On replay miss with a Last-Event-ID cursor for a known `running` run row, adopt/rebind the client to the replacement run (drop or rebind the foreign-runId filter) or return a typed "run lost" terminal instead of silently starting a new run.
- Add a zombie-run reaper (cancel+refund `running` runs older than grace) — the reconciliation report already detects them but never acts.
