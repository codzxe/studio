// @studio/billing — PlanLimitsService (W9-B): the §14.1 plan gates the gateway
// consults before a run is enqueued (§3.3 step-2 ordering) and before seats,
// engine sessions or uploads are granted.
//
// Contract alignment (W4-D, apps/gateway/src/middleware/caps.ts): caps.ts owns
// the pre-parse 413 upload guard and the fast 429 run-cap middleware; this
// service is the plan-aware verdict layer the runs route calls ONCE per
// request (checkRunIntake). NOT owned here: credit reservation (§14.2 rule 1 →
// 402 insufficient_credits, ../ledger.js), the daily workspace cap (§14.2
// rule 7 → quota_exceeded, ../plans.js), and per-plan tool allowlists
// (§15.3, tools layer).
//
// Seams are injected (this module never touches storage): a null subscription
// means a trial workspace (§14.1 — trial rules live in ./trial-rules.js).

import { z } from "zod";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MEGAPIXELS,
  PLAN_ID_SCHEMA,
  RUN_TIER_IDS,
  RUN_TIER_ID_SCHEMA,
  err,
  ok,
  planLimits,
  type PlanId,
  type PlanLimits,
  type Result,
  type RunTierId,
} from "@studio/config";
import { TRIAL_PLAN_LIMITS, checkTrialRunTier } from "./trial-rules.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Everything the service needs from the outside world (injected). */
export interface LimitsSeams {
  /**
   * Active subscription for the org, or null when the workspace is on the
   * trial (§14.1). Only the plan code is needed here; Stripe state stays in
   * the billing tables.
   */
  getSubscription(orgId: string): Promise<{ readonly planCode: string } | null>;
  /** Queued + running runs for the org — the same number W4-D's middleware uses. */
  countActiveRuns(orgId: string): Promise<number>;
  /** Live engine sessions for the org (§3.2 session pool). */
  countSessions(orgId: string): Promise<number>;
  /** Occupied seats (members + accepted invites) for the org. */
  countSeats(orgId: string): Promise<number>;
}

/** Composite intake payload for POST /v1/documents/:id/runs (§13.1). */
export interface RunIntake {
  /** Target canvas size in megapixels (width × height / 1e6) — may be fractional. */
  readonly canvasMP: number;
  /** Tier the run will be created at (§5.2). */
  readonly tier: RunTierId;
}

/** Per-file upload ceilings (§20.2). */
export interface UploadCeiling {
  readonly maxBytes: number;
  readonly maxMegaPixels: number;
}

/** Facts echoed on a successful composite intake (for headers/telemetry). */
export interface RunIntakeFacts {
  readonly plan: PlanId | "trial";
  readonly canvasCapMegapixels: number;
  readonly concurrentRunsCap: number;
}

/** Invite options: purchased extra seats raise the seat cap for their org. */
export interface InviteOptions {
  readonly extraSeatsPurchased?: number;
}

// ---------------------------------------------------------------------------
// Input schemas (Zod at every boundary, AGENTS.md)
// ---------------------------------------------------------------------------

/** Shape-only org id check; uuid-ness is validated at the HTTP boundary. */
const ORG_ID_SCHEMA = z.string().min(1);

/** Composite intake (§13.1 run creation) — validated before any seam call. */
export const RUN_INTAKE_SCHEMA = z
  .object({
    canvasMP: z.number().finite().positive(),
    tier: RUN_TIER_ID_SCHEMA,
  })
  .strict();

// ---------------------------------------------------------------------------
// Plan-code resolution
// ---------------------------------------------------------------------------

/**
 * Catalog-code aliasing (fleet divergence, see worklog W9-B): the plans table
 * comments (packages/db/src/schema/billing.ts) name the top plan 'max' while
 * @studio/config names it 'business'. Both resolve to the same ladder so the
 * catalog seed can use either vocabulary; unknown codes fail CLOSED below.
 */
const PLAN_CODE_ALIASES: Readonly<Record<string, PlanId>> = {
  max: "business",
};

function resolvePlanCode(planCode: string): PlanId | null {
  const parsed = PLAN_ID_SCHEMA.safeParse(planCode);
  if (parsed.success) {
    return parsed.data;
  }
  const alias = PLAN_CODE_ALIASES[planCode];
  return alias === undefined ? null : alias;
}

/** Resolved workspace state: a paid plan, or the trial. */
type PlanState = { readonly plan: PlanId | "trial" };

// ---------------------------------------------------------------------------
// Typed failure builders (§13.3 envelope via @studio/config err())
// ---------------------------------------------------------------------------

function invalidOrgId(): Result<never> {
  return err("validation_failed", "Invalid workspace id.", {
    hint: "The request is missing a valid workspace identifier.",
    retryable: false,
  });
}

function isAre(count: number): string {
  return count === 1 ? "is" : "are";
}

function runsAtCapacity(active: number, cap: number): Result<never> {
  const unit = cap === 1 ? "run" : "runs";
  return err("plan_limit", "Workspace is at its concurrent run limit.", {
    hint: `Your plan allows ${cap} concurrent ${unit}; ${active} ${isAre(active)} already active. Wait for a run to finish or upgrade for more.`,
    retryable: true,
  });
}

function sessionsAtCapacity(active: number, cap: number): Result<never> {
  const unit = cap === 1 ? "session" : "sessions";
  return err("plan_limit", "Workspace is at its concurrent session limit.", {
    hint: `Your plan allows ${cap} concurrent ${unit}; ${active} ${isAre(active)} open. Close a document, let an idle session be evicted, or upgrade for more.`,
    retryable: true,
  });
}

function seatsAtCapacity(active: number, cap: number, trial: boolean): Result<never> {
  const unit = cap === 1 ? "seat" : "seats";
  const hint = trial
    ? "Trials are single-seat. Upgrade to invite teammates."
    : `Your plan includes ${cap} ${unit}; ${active} ${isAre(active)} filled. Extra seats are $8/month each — add seats in billing or upgrade.`;
  return err("plan_limit", "Workspace is at its seat limit.", {
    hint,
    retryable: false,
  });
}

function formatMP(mp: number): string {
  return Number.isInteger(mp) ? String(mp) : mp.toFixed(1);
}

function canvasTooLarge(canvasMP: number, cap: number): Result<never> {
  return err("plan_limit", "Canvas is too large for this plan.", {
    hint: `Your plan allows canvases up to ${cap} MP; this document is ${formatMP(canvasMP)} MP. Reduce the canvas size or upgrade.`,
    retryable: false,
  });
}

/**
 * A broken counter (negative/NaN/fractional) is an internal bug: clamp to 0,
 * fail-soft, mirroring the W4-D middleware. The authoritative guards are the
 * §14.2 reservation transaction for money, and the unique constraints in the
 * seat/session stores for tenancy.
 */
function sanitizeCount(raw: number): number {
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

// ---------------------------------------------------------------------------
// PlanLimitsService
// ---------------------------------------------------------------------------

export class PlanLimitsService {
  constructor(private readonly seams: LimitsSeams) {}

  private async resolveState(orgId: string): Promise<Result<PlanState>> {
    const subscription = await this.seams.getSubscription(orgId);
    if (subscription === null) {
      // §14.1: no subscription → trial workspace. (Explicit annotation keeps
      // the "trial" literal from widening through the generic ok().)
      const trial: PlanState = { plan: "trial" };
      return ok(trial);
    }
    const plan = resolvePlanCode(subscription.planCode);
    if (plan === null) {
      // Fail closed: an unknown catalog code must never silently grant a
      // ladder — the money surface (§14.2 reservation) follows this gate.
      // Mirrors the unknown-code failure of seatPlanLimits in ../plans.js.
      return err("validation_failed", "Your workspace plan could not be verified.", {
        hint: "Please contact support; we could not look up your subscription.",
        retryable: false,
      });
    }
    return ok({ plan });
  }

  private limitsFor(plan: PlanId | "trial"): PlanLimits {
    // Trial workspaces run on the starter ladder (policy, ./trial-rules.js).
    return plan === "trial" ? TRIAL_PLAN_LIMITS : planLimits(plan);
  }

  /**
   * Concurrent-run gate for run creation (§14.1 ladder 1/3/6). Trial
   * workspaces are additionally tier-gated (≤ standard, §5.2); paid plans may
   * buy any tier with credits — §14.1 plan differences do not include tiers.
   */
  async canStartRun(orgId: string, tier: RunTierId): Promise<Result<void>> {
    if (!ORG_ID_SCHEMA.safeParse(orgId).success) {
      return invalidOrgId();
    }
    const tierParsed = RUN_TIER_ID_SCHEMA.safeParse(tier);
    if (!tierParsed.success) {
      return err("validation_failed", "Unknown run tier.", {
        hint: `Expected one of: ${RUN_TIER_IDS.join(", ")}.`,
        retryable: false,
      });
    }
    const state = await this.resolveState(orgId);
    if (!state.ok) {
      return state;
    }
    const { plan } = state.value;
    if (plan === "trial") {
      const tierGate = checkTrialRunTier(tierParsed.data);
      if (!tierGate.ok) {
        return tierGate;
      }
    }
    const limits = this.limitsFor(plan);
    const active = sanitizeCount(await this.seams.countActiveRuns(orgId));
    if (active >= limits.concurrentRuns) {
      return runsAtCapacity(active, limits.concurrentRuns);
    }
    return ok(undefined);
  }

  /**
   * Concurrent engine-session gate (§3.2: at most N sessions per plan).
   * Rejections are retryable: idle sessions are evictable and runs end.
   */
  async canAllocateSession(orgId: string): Promise<Result<void>> {
    if (!ORG_ID_SCHEMA.safeParse(orgId).success) {
      return invalidOrgId();
    }
    const state = await this.resolveState(orgId);
    if (!state.ok) {
      return state;
    }
    const limits = this.limitsFor(state.value.plan);
    const active = sanitizeCount(await this.seams.countSessions(orgId));
    if (active >= limits.concurrentSessions) {
      return sessionsAtCapacity(active, limits.concurrentSessions);
    }
    return ok(undefined);
  }

  /**
   * Seat gate for invites (§14.1: plans include 1/3/10 seats; extra seats are
   * +$8/month, so an org's purchased extras raise its own cap).
   */
  async canInvite(orgId: string, options: InviteOptions = {}): Promise<Result<void>> {
    if (!ORG_ID_SCHEMA.safeParse(orgId).success) {
      return invalidOrgId();
    }
    const extra = options.extraSeatsPurchased ?? 0;
    if (!Number.isSafeInteger(extra) || extra < 0) {
      return err("validation_failed", "Invalid seat purchase count.", {
        hint: "extraSeatsPurchased must be a non-negative integer.",
        retryable: false,
      });
    }
    const state = await this.resolveState(orgId);
    if (!state.ok) {
      return state;
    }
    const { plan } = state.value;
    if (plan === "trial" && extra > 0) {
      return err("validation_failed", "Trials cannot add extra seats.", {
        hint: "Extra seats are a subscription feature. Upgrade first.",
        retryable: false,
      });
    }
    const limits = this.limitsFor(plan);
    const cap = limits.seats + extra;
    const active = sanitizeCount(await this.seams.countSeats(orgId));
    if (active >= cap) {
      return seatsAtCapacity(active, cap, plan === "trial");
    }
    return ok(undefined);
  }

  /**
   * Max canvas in megapixels for the workspace's plan (§14.1: 32/64/128).
   * Note: the top plan's 128 MP exceeds the engine's current 64 MP automation
   * ceiling (@studio/config limits.ts) — the engine budget must be raised
   * before the top plan ships; the plan number is still reported here.
   */
  async canvasCeiling(orgId: string): Promise<Result<number>> {
    if (!ORG_ID_SCHEMA.safeParse(orgId).success) {
      return invalidOrgId();
    }
    const state = await this.resolveState(orgId);
    if (!state.ok) {
      return state;
    }
    return ok(this.limitsFor(state.value.plan).maxCanvasMegapixels);
  }

  /**
   * Per-file upload ceilings (§20.2: 25 MB / 60 MP for every workspace). The
   * per-request file count is a rate limit (§15.2), not a plan ceiling.
   */
  async uploadCeiling(orgId: string): Promise<Result<UploadCeiling>> {
    if (!ORG_ID_SCHEMA.safeParse(orgId).success) {
      return invalidOrgId();
    }
    const state = await this.resolveState(orgId);
    if (!state.ok) {
      return state;
    }
    // §20.2 fixes one default for all plans today; plan-gated sizes can land
    // as data later (plans.maxUploadMb already exists in the db schema).
    return ok({ maxBytes: MAX_UPLOAD_BYTES, maxMegaPixels: MAX_UPLOAD_MEGAPIXELS });
  }

  /**
   * ONE call for the runs route (§13.1 POST /v1/documents/:id/runs; §3.3
   * step-2 ordering): trial tier gate → canvas size gate → concurrent-run
   * gate. On ok the route proceeds to the §14.2 credit reservation (402
   * path) and enqueues; quota_exceeded (daily cap, §14.2 rule 7) is a
   * separate gate in ../plans.js. Static checks run before the counter seam,
   * so obvious rejections never touch storage.
   */
  async checkRunIntake(orgId: string, intake: RunIntake): Promise<Result<RunIntakeFacts>> {
    if (!ORG_ID_SCHEMA.safeParse(orgId).success) {
      return invalidOrgId();
    }
    const parsed = RUN_INTAKE_SCHEMA.safeParse(intake);
    if (!parsed.success) {
      return err("validation_failed", "Invalid run request.", {
        hint: `canvasMP must be a positive number; tier must be one of: ${RUN_TIER_IDS.join(", ")}.`,
        retryable: false,
      });
    }
    const state = await this.resolveState(orgId);
    if (!state.ok) {
      return state;
    }
    const { plan } = state.value;
    const limits = this.limitsFor(plan);
    const { canvasMP, tier } = parsed.data;
    if (plan === "trial") {
      const tierGate = checkTrialRunTier(tier);
      if (!tierGate.ok) {
        return tierGate;
      }
    }
    if (canvasMP > limits.maxCanvasMegapixels) {
      return canvasTooLarge(canvasMP, limits.maxCanvasMegapixels);
    }
    const active = sanitizeCount(await this.seams.countActiveRuns(orgId));
    if (active >= limits.concurrentRuns) {
      return runsAtCapacity(active, limits.concurrentRuns);
    }
    return ok({
      plan,
      canvasCapMegapixels: limits.maxCanvasMegapixels,
      concurrentRunsCap: limits.concurrentRuns,
    });
  }
}
