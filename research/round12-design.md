# ROUND 12 DESIGN — Studio Agent Harness v3

Status: AUTHORITATIVE for all round-12 implementation agents. Read the two
worklog round-10/12 entries + your task brief before touching code.
Research inputs: research/ai-sdk-current.md, research/ai-sdk-migration-map.md,
research/run-lifecycle-audit.md, research/engine-command-surface.md,
research/compiler-extension-map.md, research/history-persistence-audit.md,
research/chat-ui-audit.md, research/ecosystem-2026.md.

## P0 — The production "stuck in loop" (ROOT-CAUSED, must die)

The model loop executes INSIDE the SSE request on a Vercel function
(`maxDuration=60s`); the event log is a per-isolate in-memory Map (never hits
DB). Real DeepSeek multi-tool runs exceed 60s → platform hard-kill → client
re-POSTs the same idempotency key → in-memory log is gone → replay MISS →
gateway starts a DUPLICATE run (duplicate user message, duplicate credit
reserve, leaked hold, zombie `running` row) → client drops the foreign runId's
events → no terminal event → backoff → RUN_PAUSED → user hits Retry →
another duplicate → infinite loop.

Architectural conclusion: serverless + long in-request agent loops + in-memory
run state are incompatible. Round 12 moves the loop to the client (below),
which deletes this entire failure class.

## Architecture — client-driven agent loop (Cursor-style)

```
Browser (owns the loop, owns the engine)          Gateway (stateless per turn)
────────────────────────────────────────       ─────────────────────────────
chat-controller v2 loop:                        POST /v1/threads/:id/turn
  build turn messages (run transcript)           auth → load thread history
  POST turn ────────────────────────────────▶   credit RESERVE (per turn)
  stream message.delta + tool.calls          ←─ streamText (AI SDK v7,
  (SSE, short-lived, bounded)                    ONE model call, no server loop)
  execute tools LOCALLY (engine bridge):        persist assistant msg + steps
    read tools, render_audio, web_search        per turn (DB, durable)
    (web_search → POST /v1/tools/web_search)
  append tool results to transcript             commit credits per turn
  repeat until:                                  update run row heartbeat
    - model returns NO tool calls → done
    - step cap / repetition guard / stop()
  merge plan → auto-apply (existing machinery)
```

Laws kept: #5 (no filesystem paths in agent commands), #6 (one batch = one
undo = one saved version), #8.3/#5.4 (project text is data, not instructions),
§8.8 credits (reserve per turn, commit per turn, refund on abort), M4.3
prompt redaction (sha256+lengths only).

Turn idempotency: key = `${runId}:${stepIndex}`. A duplicate POST for the same
key returns the stored turn outcome (steps/message rows exist per turn) —
NEVER a duplicate model call. Turn SSE replays bounded to one model call; no
cross-request in-memory state; a dead turn is just retried by the client.

Run rows: created on first turn of a run; each turn updates `last_step_index`,
`credits_committed`, `updated_at` (heartbeat). A `running` run whose heartbeat
is older than 5 minutes reads as `abandoned`. No leaked holds: per-turn
reserve/commit inside the turn request.

## Tool catalog v3 (packages/contracts)

Existing 13 tools stay (ids, schemas, propose-only semantics). Additions:

READ (client-executed, like today's read tools):
- `studio.list_commands` — engine command catalog: categories, ids, one-line
  titles. Backed by the generated catalog (below).
- `studio.describe_command` — full params doc (+ compact JSON shape) for ids.

GENERATIVE (client-executed; NO canvas mutation; metered where noted):
- `studio.web_search` — turn returns the call; client POSTs
  `/v1/threads/:id/tools/web_search` (gateway executes: Tavily
  `X-Tavily-Access-Mode: keyless` by default, optional `TAVILY_API_KEY` env;
  5 results, content trimmed to 500 chars each; metered 1 credit) and feeds
  the JSON result into the next turn as the tool result. Key never ships.
  Unavailable → typed `RUN_WEB_SEARCH_UNAVAILABLE`-style tool error result
  the model can explain (not a run failure).
- `studio.render_audio` — JS code (Tone.js 15) run client-side via
  `Tone.Offline` → AudioBuffer → WAV (audiobuffer-to-wav) → uploaded through
  the existing asset upload seam → tool result = asset id/url + duration.
  Sandbox: code length cap 20k, run timeout 20s, sample-rate 44100.
- `studio.generate_image` — `POST /v1/threads/:id/tools/generate_image`;
  provider via `STUDIO_IMAGE_API_*` env (OpenAI-compatible images endpoint);
  NOT configured → typed unavailable tool result (honest, not a run failure).

WRITE (PROPOSE-ONLY — flow through the plan compiler into ONE atomic batch):
- keep: create_composition, create_text, set_properties, add_effect,
  set_keyframes, apply_preset, undo_run, save_version.
- `studio.engine_commands` NEW — steps: `{ command, params }[]` validated
  against the ALLOWED catalog server-side at turn time (unknown/denied id →
  typed repairable tool error listing the closest catalog id). Risk floor:
  medium (auto-eligible per D-28); HIGH (destructive/denied) never enters.
- `studio.run_script` NEW — `code` string; engine `script.run` executes at
  APPLY time (undoable, one undo group). Server static guard: forbid
  `require(`, `fetch(`, `eval(` outside comments — boa engine has no network
  anyway; risk floor medium; capped 20k chars.
- `studio.add_asset` NEW — `{ kind: "svg", name, svg }` (SVG string → engine
  vector import seam at apply) — only the string-based import path, never
  filesystem ids.

Engine catalog: extend `scripts/extract-engine-registry.mjs` to emit
`packages/contracts/src/generated/engine-catalog.json` (id, title, category,
paramsDoc, `hasPath` flag, deny tag) + `ALLOWED_COMMAND_IDS`
(machine-derived: excludes any id whose params docs contain a path-like
param or is tagged app-chrome/filesystem/render-destructive/quit).
Gateway validates propose-steps against the catalog; the CLIENT gate keeps a
tier-2 ids-only list (~10 KB — full catalog never rides the browser bundle).
Existing curated 37 command ids stay allowed (superset).

## History + context v3

- `loadHistory` rebuilt: window = last 40 messages or 24k chars (whichever
  first), INCLUDING tool parts (tool-call + tool-result rows), results
  compacted (`get_context`-style bodies truncated to 2k chars in history).
- Persistence (per turn, all durable): assistant text rows; tool calls as
  `agent_steps` rows; tool results as steps `result_json` + `agent_messages`
  role `tool` rows (payload in `content_json`: `{kind:"tool", toolCallId,
  tool, args|result}`); assistant text persisted on failed/cancelled too.
- drizzle migration 0008: `agent_steps.tool_call_id` (+ index), run heartbeat
  columns (`last_step_index`, `updated_at` index).
- Client history-on-reload: wire `threads.messages()` → transcript with plan
  cards from `plan_json` (runs) + steps.

## Prompt v3 (litellm/prompt.ts)

DO THE WORK framing kept; add: full tool list incl. new tools; engine
discovery guidance (`list_commands` → `describe_command` → `engine_commands`);
asset-from-code guidance (`render_audio`, SVG via `add_asset`); done-voice;
budget awareness (steps left are injected per turn by the client, not the
prompt); §8.3 injection posture verbatim bullets (test-pinned — do not reword).

## Chat UI v3 (Cursor-style, the moat)

- History on reload + thread switcher (list/create/switch).
- Live progress strip: per-turn tool chips (pending/running/done/error).
- Per-message actions: copy, retry (re-run from that user message), edit+resend.
- Slash commands: /undo /redo /save /checkpoint /clear /reset-panel.
- @-mentions: @layer @comp @asset resolved client-side into context chips.
- Model picker + context chips exist — keep. Stop button exists — keep.
- Panel: drag/resize/dock/persist EXIST; add: double-click header = maximize/
  restore, opacity slider + density + font-size knobs in a Panel settings
  popover, reset-geometry button. No layout surgery (audit confirmed feasible).

## Battle-testing (the fleet)

Turn engine tests (history assembly, idempotent turn, reserve/commit/refund
math, tool-call emission, catalog validation, script static guard); controller
loop tests (caps, repetition guard = same tool+argsHash twice → inject
nudge; 3× → abort RUN_STEP_LIMIT; steer; stop; mid-turn crash → turn retry
without duplicate); executor tests per new tool (audio sandbox timeout,
web_search seam, engine_commands client gate); injection corpus extended to
new tools; catalog verification swarm across engine command modules; e2e:
happy multi-tool "make a motion graphics video" journey; the round-12 loop
killer test (function death mid-run → retry → NO duplicate run row, NO
re-execution — impossible by construction, asserted via API); SSE bounded
replay; auto-apply end-to-end unchanged.

## Env deltas

`TAVILY_API_KEY` (optional, keyless default) · `STUDIO_IMAGE_API_BASE_URL`,
`STUDIO_IMAGE_API_KEY`, `STUDIO_IMAGE_API_MODEL` (optional) · `CHAT_MAX_STEPS`
(now = per-run step cap, default 24) · keep LITELLM_* as-is. No infra changes.

## File ownership map (exclusive per agent; global gates run last)

- packages/contracts/** + scripts/extract-engine-registry.mjs → agent i2
- packages/db/** (migration 0008, repos, history loader) → agent i9
- services/gateway/src/routes/turn.ts (NEW) + litellm/turn-messages.ts (NEW) +
  routes/chat.ts (reduced) + runner seam trim → LEAD (me)
- services/gateway/src/routes/tools.ts (NEW: web_search/generate_image) → i7
- services/gateway/src/litellm/prompt.ts → i8
- services/gateway/src/plan-compiler.ts + auto-apply.ts + plan.ts → i3
- packages/api-client turn transport + apps/web/src/lib/chat/chat-controller.ts
  + run-state.ts + types.ts → i4
- apps/web/src/lib/chat/tool-executor.ts + new tools files + apply.ts seam → i5
- apps/web/src/components/** (chat panel UI) + provider.tsx → i6
- tests: each agent ships unit tests for its own surface; battle wave after.

## TURN WIRE CONTRACT (pinned — implement EXACTLY; additive only)

POST `/v1/threads/:id/turn` · auth session · header `Idempotency-Key: ${runId}:${stepIndex}`

Request body (zod `TURN_REQUEST_SCHEMA`, contracts):
```ts
type TurnMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool_call"; toolCallId: string; tool: string; args: unknown }
  | { role: "tool_result"; toolCallId: string; tool: string; result: unknown }
  | { role: "steer"; text: string };
interface TurnRequestBody {
  runId: string;            // client-generated uuid, stable for the whole run
  stepIndex: number;        // 0-based; increments per model call
  model?: "studio-fast" | "studio-smart" | "studio-vision";
  messages: TurnMessage[];  // the CURRENT RUN transcript only (≤64 parts, ≤64KB)
  context?: ContextSelection;      // as today
  pinned?: PinnedContext[];         // as today
  canvas?: {                       // compact canvas snapshot; client includes on
    activeComp?: string;           // step 0 and whenever its hash changed
    layers: { id: number; name: string; type: string }[]; // ≤80 layers
    selection: number[]; playhead: number; fps: number; duration: number;
  } | null;
}
```

SSE response events (additive to StudioStreamEvent):
- `{type:"run.started", runId, model}` — every turn; client folds idempotently
- `{type:"turn.started", runId, stepIndex}`
- `{type:"message.delta", runId, delta}`
- `{type:"tool.started", runId, toolCallId, tool, args}` — per emitted call
- `{type:"turn.completed", runId, stepIndex, finishReason: "stop"|"tool-calls"|"step-limit", usage:{inputTokens,outputTokens}, credits:{committed}, assistantText?: string, toolCalls: TurnToolCall[]}`
- `{type:"turn.failed", runId, stepIndex, code, message, retryable, credits:{committed}}`

`TurnToolCall = { toolCallId, tool, args, resultForModel: unknown,
  proposal?: { compiled: { batch: AgentBatch; risk: PlanRisk; estimatedCredits: number; resolutionRequests: LayerResolutionRequest[] } } | null }`

Flow rules (law-abiding, pinned):
- Write tools: gateway validates args + compiles the carrier BEFORE emitting
  tool.started; `resultForModel` = the propose-only "proposed batch" result
  (WRITE_TOOL_RESULT_SCHEMA shape); `proposal.compiled` rides the event for
  the client plan accumulator. Invalid args → resultForModel = validation
  error (the client echoes it next turn — ONE repair turn, then repetition
  guard aborts). Client NEVER executes write tools during the run.
- Read/generative tools: proposal=null; the client executes LOCALLY
  (engine bridge / Tone.js / web_search endpoint) and echoes `result` as a
  tool_result part in the NEXT turn.
- Run ends when a turn completes with `toolCalls: []` → the client
  synthesizes the local run.completed (server never needs run state).
- Client merges accumulated proposals via NEW pure
  `mergeEditPlans(plans: EditPlan[]): EditPlan` (contracts) then
  `POST /v1/runs/:id/apply { plan }` — server stores + RE-compiles
  (authoritative) + applies the D-28 verdict, exactly the existing apply
  route + auto-apply drive.
- Repetition guard (client): same (tool, sha256(args)) twice → inject a
  steer nudge; 3× → abort with RUN_STEP_LIMIT. Step cap: CHAT_MAX_STEPS=24.
- Server per-turn: reserve credits → ONE streamText call → persist assistant
  text + steps rows (+ tool_result rows when echoed) → commit credits →
  update run heartbeat. Abort/disconnect → refund hold, no partial persist.
- web_search: `POST /v1/threads/:id/tools/web_search { query, maxResults? }`
  → metered 1 credit → Tavily keyless (or TAVILY_API_KEY), 5 results, each
  trimmed to 500 chars + url + title. generate_image:
  `POST /v1/threads/:id/tools/generate_image { prompt, size? }` → env-config-
  ured OpenAI-compatible images endpoint; unconfigured → typed unavailable.
