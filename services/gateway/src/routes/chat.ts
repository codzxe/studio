// @studio/gateway — POST /v1/threads/:id/chat (§7.2, §7.4, §8.8): the SSE
// agent route.
//
// Flow (§5.1 trust boundaries — the browser is never trusted for credits):
//   auth + workspace(editor, runAgent) → thread+project checks →
//   balance precheck (INSUFFICIENT_CREDITS before anything) → create run →
//   reserve credits (ceil(estimate × 1.2), min 1) → stream §7.4 events.
//
// Streaming contract:
//   * one SSE frame per StudioStreamEvent, `id:` carries the monotonic seq
//   * `Last-Event-ID` reconnect replays from the in-memory run log
//   * the body idempotencyKey maps to a run: a duplicate POST replays the
//     same run instead of starting a second one (§8.4 reconnect rules)
//   * client abort / POST /v1/runs/:id/cancel abort the runner, emit
//     run.cancelled and refund the full outstanding reserve (§8.9)
//
// The model side is an AgentRunner seam (runner.ts): MockRunner when
// MOCK_MODEL=true, the LiteLLM runner otherwise (D-16) — streaming via the
// OpenAI-compatible proxy, client read tools resolved through the run log's
// tool-result wait seam (Seam 2), studio.plan_edit structured server-side.

import { Hono } from "hono";

import {
  CHAT_REQUEST_SCHEMA,
  type ModelId,
  type PlanId,
  type StudioStreamEvent,
  defaultModelForPlan,
  modelAllowedForPlan,
} from "@studio/contracts";

import { StudioError } from "@studio/config";
import type { AgentMessage, Repos } from "@studio/db";

import { AUTO_APPLY_SETTING_UNAVAILABLE, autoApplyDecision } from "../auto-apply.js";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { pathParam } from "../http.js";
import { TOOL_RESULT_TIMEOUT_MS } from "../litellm/runner.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import type { CompilePlanResult } from "../plan-compiler.js";
import { resolvePlan } from "../plan.js";
import {
  type AgentRun,
  type AgentRunHistoryTurn,
  type AgentRunOutcome,
  type AgentRunStream,
  type RunLog,
  type RunStreamPayload,
  estimateRunCredits,
  reserveAmountFor,
} from "../runner.js";

/** Safety ceiling for one streaming run; afterwards the run is cancelled. */
const CHAT_TIMEOUT_MS = 120_000;

/** §8.3: the model sees the thread's last 6 turns. */
const HISTORY_TURNS = 6;

/**
 * Model selection with plan entitlements (§8.2 "Plan gating", §10.1; M4
 * Seam 1). Exported for unit tests. `requested` unset → the plan's default;
 * set but not entitled → MODEL_NOT_ENTITLED (403, never leaks plan data).
 */
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
// M5.6 auto-apply wiring (BUILD_PLAN §M5 task 6, EDITOR_CHAT_UX §7.3 — off by
// default; policy module: src/auto-apply.ts). The plan event is stamped with
// the server-side verdict as it passes through this route's emit seam:
// UI GUIDANCE ONLY in v1 — the client never executes a plan from the event
// alone; `mode: "auto"` arms the card, Apply stays the user's click (D-22
// candidate ruling, worklog M5-O).
// ---------------------------------------------------------------------------

/**
 * Pinned M6-D seam (packages/db/src/repos/settings.ts, this wave):
 * `repos.settings.getUserAutoApply(userId): Promise<boolean>` over the
 * userSettings table (autoApplyEnabled, default false). Structural — read
 * through a guard so boots without the repo (stub suites, mid-flight test
 * trees) degrade to a propose verdict, never a crash.
 */
interface SettingsAutoApplySeam {
  getUserAutoApply(userId: string): Promise<boolean>;
}

/** The per-user setting as this route sees it: readable ⇒ enabled flag. */
type UserAutoApplySetting =
  | { readonly readable: true; readonly enabled: boolean }
  | { readonly readable: false };

async function readUserAutoApplySetting(
  gatewayDeps: GatewayDeps,
  userId: string,
): Promise<UserAutoApplySetting> {
  const settings = (gatewayDeps.repos as Repos & { readonly settings?: SettingsAutoApplySeam })
    .settings;
  if (settings === undefined || typeof settings.getUserAutoApply !== "function") {
    return { readable: false };
  }
  try {
    const enabled = await settings.getUserAutoApply(userId);
    return { readable: true, enabled: enabled === true };
  } catch {
    // Repo present but the read failed (e.g. the table hasn't landed yet):
    // fail closed to propose — the run itself must never break.
    return { readable: false };
  }
}

/** The plan payload's compile view (server-recomputed fields only). */
type PlanStreamPayload = Extract<RunStreamPayload, { type: "plan" }>;

/**
 * Rebuilds the compiler-result view the policy needs from the plan event's
 * SERVER-recomputed fields (the plan event is the compiler's own projection —
 * risk/estimatedCredits/compiledBatch, never the model's plan numbers). An
 * event missing any of the three enrichment fields (M4-shaped or un-compiled
 * plans) is treated as not-compiled — fail closed, never fabricates values.
 */
function compiledViewOfPlanPayload(payload: PlanStreamPayload): CompilePlanResult {
  const { compiledBatch, risk, estimatedCredits } = payload;
  if (compiledBatch === undefined || risk === undefined || estimatedCredits === undefined) {
    return { ok: false, issues: [] };
  }
  return {
    ok: true,
    batch: compiledBatch,
    risk,
    estimatedCredits,
    resolutionRequests: [],
    placeholders: [],
    warnings: [],
  };
}

/** Stamps `{type: "plan"}` payloads with the §7.3 verdict; others pass through. */
function attachAutoApplyVerdict(
  payload: RunStreamPayload,
  setting: UserAutoApplySetting,
): RunStreamPayload {
  if (payload.type !== "plan") return payload;
  const decision =
    setting.readable === true
      ? autoApplyDecision({
          plan: payload.plan,
          compiled: compiledViewOfPlanPayload(payload),
          userAutoApplyEnabled: setting.enabled,
        })
      : AUTO_APPLY_SETTING_UNAVAILABLE;
  return { ...payload, autoApply: decision };
}

export function chatRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/threads/*", requireAuth());

  app.post(
    "/v1/threads/:id/chat",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const requestId = c.get("requestId");
      const workspace = c.get("workspace");
      const threadId = pathParam(c, "id");

      const parsed = CHAT_REQUEST_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new StudioError("VALIDATION_FAILED", { requestId });
      }
      const request = parsed.data;

      // Thread must live in this workspace (repo: cross-tenant reads as 404).
      const thread = await deps.repos.threads.get(workspace.id, threadId);
      const project = await deps.repos.projects.get(workspace.id, thread.projectId);

      // §8.8: never start a run on a zero balance.
      const balance = await deps.repos.ledger.balance(workspace.id);
      if (balance < 1) {
        throw new StudioError("INSUFFICIENT_CREDITS", { requestId });
      }

      // Duplicate POST (network retry): replay the same run's log.
      const replayKey = `${workspace.id}:${threadId}:${request.idempotencyKey}`;
      const existing = deps.chatReplay.lookup(replayKey);
      if (existing !== null) {
        return sseResponse(c, existing.log, c.req.header("last-event-id"));
      }

      // Model selection with plan entitlements (§8.2/§10.1): resolvePlan is the
      // M6 swap point; MODEL_NOT_ENTITLED never starts a run.
      const plan = await resolvePlan(workspace.id);
      const model = resolveChatModel({ requested: request.model, plan, requestId });

      // §8.3 "last 6 turns" — loaded BEFORE this run's user turn is persisted,
      // so history never contains the message the model is answering.
      const history = await loadHistory(deps, workspace.id, threadId);

      // Persist the user turn before the run exists (§9.1 agent_messages).
      await deps.repos.threads.addMessage(workspace.id, {
        threadId,
        role: "user",
        contentJson: { message: request.message, context: request.context, pinned: request.pinned },
      });

      const run = await deps.repos.runs.create(workspace.id, {
        threadId,
        projectId: project.id,
        model,
        baseVersionId: project.currentVersionId,
        reservedCredits: 0,
      });

      const estimated = estimateRunCredits({
        message: request.message,
        context: request.context,
        pinned: request.pinned,
      });
      const reserveAmount = reserveAmountFor(estimated);

      const runId = run.id;
      try {
        await deps.repos.ledger.reserve(workspace.id, {
          runId,
          amount: reserveAmount,
          idempotencyKey: `chat:${runId}:reserve`,
        });
      } catch (error) {
        // Reserve refused (e.g. balance dipped): the run never streams.
        await deps.repos.runs
          .update(workspace.id, runId, { status: "failed", errorCode: "INSUFFICIENT_CREDITS" })
          .catch(() => undefined);
        throw error;
      }

      await deps.repos.runs.update(workspace.id, runId, {
        status: "running",
        reservedCredits: reserveAmount,
      });

      // M5.6: read the per-user auto-apply setting ONCE per run (off by
      // default; pinned M6-D seam — guarded, so a missing/failed read degrades
      // to the propose verdict and never breaks the run).
      const userAutoApply = await readUserAutoApplySetting(deps, c.get("auth").user.id);

      const { log, signal } = deps.runs.register(runId);
      deps.chatReplay.store(replayKey, { runId, log });

      const agentRun: AgentRun = {
        runId,
        threadId,
        projectId: project.id,
        workspaceId: workspace.id,
        model,
        baseVersionId: project.currentVersionId,
        message: request.message,
        context: request.context,
        pinned: request.pinned,
        reservedCredits: reserveAmount,
        history,
      };

      // Stream finalization: settle/refund, terminal event, run row, steps
      // (agent_steps single writer — see recordSteps below).
      let finalized = false;
      const finalize = async (outcome: AgentRunOutcome): Promise<void> => {
        if (finalized) return;
        finalized = true;
        try {
          if (outcome.kind === "completed") {
            const settled = await deps.repos.ledger.settle(workspace.id, {
              runId,
              actualCost: outcome.committedCredits,
              idempotencyKey: `chat:${runId}:settle`,
            });
            const newBalance = await deps.repos.ledger.balance(workspace.id);
            const committed = settled.commit !== null ? -settled.commit.amount : 0;
            log.emit({
              type: "credits",
              reserved: reserveAmount,
              committed,
              balance: newBalance,
            });
            log.emit({ type: "run.completed" });
            await deps.repos.runs.update(workspace.id, runId, {
              status: "completed",
              committedCredits: committed,
              planJson: log.currentPlan ?? undefined,
            });
            const text = log
              .all()
              .filter(
                (event): event is Extract<StudioStreamEvent, { type: "message.delta" }> =>
                  event.type === "message.delta",
              )
              .map((event) => event.delta)
              .join("");
            if (text.length > 0) {
              await deps.repos.threads
                .addMessage(workspace.id, {
                  threadId,
                  role: "assistant",
                  contentJson: { text },
                  runId,
                })
                .catch(() => undefined);
            }
          } else if (outcome.kind === "failed") {
            await deps.repos.ledger.refundAll(workspace.id, {
              runId,
              idempotencyKey: `chat:${runId}:refund`,
            });
            log.emit({
              type: "run.failed",
              code: outcome.code,
              message: outcome.message,
              retryable: outcome.retryable,
            });
            await deps.repos.runs.update(workspace.id, runId, {
              status: "failed",
              errorCode: outcome.code,
              planJson: log.currentPlan ?? undefined,
            });
          } else {
            await deps.repos.ledger.refundAll(workspace.id, {
              runId,
              idempotencyKey: `chat:${runId}:refund`,
            });
            if (!log.isTerminal) log.emit({ type: "run.cancelled" });
            await deps.repos.runs.update(workspace.id, runId, {
              status: "cancelled",
              errorCode: "RUN_CANCELLED",
              planJson: log.currentPlan ?? undefined,
            });
          }
          await recordSteps(workspace.id, log, runId);
        } catch (error) {
          deps.logger.error("chat_finalize_failed", {
            requestId,
            runId,
            detail: error instanceof Error ? error.message : "unknown",
          });
        } finally {
          closeStream();
          abortListener.disconnect();
        }
      };

      // --- SSE transport -----------------------------------------------------
      const encoder = new TextEncoder();
      let lastSent = parseSeq(c.req.header("last-event-id"));
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
      let closed = false;

      const unsubscribe = log.subscribe((event) => {
        if (controllerRef === null || closed) return;
        if (event.seq > lastSent) {
          lastSent = event.seq;
          try {
            controllerRef.enqueue(encoder.encode(sseFrame(event)));
          } catch {
            // stream already torn down
          }
        }
      });

      const streamApi: AgentRunStream = {
        // M5.6: the §7.3 verdict rides the plan event (UI guidance only).
        emit: (payload) => log.emit(attachAutoApplyVerdict(payload, userAutoApply)),
        yieldToStream: () => new Promise<void>((resolveYield) => setImmediate(resolveYield)),
        expectToolCall: (toolCallId, tool) => log.expectToolCall(toolCallId, tool),
        // Seam 2: the runner waits for the client's POST /v1/runs/:id/events;
        // timeout → EDITOR_DISCONNECTED inside the LiteLLM runner.
        waitForToolResult: (toolCallId) => log.waitToolResult(toolCallId, TOOL_RESULT_TIMEOUT_MS),
        signal,
      };

      const cancelRun = (): void => {
        if (!finalized && !log.isTerminal) {
          deps.runs.cancel(runId);
          deps.runner.cancel(runId);
        }
      };

      const abortListener = {
        connect: (): void => {
          c.req.raw.signal.addEventListener("abort", onAbort);
        },
        disconnect: (): void => {
          c.req.raw.signal.removeEventListener("abort", onAbort);
        },
      };
      function onAbort(): void {
        cancelRun();
      }
      abortListener.connect();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          // Replay anything the client missed before the subscription window.
          for (const event of log.replayAfter(parseSeq(c.req.header("last-event-id")))) {
            if (event.seq > lastSent) {
              lastSent = event.seq;
              try {
                controller.enqueue(encoder.encode(sseFrame(event)));
              } catch {
                // stream already torn down
              }
            }
          }
          // Fire the run; the outcome finalizes the ledger + stream.
          void (async () => {
            let outcome: AgentRunOutcome;
            try {
              const timeout = new Promise<AgentRunOutcome>((resolveTimeout) => {
                const timer = setTimeout(() => {
                  resolveTimeout({ kind: "cancelled" });
                  deps.runs.cancel(runId);
                }, CHAT_TIMEOUT_MS);
                timer.unref?.();
              });
              outcome = await Promise.race([deps.runner.start(agentRun, streamApi), timeout]);
            } catch (error) {
              outcome = {
                kind: "failed",
                code: "INTERNAL",
                message: "Something went wrong on our side.",
                retryable: true,
              };
              deps.logger.error("chat_runner_threw", {
                requestId,
                runId,
                detail: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
              });
            }
            await finalize(outcome);
          })();
        },
        cancel() {
          // Client disconnected: stop the model + release the reserve (§8.9).
          cancelRun();
        },
      });

      function closeStream(): void {
        closed = true;
        try {
          controllerRef?.close();
        } catch {
          // already closed
        }
        unsubscribe();
      }

      // Runs cancel via POST too (see runs.ts) — the abort listener handles
      // socket disconnects; both funnel into the same finalize.
      return sseResponseFromStream(stream);
    },
  );

  /**
   * §8.3 "last 6 turns": newest-first repo page → oldest-first turns. Only
   * user/assistant rows are user-facing history; the run's own message is
   * not persisted yet at call time.
   */
  async function loadHistory(
    gatewayDeps: GatewayDeps,
    workspaceId: string,
    threadId: string,
  ): Promise<AgentRunHistoryTurn[]> {
    const page = await gatewayDeps.repos.threads.listMessages(workspaceId, threadId, {
      limit: HISTORY_TURNS,
    });
    const turns: AgentRunHistoryTurn[] = [];
    for (const message of [...page.items].reverse()) {
      const turn = historyTurn(message);
      if (turn !== null) turns.push(turn);
    }
    return turns;
  }

  function historyTurn(message: AgentMessage): AgentRunHistoryTurn | null {
    const content = message.contentJson as { message?: unknown; text?: unknown };
    if (message.role === "user" && typeof content?.message === "string") {
      return { role: "user", content: content.message };
    }
    if (message.role === "assistant" && typeof content?.text === "string") {
      return { role: "assistant", content: content.text };
    }
    return null; // system/tool rows are not user-facing history
  }

  /**
   * agent_steps SINGLE WRITER (M4 tail #2, fixed by M5-C): finalize walks
   * the run log ONCE and writes exactly one row per tool event — every
   * tool.started becomes a row with its args (status "running"), every
   * tool.result a row with its payload (status "success"), both keyed by the
   * wire `seq` (correlates 1:1 with the SSE/replay evidence; (run_id, seq)
   * UNIQUE makes replays idempotent). The runs-route event sink no longer
   * inserts step rows — this is the only writer, so one client tool call is
   * exactly TWO rows (args + result), server-resolved tools included. Run
   * once per run (the `finalized` guard); duplicate seqs are swallowed.
   */
  async function recordSteps(workspaceId: string, log: RunLog, runId: string): Promise<void> {
    for (const event of log.all()) {
      try {
        if (event.type === "tool.started") {
          await deps.repos.runs.addStep(workspaceId, {
            runId,
            seq: event.seq,
            tool: event.name,
            argsJson: event.args,
            status: "running",
          });
        } else if (event.type === "tool.result") {
          await deps.repos.runs.addStep(workspaceId, {
            runId,
            seq: event.seq,
            tool: log.toolNameFor(event.toolCallId) ?? event.toolCallId,
            resultJson: event.result,
            status: "success",
          });
        }
      } catch {
        // duplicate step ids on replay — the run row is the record of truth
      }
    }
  }

  return app;
}

function parseSeq(header: string | undefined): number {
  if (header === undefined) return -1;
  const parsed = Number.parseInt(header, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
}

function sseFrame(event: StudioStreamEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseResponseFromStream(stream: ReadableStream<Uint8Array>): Response {
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

function sseResponse(c: AppContext, log: RunLog, lastEventId: string | undefined): Response {
  const encoder = new TextEncoder();
  const from = parseSeq(lastEventId);
  const frames = log
    .replayAfter(from)
    .map((event) => sseFrame(event))
    .join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      // Live runs keep streaming; terminal logs close after the replay.
      const unsubscribe = log.subscribe((event) => {
        if (event.seq > from) {
          try {
            controller.enqueue(encoder.encode(sseFrame(event)));
          } catch {
            // already closed
          }
        }
        if (
          event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled"
        ) {
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
        controller.close();
        unsubscribe();
      }
    },
  });
  return sseResponseFromStream(stream);
}
