// @studio/gateway — /v1/runs (§7.2, §8.7, §8.9): run record, cancel, and the
// client event sink for editor tool results / apply results.
//
// §7.4 rule: tool results are accepted only with the run token (= the run id,
// authorized by workspace membership) and only for the expected toolCallId
// (the runner registered it in the run log). On a successful apply with a
// sha256 the gateway creates the version through the repo (which owns the
// PROJECT_VERSION_CONFLICT check) and commits the credits.

import { Hono } from "hono";

import { CANCEL_RUN_SCHEMA, RUN_EVENT_REQUEST_SCHEMA, type RunRecord } from "@studio/contracts";

import { type AgentRun, isTerminalRunStatus } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, pathParam } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { snapshotKey } from "../storage.js";
import { audit } from "./projects.js";

export function runsRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/runs/*", requireAuth());

  const toRecord = (
    run: AgentRun,
    steps: readonly { seq: number; tool: string; status: string; durationMs: number | null }[],
  ): RunRecord => ({
    id: run.id,
    threadId: run.threadId,
    projectId: run.projectId,
    model: (["studio-fast", "studio-smart", "studio-vision"] as const).includes(run.model as never)
      ? (run.model as RunRecord["model"])
      : "studio-fast",
    status: (
      [
        "queued",
        "streaming",
        "awaiting_approval",
        "applying",
        "completed",
        "failed",
        "cancelled",
      ] as const
    ).includes(run.status as never)
      ? (run.status as RunRecord["status"])
      : "queued",
    plan: null,
    steps: steps.map((step) => ({
      seq: step.seq,
      tool: step.tool,
      status:
        // DB writers emit "running"/"success" (and legacy "started"/"succeeded");
        // the wire vocabulary (RUN_RECORD_SCHEMA) is started/succeeded/failed/
        // skipped — translate in ONE place instead of at every writer.
        step.status === "running" || step.status === "started"
          ? "started"
          : step.status === "success" || step.status === "succeeded"
            ? "succeeded"
            : step.status === "failed"
              ? "failed"
              : "skipped",
      durationMs: step.durationMs,
    })),
    reservedCredits: run.reservedCredits,
    committedCredits: run.committedCredits,
    baseVersionId: run.baseVersionId,
    resultVersionId: run.resultVersionId,
    errorCode: run.errorCode,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt !== null ? run.completedAt.toISOString() : null,
  });

  app.get("/v1/runs/:id", requireWorkspace("viewer"), async (c: AppContext): Promise<Response> => {
    const { run, steps } = await deps.repos.runs.get(c.get("workspace").id, pathParam(c, "id"));
    return ok(c, toRecord(run, steps));
  });

  app.post(
    "/v1/runs/:id/cancel",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const requestId = c.get("requestId");
      const runId = pathParam(c, "id");
      const parsed = CANCEL_RUN_SCHEMA.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          requestId,
        });
      }

      const { run } = await deps.repos.runs.get(workspace.id, runId);
      if (isTerminalRunStatus(run.status)) {
        return ok(c, { runId, status: run.status, cancelled: false });
      }

      const log = deps.runs.get(runId);
      if (log === null) {
        // No live stream (e.g. gateway restarted with a mid-flight run):
        // finalize directly — cancel status + full refund (§8.9).
        await deps.repos.runs.update(workspace.id, runId, {
          status: "cancelled",
          errorCode: "RUN_CANCELLED",
        });
        await deps.repos.ledger.refundAll(workspace.id, {
          runId,
          idempotencyKey: `chat:${runId}:refund`,
        });
        await audit(deps, c, workspace.id, "run.cancelled", runId);
        return ok(c, { runId, status: "cancelled", cancelled: true });
      }

      const cancelled = deps.runs.cancel(runId);
      deps.runner.cancel(runId);
      if (!cancelled) {
        return ok(c, { runId, status: run.status, cancelled: false });
      }
      await audit(deps, c, workspace.id, "run.cancelled", runId);
      // The streaming finalize path emits run.cancelled and refunds.
      return ok(c, { runId, status: "cancelling", cancelled: true });
    },
  );

  app.post(
    "/v1/runs/:id/events",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const requestId = c.get("requestId");
      const runId = pathParam(c, "id");

      const parsed = RUN_EVENT_REQUEST_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Send a tool.result or an apply.result event.",
          requestId,
        });
      }
      const event = parsed.data;

      const { run } = await deps.repos.runs.get(workspace.id, runId);
      if (isTerminalRunStatus(run.status)) {
        throw new GatewayError("RUN_NOT_ACTIVE", "This run already finished.", {
          status: 409,
          hint: "Start a new run to make further changes.",
          requestId,
        });
      }
      const log = deps.runs.get(runId);
      if (log === null) {
        throw new GatewayError("RUN_NOT_ACTIVE", "This run is not accepting events right now.", {
          status: 409,
          hint: "The run must be streaming; reconnect via the chat route.",
          requestId,
        });
      }

      const { steps } = await deps.repos.runs.get(workspace.id, runId);
      const nextSeq = steps.length;

      if (event.type === "tool.result") {
        // §7.4: only the expected toolCallId may report a result.
        const tool = log.toolNameFor(event.toolCallId);
        if (tool === null) {
          throw new GatewayError("VALIDATION_FAILED", "Unknown toolCallId for this run.", {
            status: 400,
            hint: "Report results only for tool calls this run started.",
            requestId,
          });
        }
        await deps.repos.runs.addStep(workspace.id, {
          runId,
          seq: nextSeq,
          tool,
          resultJson: event.result,
          status: "success",
        });
        log.emit({ type: "tool.result", toolCallId: event.toolCallId, result: event.result });
        return ok(c, { runId, recorded: true });
      }

      // apply.result (§8.7)
      if (!event.ok) {
        const errorCode = event.errorCode ?? "RUN_FAILED";
        await deps.repos.runs.addStep(workspace.id, {
          runId,
          seq: nextSeq,
          tool: "apply",
          status: "failed",
          resultJson: { errorCode, errorMessage: event.errorMessage },
        });
        await deps.repos.runs.update(workspace.id, runId, {
          status: "failed",
          errorCode,
          planJson: log.currentPlan ?? undefined,
        });
        await deps.repos.ledger.refundAll(workspace.id, {
          runId,
          idempotencyKey: `chat:${runId}:refund`,
        });
        log.emit({
          type: "run.failed",
          code: errorCode,
          message: event.errorMessage ?? "The planned edit failed to apply.",
          retryable: false,
        });
        return ok(c, { runId, recorded: true, status: "failed" });
      }

      // Apply succeeded: register the new version (repo owns the 409 check).
      if (event.sha256 === undefined) {
        throw new GatewayError("VALIDATION_FAILED", "A successful apply requires the new sha256.", {
          status: 400,
          requestId,
        });
      }
      const sha = event.sha256;
      const objectKey = snapshotKey(workspace.id, run.projectId, sha);
      const head = await deps.storage.head(objectKey);
      try {
        const { version } = await deps.repos.versions.upload(workspace.id, {
          projectId: run.projectId,
          expectedVersionId: run.baseVersionId,
          objectKey,
          sha256: sha,
          sizeBytes: head?.size ?? 0,
          label: event.versionLabel ?? `Agent run ${runId}`,
          agentRunId: runId,
          createdBy: c.get("auth").user.id,
        });

        const committed = Math.min(
          run.reservedCredits,
          Math.max(1, Math.ceil(run.reservedCredits / 2)),
        );
        const settled = await deps.repos.ledger.settle(workspace.id, {
          runId,
          actualCost: committed,
          idempotencyKey: `chat:${runId}:settle`,
        });
        const balance = await deps.repos.ledger.balance(workspace.id);
        const actualCommit = settled.commit !== null ? -settled.commit.amount : 0;

        await deps.repos.runs.update(workspace.id, runId, {
          status: "completed",
          committedCredits: actualCommit,
          resultVersionId: version.id,
          planJson: log.currentPlan ?? undefined,
        });
        await deps.repos.runs.addStep(workspace.id, {
          runId,
          seq: nextSeq,
          tool: "apply",
          status: "success",
          resultJson: { versionId: version.id, sha256: sha },
        });

        log.emit({
          type: "credits",
          reserved: run.reservedCredits,
          committed: actualCommit,
          balance,
        });
        log.emit({ type: "run.completed", versionId: version.id });
        await audit(deps, c, workspace.id, "run.applied", run.projectId, {
          runId,
          versionId: version.id,
        });
        return ok(c, { runId, recorded: true, status: "completed", versionId: version.id });
      } catch (error) {
        // §9.3: never overwrite — the conflict bubbles as the typed 409 envelope.
        await deps.repos.runs
          .update(workspace.id, runId, {
            status: "failed",
            errorCode: "PROJECT_VERSION_CONFLICT",
          })
          .catch(() => undefined);
        await deps.repos.ledger.refundAll(workspace.id, {
          runId,
          idempotencyKey: `chat:${runId}:refund`,
        });
        log.emit({
          type: "run.failed",
          code: "PROJECT_VERSION_CONFLICT",
          message: "The project changed while you were working.",
          retryable: false,
        });
        throw error;
      }
    },
  );

  return app;
}
