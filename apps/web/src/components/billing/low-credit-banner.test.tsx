/**
 * LowCreditBanner tests (M6-G) — threshold matrix (≤20% warning; ≤5% or
 * ≤3 credits urgent, integer boundary math), block messaging, CTA wiring,
 * per-session dismissal with escalation re-show, hostile-input degradation.
 * Deterministic RTL; no network.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  LOW_CREDIT_URGENT_BALANCE_MICROCREDITS,
  LowCreditBanner,
  lowCreditLevel,
} from "./low-credit-banner";

const USER = userEvent.setup();

// Allowance for Starter: 500 credits = 500,000,000 µc (D-12).
const ALLOWANCE_500 = 500_000_000;

// ---------------------------------------------------------------------------
// Threshold matrix (integer math, exact boundaries)
// ---------------------------------------------------------------------------

describe("lowCreditLevel", () => {
  it("fires warning at ≤ 20% of the allowance, urgent at ≤ 5% or ≤ 3 credits", () => {
    // Exactly 20% → warning (boundary inclusive).
    expect(lowCreditLevel(ALLOWANCE_500 * 0.2, ALLOWANCE_500)).toBe("warning");
    // One µc above 20% → none.
    expect(lowCreditLevel(ALLOWANCE_500 * 0.2 + 1, ALLOWANCE_500)).toBe("none");
    // Exactly 5% → urgent.
    expect(lowCreditLevel(ALLOWANCE_500 * 0.05, ALLOWANCE_500)).toBe("urgent");
    // Just above 5% but under 20% → warning.
    expect(lowCreditLevel(ALLOWANCE_500 * 0.05 + 1, ALLOWANCE_500)).toBe("warning");
    // Absolute floor: ≤ 3 credits is urgent regardless of the allowance.
    expect(lowCreditLevel(LOW_CREDIT_URGENT_BALANCE_MICROCREDITS, ALLOWANCE_500)).toBe("urgent");
    expect(lowCreditLevel(LOW_CREDIT_URGENT_BALANCE_MICROCREDITS, 0)).toBe("urgent");
    expect(lowCreditLevel(LOW_CREDIT_URGENT_BALANCE_MICROCREDITS - 1, 0)).toBe("urgent");
    // Above the floor with no known allowance → no percentage applies.
    expect(lowCreditLevel(LOW_CREDIT_URGENT_BALANCE_MICROCREDITS + 1, 0)).toBe("none");
    // Healthy balance.
    expect(lowCreditLevel(ALLOWANCE_500 * 0.5, ALLOWANCE_500)).toBe("none");
    expect(lowCreditLevel(ALLOWANCE_500, ALLOWANCE_500)).toBe("none");
  });

  it("degrades hostile numbers to none — a broken input must not nag", () => {
    expect(lowCreditLevel(Number.NaN, ALLOWANCE_500)).toBe("none");
    expect(lowCreditLevel(Number.POSITIVE_INFINITY, ALLOWANCE_500)).toBe("none");
    expect(lowCreditLevel(0, Number.NaN)).toBe("urgent"); // 0 ≤ 3 credits is real
  });
});

// ---------------------------------------------------------------------------
// Banner rendering
// ---------------------------------------------------------------------------

describe("LowCreditBanner", () => {
  it("renders nothing at a healthy balance", () => {
    const { container } = render(
      <LowCreditBanner balanceMicrocredits={ALLOWANCE_500} allowanceMicrocredits={ALLOWANCE_500} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the warning banner with the 2-decimal balance and Buy-credits CTA", async () => {
    const onTopUp = vi.fn();
    render(
      <LowCreditBanner
        balanceMicrocredits={100_000_000} // 100 credits = exactly 20%
        allowanceMicrocredits={ALLOWANCE_500}
        onTopUp={onTopUp}
      />,
    );
    const banner = screen.getByTestId("low-credit-banner");
    expect(banner).toHaveAttribute("data-level", "warning");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent("100.00 credits left");
    expect(banner).toHaveTextContent("20% of your monthly allowance");
    await USER.click(screen.getByTestId("low-credit-topup"));
    expect(onTopUp).toHaveBeenCalledTimes(1);
  });

  it("renders the urgent banner as an alert with the zero-balance block copy", () => {
    render(
      <LowCreditBanner
        balanceMicrocredits={2_500_000} // 2.5 credits → absolute urgent
        allowanceMicrocredits={ALLOWANCE_500}
      />,
    );
    const banner = screen.getByTestId("low-credit-banner");
    expect(banner).toHaveAttribute("data-level", "urgent");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent("2.50 credits left");
    expect(banner).toHaveTextContent("New runs are blocked once credits reach zero.");
  });

  it("renders the CTA as a link when only a href is provided", () => {
    render(
      <LowCreditBanner
        balanceMicrocredits={0}
        allowanceMicrocredits={ALLOWANCE_500}
        topUpHref="/w/settings/billing"
      />,
    );
    const cta = screen.getByTestId("low-credit-topup");
    expect(cta.tagName).toBe("A");
    expect(cta).toHaveAttribute("href", "/w/settings/billing");
    expect(cta).toHaveTextContent("Buy credits");
  });

  it("shows a negative (hostile) balance as urgent with the formatted value", () => {
    render(
      <LowCreditBanner balanceMicrocredits={-5_000_000} allowanceMicrocredits={ALLOWANCE_500} />,
    );
    expect(screen.getByTestId("low-credit-banner")).toHaveAttribute("data-level", "urgent");
    expect(screen.getByTestId("low-credit-banner")).toHaveTextContent("-5.00 credits left");
  });

  it("renders nothing for a hostile non-finite balance", () => {
    const { container } = render(
      <LowCreditBanner balanceMicrocredits={Number.NaN} allowanceMicrocredits={ALLOWANCE_500} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("dismisses per-session, stays dismissed at the same level, re-appears on escalation", async () => {
    const props = {
      balanceMicrocredits: 100_000_000, // warning (exactly 20%)
      allowanceMicrocredits: ALLOWANCE_500,
    };
    const { rerender } = render(<LowCreditBanner {...props} />);
    await USER.click(screen.getByTestId("low-credit-dismiss"));
    expect(screen.queryByTestId("low-credit-banner")).not.toBeInTheDocument();

    // Same level after a rerender → still dismissed (in-memory, per-session).
    rerender(<LowCreditBanner {...props} />);
    expect(screen.queryByTestId("low-credit-banner")).not.toBeInTheDocument();

    // Escalation is new information → the banner comes back.
    rerender(
      <LowCreditBanner
        balanceMicrocredits={2_000_000} // 2 credits → urgent
        allowanceMicrocredits={ALLOWANCE_500}
      />,
    );
    const banner = screen.getByTestId("low-credit-banner");
    expect(banner).toHaveAttribute("data-level", "urgent");
    expect(banner).toHaveTextContent("New runs are blocked once credits reach zero.");
  });
});
