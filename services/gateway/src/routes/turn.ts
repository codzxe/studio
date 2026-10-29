// @studio/gateway — POST /v1/threads/:id/turn (round-12 TURN WIRE CONTRACT,
// research/round12-design.md): the STATELESS per-turn agent route.
//
// The browser owns the agent loop; the gateway does ONE bounded model call
// per request (the AI SDK v7 transport in litellm/openai.ts). Nothing
// cross-request lives in memory except a per-isolate single-flight guard —
// the round-10 "stuck in a loop" failure class (60s serverless hard-kill →
// in-memory replay MISS → duplicate run → RUN_PAUSED → retry → infinite) is
// now impossible by construction:
//
//   * one turn = one model call, wall-clock bounded well under maxDuration;
//   * the event log is DURABLE — every completed turn persists its outcome
//     (assistant row payload keyed by turnKey) and a duplicate POST replays
//     it from the database, never re-running the model;
//   * a turn that dies mid-stream is simply retried by the client with the
//     same key — bounded to ONE re-execution, no zombie runs, no leaked
//     holds (each turn reserves/settles its own ledger hold);
//   * run rows heartbeat per turn; a stale `running` run reads abandoned.
//
// Flow per turn (§5.1 trust boundaries — the browser is never trusted for
// credits): auth + workspace(editor) → thread+project checks → body +
// Idempotency-Key(`${runId}:${stepIndex}`) validation → replay lookup →
// balance precheck → (step 0) create run row + persist user turn →
// (step > 0) run heartbeat → settle incoming tool_result parts →
// reserve credits → build the prompt (history incl. tool parts + canvas +
// transcript) → ONE streamed model call (message.delta events live) →
// validate + compile write-tool calls (propose-only carriers; plan_edit stays
// the server-side structured call) → persist assistant row + steps →
// settle credits → turn.completed.
//
// Streaming contract: one SSE frame per StudioStreamEvent, `id:` = seq;
// `: keep-alive` comments every 15s so no client read-timeout fires on slow
// model turns; `tool.started` per emitted call before turn.completed so the
// UI chips light up live.

import { Hono } from "hono";

import {
  EDIT_PLAN_SCHEMA,
  type EditPlan,
  type ModelId,
  type PlanId,
  type StudioStreamEvent,
  TURN_REQUEST_SCHEMA,
  type TurnMessage,
  type TurnRequestBody,
  type TurnToolCall,
  defaultModelForPlan,
  modelAllowedForPlan,
} from "@studio/contracts";

import { StudioError } from "@studio/config";
import { AUTO_APPLY_SETTING_UNAVAILABLE, autoApplyDecision } from "../auto-apply.js";
import type { AppContext, GatewayDeps } from "../context.js";
import { creditsToLedgerMicrocredits } from "../credits-display.js";
import { GatewayError } from "../errors.js";
import { pathParam } from "../http.js";
import { deriveIdempotencyKey } from "@studio/db";
import type { AggregatedToolCall, OpenAIChatMessage } from "../litellm/openai.js";
import {
  type OpenAITurnDeps,
  type TurnHistoryRow,
  buildTurnMessages,
  committedCreditsFor,
  executeModelTurn,
  isClientExecutedTool,
  registeredToolFor,
  resolveWriteToolCall,
  serverSidePlan,
  validateToolCall,
} from "../litellm/turn-engine.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { compilePlan as compilePlanFn, defaultCompileDeps } from "../plan-compiler.js";
import type { CompilePlanResult } from "../plan-compiler.js";
import { isAdminRole, resolvePlan } from "../plan.js";
import { RunLog, reserveAmountFor } from "../runner.js";

/** Per-turn keep-alive cadence (round-12 fix: no dead-air between deltas). */
const TURN_KEEPALIVE_MS = 15_000;

/** How many prior-thread rows the replay lookup scans. */
const REPLAY_SCAN_ROWS = 60;

// ---------------------------------------------------------------------------
// Per-isolate single-flight (bounded duplicate protection while a turn is
// IN FLIGHT; the durable idempotency record is the assistant row's turnKey)
// ---------------------------------------------------------------------------

const turnFlights = new Map<string, RunLog>();

/**
 * AUD note: run-scoped refund surfaces (abandon in this module, cancel and
 * the §8.7 events sink in routes/runs.ts) consult this map so a client-side
 * refund never races a turn that is still streaming on THIS isolate. With
 * the uncapped settle (AUD-C1) the race is no longer a money hole, but
 * skipping the refund keeps the ledger shape honest (holds are released by
 * the turn's own settle, not by a second request).
 */
export function hasInFlightTurns(runId: string): boolean {
  for (const key of turnFlights.keys()) {
    if (key.startsWith(`${runId}:`)) return true;
  }
  return false;
}

export function resolveChatModel(input: {
  readonly requested: ModelId | undefined;
  readonly plan: PlanId;
  readonly requestId: string;
}): ModelId {
  if (input.requested !== undefined && !modelAllowedForPlan(input.requested, input.plan)) {
    throw new GatewayError("MODEL_NOT_ENTITLED", "That model isn't available on your plan.", {
      status: 403,
      hint: "Pick one of the models shown in the model picker.",
      retryable: false,
      requestId: input.requestId,
    });
  }
  return input.requested ?? defaultModelForPlan(input.plan);
}

// ---------------------------------------------------------------------------
// AUD-C2 fix — reserve-replay triage. The durable idempotency record of a
// turn key is the LEDGER pair (reserve + settle), which lives forever; the
// assistant-row replay scan only reads the newest 40 history rows, so a
// scripted re-POST of an OLD turn key used to fall through the replay miss
// into a FRESH model call whose reserve and settle both replayed (hold 0,
// charge 0 — free generation forever). Before re-executing a reserve-replayed
// key, prove it is genuinely retryable:
//   1. a settle commit entry exists → the turn fully processed → 409, never
//      a free re-execution;
//   2. a refund entry exists (the turn failed and was refunded) → honest
//      retry: the uncapped settle bills the re-execution normally;
//   3. neither (a fresh reserve with no outcome) → crash-recovery retry —
//      the pinned contract ("a turn that dies mid-stream is simply retried
//      with the same key") stands. A cross-isolate duplicate in this window
//      double-spends PROVIDER tokens but never under-charges (the settle key
//      replays; the M6 platform-cost residual lands with the multi-instance
//      Valkey wave's durable flight markers).
// ---------------------------------------------------------------------------

async function assertFreshTurnKey(
  deps: GatewayDeps,
  workspaceId: string,
  turnKey: string,
  requestId: string,
): Promise<void> {
  const settledCommit = await deps.repos.ledger.getEntryByIdempotencyKey(
    workspaceId,
    deriveIdempotencyKey(`turn:${turnKey}:settle`, "commit"),
  );
  if (settledCommit !== null) {
    throw new GatewayError("TURN_ALREADY_PROCESSED", "This turn was already completed.", {
      status: 409,
      retryable: false,
      hint: "The outcome is in the thread history; start a new run to continue.",
      requestId,
    });
  }
  const refunded = await deps.repos.ledger.getEntryByIdempotencyKey(
    workspaceId,
    `turn:${turnKey}:refund`,
  );
  if (refunded !== null) return; // failed turn, honestly refunded → retryable
  // Fresh reserve with no outcome → crash-recovery retry.
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function turnRoutes(deps: GatewayDeps): Hono {
  const app = new Hono();
  app.use("/v1/threads/*", requireAuth());
  app.use("/v1/runs/*", requireAuth());

  app.post("/v1/threads/:id/turn", requireWorkspace("editor"), async (c): Promise<Response> => {
    const requestId = c.get("requestId");
    const workspace = c.get("workspace");
    const auth = c.get("auth");
    const threadId = pathParam(c, "id");

    const parsed = TURN_REQUEST_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new StudioError("VALIDATION_FAILED", { requestId });
    }
    const request: TurnRequestBody = parsed.data;

    // TURN WIRE CONTRACT: the idempotency header IS the turn key.
    const idempotencyKey = c.req.header("idempotency-key") ?? "";
    const turnKey = `${request.runId}:${request.stepIndex}`;
    if (idempotencyKey === "" || idempotencyKey !== turnKey) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: `Idempotency-Key must be exactly "${turnKey}".`,
        requestId,
      });
    }

    // Thread must live in this workspace (cross-tenant reads as 404).
    const thread = await deps.repos.threads.get(workspace.id, threadId);
    const project = await deps.repos.projects.get(workspace.id, thread.projectId);

    // DURABLE replay: a completed turn persists its outcome keyed by
    // turnKey — a duplicate POST replays it, never a second model call.
    const historyRows = await deps.repos.threads.loadThreadHistory(threadId);
    const replayRow = findReplayTurn(historyRows, turnKey);
    if (replayRow !== null) {
      return replayTurnOutcome(c, request, replayRow);
    }

    // §8.8: never start a turn on a zero balance.
    const balance = await deps.repos.ledger.balance(workspace.id);
    if (balance < 1) {
      throw new StudioError("INSUFFICIENT_CREDITS", { requestId });
    }

    const plan = await resolvePlan(workspace.id, {
      admin: isAdminRole(auth.user.role),
    });
    const model = resolveChatModel({ requested: request.model, plan, requestId });
    // Step 0 creates the run (client-owned id) + persists the user turn.
    // Steps > 0 verify the run + heartbeat + settle echoed tool results.
    let committedSoFar = 0;
    if (request.stepIndex === 0) {
      // THE RUN ROW FIRST (12-w5-t2 bug pin): linkUserMessageToRun 404s
      // unless the run exists, so the user turn persists only after a live
      // run row. A same-key retry of a crashed step-0 (run row already
      // created) reuses the run and does NOT duplicate the user row — the
      // transcript always carries the user message, so a rare crash window
      // only risks a missing history row, never a duplicate.
      let runExisted = false;
      try {
        await deps.repos.runs.create(workspace.id, {
          runId: request.runId,
          threadId,
          projectId: project.id,
          model,
          baseVersionId: project.currentVersionId,
          reservedCredits: 0,
        });
      } catch (error) {
        const existing = await deps.repos.runs.get(workspace.id, request.runId).catch(() => null);
        if (existing === null || existing.run.threadId !== threadId) throw error;
        runExisted = true;
        // AUD-M5: a terminal run is not a free re-entry ticket — the run row
        // is the authority on run liveness, and its terminal states must
        // gate step-0 retries exactly like step>0 below.
        if (isTerminalRunStatus(existing.run.status)) {
          throw new GatewayError("RUN_NOT_ACTIVE", "This run already finished.", {
            status: 409,
            hint: "Start a new run to keep working.",
            requestId,
          });
        }
      }
      if (!runExisted) {
        const userMessage = lastUserText(request.messages);
        if (userMessage !== null) {
          const row = await deps.repos.threads.addMessage(workspace.id, {
            threadId,
            role: "user",
            contentJson: {
              message: userMessage,
              context: request.context,
              pinned: request.pinned,
            },
          });
          await deps.repos.threads
            .linkUserMessageToRun({ messageId: row.id, runId: request.runId })
            .catch(() => undefined);
        }
      }
    } else {
      const { run } = await deps.repos.runs.get(workspace.id, request.runId);
      if (run.threadId !== threadId) {
        throw new GatewayError("RUN_NOT_ACTIVE", "This run belongs to another thread.", {
          status: 404,
          requestId,
        });
      }
      // AUD-M5: the run row's liveness gates EVERY step > 0 — pre-fix a
      // scripted loop could keep driving turns on an abandoned/cancelled run
      // (and with the refund race, for free).
      if (isTerminalRunStatus(run.status)) {
        throw new GatewayError("RUN_NOT_ACTIVE", "This run already finished.", {
          status: 409,
          hint: "Start a new run to keep working.",
          requestId,
        });
      }
      committedSoFar = run.committedCredits;
      await settleEchoedToolResults(deps, threadId, request);
    }
    await deps.repos.runs.touchRunHeartbeat({
      runId: request.runId,
      lastStepIndex: request.stepIndex,
    });

    // §8.8 per-turn reserve: estimate from the assembled prompt size; the
    // authoritative commit is actual usage at turn end.
    const promptMessages = buildTurnMessages({
      history: historyRows,
      transcript: request.messages,
      canvas: request.canvas ?? null,
      context: request.context,
      pinned: request.pinned,
      currentRunId: request.runId,
    });
    const estimate = Math.max(
      1,
      Math.min(12, Math.ceil(JSON.stringify(promptMessages).length / 4000)),
    );
    const reserveAmount = reserveAmountFor(estimate);
    const reserveMicrocredits = creditsToLedgerMicrocredits(reserveAmount);
    const reserved = await deps.repos.ledger.reserve(workspace.id, {
      runId: request.runId,
      amount: reserveMicrocredits,
      idempotencyKey: `turn:${turnKey}:reserve`,
    });
    // AUD-C2: a reserve REPLAY means this exact turn key was seen before.
    // Refuse the re-execution when the turn already completed (its settle
    // commit is a durable record) — pre-fix the replay miss on old turns
    // re-ran the model while both ledger keys replayed (free generation).
    if (reserved.replayed) {
      await assertFreshTurnKey(deps, workspace.id, turnKey, requestId);
    }

    // Local run log: one request, one log — no cross-request state.
    const log = new RunLog(request.runId);
    const inFlight = turnFlights.get(turnKey);
    if (inFlight !== undefined) {
      // Same isolate already streaming this exact turn: attach as a
      // replay of its in-memory log (bounded duplicate protection).
      return sseResponseFromLog(c, inFlight);
    }
    turnFlights.set(turnKey, log);

    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller2) {
        let closed = false;
        const unsubscribe = log.subscribe((event) => {
          if (closed) return;
          try {
            controller2.enqueue(encoder.encode(sseFrame(event)));
          } catch {
            closed = true;
          }
        });
        const keepAlive = setInterval(() => {
          if (closed) return;
          try {
            controller2.enqueue(encoder.encode(": keep-alive\n\n"));
          } catch {
            closed = true;
          }
        }, TURN_KEEPALIVE_MS);
        const finish = (): void => {
          closed = true;
          clearInterval(keepAlive);
          unsubscribe();
          turnFlights.delete(turnKey);
          c.req.raw.signal.removeEventListener("abort", onAbort);
          try {
            controller2.close();
          } catch {
            // already closed
          }
        };
        log.emit({ type: "run.started", model });
        void (async () => {
          await runTurn(deps, {
            request,
            model,
            workspaceId: workspace.id,
            threadId,
            turnKey,
            log,
            promptMessages,
            reserveAmount,
            committedSoFar,
            signal: controller.signal,
            logger: deps.logger,
          });
          finish();
        })();
      },
      cancel() {
        controller.abort();
        turnFlights.delete(turnKey);
        c.req.raw.signal.removeEventListener("abort", onAbort);
      },
    });
    return sseResponse(stream);
  });

  // -------------------------------------------------------------------------
  // POST /v1/runs/:id/plan — the client's MERGED plan lands here at run end:
  // the server VALIDATES + re-compiles it (authoritative) + stamps the §7.3
  // auto-apply verdict + stores plan_json — then the client folds the
  // returned payload as the plan card and (verdict "auto") drives apply.
  // -------------------------------------------------------------------------

  app.post("/v1/runs/:id/plan", requireWorkspace("editor"), async (c): Promise<Response> => {
    const requestId = c.get("requestId");
    const workspace = c.get("workspace");
    const runId = pathParam(c, "id");
    const body = (await c.req.json().catch(() => null)) as { plan?: unknown; end?: boolean } | null;
    // End-arm checks the VALUE, not key presence (round-12 lead TODO, closed
    // round-13 w3-b03): only a literal {end:true} is the proposal-less end
    // marker — {end:false} falls through to the plan arm and answers 400
    // instead of silently completing the run.
    const rawPlan = body?.plan ?? (body !== null && body.end === true ? undefined : body);
    const planChecked = rawPlan === undefined ? null : EDIT_PLAN_SCHEMA.safeParse(rawPlan);
    if (planChecked !== null && !planChecked.success) {
      throw new GatewayError("VALIDATION_FAILED", "That plan didn't look right.", {
        status: 400,
        requestId,
      });
    }
    const plan: EditPlan | null = planChecked?.data ?? null;
    const { run } = await deps.repos.runs.get(workspace.id, runId);
    if (isTerminalRunStatus(run.status) && run.status !== "completed") {
      throw new GatewayError("RUN_NOT_ACTIVE", "This run already finished.", {
        status: 409,
        requestId,
      });
    }
    // The plan POST IS the run's terminal moment (the client posts it
    // exactly once at run end — a merged plan when carriers exist, an
    // end marker when none do). Marking the run completed here is what
    // makes /v1/runs/:id/apply's D-11 plannable-status gate pass
    // (12-w6-e2 finding) and what keeps proposal-less runs from rotting
    // as stale "running" rows.
    if (run.status !== "completed") {
      await deps.repos.runs
        .update(workspace.id, runId, { status: "completed" })
        .catch(() => undefined);
    }
    if (plan === null) {
      // End marker: no proposals (read-only run) — nothing else to do.
      return Response.json({ runId, ended: true }, { headers: { "x-request-id": requestId } });
    }
    const compiled = compilePlanSafe(deps, plan);
    const userAutoApply = await readUserAutoApplySetting(deps, c.get("auth").user.id);
    const decision =
      userAutoApply.readable === true
        ? autoApplyDecision({
            plan,
            compiled,
            userAutoApplyEnabled: userAutoApply.enabled === true,
          })
        : AUTO_APPLY_SETTING_UNAVAILABLE;
    // AUD-H2 fix: store the SERVER-recompiled estimate, never the client's
    // number — `planJson.estimatedCredits` is exactly what the apply path's
    // planCreditsOf trusts, and a devtools client could post 0.0001 on a
    // plan whose compiled cost is far higher. The returned payload carries
    // the same server-stamped plan so the client's plan card is honest.
    const storedPlan =
      compiled.ok && Number.isFinite(compiled.estimatedCredits)
        ? { ...plan, estimatedCredits: Math.max(1, Math.ceil(compiled.estimatedCredits)) }
        : plan;
    await deps.repos.runs.update(workspace.id, runId, { planJson: storedPlan });
    const payload: Record<string, unknown> = {
      runId,
      plan: storedPlan,
      autoApply: decision,
      baseVersionId: run.baseVersionId ?? undefined,
    };
    if (compiled.ok) {
      payload.compiledBatch = compiled.batch;
      payload.risk = compiled.risk;
      payload.estimatedCredits = compiled.estimatedCredits;
      payload.resolutionRequests = compiled.resolutionRequests.map((request2) => ({
        requestId: request2.requestId,
        layerName: request2.layerName,
        disambiguation: [...request2.disambiguation],
      }));
    }
    return Response.json(payload, {
      status: 200,
      headers: { "x-request-id": requestId },
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/runs/:id/abandon — the client gives up mid-run (tab closed,
  // loop aborted): the run is marked abandoned (RUN_ABANDONED, idempotent)
  // and any outstanding holds are refunded. No zombie `running` rows.
  // -------------------------------------------------------------------------

  app.post("/v1/runs/:id/abandon", requireWorkspace("editor"), async (c): Promise<Response> => {
    const requestId = c.get("requestId");
    const workspace = c.get("workspace");
    const runId = pathParam(c, "id");
    const { run } = await deps.repos.runs.get(workspace.id, runId);
    if (!isTerminalRunStatus(run.status)) {
      await deps.repos.runs.markRunAbandoned({ runId });
      // AUD-C1 belt-and-braces: never refund a run-scope hold while one of
      // its turns is still streaming on this isolate — the turn's own
      // uncapped settle is the only thing that may release the hold now.
      // (Money-safety no longer depends on this check; it keeps the ledger
      // shape honest.)
      if (!hasInFlightTurns(runId)) {
        await deps.repos.ledger.refundAll(workspace.id, {
          runId,
          idempotencyKey: `turn:${runId}:abandon:refund`,
        });
      }
    }
    return Response.json(
      { runId, status: "abandoned" },
      { headers: { "x-request-id": requestId } },
    );
  });

  return app;
}

// ---------------------------------------------------------------------------
// The turn body (shared by the real + mock paths)
// ---------------------------------------------------------------------------

async function runTurn(
  deps: GatewayDeps,
  input: {
    readonly request: TurnRequestBody;
    readonly model: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnKey: string;
    readonly log: RunLog;
    readonly promptMessages: readonly OpenAIChatMessage[];
    readonly reserveAmount: number;
    readonly committedSoFar: number;
    readonly signal: AbortSignal;
    readonly logger: import("../logger.js").Logger;
  },
): Promise<void> {
  const { request, log } = input;
  log.emit({ type: "turn.started", stepIndex: request.stepIndex });

  const mockModel = deps.env.app.mockModel === true;
  // AUD-C1: hoisted so the abort path can bill the tokens the side calls
  // (studio.plan_edit) already spent before the stream was cut.
  let sideUsage: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  };
  try {
    let text: string;
    let toolCalls: TurnToolCall[];
    let usage: { inputTokens: number; outputTokens: number };
    let committed: number;

    if (mockModel) {
      const mock = await mockTurn(deps, request, input);
      if (mock.deltas.length > 0) {
        for (const delta of mock.deltas) {
          log.emit({ type: "message.delta", delta });
        }
      }
      text = mock.text;
      toolCalls = mock.toolCalls;
      usage = { inputTokens: 900, outputTokens: 200 };
      committed = 1;
    } else {
      const modelDeps: OpenAITurnDeps = {
        baseUrl: deps.env.litellm.baseUrl,
        apiKey: deps.env.litellm.apiKey,
        virtualKey: deps.env.litellm.virtualKey,
        modelMap: deps.env.litellm.modelMap,
      };
      const round = await executeModelTurn(modelDeps, {
        model: input.model,
        messages: input.promptMessages,
        withTools: true,
        signal: input.signal,
        onDelta: (delta) => {
          log.emit({ type: "message.delta", delta });
        },
      });
      text = round.text;
      usage = { inputTokens: round.inputTokens, outputTokens: round.outputTokens };
      const resolvedCalls = await resolveToolCalls(deps, {
        calls: round.calls,
        model: input.model,
        messages: input.promptMessages,
        modelDeps,
        signal: input.signal,
        log,
        onSideUsage: (used: { inputTokens: number; outputTokens: number }) => {
          sideUsage = {
            inputTokens: sideUsage.inputTokens + used.inputTokens,
            outputTokens: sideUsage.outputTokens + used.outputTokens,
          };
        },
      });
      // §8.8 honesty: the plan_edit side call's tokens bill with the turn
      // (12-w6-g1) — usage-seen billing needs the accumulator marked true.
      usage = {
        inputTokens: usage.inputTokens + sideUsage.inputTokens,
        outputTokens: usage.outputTokens + sideUsage.outputTokens,
      };
      // §8.8: bill the turn's TOTAL usage — the main call + the plan_edit
      // side call's tokens are both real model spend (12-w7-r2 bug pin:
      // spreading `round` here silently dropped the side-folded usage).
      committed = committedCreditsFor(
        input.model,
        { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usageSeen: true },
        input.promptMessages,
      );
      toolCalls = resolvedCalls;
    }

    // Persist the durable turn outcome (the idempotency record) + steps.
    for (const call of toolCalls) {
      await deps.repos.runs
        .insertToolCallStep({
          runId: request.runId,
          threadId: input.threadId,
          stepIndex: request.stepIndex,
          toolCallId: call.toolCallId,
          tool: call.tool,
          argsJson: call.args,
        })
        .catch(() => undefined);
      log.emit({
        type: "tool.started",
        toolCallId: call.toolCallId,
        name: call.tool,
        args: call.args,
      });
    }
    if (text !== "" || toolCalls.length > 0) {
      await deps.repos.threads.insertAssistantMessageRow({
        threadId: input.threadId,
        runId: request.runId,
        text,
        status: "completed",
        payload: {
          turnKey: input.turnKey,
          stepIndex: request.stepIndex,
          toolCalls,
          usage,
          committed,
        },
      });
    }

    // §8.8: settle the per-turn hold with the ACTUAL cost; heartbeat the run.
    // AUD-C1 fix — `uncapped`: the commit is the FULL server-measured
    // actual cost even when a concurrent abandon/cancel/abort already
    // refunded the run-scope hold mid-flight. Pre-fix, the cap
    // (min(actualCost, outstanding)) silently zeroed the charge of every
    // in-flight turn whenever ANY client-reachable refund path won the
    // race — streamed output was delivered + persisted for free.
    await deps.repos.ledger.settle(input.workspaceId, {
      runId: request.runId,
      actualCost: creditsToLedgerMicrocredits(committed),
      idempotencyKey: `turn:${input.turnKey}:settle`,
      uncapped: true,
      metadata: { turnKey: input.turnKey, stepIndex: request.stepIndex },
    });
    await deps.repos.runs.touchRunHeartbeat({
      runId: request.runId,
      lastStepIndex: request.stepIndex,
      creditsCommitted: input.committedSoFar + committed,
    });

    log.emit({
      type: "turn.completed",
      stepIndex: request.stepIndex,
      finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
      usage,
      credits: { committed },
      ...(text !== "" ? { assistantText: text } : {}),
      toolCalls,
    });
  } catch (error) {
    const aborted = input.signal.aborted || (error instanceof Error && error.name === "AbortError");
    const code = aborted
      ? "TURN_CANCELLED"
      : error instanceof Error && error.name === "ModelUnavailableError"
        ? "RUN_MODEL_UNAVAILABLE"
        : "INTERNAL";
    const message = aborted
      ? "The turn was cancelled."
      : error instanceof Error && error.name === "ModelUnavailableError"
        ? "The model service is unavailable right now."
        : "Something went wrong on our side.";
    const retryable = !aborted && code === "RUN_MODEL_UNAVAILABLE";
    // Failed turns NEVER persist the turnKey (a retry must re-run the model),
    // but partial text is kept honestly (status "failed").
    const partialText = collectDeltas(log);
    if (partialText !== "") {
      await deps.repos.threads
        .insertAssistantMessageRow({
          threadId: input.threadId,
          runId: request.runId,
          text: partialText,
          status: "failed",
        })
        .catch(() => undefined);
    }

    // AUD-C1 abort-honesty fix: a client abort is no longer a free-partial-
    // output gesture. When the caller cut the stream AFTER deltas were
    // delivered, the turn settles the server-measured usage (emitted deltas
    // for the output, the assembled prompt for the input, plus any tokens
    // the plan_edit side call already spent) — exactly like a completed
    // turn, so "stream then abort at 95%" costs what it consumed. An abort
    // with NOTHING delivered stays free (honest instant cancel), and
    // provider-side failures (non-abort) keep the full-refund posture.
    let committedOnAbort = 0;
    if (aborted && partialText !== "") {
      committedOnAbort = committedCreditsFor(
        input.model,
        {
          inputTokens:
            Math.ceil(JSON.stringify(input.promptMessages).length / 4) + sideUsage.inputTokens,
          outputTokens: Math.ceil(partialText.length / 4) + sideUsage.outputTokens,
          usageSeen: true,
        },
        input.promptMessages,
      );
      await deps.repos.ledger
        .settle(input.workspaceId, {
          runId: request.runId,
          actualCost: creditsToLedgerMicrocredits(committedOnAbort),
          idempotencyKey: `turn:${input.turnKey}:settle`,
          uncapped: true,
          metadata: { turnKey: input.turnKey, stepIndex: request.stepIndex, aborted: true },
        })
        .catch(() => undefined);
    } else {
      await deps.repos.ledger
        .refundAll(input.workspaceId, {
          runId: request.runId,
          idempotencyKey: `turn:${input.turnKey}:refund`,
        })
        .catch(() => undefined);
    }
    input.logger.error("turn_failed", {
      turnKey: input.turnKey,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
    });
    log.emit({
      type: "turn.failed",
      stepIndex: request.stepIndex,
      code,
      message,
      retryable,
      credits: { committed: committedOnAbort },
    });
  }
}

// ---------------------------------------------------------------------------
// Tool-call resolution (validate → compile write carriers / plan_edit stays
// server-side; read/generative tools return to the client for local execution)
// ---------------------------------------------------------------------------

async function resolveToolCalls(
  deps: GatewayDeps,
  input: {
    readonly calls: readonly AggregatedToolCall[];
    readonly model: string;
    readonly messages: readonly OpenAIChatMessage[];
    readonly modelDeps: OpenAITurnDeps;
    readonly signal: AbortSignal;
    readonly log: RunLog;
    readonly onSideUsage: (usage: { inputTokens: number; outputTokens: number }) => void;
  },
): Promise<TurnToolCall[]> {
  const resolved: TurnToolCall[] = [];
  for (const call of input.calls) {
    const tool = registeredToolFor(call.name);
    const validation = validateToolCall(call);
    if (!validation.ok) {
      resolved.push({
        toolCallId: call.id,
        tool: call.name,
        args: safeJson(call.arguments),
        resultForModel: { error: "INVALID_TOOL_CALL", message: validation.message },
      });
      continue;
    }
    if (tool === null) {
      resolved.push({
        toolCallId: call.id,
        tool: call.name,
        args: safeJson(call.arguments),
        resultForModel: { error: "UNKNOWN_TOOL", message: `Unknown tool "${call.name}".` },
      });
      continue;
    }
    if (tool.id === "studio.plan_edit") {
      const goal = (validation.args as { goal?: string }).goal ?? "";
      const attempt = await serverSidePlan(input.modelDeps, {
        model: input.model,
        goal,
        conversation: input.messages,
        signal: input.signal,
      });
      if (attempt.usage !== undefined) input.onSideUsage(attempt.usage);
      if (attempt.plan !== null) {
        const compiled = compilePlanSafe(deps, attempt.plan);
        const proposal = compiled.ok
          ? {
              compiled: {
                batch: compiled.batch,
                risk: compiled.risk,
                estimatedCredits: compiled.estimatedCredits,
                resolutionRequests: compiled.resolutionRequests.map((request) => ({
                  requestId: request.requestId,
                  layerName: request.layerName,
                  disambiguation: [...request.disambiguation],
                })),
              },
            }
          : null;
        resolved.push({
          toolCallId: call.id,
          tool: tool.id,
          args: validation.args,
          resultForModel: {
            note: "Plan generated. Call the write tools now to propose each change.",
            plan: { intent: attempt.plan.intent, summary: attempt.plan.summary },
          },
          ...(proposal !== null ? { proposal } : {}),
        });
      } else {
        resolved.push({
          toolCallId: call.id,
          tool: tool.id,
          args: validation.args,
          resultForModel: {
            error: "PLAN_INVALID",
            message: attempt.errorMessage ?? "The plan could not be generated.",
          },
        });
      }
      continue;
    }
    if (isClientExecutedTool(tool.id)) {
      resolved.push({
        toolCallId: call.id,
        tool: tool.id,
        args: validation.args,
        resultForModel: {
          note: "Execute this tool locally and report the result with the next turn.",
        },
      });
      continue;
    }
    // Write tools: PROPOSE-ONLY — validate + compile the carrier server-side.
    const proposal = await resolveWriteToolCall(tool, validation.args);
    resolved.push({
      toolCallId: call.id,
      tool: tool.id,
      args: validation.args,
      resultForModel: proposal.resultForModel,
      proposal: proposal.proposal,
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// MOCK_MODEL (the offline journey — one propose turn, one closing text turn)
// ---------------------------------------------------------------------------

async function mockTurn(
  deps: GatewayDeps,
  request: TurnRequestBody,
  input: {
    readonly log: RunLog;
    readonly signal: AbortSignal;
  },
): Promise<{ text: string; deltas: string[]; toolCalls: TurnToolCall[] }> {
  if (input.signal.aborted) {
    throw new DOMException("The turn was cancelled.", "AbortError");
  }
  if (request.stepIndex === 0) {
    const deltas = ["I'll set up a demo for you — a new composition with a text layer. "];
    const toolCalls: TurnToolCall[] = [];
    const carriers: [string, unknown][] = [
      [
        "studio.create_composition",
        { name: "Agent Demo", width: 1920, height: 1080, frameRate: 30, durationSeconds: 4 },
      ],
      [
        "studio.create_text",
        {
          text: "Made with Studio",
          name: "Agent Text",
          position: [960, 540],
          size: 96,
          fill: "#F4F4F5",
        },
      ],
    ];
    for (const [index, [toolId, args]] of carriers.entries()) {
      const tool = registeredToolFor(toolId);
      if (tool === null) continue;
      const proposal = await resolveWriteToolCall(tool, args);
      toolCalls.push({
        toolCallId: `call_mock_${index.toString().padStart(2, "0")}`,
        tool: toolId,
        args,
        resultForModel: proposal.resultForModel,
        proposal: proposal.proposal,
      });
    }
    return { text: deltas.join(""), deltas, toolCalls };
  }
  const text = "Done — I created the Agent Demo composition with a text layer.";
  return { text, deltas: [text], toolCalls: [] };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function compilePlanSafe(deps: GatewayDeps, plan: EditPlan): CompilePlanResult {
  try {
    return compilePlanFn({ plan }, defaultCompileDeps());
  } catch {
    return { ok: false, issues: [] };
  }
}

function lastUserText(messages: readonly TurnMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const part = messages[index];
    if (part !== undefined && (part.role === "user" || part.role === "steer")) return part.text;
  }
  return null;
}

async function settleEchoedToolResults(
  deps: GatewayDeps,
  threadId: string,
  request: TurnRequestBody,
): Promise<void> {
  // The previous turn's tool_result parts arrive in THIS turn's transcript:
  // settle their step rows + persist the tool message rows (history). The
  // cumulative transcript carries the matching tool_call parts too, so the
  // persisted row holds {args, result} together — the exact shape the
  // turn-engine history mapper reads (12-w5-t3 bug pin).
  const argsByCallId = new Map<string, unknown>();
  for (const part of request.messages) {
    if (part.role === "tool_call") argsByCallId.set(part.toolCallId, part.args);
  }
  for (const part of request.messages) {
    if (part.role !== "tool_result") continue;
    await deps.repos.threads
      .insertToolMessageRow({
        threadId,
        runId: request.runId,
        toolCallId: part.toolCallId,
        tool: part.tool,
        payload: {
          args: argsByCallId.get(part.toolCallId) ?? {},
          result: part.result,
        },
      })
      .catch(() => undefined);
    await deps.repos.runs
      .completeToolStep({
        toolCallId: part.toolCallId,
        resultJson: part.result,
        runId: request.runId,
      })
      .catch(() => undefined);
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw === "" ? "{}" : raw);
  } catch {
    return { raw };
  }
}

function collectDeltas(log: RunLog): string {
  return log
    .all()
    .filter(
      (event): event is Extract<StudioStreamEvent, { type: "message.delta" }> =>
        event.type === "message.delta",
    )
    .map((event) => event.delta)
    .join("");
}

interface UserAutoApplySetting {
  readonly readable: boolean;
  readonly enabled?: boolean;
}

async function readUserAutoApplySetting(
  gatewayDeps: GatewayDeps,
  userId: string,
): Promise<UserAutoApplySetting> {
  const settings = (
    gatewayDeps.repos as {
      readonly settings?: { getUserAutoApply?: (id: string) => Promise<boolean> };
    }
  ).settings;
  if (settings === undefined || typeof settings.getUserAutoApply !== "function") {
    return { readable: false };
  }
  try {
    const enabled = await settings.getUserAutoApply(userId);
    return { readable: true, enabled: enabled === true };
  } catch {
    return { readable: false };
  }
}

function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

interface ReplayOutcome {
  readonly text: string;
  readonly toolCalls: TurnToolCall[];
  readonly usage: { inputTokens: number; outputTokens: number };
  readonly committed: number;
  readonly model?: string;
}

function findReplayTurn(rows: readonly TurnHistoryRow[], turnKey: string): ReplayOutcome | null {
  const recent = rows.slice(-REPLAY_SCAN_ROWS);
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const row = recent[index];
    if (row === undefined || row.role !== "assistant") continue;
    const payload = (row.contentJson ?? {}) as {
      turnKey?: unknown;
      toolCalls?: unknown;
      usage?: unknown;
      committed?: unknown;
      model?: unknown;
    };
    if (payload.turnKey !== turnKey) continue;
    return {
      text: row.text ?? "",
      toolCalls: Array.isArray(payload.toolCalls) ? (payload.toolCalls as TurnToolCall[]) : [],
      usage: {
        inputTokens:
          typeof payload.usage === "object" && payload.usage !== null
            ? Number((payload.usage as { inputTokens?: unknown }).inputTokens ?? 0)
            : 0,
        outputTokens:
          typeof payload.usage === "object" && payload.usage !== null
            ? Number((payload.usage as { outputTokens?: unknown }).outputTokens ?? 0)
            : 0,
      },
      committed: typeof payload.committed === "number" ? payload.committed : 0,
      model: typeof payload.model === "string" ? payload.model : undefined,
    };
  }
  return null;
}

function replayTurnOutcome(
  c: import("../context.js").AppContext,
  request: TurnRequestBody,
  outcome: ReplayOutcome,
): Response {
  const log = new RunLog(request.runId);
  const encoder = new TextEncoder();
  const frames: string[] = [];
  log.emit({
    type: "run.started",
    model: outcome.model ?? request.model ?? "studio-fast",
  });
  log.emit({ type: "turn.started", stepIndex: request.stepIndex });
  log.emit({
    type: "turn.completed",
    stepIndex: request.stepIndex,
    finishReason: outcome.toolCalls.length > 0 ? "tool-calls" : "stop",
    usage: outcome.usage,
    credits: { committed: 0 }, // already committed by the original turn
    ...(outcome.text !== "" ? { assistantText: outcome.text } : {}),
    toolCalls: outcome.toolCalls,
  });
  for (const event of log.all()) frames.push(sseFrame(event));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join("")));
      controller.close();
    },
  });
  return sseResponse(stream);
}

function sseResponseFromLog(c: import("../context.js").AppContext, log: RunLog): Response {
  const encoder = new TextEncoder();
  const existing = log
    .all()
    .map((event) => sseFrame(event))
    .join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(existing));
      const unsubscribe = log.subscribe((event) => {
        try {
          controller.enqueue(encoder.encode(sseFrame(event)));
        } catch {
          // stream torn down
        }
        if (log.isTerminal) {
          setImmediate(() => {
            try {
              controller.close();
            } catch {
              // already closed
            }
            unsubscribe();
          });
        }
      });
      if (log.isTerminal) {
        try {
          controller.close();
        } catch {
          // already closed
        }
        unsubscribe();
      }
    },
  });
  return sseResponse(stream);
}

function sseFrame(event: StudioStreamEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
