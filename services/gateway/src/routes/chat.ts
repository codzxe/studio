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
// MOCK_MODEL=true, UnavailableRunner (RUN_MODEL_UNAVAILABLE, refunded)
// until the LiteLLM runner lands in Wave 4.

import { Hono } from "hono";

import {
  CHAT_REQUEST_SCHEMA,
  defaultModelForPlan,
  type StudioStreamEvent,
} from "@studio/contracts";

import { StudioError } from "@studio/config";

import { pathParam } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import {
  estimateRunCredits,
  reserveAmountFor,
  type AgentRun,
  type AgentRunOutcome,
  type AgentRunStream,
  type RunLog,
} from "../runner.js";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";

/** Safety ceiling for one streaming run; afterwards the run is cancelled. */
const CHAT_TIMEOUT_MS = 120_000;

export function chatRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/threads/*", requireAuth());

  app.post("/v1/threads/:id/chat", requireWorkspace("editor"), async (c: AppContext): Promise<Response> => {
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

    const model = defaultModelForPlan("trial");

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
    };

    // Stream finalization: settle/refund, terminal event, run row, steps.
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
            .filter((event): event is Extract<StudioStreamEvent, { type: "message.delta" }> => event.type === "message.delta")
            .map((event) => event.delta)
            .join("");
          if (text.length > 0) {
            await deps.repos.threads
              .addMessage(workspace.id, { threadId, role: "assistant", contentJson: { text }, runId })
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
      emit: (payload) => log.emit(payload),
      yieldToStream: () => new Promise<void>((resolveYield) => setImmediate(resolveYield)),
      expectToolCall: (toolCallId, tool) => log.expectToolCall(toolCallId, tool),
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
  });

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
        if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
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
