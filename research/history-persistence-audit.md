# History persistence audit — round 12 (Task ID 12-w2-a6)

**Scope:** what exactly is persisted today for agent chat (threads/messages/runs/steps), what the model sees as "history", and what blocks reconstruction of FULL history (user msgs, assistant text, tool calls, tool results) into Vercel AI SDK v7 `ModelMessage[]`.

**Method:** read-only audit — `packages/db/src/schema.ts`, `schema-sqlite.ts`, `repos/threads.ts`, `repos/runs.ts`, `repos/leases.ts`, `services/gateway/src/routes/chat.ts`, `routes/threads.ts`, `routes/runs.ts`, `src/runner.ts`, `src/litellm/prompt.ts`, `src/litellm/openai.ts`, `packages/contracts/src/events.ts`, `routes/threads.ts`, `routes/chat.ts`, `packages/api-client/src/client.ts`, `apps/web/src/lib/chat/run-state.ts`, `types.ts`. No product files changed.

---

## 1. Exact schema columns (pg = `packages/db/src/schema.ts` §6; sqlite twin `schema-sqlite.ts` §6 is column-identical, timestamps as `unixepoch('subsec')*1000`)

### `agent_threads` (schema.ts L384–401)

| column | type | constraints |
|---|---|---|
| id | text | PK, app-side `createId("thr")` |
| project_id | text | NOT NULL, FK projects.id ON DELETE CASCADE |
| created_by | text | NOT NULL, FK user.id |
| title | text | NULL |
| created_at | timestamptz | NOT NULL DEFAULT now() |
| updated_at | timestamptz | NOT NULL DEFAULT now() |

Index: `agent_threads_project_idx (project_id, updated_at DESC)`.

### `agent_messages` (L403–421) — **the transcript**

| column | type | constraints |
|---|---|---|
| id | text | PK, `createId("msg")` |
| thread_id | text | NOT NULL, FK agent_threads.id ON DELETE CASCADE |
| role | text | NOT NULL — free text in DB; repo validates `user\|assistant\|system\|tool` |
| content_json | **jsonb** | NOT NULL — opaque payload (no shape contract) |
| run_id | text | NULL, **no FK**, indexed |
| created_at | timestamptz | NOT NULL DEFAULT now() |

Indexes: `agent_messages_thread_created_idx (thread_id, created_at DESC)`, `agent_messages_run_idx (run_id)`.
**No seq/position column** — ordering is the keyset `(created_at DESC, id DESC)`; same-millisecond ties break on a random uuid id.

### `agent_runs` (L431–474)

| column | type | constraints |
|---|---|---|
| id | text | PK, `run_` |
| thread_id / project_id | text | NOT NULL, FK cascade (projects cascade) |
| model | text | NOT NULL (alias: studio-fast/smart/vision) |
| status | text | NOT NULL DEFAULT 'queued'; `$type<RunStatus>`: queued, running, awaiting_approval, completed, failed, cancelled (transition-asserted in repo) |
| plan_json | **jsonb** | NULL — the LAST `plan` event's EditPlan (incl. round-10 mergedCarrierPlan rescue) |
| reserved_credits / committed_credits | integer | NOT NULL DEFAULT 0 (whole credits, D-12) |
| base_version_id | text | NULL FK project_versions.id SET NULL (M5-Q) |
| result_version_id | text | NULL |
| applied_at | timestamptz | NULL |
| applied_batch_sha256 | char(64) | NULL |
| applied_version_id | text | NULL FK project_versions.id SET NULL |
| undone_at / undone_by | timestamptz / text | NULL (user FK SET NULL) |
| error_code | text | NULL |
| created_at / completed_at | timestamptz | NOT NULL / NULL |

Indexes: `thread_idx(thread_id)`, `project_idx(project_id, created_at DESC)`, `status_idx(status)`.

### `agent_steps` (L478–496) — **per-run tool evidence**

| column | type | constraints |
|---|---|---|
| id | text | PK, `stp_` |
| run_id | text | NOT NULL FK agent_runs.id CASCADE |
| seq | integer | NOT NULL — **the SSE wire seq**, UNIQUE `(run_id, seq)` |
| tool | text | NOT NULL — registry id (`studio.get_context`, …) |
| args_json | **jsonb** | NULL — full tool args |
| result_json | **jsonb** | NULL — full tool result |
| command_batch_json | **jsonb** | NULL — compiled carrier batch (write tools) |
| status | text | NOT NULL DEFAULT 'pending': pending, running, success, failed |
| duration_ms | integer | NULL |

**No `tool_call_id`, no `created_at`, no thread_id.** UNIQUE index `agent_steps_run_seq_uniq (run_id, seq)`.

Migrations: drizzle journal at `0007_fresh_dreaming_celestial` (0007 = user_settings.auto_apply default true).

---

## 2. Repos (`packages/db/src/repos/`)

### threads.ts (`ThreadsRepo`)
- `create(workspaceId, {projectId, createdBy, title})`
- `listByProject(workspaceId, projectId, {limit?, cursor?})` — keyset page `(updatedAt DESC, id DESC)`, default limit 20, max 100 (`DEFAULT_PAGE_SIZE`/`MAX_PAGE_SIZE` in cursor.ts)
- `get`, `addMessage({threadId, role, contentJson, runId?})` — validates role ∈ {user, assistant, system, tool}, bumps `agent_threads.updated_at` in a tx
- `listMessages(workspaceId, threadId, {limit?, cursor?})` — **newest-first** keyset page `(created_at DESC, id DESC)`; returns `{items, nextCursor}`

### runs.ts (`RunsRepo`)
- `create({threadId, projectId, model, baseVersionId?, reservedCredits?, planJson?})` → status queued
- `update(runId, {status?, planJson?, reservedCredits?, committedCredits?, resultVersionId?, errorCode?})` — status transition asserted, terminal sets completed_at
- `addStep({runId, seq, tool, argsJson?, resultJson?, commandBatchJson?, status?, durationMs?})` — UNIQUE(run_id, seq) → CONFLICT on dup
- `get` → `{run, steps}` (steps ORDER BY seq ASC)
- `listByThread`, `recordApplied`, `recordUndone`, `getPlanState` (proposed/applied/undone)

Leases repo is the project edit-lock — **unrelated to chat history** (queue is module-level in-memory). No `events` table exists anywhere (webhook_events = Stripe idempotency only; audit_log = run.applied/run.cancelled actor rows only).

---

## 3. What `POST /v1/threads/:id/chat` (routes/chat.ts) persists per run

History is loaded **before** the user turn is inserted (`HISTORY_TURNS = 6`, L67). Persistence happens at three moments: **pre-run** (user row), **finalize** (run status/plan/steps/assistant row), and via `POST /v1/runs/:id/events` (apply result rows only).

| event type | stored? | where | exact shape |
|---|---|---|---|
| user turn | ✅ always, before run create (L249) | `agent_messages` | role `user`, `content_json = { message, context, pinned }` (raw ChatRequest parts), **runId = NULL**, created_at = now |
| run bookkeeping | ✅ | `agent_runs` | model, base_version_id, reserved/committed credits, status queued→running→completed/failed/cancelled, error_code on failure |
| assistant text (final) | ⚠️ **completed runs only, best-effort** (L356–364) | `agent_messages` | concatenation of ALL `message.delta` events (`.map(delta).join("")`), role `assistant`, `content_json = { text }`, runId set. Insert is `.catch(() => undefined)` — **silent loss on DB error**. Never written for failed/cancelled runs (partial text lost). Deltas are NOT stored individually |
| tool call (`tool.started`) | ✅ at finalize (`recordSteps` L572) | `agent_steps` | seq = wire seq, tool = event.name, `args_json` = full args, status `running`. **No tool_call_id** |
| tool result (`tool.result`) | ✅ at finalize | `agent_steps` | seq = wire seq, tool = `log.toolNameFor(toolCallId)`, `result_json` = full result, status `success`. Client results arrive via POST /v1/runs/:id/events → run log (memory); server-resolved tools (studio.plan_edit + 8 write tools) emit their own tool.result. A *failed* client tool result (Seam-6 `{error}` shape) still lands as status `success` with the error inside result_json |
| tool delta (`tool.delta`) | ❌ never persisted | — | card `deltaText` lost after reload |
| plan (`plan` / mergedCarrierPlan) | ⚠️ partial | `agent_runs.plan_json` | ONLY the LAST plan event (log.currentPlan), written on every terminal outcome incl. failure. **Not in agent_messages, not in GET /v1/runs/:id (hardcoded `plan: null` in runs.ts toRecord)** |
| apply result | ✅ runs.ts route L214/L279 | `agent_steps` | tool `apply`, status failed/success, result_json `{errorCode, errorMessage}` / `{versionId, sha256}` — seq from `steps.length` (can collide with finalize's wire-seq rows) |
| error (`run.failed`) | ⚠️ partial | `agent_runs.error_code` | code only; the human message + retryable flag exist only in the in-memory run log |
| SSE event stream | ❌ **in-memory only** | `RunLog` (module-level `RunRegistry` Map) + in-memory `chatReplay` keyed `workspace:thread:idempotencyKey` | Last-Event-ID replay works only while the process lives; nothing durable (no events table, no lease rows for chat) |
| credits event | ⚠️ | `agent_runs.reserved/committed` + `credit_ledger` | SSE balance snapshot not durable |

---

## 4. GET /v1/threads/:id/messages — exact current contract

Route: `routes/threads.ts` L87–109 (viewer role), repo `listMessages` → `page(c, items, nextCursor)` → envelope `{ data: { items: ThreadMessage[], nextCursor: string | null } }`, **newest-first**, limit default 20 / max 100, cursor = base64url `{t,id}`.

Zod/type contract (`packages/contracts/src/routes/threads.ts`):

```ts
THREAD_MESSAGE_ROLE_SCHEMA = z.enum(["user", "assistant", "system"]);   // NO "tool"

interface ThreadMessage {
  id: Id; threadId: Id;
  role: ThreadMessageRole;      // user | assistant | system
  content: unknown;             // content_json verbatim — opaque, per-role shape undocumented
  runId: Id | null;             // set on assistant rows only (user rows are null)
  createdAt: string;           // ISO
}
```

Gateway mapping (`toMessageDto` L32–39): `role === "assistant" || role === "system" ? role : "user"` — **anything else (incl. a `tool` row, if one ever existed) is silently reported as `user`**. Content is raw: user rows → `{message, context, pinned}`, assistant rows → `{text}`. **No tool calls, no tool results, no plan, no error info, no steps.** The api-client method exists (`client.threads.messages(threadId, query)` — client.ts L776) and is **never called** by `apps/web` (only its own test calls it).

Related: `GET /v1/runs/:id` returns RunRecord with **`plan: null` hardcoded** and steps as `{seq, tool, status, durationMs}` — args/results deliberately omitted from the wire.

---

## 5. `apps/web/src/lib/chat/run-state.ts` + `types.ts` — what ChatUiState keeps

```
ChatUiState = {
  messages: ChatUiMessage[]      // id: "msg_*" (user, client-generated) | "run:<runId>" (assistant placeholder)
                                   // { id, role: user|assistant, text, runId?, toolCards, plan?, planRuntime?, credits? }
  phase: idle|sending|streaming|reconnecting|done|failed|cancelled
  activeRunId, error?, blocked?, lastSeq
}
ToolCardState  = { toolCallId, name, args?, status queued|running|done|failed, result?, deltaText? }   // from tool.started/tool.delta/tool.result
PlanRuntime    = { compiledBatch, resolutionRequests?, baseVersionId?, risk?, estimatedCredits?,
                   autoApply?, candidates?, resolutionPicks?, outcome idle..undone, versionId?, error?, dismissed? }
```

`foldEvent`: run.started creates the assistant placeholder; message.delta appends text; tool.started/delta/result maintain toolCards; plan sets `message.plan` + `planRuntime`; credits snapshots; run.failed sets error; preview/approval.required are cursor-only.

**A reloaded page starts from `createInitialChatUiState()` (empty)** — no fetch reconstructs anything. To rehydrate it would need per run: final text, toolCards (name+args+status+result per call), plan+planRuntime (incl. compiledBatch for the applied/undone card states — obtainable from `run.plan_json` + planState), credits, error, phase. Today `threads.messages()` could rebuild at most text-only bubbles.

---

## 6. What the model sees today (the "no chat history" complaint)

- `loadHistory` (chat.ts L534): `threads.listMessages(limit: HISTORY_TURNS /* 6 */)` → newest-first page → reversed → `historyTurn` keeps **only** `role=user` with `content.message` and `role=assistant` with `content.text`; system/tool rows → dropped (L558).
- `buildMessages` (litellm/prompt.ts L90): SYSTEM_PROMPT + those `{role, content}` text turns + the current user message → `OpenAIChatMessage[]` (system/user/assistant text only).
- `toSdkPrompt` (litellm/openai.ts L262) converts to AI SDK v7 `ModelMessage[]` and **already supports** assistant `tool-call` parts and `tool` `tool-result` parts (with pending-call stub closure) — **within the current run only**. Prior runs' tool activity is never sent.

So "6 rows of text" is literally the entire model-visible history; everything tool-shaped lives in `agent_steps` but is never fed back.

---

## 7. Gaps blocking FULL-history reconstruction

1. **Text-only, 6-row window** — `HISTORY_TURNS = 6` is a row cap (not even 6 turns: user+assistant = 3 exchanges), and `historyTurn` drops every non-text row. Tool calls/results of prior runs never reach the model; the OpenAI `tool_calls` of an assistant turn are not reconstructable from `agent_messages` (final text only).
2. **`agent_steps` lacks `tool_call_id`** (and any timestamp): pairing a `tool.started` row with its `tool.result` row requires order/name inference; ids must be synthesized for AI SDK `toolCallId`. Steps are per-run keyed by SSE seq with no thread-level ordering column — cross-table ordering relies on `created_at` (absent on steps).
3. **Assistant message fidelity**: written only on completed runs, wrapped in `.catch(() => undefined)` (silent loss), and user rows carry `runId = NULL` — a failed/cancelled run leaves a dangling user turn with no assistant reply; you cannot correlate user↔run without timestamp guessing.
4. **Contract mismatches**: `THREAD_MESSAGE_ROLE_SCHEMA` has no `tool`; `toMessageDto` coerces tool→user; `ThreadMessage.content` is `unknown` with no per-role shape; `GET /v1/runs/:id` hardcodes `plan: null` though `plan_json` is in the DB — so neither messages nor runs endpoints can serve plans/tool parts to a reloading client.

## 8. Recommended minimal migration

**Goal:** one ordered transcript + one join, no new tables.

1. **DB (drizzle 0008, tiny):**
   - `agent_steps`: ADD `tool_call_id text NULL` (+ optional index `(run_id, tool_call_id)`); optionally `created_at timestamptz DEFAULT now()`.
   - `agent_messages`: **no new column required** — `content_json` jsonb already IS the payload column and `role` already accepts `"tool"` at the repo layer. (Only add a per-thread `seq bigint` if same-ms ordering proves insufficient; the existing `(thread_id, created_at DESC)` index is the pagination key and is fine.)
2. **Writers (routes/chat.ts finalize):**
   - Persist assistant final text on **failed/cancelled** runs too (any `text.length > 0`), and stop swallowing the insert error (log it).
   - Set `runId` on the user message row (`addMessage(..., { runId })`) for direct user↔run correlation.
   - Persist one `role:"tool"` message row per tool.started/tool.result with a **discriminated content_json**: `{ kind:"tool-call", toolCallId, tool, args }` / `{ kind:"tool-result", toolCallId, tool, result }` (UI reload + history in one place). Cheaper alternative: keep steps as the tool store and only add a `{ kind:"plan", plan, compiledBatch, ... }` assistant-adjacent row so plan cards survive reloads.
   - recordSteps: pass the wire `toolCallId` through to `addStep`.
3. **Contracts:**
   - `THREAD_MESSAGE_ROLE_SCHEMA` += `"tool"`; document per-role `content` shapes (discriminated union on `kind`); fix `toMessageDto` to stop coercing tool→user.
   - Expose the plan: `GET /v1/runs/:id` → `plan: run.planJson` (drop the hardcoded null), or fold plan into the thread message row per (2).
4. **loadHistory (the actual fix):** page messages with a raised cap (e.g. 200 rows or a token-budget window), fold runs+steps, and emit either `OpenAIChatMessage[]` with `tool_calls`/`tool_call_id` (existing `toSdkPrompt` already converts to v7 `ModelMessage[]`, including pending-call stubs) or `ModelMessage[]` parts directly, synthesizing `toolCallId` as `` `${runId}:${seq}` `` where missing. **`agent_steps` already carries enough to rebuild tool turns** (tool, args_json, result_json, seq order per run); the migration adds the id/timestamp safety and the missing rows (failed-run text, plan), not a new store.

No events-table / SSE-durability migration is required for the history goal — that only matters for cross-instance replay, a separate concern.
