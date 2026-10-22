"use client";

/**
 * UpgradeCta — the §8.8 "Plan → Change plan" comparison strip (BUILD_PLAN
 * §M6 task 4 "upgrade CTAs").
 *
 * D-4 is ENFORCED, not assumed: the pricing display list is EXACTLY
 * starter/pro/studio. The component normalizes whatever it is given — keeps
 * only known paid ids, dedupes, orders them starter → pro → studio — so even
 * a lazy or hostile caller cannot render a trial row or an invented tier.
 * Trial is a subscription state, never a checkout target.
 *
 * Display data comes IN as props (`plans`: name, price cents placeholder,
 * highlights) — the component never imports `@studio/config` and never
 * hardcodes entitlements or prices; the page (M6-F) owns the data (catalog
 * or billing state). Price strings are BUSINESS-PENDING placeholders until
 * real Stripe pricing lands.
 *
 * → POST /v1/billing/checkout through the injected seam (the page wires
 * `client.billing.checkout`). Idempotency (law #4): one key per attempt
 * (fresh key on retry — a duplicate Checkout session is never a charge),
 * every button disabled while an attempt is in flight. Two success arms per
 * the wire contract: `planChanged: true` → server-side switch, no redirect
 * (announce + `onPlanChanged`); otherwise redirect to the Checkout `url`
 * (http(s)-validated, with a manual Continue link as the redirect fallback).
 *
 * Exported surface (binding for M6-F):
 *   UpgradeCtaProps + UpgradeCta + UpgradePlanOption + UpgradePlanId
 *   + CheckoutStart + CheckoutAttemptOptions
 */

import type { CheckoutRequest, CheckoutResponse, PlanId } from "@studio/contracts";
import { Badge, Button, Card, CardContent, CardTitle, cn } from "@studio/ui";
import { CircleAlert, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { ReactElement } from "react";
import { truncateForDisplay } from "./ledger-table";
import { type RedirectTo, defaultRedirectTo, isSafeCheckoutUrl } from "./topup-flow";

// ---------------------------------------------------------------------------
// D-4 pin (local, import-type-only boundary law)
// ---------------------------------------------------------------------------

/** The purchasable plan ids — derived from the wire `CheckoutRequest` union. */
export type UpgradePlanId = CheckoutRequest["planId"];

/** The D-4 pricing-page display list, in canonical order. */
const ORDERED_PAID_PLAN_IDS = [
  "starter",
  "pro",
  "studio",
] as const satisfies readonly UpgradePlanId[];

// ---------------------------------------------------------------------------
// Seam types
// ---------------------------------------------------------------------------

/** Options the strip attaches to ONE checkout attempt (law #4). */
export interface CheckoutAttemptOptions {
  /** Idempotency key for this attempt — the gateway replays on re-send. */
  readonly idempotencyKey: string;
}

/**
 * The `POST /v1/billing/checkout` seam — the page wires it to the api-client:
 *   (planId, { idempotencyKey }) => client.billing.checkout({ planId }, { idempotencyKey })
 */
export type CheckoutStart = (
  planId: UpgradePlanId,
  options: CheckoutAttemptOptions,
) => Promise<CheckoutResponse>;

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** One purchasable plan as the strip renders it (display data passed IN). */
export interface UpgradePlanOption {
  readonly planId: UpgradePlanId;
  /** Display name (UI_DS §14: "Starter", "Pro", "Studio"). */
  readonly name: string;
  /** Monthly display price in integer cents (BUSINESS-PENDING placeholder). */
  readonly priceCents: number;
  /** Price suffix; default "per month". */
  readonly priceNote?: string;
  /** Short feature lines (bounded at render: ≤ 6 lines, 80 chars each). */
  readonly highlights: readonly string[];
}

/** "$12" / "$39.50"; hostile prices (non-finite, negative) render as "—". */
function formatPriceCents(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return "—";
  const whole = Number.isInteger(cents) && cents % 100 === 0;
  const fractionDigits = whole ? 0 : 2;
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** Wire-safe error text: bounded, never a raw dump of a hostile throw. */
function checkoutErrorMessage(cause: unknown): string {
  if (cause instanceof Error && typeof cause.message === "string" && cause.message.length > 0) {
    return truncateForDisplay(cause.message);
  }
  return "Checkout could not be started.";
}

/** D-4 normalization: exactly the known paid ids, canonical order, deduped. */
function normalizePlans(plans: readonly UpgradePlanOption[]): UpgradePlanOption[] {
  const byId = new Map<UpgradePlanId, UpgradePlanOption>();
  for (const plan of plans) {
    if (typeof plan?.planId === "string" && !byId.has(plan.planId)) {
      byId.set(plan.planId, plan);
    }
  }
  const ordered: UpgradePlanOption[] = [];
  for (const id of ORDERED_PAID_PLAN_IDS) {
    const plan = byId.get(id);
    if (plan !== undefined) ordered.push(plan);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// UpgradeCta
// ---------------------------------------------------------------------------

type CheckoutPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "busy"; readonly planId: UpgradePlanId }
  | { readonly kind: "redirecting"; readonly url: string }
  | { readonly kind: "done"; readonly planId: UpgradePlanId }
  | { readonly kind: "error"; readonly planId: UpgradePlanId; readonly message: string };

export interface UpgradeCtaProps {
  /** Display data for the three paid plans (D-4); see `UpgradePlanOption`. */
  readonly plans: readonly UpgradePlanOption[];
  /** The workspace's effective plan ("trial" while trialing, D-4). */
  readonly currentPlan?: PlanId | null;
  /** Required: the `POST /v1/billing/checkout` seam (see `CheckoutStart`). */
  readonly startCheckout: CheckoutStart;
  /** `planChanged: true` arm — the server switched the plan without a session. */
  readonly onPlanChanged?: (response: CheckoutResponse) => void;
  readonly redirectTo?: RedirectTo;
  /** Injectable idempotency-key factory (8–128 chars, §7.2); default crypto UUID. */
  readonly idempotencyKeyFactory?: () => string;
  /** Page-level lock: disables every checkout button (a billing action is in flight). */
  readonly busy?: boolean;
  readonly title?: string;
  readonly className?: string;
}

export function UpgradeCta({
  plans,
  currentPlan = null,
  startCheckout,
  onPlanChanged,
  redirectTo = defaultRedirectTo,
  idempotencyKeyFactory = () => crypto.randomUUID(),
  busy = false,
  title = "Choose a plan",
  className,
}: UpgradeCtaProps): ReactElement | null {
  const [phase, setPhase] = useState<CheckoutPhase>({ kind: "idle" });

  const ordered = normalizePlans(plans);
  if (ordered.length === 0) return null;

  const busyAll = busy || phase.kind === "busy" || phase.kind === "redirecting";
  const isCurrentPlan = (planId: UpgradePlanId): boolean =>
    currentPlan !== null && currentPlan === planId;
  const hasPaidPlan =
    currentPlan !== null && (ORDERED_PAID_PLAN_IDS as readonly string[]).includes(currentPlan);

  const attempt = (plan: UpgradePlanOption): void => {
    if (busyAll || isCurrentPlan(plan.planId)) return;
    const idempotencyKey = idempotencyKeyFactory();
    setPhase({ kind: "busy", planId: plan.planId });
    startCheckout(plan.planId, { idempotencyKey })
      .then((response) => {
        if (response?.planChanged === true) {
          setPhase({ kind: "done", planId: plan.planId });
          onPlanChanged?.(response);
          return;
        }
        const url = typeof response?.url === "string" ? response.url : "";
        if (!isSafeCheckoutUrl(url)) {
          setPhase({
            kind: "error",
            planId: plan.planId,
            message: "The checkout link from the server was invalid.",
          });
          return;
        }
        setPhase({ kind: "redirecting", url });
        if (redirectTo !== undefined) redirectTo(url);
      })
      .catch((cause: unknown) => {
        setPhase({ kind: "error", planId: plan.planId, message: checkoutErrorMessage(cause) });
      });
  };

  const busyName = (phase: CheckoutPhase): string | null => {
    if (phase.kind === "busy" || phase.kind === "done" || phase.kind === "error") {
      const plan = ordered.find((candidate) => candidate.planId === phase.planId);
      return plan ? truncateForDisplay(plan.name, 40) : null;
    }
    return null;
  };

  return (
    <section
      aria-label="Plan options"
      data-testid="upgrade-cta"
      data-phase={phase.kind}
      className={className}
    >
      {title ? <h3 className="mb-3 text-body-l font-medium text-primary">{title}</h3> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        {ordered.map((plan) => {
          const current = isCurrentPlan(plan.planId);
          const name = truncateForDisplay(plan.name, 40);
          const highlighted = plan.highlights.slice(0, 6);
          return (
            <Card
              key={plan.planId}
              data-testid={`upgrade-plan-${plan.planId}`}
              data-current={current || undefined}
              className={cn("flex flex-col", current && "border-signal")}
            >
              <div className="flex items-center justify-between gap-2">
                <CardTitle>{name}</CardTitle>
                {current ? (
                  <Badge variant="signal" data-testid={`upgrade-current-${plan.planId}`}>
                    Current plan
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1.5 text-body text-primary">
                <span className="tabular">{formatPriceCents(plan.priceCents)}</span>{" "}
                <span className="text-caption text-muted">{plan.priceNote ?? "per month"}</span>
              </p>
              <CardContent className="mt-2 flex-1">
                <ul className="flex flex-col gap-1">
                  {highlighted.map((line, index) => (
                    <li key={`${plan.planId}-${index}`} className="text-caption text-secondary">
                      {truncateForDisplay(line, 80)}
                    </li>
                  ))}
                </ul>
              </CardContent>
              <div className="mt-4">
                {current ? (
                  <Button size="sm" variant="secondary" disabled>
                    Current plan
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid={`upgrade-choose-${plan.planId}`}
                    loading={phase.kind === "busy" && phase.planId === plan.planId}
                    disabled={busyAll}
                    onClick={() => attempt(plan)}
                  >
                    {hasPaidPlan ? `Switch to ${name}` : `Choose ${name}`}
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {phase.kind === "redirecting" ? (
        <output
          data-testid="upgrade-redirecting"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-sm border border-border bg-panel px-3 py-2 text-caption text-primary"
        >
          <span className="min-w-0 flex-1">Opening secure checkout…</span>
          <a
            data-testid="upgrade-continue-link"
            href={phase.url}
            className="inline-flex items-center gap-1.5 text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
            Continue to checkout
          </a>
        </output>
      ) : null}

      {phase.kind === "done" ? (
        <output
          data-testid="upgrade-done"
          className="mt-3 block rounded-sm border border-success/40 bg-success/10 px-3 py-2 text-caption text-primary"
        >
          {`Your plan is now ${busyName(phase) ?? "updated"}. Entitlements apply immediately.`}
        </output>
      ) : null}

      {phase.kind === "error" ? (
        <div
          role="alert"
          data-testid="upgrade-error"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
        >
          <CircleAlert
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-danger"
          />
          <p className="min-w-0 flex-1">{phase.message}</p>
          <Button
            size="sm"
            variant="secondary"
            data-testid="upgrade-retry"
            onClick={() => {
              const plan = ordered.find((candidate) => candidate.planId === phase.planId);
              if (plan !== undefined) attempt(plan);
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
    </section>
  );
}
