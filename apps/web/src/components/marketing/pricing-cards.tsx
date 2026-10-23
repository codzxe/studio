import {
  MICROCREDITS_PER_CREDIT,
  PLAN_CATALOG,
  type PaidPlanId,
  type PlanModelId,
  RENDER_FORMATS,
} from "@studio/config";
import { buttonVariants } from "@studio/ui";
import Link from "next/link";

/**
 * PricingCards — the §8.1 §8 "three plans + top-ups" block, built for the
 * /pricing page (M9-E, AUD-5 finding).
 *
 * HONESTY CONTRACT (§8.8 + §2.1): every number on this page is DERIVED from
 * `@studio/config` `PLAN_CATALOG` — the catalog of record (M6-A; BUSINESS-
 * PENDING prices, real entitlements). Nothing is invented here: no fake
 * "save X%", no annual price (none exists yet), no uptime or customer
 * metrics. The trial is a subscription STATE on the Starter row (D-4), so
 * the §8.2 trial copy quotes the Starter price.
 *
 * The top-up packs mirror the wire catalog (`@studio/contracts`
 * `TOP_UP_PACKS`: credits100/500/2000 — runtime import is forbidden in
 * apps/web, so the ids/credits are pinned here and pointed at the source).
 * Pack PRICES live in Stripe only and are never on the wire — the cards say
 * "price at checkout", exactly like the billing page's TopUpFlow.
 */

// ---------------------------------------------------------------------------
// Catalog derivations (no hardcoded entitlements anywhere below)
// ---------------------------------------------------------------------------

/** §14 money: integer cents → "$12" / "$39.50". */
function formatMonthlyPrice(cents: number): string {
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars.toString() : dollars.toFixed(2)}`;
}

/** §14 numbers: `1,200` with commas. */
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** §14 byte sizes, binary steps (same math as the billing usage meters). */
function formatStorage(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number.isInteger(value) ? value.toString() : value.toFixed(1)} ${units[unit]}`;
}

/** Short model label (§8.2 picker aliases; "studio-fast" → "Fast"). */
function modelLabel(id: PlanModelId): string {
  if (id === "studio-fast") return "Fast";
  if (id === "studio-smart") return "Smart";
  if (id === "studio-vision") return "Vision";
  return id;
}

/** "Fast + Smart models" — derived, so a catalog change can never drift. */
function modelsLine(models: readonly PlanModelId[]): string {
  const labels = models.map(modelLabel);
  if (labels.length === 0) return "No models";
  if (labels.length === 1) return `${labels[0]} model`;
  return `${labels.slice(0, -1).join(" + ")} + ${labels[labels.length - 1]} models`;
}

/** Whole credits from the D-12 integer-µc allowance. */
function creditAllowance(monthlyCreditAllowance: number): string {
  return formatCount(monthlyCreditAllowance / MICROCREDITS_PER_CREDIT);
}

interface PricingPlanCard {
  readonly id: PaidPlanId;
  readonly featured: boolean;
  /** One honest sentence — positioning, no metrics. */
  readonly blurb: string;
}

/** The D-4 display list: exactly starter/pro/studio; Pro featured (§8.1 §8). */
const PRICING_PAGE_CARDS: readonly PricingPlanCard[] = [
  { id: "starter", featured: false, blurb: "For solo motion work and small jobs." },
  { id: "pro", featured: true, blurb: "For small teams shipping every week." },
  { id: "studio", featured: false, blurb: "For studios with heavy render volume." },
] as const;

/** The wire top-up pack catalog, pinned (see the module header). */
const TOP_UP_PACKS: readonly { readonly credits: number }[] = Object.freeze([
  { credits: 100 },
  { credits: 500 },
  { credits: 2000 },
] as const);

// ---------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------

/** The three plan cards, each derived from its PLAN_CATALOG row. */
export function PricingCards() {
  const starter = PLAN_CATALOG.starter;
  return (
    <div className="grid gap-6 md:grid-cols-3 lg:gap-8">
      {PRICING_PAGE_CARDS.map((card) => {
        const plan = PLAN_CATALOG[card.id];
        return (
          <div
            key={plan.id}
            data-testid={`pricing-card-${plan.id}`}
            className={`flex flex-col gap-4 rounded-md border bg-panel p-6 transition-colors duration-120 ${
              card.featured ? "border-signal" : "border-border hover:border-border-strong"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-title-m text-primary">{plan.name}</h3>
              {card.featured ? (
                <span className="rounded-xs bg-signal px-1.5 py-0.5 text-hint font-medium tracking-[0.06em] uppercase text-signal-ink">
                  Most popular
                </span>
              ) : null}
            </div>
            <p className="text-caption text-secondary">{card.blurb}</p>
            <p className="flex items-baseline gap-1">
              <span className="font-display text-display-m tabular text-primary">
                {formatMonthlyPrice(plan.monthlyPriceCents)}
              </span>
              <span className="text-caption text-muted">/mo</span>
            </p>
            <ul className="flex flex-col gap-2 border-t border-border pt-4 text-body-s text-secondary">
              <li className="tabular">{creditAllowance(plan.monthlyCreditAllowance)} credits/mo</li>
              <li className="tabular">{formatCount(plan.seats)} seats</li>
              <li>{modelsLine(plan.models)}</li>
              <li className="tabular">{formatCount(plan.maxProjects)} projects</li>
              <li>{formatStorage(plan.storageBytes)} storage</li>
              <li className="tabular">
                {formatCount(plan.renderMinutesPerMonth)} render minutes/mo
              </li>
            </ul>
            <p className="tabular text-caption text-muted">
              {formatCount(plan.maxConcurrentRenders)} render
              {plan.maxConcurrentRenders === 1 ? "" : "s"} at a time · up to{" "}
              {formatCount(plan.maxRenderLongEdgePx)} px · outputs kept{" "}
              {formatCount(plan.renderRetentionDays)} days
            </p>
            <Link
              href="/sign-up"
              className={`mt-auto ${buttonVariants({
                variant: card.featured ? "primary" : "secondary",
                size: "lg",
              })}`}
            >
              Start {plan.name} trial
            </Link>
          </div>
        );
      })}
    </div>
  );
}

/** The top-ups block — pack sizes are real, prices are Stripe-only (honest). */
export function TopUpBlock() {
  return (
    <div data-testid="pricing-topups" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-3">
        {TOP_UP_PACKS.map((pack, index) => (
          <span key={pack.credits} className="flex items-baseline gap-3">
            {index > 0 ? (
              <span aria-hidden="true" className="text-disabled">
                ·
              </span>
            ) : null}
            <span className="tabular font-display text-title-m text-primary">
              {formatCount(pack.credits)} credits
            </span>
          </span>
        ))}
      </div>
      <p className="max-w-[68ch] text-body-s leading-relaxed text-secondary">
        One-time packs, never a subscription. Pack prices live in Stripe and are shown at checkout —
        we never auto-charge a top-up.
      </p>
    </div>
  );
}

/** The trial block — §8.2 copy, every number from the trial row (D-4). */
export function TrialBlock() {
  const trial = PLAN_CATALOG.trial;
  const starter = PLAN_CATALOG.starter;
  return (
    <div data-testid="pricing-trial" className="flex flex-col gap-4">
      <p className="text-body-l text-primary">
        14 days free, then {formatMonthlyPrice(starter.monthlyPriceCents)}/mo. Card required today.
        Cancel anytime.
      </p>
      <p className="max-w-[68ch] text-body-s leading-relaxed text-secondary">
        The trial is a state of the Starter plan, not a separate tier:{" "}
        {creditAllowance(trial.monthlyCreditAllowance)} credits, {formatCount(trial.seats)} seat,{" "}
        {formatCount(trial.maxProjects)} projects, {formatCount(trial.renderMinutesPerMonth)} render
        minutes a month and the {modelsLine(trial.models)}.
      </p>
      <p className="max-w-[68ch] text-body-s leading-relaxed text-secondary">
        There is no free tier. Cancel during the trial and the card is not charged at trial end.
      </p>
    </div>
  );
}

/** Render formats footnote — derived from the config catalog (D-2). */
export function RenderFormatsNote() {
  const enabled = RENDER_FORMATS.filter((format) => format.enabled).map((format) => format.label);
  const reserved = RENDER_FORMATS.filter((format) => !format.enabled).map((format) => format.label);
  return (
    <p className="max-w-[68ch] text-body-s leading-relaxed text-secondary">
      Renders export as {enabled.join(" or ")} today.{" "}
      {reserved.length > 0
        ? `${reserved.join(", ")} are on the format list but not enabled yet — they appear the day the render worker supports them.`
        : ""}
    </p>
  );
}
