# 12-w4-i4 SPEC — client turn-loop controller (authoritative)

Goal: move the agent loop INTO apps/web chat-controller. The gateway /chat
route is DELETED. New server route: POST /v1/threads/:id/turn (see
services/gateway/src/routes/turn.ts header + packages/contracts/src/routes/turn.ts
+ turn.* events in packages/contracts/src/events.ts). Research:
research/round12-design.md "TURN WIRE CONTRACT".

Wire: POST /v1/threads/:id/turn, header `Idempotency-Key: ${runId}:${stepIndex}`,
body = TURN_REQUEST_SCHEMA { runId, stepIndex, model?, messages: TurnMessage[],
context?, pinned?, canvas? }. SSE: run.started → turn.started → message.delta*
→ tool.started* → turn.completed {stepIndex, finishReason, usage, credits,
assistantText?, toolCalls:[{toolCallId,tool,args,resultForModel,proposal?}]}
| turn.failed {code,message,retryable,credits}.

Loop (in chat-controller.send):
1. runId = crypto.randomUUID(); stepIndex = 0; transcript = [user part].
2. POST turn (client.chat.turn seam you add to packages/api-client).
3. On turn.completed: fold text + tool chips. If toolCalls empty → END:
   merge accumulated write-tool carriers into one EditPlan (build one one-step
   EditPlan per toolCall WITH proposal: {intent by tool ("studio.create_composition"→create,
   create_text→create, set_properties→edit, add_effect→style, set_keyframes→animate,
   apply_preset→animate, engine_commands→edit, run_script→animate, add_asset→create,
   undo_run/save_version→organize; default edit), summary: human text you
   compose, risk: proposal.compiled.risk, requiresApproval: risk==="high",
   affectedLayers: [], estimatedCredits: proposal.compiled.estimatedCredits,
   steps:[{title,tool,args,batch:{label,atomic:true,steps:[{command:tool.replace(/^studio\./,""),params:args}]}}]}
   then EDIT_PLAN_SCHEMA.parse + mergeEditPlans (both from @studio/contracts))
   → POST /v1/runs/:id/plan {plan} → response {plan, compiledBatch, risk,
   estimatedCredits, resolutionRequests, autoApply:{mode,reason}, baseVersionId}
   → fold as the plan card (existing plan fold) → auto-apply when
   autoApply.mode === "auto" (keep round-10 once-per-runId guard + existing
   apply gesture) → synthesize local run.completed fold.
   Else per toolCall: proposal present (write tool) → accumulate + echo
   resultForModel as tool_result part; else executor.execute(tool,args) →
   echo result (ClientToolError → result {error:code,message:err.message}).
   Append assistant text part; stepIndex++; loop.
4. Guards (export constants): CHAT_MAX_CLIENT_STEPS=24 → abort RUN_STEP_LIMIT;
   repetition key `${tool}:${JSON.stringify(args)}`: 2nd → inject steer part
   "You already proposed {tool}; continue with the next step." and continue;
   3rd → abort RUN_STEP_LIMIT; wall-clock 10min → RUN_TIMEOUT.
5. stop(): abort fetch + fire-and-forget POST /v1/runs/:id/abandon + local
   cancelled fold. retry(): resend CURRENT step same key; terminal → new runId.
6. Steer queue kept: queued sends during a live run become steer parts.
7. api-client chat.turn: SSE POST with the header; same envelope/validation
   posture as existing seam; on drop re-POST SAME key ≤3 then error
   TURN_PAUSED; retryable turn.failed → ONE same-key retry (1s) then surface.
8. run-state.ts: fold turn.* additively; keep ALL existing folds/phases/plan
   machinery intact (UI must not change shape — agent i6 builds on it).
9. canvas: optional CreateChatControllerOptions.canvasSnapshot?: () =>
   TurnCanvas|null; include on step 0 + on JSON-hash change.

Executor seam (SHIPPED by i5 — import from ./tool-executor.js):
`createClientToolExecutor(deps)` → { execute(tool,args): Promise<unknown>,
handles(tool): boolean }; throws ClientToolError (exported) on failure.

Tests to rewrite: chat-controller.test.ts + run-state.test.ts — (a) 2-turn
loop with mocks: turn 0 = write toolCall w/ proposal + read toolCall; turn 1
= final text; assert executor only ran for read, resultForModel echoed for
write, plan POSTed with merged plan, auto-apply fired on mode:auto; (b) step
cap; (c) repetition ×3; (d) stop mid-turn (abandon once); (e) retryable
turn.failed retried once same key; (f) no plan POST without proposals; keep
all still-valid existing folds.

Ownership: packages/api-client/src/**, apps/web/src/lib/chat/{chat-controller,
run-state, types, provider}.ts + their tests. NOT: tool-executor.ts/apply.ts
(i5, DONE), components (i6).

Gates: apps/web vitest for your two test files green; api-client tests green;
biome on your files; repo-wide gates are the lead's.
Worklog: read tail first; APPEND `---` + `Task ID: 12-w4-i4` section.
Report ≤170 words: loop behavior, constants, api-client seam signature,
UI-facing state deltas for i6.
