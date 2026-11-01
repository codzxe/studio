// @studio/gateway — /v1/runs (§7.2, §8.7, §8.9): run record, cancel, and the
// client event sink for apply results (the legacy §8.7 surface the wire
// contracts still pin). On a successful apply with a sha256 the gateway
// creates the version through the repo (which owns the PROJECT_VERSION_
// CONFLICT check) and commits the credits.
//
// agent_steps SINGLE-WRITER (M4 tail #2, fixed by M5-C): the chat route's
// finalize (recordSteps in routes/chat.ts) was the only writer of run step
// rows in the round-10 world; the round-12 turn route (routes/turn.ts) now
// persists its own tool-call steps per turn. THIS sink's apply.result arm
// still writes exactly ONE "apply" step row per run (the client's §8.7
// outcome); its tool.result arm is the honest 409 (see below).
//
// ROUND-12 TRUTH (w1-a27 S248/S255, W3-b02): the retired round-10 chat loop
// was the ONLY RunRegistry.register caller and is not mounted — nothing in
// the mounted app ever populates the registry, so this module no longer
// consults it (deps.runs/deps.runner stay on GatewayDeps for other callers).
// The DB run row is the single authority: cancel is a DB-only finalize, the
// apply.result settle bills the run row's accumulated ACTUAL usage in the
// turn world's µc dialect (D-12). The round-12 client's stop gesture is
// POST /v1/runs/:id/abandon (routes/turn.ts); the tool-result round-trip
// rides the next turn's BODY, so this sink's tool.result arm answers the
// honest 409 below.

import { Hono } from "hono";

import { CANCEL_RUN_SCHEMA, RUN_EVENT_REQUEST_SCHEMA, type RunRecord } from "@studio/contracts";

import { type AgentRun, isTerminalRunStatus } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { creditsToLedgerMicrocredits, microcreditsToWholeCredits } from "../credits-display.js";
import { GatewayError } from "../errors.js";
import { ok, pathParam } from "../http.js";
import { requireLeaseForMutation } from "../lease-guard.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { snapshotKey } from "../storage.js";
import { audit } from "./projects.js";
import { hasInFlightTurns } from "./turn.js";

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
    // ROUND-12 (12-w7-r1 BUG-2a fix): the turn world's DB rows speak
    // "running" — the wire vocabulary never learned it, so every live run
    // misread "queued". Map it to the wire's "streaming" (honest: a
    // heartbeating turn-world run IS streaming from the client's view).
    status:
      run.status === "running"
        ? "streaming"
        : (
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

      // ROUND-12 TRUTH (w1-a27 S248/S255, W3-b02): the DB row is the
      // authority: finalize directly — cancel status + full refund (§8.9).
      // A live turn's own settle/refund keys are idempotent, so a cancel
      // racing a turn finalize fails safe (refundAll no-ops on a zero
      // outstanding hold).
      //
      // AUD-C1 (2026-10-30 deep audit): the refund is SKIPPED while one of
      // the run's turns is still streaming on this isolate — the turn's own
      // uncapped settle both commits the delivered usage and releases the
      // hold. Money-safety no longer depends on this check (settle is
      // uncapped); it keeps the ledger shape honest.
      await deps.repos.runs.update(workspace.id, runId, {
        status: "cancelled",
        errorCode: "RUN_CANCELLED",
      });
      if (!hasInFlightTurns(runId)) {
        await deps.repos.ledger.refundAll(workspace.id, {
          runId,
          idempotencyKey: `chat:${runId}:refund`,
        });
      }
      await audit(deps, c, workspace.id, "run.cancelled", runId);
      return ok(c, { runId, status: "cancelled", cancelled: true });
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

      // ONE fetch: the run row AND its steps (the second full fetch the old
      // code made just to re-read `steps` is gone — w1-a27 S248 LOW).
      const { run, steps } = await deps.repos.runs.get(workspace.id, runId);
      if (isTerminalRunStatus(run.status)) {
        throw new GatewayError("RUN_NOT_ACTIVE", "This run already finished.", {
          status: 409,
          hint: "Start a new run to make further changes.",
          requestId,
        });
      }
      const nextSeq = steps.length;

      if (event.type === "tool.result") {
        // ROUND-12: the client tool round-trip rides the NEXT TURN's body —
        // the round-10 run-log wait seam (the in-memory RunRegistry) is gone
        // with the server loop, so there is no live log to accept a tool
        // result into. The honest answer is the same 409 the registry miss
        // always produced (never a silent drop).
        throw new GatewayError("RUN_NOT_ACTIVE", "This run is not accepting events right now.", {
          status: 409,
          hint: "Tool results travel in the next turn's body; apply results use POST /v1/runs/:id/apply.",
          requestId,
        });
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
        });
        // AUD-C1: same in-flight guard as cancel — a live turn's uncapped
        // settle owns its own hold release.
        if (!hasInFlightTurns(runId)) {
          await deps.repos.ledger.refundAll(workspace.id, {
            runId,
            idempotencyKey: `chat:${runId}:refund`,
          });
        }
        return ok(c, { runId, recorded: true, status: "failed" });
      }

      // Apply succeeded: register the new version (repo owns the 409 check).
      // AUD-F3 (2026-10-30 deep audit): the §8.7 sink bypassed BOTH the
      // single-writer lease (the real versions/apply routes gate on it) and
      // the storage-existence check — any editor could advance the project
      // head onto a PHANTOM snapshot (a sha256 whose bytes were never
      // uploaded) while another member held the lease. Both gates now match
      // the mounted apply surface.
      if (event.sha256 === undefined) {
        throw new GatewayError("VALIDATION_FAILED", "A successful apply requires the new sha256.", {
          status: 400,
          requestId,
        });
      }
      await requireLeaseForMutation(deps, c, run.projectId);
      const sha = event.sha256;
      const objectKey = snapshotKey(workspace.id, run.projectId, sha);
      const head = await deps.storage.head(objectKey);
      if (head === null) {
        throw new GatewayError(
          "SNAPSHOT_NOT_FOUND",
          "That snapshot was never uploaded — a version must point at real bytes.",
          {
            status: 400,
            hint: "Upload the snapshot bytes before reporting the apply result.",
            requestId,
          },
        );
      }
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

        // §8.8 + D-12 (w1-a27 S248, the two HIGH billing bugs, W3-b02):
        // bill the run's ACTUAL usage — the run row's committedCredits column
        // IS the accumulated Σ committedCreditsFor per-turn usage the turn
        // world heartbeats in (routes/turn.ts) — never the old half-the-
        // reserve guess, and convert whole credits → integer µc at the ledger
        // boundary exactly like routes/turn.ts:555 / routes/apply.ts:210
        // (the pre-fix code passed whole credits straight to ledger.settle,
        // a 10⁻⁶ undercharge). The §8.8 min-1 floor mirrors
        // committedCreditsFor's contract; planSettlement caps the commit at
        // the run's outstanding hold and releases the FULL hold (D-20), so
        // per-turn settles that already committed never double-charge.
        const committedUsage = Math.max(1, run.committedCredits);
        const settled = await deps.repos.ledger.settle(workspace.id, {
          runId,
          actualCost: creditsToLedgerMicrocredits(committedUsage),
          idempotencyKey: `chat:${runId}:settle`,
        });
        const balance = await deps.repos.ledger.balance(workspace.id);
        // D-12 row ruling: the committedCredits column is WHOLE credits. The
        // settle's commit entry is µc — convert back for the row, and keep
        // the row monotonic (never clobber the accumulated per-turn usage
        // with a smaller settle-time commit when the holds already settled).
        const settleCommit =
          settled.commit !== null ? microcreditsToWholeCredits(-settled.commit.amount) : 0;
        const committedRow = Math.max(run.committedCredits, settleCommit);

        await deps.repos.runs.update(workspace.id, runId, {
          status: "completed",
          committedCredits: committedRow,
          resultVersionId: version.id,
        });
        await deps.repos.runs.addStep(workspace.id, {
          runId,
          seq: nextSeq,
          tool: "apply",
          status: "success",
          resultJson: { versionId: version.id, sha256: sha },
        });

        await audit(deps, c, workspace.id, "run.applied", run.projectId, {
          runId,
          versionId: version.id,
          creditsCommitted: committedRow,
          balanceMicrocredits: balance,
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
        if (!hasInFlightTurns(runId)) {
          await deps.repos.ledger.refundAll(workspace.id, {
            runId,
            idempotencyKey: `chat:${runId}:refund`,
          });
        }
        throw error;
      }
    },
  );

  return app;
}
