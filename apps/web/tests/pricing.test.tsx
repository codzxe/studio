import PricingPage, { metadata } from "@/app/(marketing)/pricing/page";
import { PLAN_CATALOG, brandViolations } from "@studio/config";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * /pricing contract (M9-E, AUD-5): the page mirrors the REAL plan catalog —
 * `@studio/config` PLAN_CATALOG is the source of record, so the expectations
 * below are DERIVED from it too (a catalog change moves both; a hardcoded
 * drift on either side fails the test). §8.8 honesty: no invented "save X%",
 * no annual price, pack prices are Stripe-only ("shown at checkout"), no free
 * tier.
 */

const MICROS_PER_CREDIT = 1_000_000;

/** Same §14 formatting the page uses. */
function usd(cents: number): string {
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars.toString() : dollars.toFixed(2)}`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function credits(micro: number): string {
  return count(micro / MICROS_PER_CREDIT);
}

describe("pricing page", () => {
  it("has pricing metadata (title via the Brand-token conventions)", () => {
    expect(metadata.title).toBe("Pricing");
    expect((metadata.description ?? "").length).toBeGreaterThan(0);
  });

  it("renders the three catalog plans with REAL catalog numbers", () => {
    render(<PricingPage />);
    const cards = {
      starter: screen.getByTestId("pricing-card-starter"),
      pro: screen.getByTestId("pricing-card-pro"),
      studio: screen.getByTestId("pricing-card-studio"),
    } as const;

    for (const id of ["starter", "pro", "studio"] as const) {
      const plan = PLAN_CATALOG[id];
      const card = cards[id];
      // Price, allowance, seats, projects, render minutes — all derived.
      expect(within(card).getByText(usd(plan.monthlyPriceCents))).toBeInTheDocument();
      expect(
        within(card).getByText(`${credits(plan.monthlyCreditAllowance)} credits/mo`),
      ).toBeInTheDocument();
      expect(within(card).getByText(`${count(plan.seats)} seats`)).toBeInTheDocument();
      expect(within(card).getByText(`${count(plan.maxProjects)} projects`)).toBeInTheDocument();
      expect(
        within(card).getByText(`${count(plan.renderMinutesPerMonth)} render minutes/mo`),
      ).toBeInTheDocument();
      // Model tiers come from the catalog rows (D-8: no vision tier on any plan).
      expect(within(card).getByText("Fast + Smart models")).toBeInTheDocument();
      // The render-cap footnote, derived from the M8 entitlement fields.
      expect(
        within(card).getByText(
          `${count(plan.maxConcurrentRenders)} render${plan.maxConcurrentRenders === 1 ? "" : "s"} at a time · up to ${count(plan.maxRenderLongEdgePx)} px · outputs kept ${count(plan.renderRetentionDays)} days`,
        ),
      ).toBeInTheDocument();
    }

    // §14 storage display (binary steps, like the billing usage meters).
    expect(within(cards.starter).getByText("20 GB storage")).toBeInTheDocument();
    expect(within(cards.studio).getByText("1 TB storage")).toBeInTheDocument();
  });

  it("features exactly Pro, with a /sign-up CTA on every card", () => {
    render(<PricingPage />);
    expect(
      within(screen.getByTestId("pricing-card-pro")).getByText("Most popular"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Most popular")).toHaveLength(1);
    for (const name of ["Start Starter trial", "Start Pro trial", "Start Studio trial"]) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", "/sign-up");
    }
  });

  it("top-ups: the three real wire packs, price honestly at checkout, never auto-charged", () => {
    render(<PricingPage />);
    const topups = screen.getByTestId("pricing-topups");
    for (const label of ["100 credits", "500 credits", "2,000 credits"]) {
      expect(within(topups).getByText(label)).toBeInTheDocument();
    }
    expect(within(topups).getByText(/shown at checkout/i)).toBeInTheDocument();
    expect(within(topups).getByText(/never auto-charge/i)).toBeInTheDocument();
  });

  it("trial copy: the §8.2 line with the Starter price + entitlements from the trial row (D-4)", () => {
    render(<PricingPage />);
    const trial = screen.getByTestId("pricing-trial");
    expect(
      within(trial).getByText(
        `14 days free, then ${usd(PLAN_CATALOG.starter.monthlyPriceCents)}/mo. Card required today. Cancel anytime.`,
      ),
    ).toBeInTheDocument();
    const t = PLAN_CATALOG.trial;
    expect(
      within(trial).getByText(new RegExp(`${credits(t.monthlyCreditAllowance)} credits`)),
    ).toBeInTheDocument();
    expect(within(trial).getByText(/1 seat/)).toBeInTheDocument();
    expect(within(trial).getByText(/Fast model/)).toBeInTheDocument();
    expect(within(trial).getByText(/no free tier/i)).toBeInTheDocument();
  });

  it("render formats note mirrors the D-2 catalog: enabled formats only", () => {
    render(<PricingPage />);
    expect(
      screen.getByText(/Renders export as MP4 \(H\.264\) or PNG sequence today/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/ProRes, GIF, WAV audio are on the format list but not enabled yet/),
    ).toBeInTheDocument();
  });

  it("is brand-safe and free of invented metrics or fake discounts", () => {
    const { container } = render(<PricingPage />);
    const text = container.textContent ?? "";
    expect(brandViolations(text)).toEqual([]);
    const lower = text.toLowerCase();
    for (const banned of [
      "lorem ipsum",
      "save 20",
      "save x",
      "free forever",
      "trusted by",
      "ai-powered",
      "unlimited",
      "annual",
      "99.9",
    ]) {
      expect(lower).not.toContain(banned);
    }
  });
});
