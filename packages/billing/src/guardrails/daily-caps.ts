// @studio/billing — daily provider-spend caps + the WORKSPACE kill switch (W9-N).
//
// Spec anchors:
//   §18.4  free-tier/demo budget guardrails — "hard spend caps at every
//          provider"; a hard workspace daily cap (§18.2 rules); §18.4 also
//          lets an admin disable a workspace outright
//   §14.2  rule 7 — daily workspace cap (configurable, default 2× monthly
//          plan credits) to stop runaway loops; alert at 80%. plans.ts
//          enforces that cap in CREDITS; this guard enforces the same window
//          in ACTUAL PROVIDER SPEND (USD cents) so a model-rate change or a
//          runaway loop is stopped on the cost side too.
//   §22    "AI cost per run/workspace/day" metric + "cost per day > budget"
//          alert — the caps table below IS that budget.
//   §12    usage_daily rollup (workspace_id, day, cost_usd) — the seam's
//          backing store; day rows are UTC-keyed, so caps reset at 00:00 UTC.
//   §26.3  open question "Budget caps set?" — this table is the §18.4
//          default answer; per-call `capUsdCents` is the override lever
//          (§14.2 r7 "configurable") so ops can tighten a single workspace
//          without a deploy.
//
// Failure mode: ALL seams fail OPEN (a seam outage proceeds, the error is
// logged by the caller). Precedent: gateway rate-limit middleware — this is
// abuse protection, and the authoritative money gate is the §14.2
// reserve/commit ledger transaction, which is Postgres-backed and unaffected.
// A disabled-workspace verdict is the only admin-verdict seam and still fails
// open on outage, for the same "cache blip ≠ site outage" reason.
//
// Pure policy over injected seams (no storage, no Date.now): the seams come
// from the §12 usage_daily rollup and the workspaces table's `kill_switched`
// admin flag.

import {
  CREDIT_PRICE_USD_CENTS,
  DAILY_CAP_ALERT_FRACTION,
  DAILY_SPEND_CAP_MULTIPLIER,
  type PlanId,
  PLAN_ID_SCHEMA,
  PLANS,
  TRIAL_CREDITS,
} from "@studio/config";

import {
  formatUsdCents,
  guardrailErr,
  guardrailOk,
  isValidOrgId,
  sanitizeCounter,
  type GuardrailResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// §18.4 derivation — the per-plan daily spend caps table
// ---------------------------------------------------------------------------

/**
 * Expected COGS share of a credit's list price (§14.4: gross margins run
 * 63–72% on the §5.3 routes → the provider-bill share of list is ~30%).
 * Policy constant: the §18.4 caps guard PROVIDER SPEND, not list value.
 */
export const EXPECTED_COGS_SHARE = 0.3;

/**
 * The §18.4 derivation, USD cents (the "starter $6/day equivalent" table):
 *
 *   plan monthlyCredits (§14.1)     100     250     600   granted credits / month
 *   × §14.2 r7 daily multiplier      2       2       2   daily runaway cap, credits
 *   × §14.1 credit list price    $0.10   $0.10   $0.10   list value of the daily cap
 *   × §14.4 COGS share              30%     30%     30%   provider-bill share of list
 *   ─ daily spend cap (rounded)  $6.00  $15.00  $36.00   starter = $6/day equivalent
 *
 * `dailyCapUsdCents = round(monthlyCredits × 2 × $0.10 × 0.30)` — the §14.2
 * rule-7 daily credit runaway cap, valued at the §14.1 list price, expressed
 * as expected provider spend (§14.4 margins) and rounded to whole cents
 * (§12.2: money is never a float). The trial's one-time 30-credit grant (§14.1)
 * gets the same derivation → $1.80/day.
 */
export function deriveDailyCapUsdCents(monthlyCredits: number): number {
  if (!Number.isSafeInteger(monthlyCredits) || monthlyCredits < 0) {
    throw new Error("[billing/guardrails] monthlyCredits must be a non-negative integer");
  }
  return Math.round(
    monthlyCredits * DAILY_SPEND_CAP_MULTIPLIER * CREDIT_PRICE_USD_CENTS * EXPECTED_COGS_SHARE,
  );
}

/** Per-plan daily provider-spend caps, USD cents (§18.4; see the derivation above). */
export const PLAN_DAILY_SPEND_CAP_USD_CENTS: Readonly<Record<PlanId, number>> = {
  starter: 600, // $6.00/day — the §18.4 starter-equivalent note
  pro: 1500, // $15.00/day
  business: 3600, // $36.00/day
} as const;

/** Trial workspaces (§14.1: one-time 30 credits) — same derivation, $1.80/day. */
export const TRIAL_DAILY_SPEND_CAP_USD_CENTS: number = deriveDailyCapUsdCents(TRIAL_CREDITS);

/**
 * Catalog-code aliasing (limits-service precedent): the db plans table names
 * the top plan 'max' while @studio/config names it 'business'; both resolve
 * to the same ladder. Unknown codes fail CLOSED.
 */
const PLAN_CODE_ALIASES: Readonly<Record<string, PlanId>> = {
  max: "business",
};

/**
 * The daily spend cap in USD cents for a subscription plan code, or "trial"
 * for a workspace without a subscription (§14.1). Unknown codes fail closed —
 * the money surface (§14.2) follows this gate.
 */
export function dailySpendCapUsdCents(planCode: string): GuardrailResult<number> {
  if (planCode === "trial") {
    return guardrailOk(TRIAL_DAILY_SPEND_CAP_USD_CENTS);
  }
  const parsed = PLAN_ID_SCHEMA.safeParse(planCode);
  if (parsed.success) {
    return guardrailOk(PLAN_DAILY_SPEND_CAP_USD_CENTS[parsed.data]);
  }
  const alias = PLAN_CODE_ALIASES[planCode];
  if (alias !== undefined) {
    return guardrailOk(PLAN_DAILY_SPEND_CAP_USD_CENTS[alias]);
  }
  return guardrailErr(
    "validation_failed",
    "Unknown plan code.",
    { hint: `Expected a @studio/config plan id, an alias, or "trial".` },
  );
}

// ---------------------------------------------------------------------------
// Reset windows (UTC day boundaries — §12 usage_daily is day-keyed)
// ---------------------------------------------------------------------------

/** The UTC rollup day (`YYYY-MM-DD`) a moment falls in (§12 usage_daily.day). */
export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * When the current daily window ends: the NEXT 00:00 UTC strictly after
 * `nowMs`. Month/year rollovers are handled by Date.UTC; a moment exactly at
 * midnight is the first instant of a FRESH window (spend already reset), so
 * its reset hint is the following midnight.
 */
export function nextUtcMidnightIso(nowMs: number): string {
  const now = new Date(nowMs);
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Everything the guard needs from the outside world (injected, testable). */
export interface DailySpendSeams {
  /**
   * USD cents the workspace has committed to providers since 00:00 UTC
   * (§12 usage_daily.cost_usd rollup for today's day-key; integer cents —
   * §12.2 money is never a float).
   */
  spendToday(orgId: string): Promise<number>;
  /** Wall clock, epoch ms (deterministic tests; budgets.ts Clock precedent). */
  now(): number;
  /**
   * The WORKSPACE kill switch: the `kill_switched` flag (§18.4 — an admin can
   * disable a workspace). True = the workspace is disabled.
   */
  isDisabled(orgId: string): Promise<boolean>;
}

/** Facts on an allowed check — callers surface these in headers/telemetry. */
export interface DailyCapFacts {
  readonly spentUsdCents: number;
  readonly capUsdCents: number;
  readonly remainingUsdCents: number;
  /** When the window resets (ISO-8601 UTC) — countdowns, Retry-After math. */
  readonly resetAtIso: string;
}

// ---------------------------------------------------------------------------
// DailySpendGuard
// ---------------------------------------------------------------------------

function invalidOrgId<T>(): GuardrailResult<T> {
  return guardrailErr("validation_failed", "Invalid workspace id.", {
    hint: "The request is missing a valid workspace identifier.",
    retryable: false,
  });
}

/**
 * §18.4/§14.2 r7 daily-spend gate + the §18.4 workspace kill switch, over
 * injected seams. One instance per request scope (stateless besides seams).
 */
export class DailySpendGuard {
  constructor(private readonly seams: DailySpendSeams) {}

  /**
   * The WORKSPACE kill switch alone (§18.4): admin-disabled workspaces are
   * rejected with a typed `disabled_workspace` error and a support hint, before
   * any spend is consulted. Exposed standalone so non-run surfaces (exports,
   * uploads) can gate on it too.
   */
  async checkWorkspaceEnabled(orgId: string): Promise<GuardrailResult<void>> {
    if (!isValidOrgId(orgId)) {
      return invalidOrgId();
    }
    let disabled = false;
    try {
      disabled = await this.seams.isDisabled(orgId);
    } catch {
      // Fail open: an admin-flag outage must not become a site outage.
      disabled = false;
    }
    if (disabled) {
      return guardrailErr("disabled_workspace", "This workspace is currently disabled.", {
        hint: "The workspace has been disabled by an administrator. Contact support if you think this is a mistake.",
        retryable: false,
      });
    }
    return guardrailOk(undefined);
  }

  /**
   * Daily provider-spend cap (§18.4 hard cap; the USD-cents twin of plans.ts
   * dailySpendPolicy, §14.2 r7). Runs are rejected with typed
   * `cost_cap_reached` once the workspace has committed `capUsdCents` today;
   * the failure carries the reset-at hint (next 00:00 UTC). The kill switch
   * is checked FIRST — a disabled workspace never touches the spend counter.
   *
   * `capUsdCents` comes from the caps table above by default and stays
   * per-call overridable (§14.2 r7 "configurable").
   */
  async enforceDailyCap(
    orgId: string,
    options: { readonly capUsdCents: number },
  ): Promise<GuardrailResult<DailyCapFacts>> {
    if (!isValidOrgId(orgId)) {
      return invalidOrgId();
    }
    const capUsdCents = options.capUsdCents;
    if (!Number.isSafeInteger(capUsdCents) || capUsdCents < 0) {
      return guardrailErr("validation_failed", "Invalid daily spend cap.", {
        hint: "capUsdCents must be a non-negative integer of USD cents.",
        retryable: false,
      });
    }

    const killSwitch = await this.checkWorkspaceEnabled(orgId);
    if (!killSwitch.ok) {
      return killSwitch;
    }

    let spent = 0;
    try {
      spent = sanitizeCounter(await this.seams.spendToday(orgId));
    } catch {
      // Fail open: the rollup is observability-grade; the §14.2 reservation
      // transaction remains the authoritative money gate.
      spent = 0;
    }

    const nowMs = this.seams.now();
    const resetAtIso = nextUtcMidnightIso(nowMs);

    if (spent >= capUsdCents) {
      return guardrailErr(
        "cost_cap_reached",
        "This workspace reached its daily spend cap.",
        {
          hint: `Daily spend is ${formatUsdCents(spent)} of the ${formatUsdCents(
            capUsdCents,
          )} cap. New runs resume at ${resetAtIso}.`,
          retryable: true,
          resetAtIso,
        },
      );
    }

    return guardrailOk({
      spentUsdCents: spent,
      capUsdCents,
      remainingUsdCents: capUsdCents - spent,
      resetAtIso,
    });
  }
}

// ---------------------------------------------------------------------------
// §22 / §14.2 r7 alert hook (80% of the daily cap)
// ---------------------------------------------------------------------------

/**
 * Whether the §22 "cost per day > budget" alert should fire: usage has
 * reached the 80%-of-cap warning threshold (§14.2 r7 "alert at 80%",
 * DAILY_CAP_ALERT_FRACTION). Integer math: spent/cap ≥ 0.8 ⇔ spent×5 ≥ cap×4.
 * A $0 cap is cap-blocked by definition, so alerting on it is fine.
 */
export function isDailySpendAlertDue(facts: DailyCapFacts): boolean {
  return facts.spentUsdCents * 5 >= facts.capUsdCents * 4;
}

/** The 80%-of-cap alert threshold in USD cents, for dashboards (§14.2 r7). */
export function dailySpendAlertThresholdUsdCents(capUsdCents: number): number {
  if (!Number.isSafeInteger(capUsdCents) || capUsdCents < 0) {
    throw new Error("[billing/guardrails] capUsdCents must be a non-negative integer");
  }
  return Math.floor(capUsdCents * DAILY_CAP_ALERT_FRACTION);
}

export { DAILY_CAP_ALERT_FRACTION };
