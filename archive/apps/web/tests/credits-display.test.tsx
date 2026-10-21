/**
 * Tier cost display tests (W8-T) — §5.2 rows + §14.1/§14.4 multipliers.
 *
 * §16.2 truthfulness: the credit cost of every tier is resolved and shown
 * BEFORE the run starts — quick 1 / standard 2 / complex 5 / premium ×2
 * standard = 4 / max ×4 standard = 8. Two layers are pinned:
 *   1. the TIER_COSTS table itself (real path: components/compose/run-contract);
 *   2. the rendered <TierSelector> — cost labels, checked state, and the
 *      unaffordable badge, which flags but never blocks selection (§14.2
 *      rule 1: the gateway is the money authority — a 402, not a disabled
 *      radio, is the honest outcome).
 * Deterministic, no network, no timers.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  COMPOSABLE_TIERS,
  TIER_COSTS,
  creditsForTier,
  isTierUnaffordable,
  type ComposableTier,
} from "../src/components/compose/run-contract";
import { TierSelector } from "../src/components/compose/tier-selector";

// The <label> wrapping one tier card. `screen.getByText(tier)` matches the
// card's unique title span ("quick" / "standard" / …); climb to the label
// that owns the radio from there.
function tierCard(tier: string): HTMLElement {
  const card = screen.getByText(tier).closest("label");
  if (card === null) {
    throw new Error(`no tier card rendered for ${tier}`);
  }
  return card as HTMLElement;
}

describe("TIER_COSTS — the §5.2 table run-contract pins", () => {
  it("lists the five composable tiers in gateway order", () => {
    expect(TIER_COSTS.map((tier) => tier.tier)).toEqual([...COMPOSABLE_TIERS]);
    expect([...COMPOSABLE_TIERS]).toEqual([
      "quick",
      "standard",
      "complex",
      "premium",
      "max",
    ]);
  });

  it("resolves credits to 1 / 2 / 5 and premium ×2 = 4, max ×4 = 8 (§5.2, §14.4)", () => {
    expect(TIER_COSTS.map((tier) => tier.credits)).toEqual([1, 2, 5, 4, 8]);
    const byTier = Object.fromEntries(
      TIER_COSTS.map((tier) => [tier.tier, tier] as const),
    ) as Record<ComposableTier, (typeof TIER_COSTS)[number]>;
    expect(byTier.quick.multiplied).toBe(false);
    expect(byTier.standard.multiplied).toBe(false);
    expect(byTier.complex.multiplied).toBe(false);
    expect(byTier.premium.multiplied).toBe(true);
    expect(byTier.max.multiplied).toBe(true);
    // §14.1/§14.4: the multiplier multiplies the standard base, resolved.
    expect(byTier.premium.credits).toBe(2 * byTier.standard.credits);
    expect(byTier.max.credits).toBe(4 * byTier.standard.credits);
  });

  it("creditsForTier mirrors the table; isTierUnaffordable compares the balance", () => {
    for (const tier of TIER_COSTS) {
      expect(creditsForTier(tier.tier)).toBe(tier.credits);
    }
    expect(isTierUnaffordable("max", 7)).toBe(true);
    expect(isTierUnaffordable("max", 8)).toBe(false);
    expect(isTierUnaffordable("quick", 0)).toBe(true);
    // Loading balance ≠ broke — no badge while the GET /v1/credits is in flight.
    expect(isTierUnaffordable("quick", undefined)).toBe(false);
  });
});

describe("TierSelector cost display (§16.2: costs before the run)", () => {
  it("renders all five cards with the resolved, multiplier-visible cost labels", () => {
    render(<TierSelector value="standard" onChange={() => {}} balance={undefined} />);
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(screen.getByText("1 credit")).toBeDefined();
    expect(screen.getByText("2 credits")).toBeDefined();
    expect(screen.getByText("5 credits")).toBeDefined();
    expect(screen.getByText("4 credits (×2 standard)")).toBeDefined();
    expect(screen.getByText("8 credits (×4 standard)")).toBeDefined();
  });

  it("marks only the selected tier's radio as checked", () => {
    render(<TierSelector value="standard" onChange={() => {}} balance={undefined} />);
    expect(within(tierCard("standard")).getByRole("radio")).toBeChecked();
    for (const tier of ["quick", "complex", "premium", "max"]) {
      expect(within(tierCard(tier)).getByRole("radio")).not.toBeChecked();
    }
  });

  it("reports the picked tier through onChange", () => {
    const onChange = vi.fn();
    render(<TierSelector value="quick" onChange={onChange} balance={undefined} />);
    fireEvent.click(within(tierCard("complex")).getByRole("radio"));
    expect(onChange).toHaveBeenCalledWith("complex");
  });

  it("flags unaffordable tiers with a badge but never disables selection (§14.2 r1)", () => {
    render(<TierSelector value="standard" onChange={() => {}} balance={3} />);
    expect(screen.getByText("Needs 4 credits — below your current balance")).toBeDefined();
    expect(screen.getByText("Needs 8 credits — below your current balance")).toBeDefined();
    expect(screen.queryByText("Needs 1 credits — below your current balance")).toBeNull();
    expect(screen.queryByText("Needs 2 credits — below your current balance")).toBeNull();
    expect(screen.queryByText("Needs 5 credits — below your current balance")).toBeNull();
    for (const tier of COMPOSABLE_TIERS) {
      expect(within(tierCard(tier)).getByRole("radio")).toBeEnabled();
    }
  });

  it("shows no badge while the balance is still loading", () => {
    render(<TierSelector value="standard" onChange={() => {}} balance={undefined} />);
    expect(screen.queryByText(/below your current balance/)).toBeNull();
  });

  it("shows no badge when the balance covers every tier", () => {
    render(<TierSelector value="standard" onChange={() => {}} balance={8} />);
    expect(screen.queryByText(/below your current balance/)).toBeNull();
  });

  it("disabled prop freezes the whole fieldset (radios inert)", () => {
    render(
      <TierSelector value="standard" onChange={() => {}} balance={undefined} disabled />,
    );
    for (const tier of COMPOSABLE_TIERS) {
      expect(within(tierCard(tier)).getByRole("radio")).toBeDisabled();
    }
  });
});
