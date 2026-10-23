/**
 * TopUpFlow tests (M6-G) — pack catalog pin, picker → confirm → POST →
 * redirect flow, idempotency-key-per-attempt, busy/replay-safety, hostile
 * checkout URLs and error bounding. Deterministic RTL; no network.
 */

import type { TopUpPackId, TopUpResponse } from "@studio/contracts";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TOP_UP_PACKS } from "./top-up-packs";
import { type TopUpAttemptOptions, TopUpFlow } from "./topup-flow";

const USER = userEvent.setup();

const SESSION: TopUpResponse = {
  sessionId: "cs_test_123",
  url: "https://checkout.stripe.com/c/pay/cs_test_123",
};

/** Each startTopUp call gets its OWN deferred promise, recorded in order. */
function deferredStartTopUp() {
  const calls: {
    resolve: (value: TopUpResponse) => void;
    reject: (cause: unknown) => void;
  }[] = [];
  const startTopUp = vi.fn(
    (_packId: TopUpPackId, _options: TopUpAttemptOptions) =>
      new Promise<TopUpResponse>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  );
  return { startTopUp, calls };
}

// ---------------------------------------------------------------------------
// Pack catalog (the shared ./top-up-packs pin — values pinned against
// @studio/contracts TOP_UP_PACKS in top-up-packs.test.ts)
// ---------------------------------------------------------------------------

describe("TopUpFlow — pack catalog", () => {
  it("defaults to the wire packs credits100/credits500/credits2000 with whole-credit labels", () => {
    render(<TopUpFlow startTopUp={vi.fn()} redirectTo={vi.fn()} />);
    expect(TOP_UP_PACKS).toEqual([
      { packId: "credits100", credits: 100 },
      { packId: "credits500", credits: 500 },
      { packId: "credits2000", credits: 2000 },
    ]);
    for (const pack of TOP_UP_PACKS) {
      expect(screen.getByTestId(`topup-pack-${pack.packId}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("topup-pack-credits2000")).toHaveTextContent("2,000");
    // Prices live in Stripe — never on the wire, never invented here.
    expect(screen.getByTestId("topup-pack-credits100")).toHaveTextContent(
      "Price shown at checkout",
    );
    // Nothing is purchasable before a selection.
    expect(screen.getByTestId("topup-continue")).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// The purchase flow
// ---------------------------------------------------------------------------

describe("TopUpFlow — picker → confirm → POST → redirect", () => {
  it("runs the full flow and redirects to the Checkout session url", async () => {
    const { startTopUp, calls } = deferredStartTopUp();
    const redirectTo = vi.fn();
    render(<TopUpFlow startTopUp={startTopUp} redirectTo={redirectTo} />);

    // Picker: select, confirm copy, POST.
    await USER.click(screen.getByTestId("topup-pack-credits500"));
    expect(screen.getByTestId("topup-pack-credits500")).toHaveAttribute("data-selected", "true");
    await USER.click(screen.getByTestId("topup-continue"));
    expect(screen.getByTestId("topup-confirm-copy")).toHaveTextContent("You’re buying 500 credits");
    await USER.click(screen.getByTestId("topup-confirm"));
    expect(startTopUp).toHaveBeenCalledTimes(1);
    expect(startTopUp).toHaveBeenCalledWith(
      "credits500",
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    const key = startTopUp.mock.calls.at(0)?.[1].idempotencyKey ?? "";
    expect(key.length).toBeGreaterThanOrEqual(8);

    // Busy: everything is locked while the POST is in flight.
    const confirmButton = screen.getByTestId("topup-confirm");
    expect(confirmButton).toBeDisabled();
    expect(confirmButton).toHaveTextContent("Working…");
    expect(screen.getByTestId("topup-pack-credits100")).toBeDisabled();
    await USER.click(confirmButton);
    expect(startTopUp).toHaveBeenCalledTimes(1);

    // Success: redirect to the session url, with a manual fallback link.
    await act(async () => {
      calls.at(0)?.resolve(SESSION);
    });
    expect(redirectTo).toHaveBeenCalledWith(SESSION.url);
    expect(screen.getByTestId("topup-flow")).toHaveAttribute("data-status", "redirecting");
    expect(screen.getByTestId("topup-continue-link")).toHaveAttribute("href", SESSION.url);
  });

  it("generates ONE idempotency key per attempt — a retry uses a fresh key", async () => {
    const { startTopUp, calls } = deferredStartTopUp();
    const redirectTo = vi.fn();
    let n = 0;
    render(
      <TopUpFlow
        startTopUp={startTopUp}
        redirectTo={redirectTo}
        idempotencyKeyFactory={() => `key-${++n}`}
      />,
    );

    await USER.click(screen.getByTestId("topup-pack-credits100"));
    await USER.click(screen.getByTestId("topup-continue"));
    await USER.click(screen.getByTestId("topup-confirm"));
    expect(startTopUp.mock.calls.at(0)?.[1].idempotencyKey).toBe("key-1");

    await act(async () => {
      calls.at(0)?.reject(new Error("Stripe unavailable."));
    });
    expect(screen.getByTestId("topup-error")).toHaveAttribute("role", "alert");

    // Retry: same intent, FRESH key (a duplicate session is never a charge).
    await USER.click(screen.getByTestId("topup-retry"));
    expect(startTopUp).toHaveBeenCalledTimes(2);
    expect(startTopUp.mock.calls.at(1)?.[1].idempotencyKey).toBe("key-2");

    await act(async () => {
      calls.at(1)?.resolve(SESSION);
    });
    expect(redirectTo).toHaveBeenCalledWith(SESSION.url);
  });

  it("shows a bounded inline error with Back + Try again after a failure", async () => {
    const { startTopUp, calls } = deferredStartTopUp();
    render(<TopUpFlow startTopUp={startTopUp} redirectTo={vi.fn()} />);

    await USER.click(screen.getByTestId("topup-pack-credits2000"));
    await USER.click(screen.getByTestId("topup-continue"));
    await USER.click(screen.getByTestId("topup-confirm"));
    await act(async () => {
      calls.at(0)?.reject(new Error("E".repeat(5000)));
    });

    const strip = screen.getByTestId("topup-error");
    expect(strip).toHaveAttribute("role", "alert");
    expect(strip.querySelector("p")?.textContent?.length ?? 0).toBeLessThanOrEqual(200);

    await USER.click(screen.getByTestId("topup-back"));
    expect(screen.getByTestId("topup-flow")).toHaveAttribute("data-status", "picker");
    expect(screen.queryByTestId("topup-error")).not.toBeInTheDocument();
  });

  it("refuses to redirect to a hostile checkout url", async () => {
    const { startTopUp, calls } = deferredStartTopUp();
    const redirectTo = vi.fn();
    render(<TopUpFlow startTopUp={startTopUp} redirectTo={redirectTo} />);

    await USER.click(screen.getByTestId("topup-pack-credits100"));
    await USER.click(screen.getByTestId("topup-continue"));
    await USER.click(screen.getByTestId("topup-confirm"));
    await act(async () => {
      calls.at(0)?.resolve({ sessionId: "cs_evil", url: "javascript:alert(1)" });
    });

    expect(redirectTo).not.toHaveBeenCalled();
    expect(screen.getByTestId("topup-flow")).toHaveAttribute("data-status", "error");
    expect(screen.getByTestId("topup-error")).toHaveTextContent(
      "The checkout link from the server was invalid.",
    );

    // Oversized urls are rejected the same way.
    await USER.click(screen.getByTestId("topup-retry"));
    expect(startTopUp).toHaveBeenCalledTimes(2);
    await act(async () => {
      calls
        .at(1)
        ?.resolve({ sessionId: "cs_big", url: `https://checkout.stripe.com/${"a".repeat(4000)}` });
    });
    expect(redirectTo).not.toHaveBeenCalled();
    expect(screen.getByTestId("topup-flow")).toHaveAttribute("data-status", "error");
  });

  it("renders packs passed from billing state verbatim", () => {
    render(
      <TopUpFlow
        packs={[{ packId: "credits100", credits: 100 }]}
        startTopUp={vi.fn()}
        redirectTo={vi.fn()}
      />,
    );
    expect(screen.getByTestId("topup-pack-credits100")).toBeInTheDocument();
    expect(screen.queryByTestId("topup-pack-credits500")).not.toBeInTheDocument();
  });

  it("honours the page-level busy lock: every control is disabled and inert", async () => {
    const startTopUp = vi.fn();
    render(<TopUpFlow startTopUp={startTopUp} redirectTo={vi.fn()} busy />);
    expect(screen.getByTestId("topup-pack-credits500")).toBeDisabled();
    // Disabled pack buttons never change the selection…
    await USER.click(screen.getByTestId("topup-pack-credits500"));
    expect(screen.getByTestId("topup-pack-credits500")).not.toHaveAttribute("data-selected");
    // …so there is nothing to confirm either.
    expect(screen.getByTestId("topup-continue")).toBeDisabled();
    await USER.click(screen.getByTestId("topup-continue"));
    expect(startTopUp).not.toHaveBeenCalled();
  });
});
