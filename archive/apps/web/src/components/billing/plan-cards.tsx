"use client";

// components/billing/plan-cards — the §14.1 pricing grid on /billing (W8-K):
// three subscriptions ($30 Starter / $60 Pro / $120 Max = 100/250/600
// monthly credits, seats 1/3/10 with extra seats +$8, concurrent runs 1/3/6,
// canvas 32/64/128 MP) plus the credit-pack card ($10 per 100 credits,
// never expiring while subscribed). §14.1: "All plans include the full
// editor; plan differences are credits, seats …".
//
// Source of truth is GET /v1/billing/plans (@studio/config's §14.1 table
// served by the gateway). While that route is unreachable (typed 501 until
// the wiring wave mounts it) the grid renders the exact §14.1 fallback in
// use-billing.ts, clearly labeled. Upgrades/downgrades/packs all go through
// POST /v1/billing/checkout { planCode } (§14.3, Stripe-hosted redirect);
// card/plan changes on an existing subscription belong to the portal.
// RBAC: CTAs render for admins/owners only (§15.2) — the gateway enforces.

import { useState } from "react";
import { CheckoutButton } from "./checkout-button";
import {
  CREDIT_PACK_FALLBACK_14,
  PLAN_CATALOG_FALLBACK_14,
  formatCredits,
  formatUsdCents,
  planDisplayName,
  useBillingPlans,
  useCanManageBilling,
  useCurrentPlan,
  type BillingActionError,
  type CreditPack,
  type PlanCard,
} from "./use-billing";

const CARD_CLASS = "rounded-lg border border-border bg-surface";
const ERROR_CLASS = "rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground";
const RETRY_CLASS = "font-medium text-foreground underline underline-offset-2";
const CURRENT_CHIP_CLASS =
  "inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium text-muted-foreground";
const SKELETON_IDS = ["starter", "pro", "max"] as const;

export function PlanCardsSection() {
  const plansQuery = useBillingPlans();
  const currentPlan = useCurrentPlan();
  const canManage = useCanManageBilling();
  const [actionError, setActionError] = useState<BillingActionError | null>(null);

  const wirePlans = plansQuery.data?.plans;
  const plans: readonly PlanCard[] =
    wirePlans !== undefined && wirePlans.length > 0 ? wirePlans : PLAN_CATALOG_FALLBACK_14;
  const pack: CreditPack = plansQuery.data?.credit_pack ?? CREDIT_PACK_FALLBACK_14;
  const currentCode = currentPlan.plan?.code ?? null;

  return (
    <section aria-labelledby="plans-heading">
      <h2 id="plans-heading" className="text-base font-semibold">
        Plans
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Monthly credits refill every billing cycle; unused pack credits never expire while
        subscribed (pack expiry is stated in the terms of service).
      </p>

      <div className="mt-3">
        {plansQuery.isPending ? (
          <>
            <span role="status" className="sr-only">
              Loading plans…
            </span>
            <ul aria-hidden="true" className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {SKELETON_IDS.map((id) => (
                <li key={id} className={`${CARD_CLASS} p-5`}>
                  <div className="h-5 w-20 animate-pulse rounded bg-surface-muted" />
                  <div className="mt-3 h-8 w-24 animate-pulse rounded bg-surface-muted" />
                  <div className="mt-4 h-3 w-full max-w-56 animate-pulse rounded bg-surface-muted" />
                  <div className="mt-2 h-3 w-32 animate-pulse rounded bg-surface-muted" />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            {plansQuery.isError ? (
              <p role="status" className={ERROR_CLASS}>
                Showing list pricing — the plan service is unreachable.{" "}
                {plansQuery.error instanceof Error ? plansQuery.error.message : ""}{" "}
                <button
                  type="button"
                  onClick={() => {
                    void plansQuery.refetch();
                  }}
                  className={RETRY_CLASS}
                >
                  Retry
                </button>
              </p>
            ) : null}
            <ul className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
              {plans.map((plan) => (
                <li key={plan.code}>
                  <PlanCardView
                    plan={plan}
                    isCurrent={plan.code === currentCode}
                    canManage={canManage}
                    onError={setActionError}
                  />
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <PackCardView pack={pack} canManage={canManage} onError={setActionError} />
            </div>
          </>
        )}
      </div>

      {actionError === null ? null : (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {actionError.message}
          {actionError.hint === null ? null : (
            <span className="text-muted-foreground"> — {actionError.hint}</span>
          )}
        </p>
      )}
    </section>
  );
}

function PlanCardView({
  plan,
  isCurrent,
  canManage,
  onError,
}: {
  readonly plan: PlanCard;
  readonly isCurrent: boolean;
  readonly canManage: boolean;
  readonly onError: (error: BillingActionError) => void;
}) {
  return (
    <article className={`${CARD_CLASS} flex h-full flex-col p-5`}>
      <h3 className="text-base font-semibold">{planDisplayName(plan.code)}</h3>
      <p className="mt-2 text-2xl font-semibold">
        {formatUsdCents(plan.monthly_price_usd_cents)}
        <span className="text-sm font-normal text-muted-foreground"> / month</span>
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {formatCredits(plan.monthly_credits)} credits every month
      </p>
      <ul className="mt-4 flex flex-col gap-1.5 text-sm text-muted-foreground">
        <li>
          {plan.seats} {plan.seats === 1 ? "seat" : "seats"} · extra seats{" "}
          {formatUsdCents(plan.extra_seat_price_usd_cents)} / month
        </li>
        <li>
          {plan.concurrent_runs} concurrent agent
          run{plan.concurrent_runs === 1 ? "" : "s"}
        </li>
        <li>Canvas up to {plan.max_canvas_megapixels} megapixels</li>
        <li>Full editor included</li>
      </ul>
      <div className="mt-5">
        {isCurrent ? (
          <span
            className={CURRENT_CHIP_CLASS}
            aria-label={`Current plan: ${planDisplayName(plan.code)}`}
          >
            Current plan
          </span>
        ) : canManage ? (
          <CheckoutButton
            planCode={plan.code}
            label={`Switch to ${planDisplayName(plan.code)}`}
            onError={onError}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            Ask a workspace admin to change the plan.
          </p>
        )}
      </div>
    </article>
  );
}

/** §14.1 pack: $10 per 100 credits, one-time, never expiring while subscribed. */
function PackCardView({
  pack,
  canManage,
  onError,
}: {
  readonly pack: CreditPack;
  readonly canManage: boolean;
  readonly onError: (error: BillingActionError) => void;
}) {
  return (
    <article className="rounded-lg border border-dashed border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Credit pack</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatUsdCents(pack.price_usd_cents)} for {formatCredits(pack.credits)} extra credits
            — never expiring while subscribed (expiry stated in the terms of service). Charged
            once, available as soon as Stripe confirms the payment.
          </p>
        </div>
        {canManage ? (
          <CheckoutButton planCode="pack" variant="secondary" onError={onError} />
        ) : null}
      </div>
    </article>
  );
}
