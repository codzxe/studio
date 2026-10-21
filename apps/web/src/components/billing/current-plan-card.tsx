"use client";

// components/billing/current-plan-card — the "Current plan" card on
// /billing (W8-K, §14): plan name, monthly credits, seats and renewal,
// plus the manage-in-portal CTA (§14.3 — Stripe hosts card/plan changes).
//
// Data: GET /v1/me `plan` (§13.1 contract-only today — renders a typed
// error state with retry until the auth wave lands /v1/me). When the plan
// object is absent, identity falls back to GET /v1/credits/summary's
// `trial` flag: trial → the §14.1 trial facts (one-time 30 credits, no
// card, one per account); otherwise → a no-active-plan card pointing at
// the plan grid below. RBAC: manage/checkout CTAs render for admins and
// owners only (§15.2) — the gateway enforces regardless.

import { CreditCard, Zap } from "lucide-react";
import { useState } from "react";
import { ManageBillingButton } from "./checkout-button";
import {
  formatCredits,
  useCanManageBilling,
  useCreditsSummary,
  useCurrentPlan,
  type BillingActionError,
  type CurrentPlanSummary,
} from "./use-billing";

const CARD_CLASS = "rounded-lg border border-border bg-surface";
const ERROR_CLASS = "rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground";
const RETRY_CLASS = "font-medium text-foreground underline underline-offset-2";
const SECTION_HEADING_CLASS = "text-xs font-medium uppercase tracking-wide text-muted-foreground";
const STATUS_CHIP_CLASS =
  "inline-flex items-center rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium capitalize";

// Fixed locale keeps markup identical across server render and hydration.
const DATE_TIME_FORMAT = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDateTime(date: Date): string {
  return DATE_TIME_FORMAT.format(date);
}

/** Shared inline failure line — envelope message plus hint (§13.3). */
function ActionErrorLine({ error }: { readonly error: BillingActionError }) {
  return (
    <p role="alert" className="mt-2 text-sm text-red-600">
      {error.message}
      {error.hint === null ? null : (
        <span className="text-muted-foreground"> — {error.hint}</span>
      )}
    </p>
  );
}

export function CurrentPlanCard() {
  const planQuery = useCurrentPlan();
  const summaryQuery = useCreditsSummary();

  if (planQuery.status === "loading") {
    return (
      <section aria-labelledby="current-plan-heading" className={CARD_CLASS}>
        <span role="status" className="sr-only">
          Loading your plan…
        </span>
        <div aria-hidden="true" className="m-5">
          <div className="h-4 w-24 animate-pulse rounded bg-surface-muted" />
          <div className="mt-3 h-7 w-40 animate-pulse rounded bg-surface-muted" />
          <div className="mt-4 h-3 w-64 max-w-full animate-pulse rounded bg-surface-muted" />
        </div>
      </section>
    );
  }

  if (planQuery.status === "error") {
    return (
      <section aria-labelledby="current-plan-heading">
        <h2 id="current-plan-heading" className="sr-only">
          Current plan
        </h2>
        <p role="status" className={ERROR_CLASS}>
          Couldn&apos;t load your plan — {planQuery.message ?? "please try again."}{" "}
          <button type="button" onClick={planQuery.retry} className={RETRY_CLASS}>
            Retry
          </button>
        </p>
      </section>
    );
  }

  if (planQuery.plan !== null) {
    return <PlanDetails plan={planQuery.plan} />;
  }

  // Plan unknown from /me — identity falls back to the summary trial flag.
  if (summaryQuery.isPending) {
    return (
      <section aria-labelledby="current-plan-heading" className={CARD_CLASS}>
        <span role="status" className="sr-only">
          Loading your plan…
        </span>
        <div aria-hidden="true" className="m-5">
          <div className="h-4 w-24 animate-pulse rounded bg-surface-muted" />
          <div className="mt-3 h-7 w-40 animate-pulse rounded bg-surface-muted" />
        </div>
      </section>
    );
  }

  if (summaryQuery.isError) {
    return (
      <section aria-labelledby="current-plan-heading">
        <h2 id="current-plan-heading" className="sr-only">
          Current plan
        </h2>
        <p role="status" className={ERROR_CLASS}>
          Couldn&apos;t load your plan —{" "}
          {summaryQuery.error instanceof Error
            ? summaryQuery.error.message
            : "please try again."}{" "}
          <button
            type="button"
            onClick={() => {
              void summaryQuery.refetch();
            }}
            className={RETRY_CLASS}
          >
            Retry
          </button>
        </p>
      </section>
    );
  }

  return summaryQuery.data.trial ? <TrialCard /> : <NoPlanCard />;
}

function PlanDetails({ plan }: { readonly plan: CurrentPlanSummary }) {
  const canManage = useCanManageBilling();
  const [actionError, setActionError] = useState<BillingActionError | null>(null);

  return (
    <section aria-labelledby="current-plan-heading" className={`${CARD_CLASS} p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="current-plan-heading" className={SECTION_HEADING_CLASS}>
            Current plan
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h3 className="text-xl font-semibold">{plan.name ?? "Subscription"}</h3>
            {plan.status === null ? null : (
              <span className={STATUS_CHIP_CLASS}>{plan.status.replaceAll("_", " ")}</span>
            )}
          </div>
        </div>
        {canManage ? (
          <ManageBillingButton onError={setActionError} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Card and plan changes are made by workspace admins.
          </p>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Monthly credits</dt>
          <dd className="mt-0.5 font-medium">
            {plan.monthlyCredits === null ? "—" : `${formatCredits(plan.monthlyCredits)} / mo`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Seats</dt>
          <dd className="mt-0.5 font-medium">
            {plan.seats === null ? "—" : `${plan.seats} (+$8 / extra seat)`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Renews</dt>
          <dd className="mt-0.5 font-medium">
            {plan.renewal === null ? "—" : formatDateTime(plan.renewal)}
          </dd>
        </div>
      </dl>

      {actionError === null ? null : <ActionErrorLine error={actionError} />}
    </section>
  );
}

/** §14.1 trial: one-time 30 credits, no card required, one per account. */
function TrialCard() {
  return (
    <section aria-labelledby="current-plan-heading" className={`${CARD_CLASS} p-5`}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex size-9 items-center justify-center rounded-md bg-surface-muted"
        >
          <Zap className="size-4 text-accent" />
        </span>
        <div>
          <h2 id="current-plan-heading" className={SECTION_HEADING_CLASS}>
            Current plan
          </h2>
          <h3 className="mt-1 text-xl font-semibold">Free trial</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            30 one-time credits, no card required — one trial per account. Pick a plan below to
            keep creating when they run out.
          </p>
        </div>
      </div>
    </section>
  );
}

function NoPlanCard() {
  return (
    <section aria-labelledby="current-plan-heading" className={`${CARD_CLASS} p-5`}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex size-9 items-center justify-center rounded-md bg-surface-muted"
        >
          <CreditCard className="size-4" />
        </span>
        <div>
          <h2 id="current-plan-heading" className={SECTION_HEADING_CLASS}>
            Current plan
          </h2>
          <h3 className="mt-1 text-xl font-semibold">No active plan</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Choose a subscription below — monthly credits land as soon as Stripe confirms the
            first payment.
          </p>
        </div>
      </div>
    </section>
  );
}
