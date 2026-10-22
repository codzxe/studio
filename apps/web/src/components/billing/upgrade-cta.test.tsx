/**
 * UpgradeCta tests (M6-G) — D-4 exactly-starter/pro/studio normalization,
 * current-plan marking, checkout attempt idempotency + busy locking, the two
 * success arms (planChanged vs redirect), hostile urls/strings, price
 * formatting. Deterministic RTL; no network.
 */

import type { CheckoutResponse, PlanId } from "@studio/contracts";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  type CheckoutAttemptOptions,
  UpgradeCta,
  type UpgradePlanId,
  type UpgradePlanOption,
} from "./upgrade-cta";

const USER = userEvent.setup();

const PLANS = [
  {
    planId: "starter",
    name: "Starter",
    priceCents: 1200,
    highlights: ["2 seats", "500 credits/mo"],
  },
  { planId: "pro", name: "Pro", priceCents: 3950, highlights: ["5 seats", "2,000 credits/mo"] },
  {
    planId: "studio",
    name: "Studio",
    priceCents: 9900,
    highlights: ["15 seats", "10,000 credits/mo"],
  },
] satisfies UpgradePlanOption[];

/** Each startCheckout call gets its OWN deferred promise, recorded in order. */
function deferredCheckout() {
  const calls: {
    resolve: (value: CheckoutResponse) => void;
    reject: (cause: unknown) => void;
  }[] = [];
  const startCheckout = vi.fn(
    (_planId: UpgradePlanId, _options: CheckoutAttemptOptions) =>
      new Promise<CheckoutResponse>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  );
  return { startCheckout, calls };
}

// ---------------------------------------------------------------------------
// D-4 — exactly starter/pro/studio
// ---------------------------------------------------------------------------

describe("UpgradeCta — D-4 display list", () => {
  it("renders exactly starter, pro, studio in canonical order from any input", () => {
    const shuffled = [
      PLANS[2],
      PLANS[1],
      { ...PLANS[1], highlights: ["duplicate pro"] }, // duplicate: FIRST occurrence kept
      PLANS[0],
      // Hostile junk never reaches the display list (D-4: trial is a state).
      { planId: "trial", name: "Trial", priceCents: 0, highlights: [] },
      { planId: "enterprise", name: "Evil Tier", priceCents: 1, highlights: [] },
    ] as unknown as UpgradePlanOption[];
    render(<UpgradeCta plans={shuffled} startCheckout={vi.fn()} />);

    const cards = screen.getAllByTestId(/^upgrade-plan-/);
    expect(cards.map((card) => card.getAttribute("data-testid"))).toEqual([
      "upgrade-plan-starter",
      "upgrade-plan-pro",
      "upgrade-plan-studio",
    ]);
    // The duplicate pro row keeps the FIRST occurrence's data.
    const pro = screen.getByTestId("upgrade-plan-pro");
    expect(within(pro).getByText("Pro")).toBeInTheDocument();
    expect(within(pro).queryByText("duplicate pro")).not.toBeInTheDocument();
    expect(within(pro).getByText("5 seats")).toBeInTheDocument();
  });

  it("renders nothing when there are no paid plans to show", () => {
    const { container } = render(<UpgradeCta plans={[]} startCheckout={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("formats placeholder prices as USD and degrades hostile values", () => {
    render(<UpgradeCta plans={PLANS} startCheckout={vi.fn()} />);
    expect(screen.getByTestId("upgrade-plan-starter")).toHaveTextContent("$12");
    expect(screen.getByTestId("upgrade-plan-pro")).toHaveTextContent("$39.50");
    expect(screen.getByTestId("upgrade-plan-studio")).toHaveTextContent("$99");
    for (const card of screen.getAllByTestId(/^upgrade-plan-/)) {
      expect(card).toHaveTextContent("per month");
    }
  });

  it("bounds hostile display strings (name ≤ 40, highlights ≤ 6 × 80 chars)", () => {
    render(
      <UpgradeCta
        plans={[
          {
            planId: "starter",
            name: "S".repeat(500),
            priceCents: -5,
            highlights: ["x".repeat(500), "one", "two", "three", "four", "five", "six", "seven"],
          },
        ]}
        startCheckout={vi.fn()}
      />,
    );
    const card = screen.getByTestId("upgrade-plan-starter");
    const name = card.querySelector("h3")?.textContent ?? "";
    expect(name.length).toBeLessThanOrEqual(40);
    // Hostile price renders the em dash, never a negative dollar amount.
    expect(card).toHaveTextContent("—");
    const items = within(card).getAllByRole("listitem");
    expect(items.length).toBe(6);
    expect(items[0]?.textContent?.length ?? 0).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
// Current plan + checkout attempts
// ---------------------------------------------------------------------------

describe("UpgradeCta — current plan + checkout", () => {
  it("marks the current plan and disables its checkout button", () => {
    render(<UpgradeCta plans={PLANS} currentPlan="pro" startCheckout={vi.fn()} />);
    expect(screen.getByTestId("upgrade-plan-pro")).toHaveAttribute("data-current", "true");
    expect(screen.getByTestId("upgrade-current-pro")).toHaveTextContent("Current plan");
    const proButton = screen.getByRole("button", { name: "Current plan" });
    expect(proButton).toBeDisabled();
    // Other plans read "Switch to X" when a paid plan is current.
    expect(screen.getByTestId("upgrade-choose-starter")).toHaveTextContent("Switch to Starter");
    expect(screen.getByTestId("upgrade-choose-studio")).toHaveTextContent("Switch to Studio");
  });

  it("labels the CTA 'Choose X' while on trial (D-4: trial is a state)", () => {
    const currentPlan: PlanId = "trial";
    render(<UpgradeCta plans={PLANS} currentPlan={currentPlan} startCheckout={vi.fn()} />);
    expect(screen.getByTestId("upgrade-choose-pro")).toHaveTextContent("Choose Pro");
  });

  it("POSTs checkout with one idempotency key per attempt, locks buttons while in flight", async () => {
    const { startCheckout, calls } = deferredCheckout();
    const redirectTo = vi.fn();
    let n = 0;
    render(
      <UpgradeCta
        plans={PLANS}
        currentPlan="starter"
        startCheckout={startCheckout}
        redirectTo={redirectTo}
        idempotencyKeyFactory={() => `key-${++n}`}
      />,
    );

    await USER.click(screen.getByTestId("upgrade-choose-pro"));
    expect(startCheckout).toHaveBeenCalledTimes(1);
    expect(startCheckout).toHaveBeenCalledWith(
      "pro",
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(startCheckout.mock.calls.at(0)?.[1].idempotencyKey).toBe("key-1");

    // Busy: every checkout button is locked while the POST is in flight.
    expect(screen.getByTestId("upgrade-choose-pro")).toBeDisabled();
    expect(screen.getByTestId("upgrade-choose-studio")).toBeDisabled();
    await USER.click(screen.getByTestId("upgrade-choose-pro"));
    expect(startCheckout).toHaveBeenCalledTimes(1);

    // planChanged arm: server-side switch — no redirect, an announcement.
    await act(async () => {
      calls.at(0)?.resolve({ planChanged: true, sessionId: "", url: "https://checkout.example/s" });
    });
    expect(redirectTo).not.toHaveBeenCalled();
    expect(screen.getByTestId("upgrade-done")).toHaveTextContent("Your plan is now Pro.");
    expect(screen.getByTestId("upgrade-cta")).toHaveAttribute("data-phase", "done");
  });

  it("redirects to the hosted session when the server returns a url", async () => {
    const { startCheckout, calls } = deferredCheckout();
    const redirectTo = vi.fn();
    const onPlanChanged = vi.fn();
    render(
      <UpgradeCta
        plans={PLANS}
        currentPlan="trial"
        startCheckout={startCheckout}
        redirectTo={redirectTo}
        onPlanChanged={onPlanChanged}
      />,
    );

    await USER.click(screen.getByTestId("upgrade-choose-studio"));
    const session: CheckoutResponse = {
      sessionId: "cs_sub_1",
      url: "https://checkout.stripe.com/c/pay/cs_sub_1",
    };
    await act(async () => {
      calls.at(0)?.resolve(session);
    });
    expect(redirectTo).toHaveBeenCalledWith(session.url);
    expect(onPlanChanged).not.toHaveBeenCalled();
    expect(screen.getByTestId("upgrade-cta")).toHaveAttribute("data-phase", "redirecting");
    expect(screen.getByTestId("upgrade-continue-link")).toHaveAttribute("href", session.url);
  });

  it("shows a bounded error and retries with a FRESH key", async () => {
    const { startCheckout, calls } = deferredCheckout();
    let n = 0;
    render(
      <UpgradeCta
        plans={PLANS}
        currentPlan="trial"
        startCheckout={startCheckout}
        redirectTo={vi.fn()}
        idempotencyKeyFactory={() => `key-${++n}`}
      />,
    );

    await USER.click(screen.getByTestId("upgrade-choose-pro"));
    await act(async () => {
      calls.at(0)?.reject(new Error("E".repeat(5000)));
    });
    const strip = screen.getByTestId("upgrade-error");
    expect(strip).toHaveAttribute("role", "alert");
    expect(strip.querySelector("p")?.textContent?.length ?? 0).toBeLessThanOrEqual(200);

    await USER.click(screen.getByTestId("upgrade-retry"));
    expect(startCheckout).toHaveBeenCalledTimes(2);
    expect(startCheckout.mock.calls.at(1)?.[1].idempotencyKey).toBe("key-2");
  });

  it("refuses to redirect to a hostile checkout url", async () => {
    const { startCheckout, calls } = deferredCheckout();
    const redirectTo = vi.fn();
    render(
      <UpgradeCta
        plans={PLANS}
        currentPlan="trial"
        startCheckout={startCheckout}
        redirectTo={redirectTo}
      />,
    );

    await USER.click(screen.getByTestId("upgrade-choose-pro"));
    await act(async () => {
      calls.at(0)?.resolve({ sessionId: "cs_evil", url: "javascript:alert(1)" });
    });
    expect(redirectTo).not.toHaveBeenCalled();
    expect(screen.getByTestId("upgrade-error")).toHaveTextContent(
      "The checkout link from the server was invalid.",
    );
  });

  it("honours the page-level busy lock without touching internal state", async () => {
    const startCheckout = vi.fn();
    render(<UpgradeCta plans={PLANS} currentPlan="trial" startCheckout={startCheckout} busy />);
    const button = screen.getByTestId("upgrade-choose-pro");
    expect(button).toBeDisabled();
    await USER.click(button);
    expect(startCheckout).not.toHaveBeenCalled();
    expect(screen.getByTestId("upgrade-cta")).toHaveAttribute("data-phase", "idle");
  });
});
