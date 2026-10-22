// @studio/gateway — POST /v1/runs/:id/apply + /v1/runs/:id/undo (BUILD_PLAN
// §M5.4/§M5.5; PRODUCT_ARCHITECTURE §8.7 apply/undo/version, §8.8 credits,
// §8.9 failure semantics; M5-SEAMS pinned wire).
//
// Apply (§8.7): the client executed the run's compiled plan as ONE atomic
// `engine.batch`, autosaved (D-6) and uploaded the created version through
// POST /v1/projects/:id/versions with agentRunId = the run id. This route:
//   1. auth + workspace + Idempotency-Key (middleware) + Zod body (law #2/#4)
//   2. loads the run TENANT-FILTERED — cross-tenant reads as 404 (law #3)
//   3. rejects runs outside the plannable vocabulary: the DB statuses win
//      (D-11) — apply needs `awaiting_approval` or terminal `completed`
//   4. verifies the uploaded version belongs to the run's project AND was
//      created by this run (agentRunId), then the §9.3/M5.5 base-version
//      lineage: the applied version must descend from the run's recorded
//      base_version_id and still be the project head — mismatch ⇒ 409
//      VERSION_CONFLICT (never overwrite)
//   5. guards the wallet (§8.8: never on a zero balance) BEFORE any state
//      change ⇒ 402 INSUFFICIENT_CREDITS with no ledger row
//   6. commits the plan credits through ledger.settle — the D-20-correct
//      sequence: planSettlement caps the commit at the outstanding hold and
//      releases the FULL hold (reserve −N, commit −M, refund +N ⇒ the run
//      nets −M). Keyed `apply:{runId}:settle`, so replays never double-charge.
//   7. records the apply on the run row (M5-D recordApplied) and audits it.
//
// Undo (§8.7/§M5.5): requires an applied run; records the undo (version rows
// are NEVER deleted, §9.3) and performs NO ledger mutation — §8.8 charges
// the run at apply time and §8.7's undo is a local `edit.undo` of the ONE
// batch, so undoing a committed apply is free. Replaying undo (same body,
// fresh transport key) is idempotent: { undone: true } with no new writes.

import { Hono } from "hono";

import { APPLY_REQUEST_SCHEMA, EDIT_PLAN_SCHEMA, UNDO_REQUEST_SCHEMA } from "@studio/contracts";

import { StudioError } from "@studio/config";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, pathParam } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { audit } from "./projects.js";

/** §7.2 idempotency: the ledger settle key for an apply (derive-safe prefix). */
const applySettleKey = (runId: string): string => `apply:${runId}:settle`;

/**
 * D-11: the DB status vocabulary wins. A plan is appliable only once the run
 * has finished planning — paused for approval or terminal-completed. Every
 * other status (queued/running/failed/cancelled) ⇒ 409 before any state or
 * ledger change.
 */
const APPLYABLE_RUN_STATUSES = ["awaiting_approval", "completed"] as const;

export function applyRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/runs/*", requireAuth());

  app.post(
    "/v1/runs/:id/apply",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const requestId = c.get("requestId");
      const workspace = c.get("workspace");
      const runId = pathParam(c, "id");

      const parsed = APPLY_REQUEST_SCHEMA.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "The apply needs batchSha256 (64 hex), versionId and an idempotency key.",
          requestId,
        });
      }
      const body = parsed.data;

      // Law #3: tenant-filtered load — cross-tenant and unknown ids read as
      // 404 RUN_NOT_FOUND (the repo + error boundary own the mapping).
      const { run } = await deps.repos.runs.get(workspace.id, runId);
      const planState = await deps.repos.runs.getPlanState(workspace.id, runId);

      // Same logical apply, replayed with a fresh transport key: return the
      // recorded outcome instead of a confusing 409. The settle below is
      // idempotent (same key ⇒ replayed entry, no new rows).
      if (
        planState.status === "applied" &&
        planState.appliedBatchSha256 === body.batchSha256 &&
        planState.appliedVersionId === body.versionId
      ) {
        // The stored settle replays the original commit entry regardless of
        // this cost (same key ⇒ replayed); 0 keeps the call valid even if the
        // plan row was replaced after the apply.
        const replayed = await deps.repos.ledger.settle(workspace.id, {
          runId,
          actualCost: planCreditsOf(run.planJson) ?? 0,
          idempotencyKey: applySettleKey(runId),
        });
        return ok(c, {
          applied: true,
          versionId: body.versionId,
          creditsCommitted: replayed.commit !== null ? -replayed.commit.amount : 0,
        });
      }

      if (planState.status !== "proposed") {
        // Already applied (different batch/version) or already undone.
        throw new GatewayError("RUN_ALREADY_APPLIED", "This run's plan was already applied.", {
          status: 409,
          hint: "Undo it first, or start a new run to apply again.",
          requestId,
        });
      }

      if (!applyable(run.status)) {
        const streaming = run.status === "queued" || run.status === "running";
        throw new GatewayError(
          "RUN_NOT_ACTIVE",
          streaming
            ? "This run is still planning — wait for its plan before applying."
            : "This run can no longer be applied.",
          {
            status: 409,
            hint: streaming
              ? "Apply arrives with the plan card once the run finishes."
              : "Start a new run to make further changes.",
            requestId,
          },
        );
      }

      const estimatedCredits = planCreditsOf(run.planJson);
      if (estimatedCredits === null) {
        throw new GatewayError("RUN_NOT_ACTIVE", "This run has no plan to apply.", {
          status: 409,
          hint: "Ask the agent for a plan first.",
          requestId,
        });
      }

      // §9.3 scope: the version must belong to the run's project (404 when
      // it does not) AND have been created by this very run.
      const version = await deps.repos.versions.get(workspace.id, run.projectId, body.versionId);
      if (version.agentRunId !== runId) {
        // Never confirm more than "not found" (law #3).
        throw new GatewayError("VERSION_NOT_FOUND", "Version not found.", {
          status: 404,
          hint: "Upload the applied version with this run's agentRunId, then retry.",
          requestId,
        });
      }

      const project = await deps.repos.projects.get(workspace.id, run.projectId);
      // BP M5.5 / §8.7: re-apply only while the plan's base still matches —
      // the applied version must descend from the run's recorded base AND be
      // the current head. Anything else means the project moved on: 409,
      // never overwrite.
      if (version.parentVersionId !== planState.baseVersionId) {
        throw new GatewayError(
          "VERSION_CONFLICT",
          "The project changed while this plan was open.",
          {
            status: 409,
            hint: "The plan was built on an older version. Re-run it on the current project.",
            requestId,
          },
        );
      }
      if (project.currentVersionId !== body.versionId) {
        throw new GatewayError(
          "VERSION_CONFLICT",
          "The project changed while this plan was open.",
          {
            status: 409,
            hint: "A newer version is the project head now. Refresh and re-run the plan.",
            requestId,
          },
        );
      }

      // §8.8: never move money on a zero balance — and no state change at
      // all before this guard passes.
      const balance = await deps.repos.ledger.balance(workspace.id);
      if (balance < 1) {
        throw new StudioError("INSUFFICIENT_CREDITS", { requestId });
      }

      // D-20 / §8.8: the plan estimate was reserved at run start; apply
      // COMMITS the plan portion. settle() is the single source: it caps the
      // commit at the outstanding hold and releases the FULL hold, so the run
      // nets exactly −commit. If the run's hold was already fully settled
      // (stream-finalize path), the commit is 0 — never a double charge.
      const settled = await deps.repos.ledger.settle(workspace.id, {
        runId,
        actualCost: estimatedCredits,
        idempotencyKey: applySettleKey(runId),
      });
      const creditsCommitted = settled.commit !== null ? -settled.commit.amount : 0;

      // M5-D: pin batch digest + version + base on the run row. Money first,
      // row second — a crash between them recovers on retry (settle replays,
      // recordApplied retries).
      await deps.repos.runs.recordApplied(workspace.id, {
        runId,
        batchSha256: body.batchSha256,
        versionId: body.versionId,
        baseVersionId: planState.baseVersionId,
      });

      await audit(deps, c, workspace.id, "run.applied", run.projectId, {
        runId,
        versionId: body.versionId,
        creditsCommitted,
        resolvedLayers: body.resolvedLayers?.length ?? 0,
      });

      return ok(c, { applied: true, versionId: body.versionId, creditsCommitted });
    },
  );

  app.post(
    "/v1/runs/:id/undo",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const requestId = c.get("requestId");
      const workspace = c.get("workspace");
      const runId = pathParam(c, "id");

      const parsed = UNDO_REQUEST_SCHEMA.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Send an idempotency key (8-128 chars) with the undo.",
          requestId,
        });
      }

      const { run } = await deps.repos.runs.get(workspace.id, runId);
      const planState = await deps.repos.runs.getPlanState(workspace.id, runId);

      if (planState.status === "proposed") {
        throw new GatewayError("RUN_NOT_APPLIED", "This run has not been applied yet.", {
          status: 409,
          hint: "Apply the plan first — undo reverts one applied batch.",
          requestId,
        });
      }
      if (planState.status === "undone") {
        // Idempotent by state: replaying an undo (fresh transport key) is a
        // no-op answer, not an error — nothing is written twice.
        return ok(c, { undone: true });
      }

      // §8.7/§M5.5: ONE undo step for the whole run; the version row stays
      // (§9.3). No ledger mutation — the credits were committed at apply time
      // (§8.8); undo never refunds or re-charges.
      await deps.repos.runs.recordUndone(workspace.id, {
        runId,
        userId: c.get("auth").user.id,
      });

      await audit(deps, c, workspace.id, "run.undone", run.projectId, {
        runId,
        versionId: planState.appliedVersionId,
      });

      return ok(c, { undone: true });
    },
  );

  return app;
}

/** D-11 (DB status vocabulary wins) + §M5.4: plannable ⇒ appliable. */
function applyable(status: string): boolean {
  return (APPLYABLE_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * The plan portion to commit (§8.6 `estimatedCredits` on the run's plan),
 * as a D-12-safe integer ≥ 1 — the ledger stores integer amounts and the
 * §8.8 reserve rule is ceil(estimate × 1.2), min 1. `null` = no valid plan
 * on the row (nothing to apply).
 */
function planCreditsOf(planJson: unknown): number | null {
  const parsed = EDIT_PLAN_SCHEMA.safeParse(planJson);
  if (!parsed.success) return null;
  return Math.max(1, Math.ceil(parsed.data.estimatedCredits));
}
