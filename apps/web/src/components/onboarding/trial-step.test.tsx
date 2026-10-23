/**
 * TrialStep tests (W2-02) — the D-4 copy verbatim, the two §8.3 exits, and
 * every typed arm of `POST /v1/billing/trial`: 400 payment-method-required
 * (honest guidance + /w/billing), 403 card-already-trialed, 409
 * workspace-has-history, the bounded fallback, and the success notice with
 * the trial-days count + navigation to /w. Deterministic RTL + fake port;
 * no network.
 */

import { ApiError, type ApiErrorInit } from "@studio/api-client";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type TrialStepProps, TrialStep } from "./trial-step";

const USER = userEvent.setup();

const WORKSPACE = { id: "ws_new", name: "Acme Films", slug: "acme-films" };

/** Pinned clock so the trial-days count is deterministic. */
const NOW_ISO = "2026-10-21T12:00:00.000Z";
/** Exactly 14 days after NOW (the D-4 trial length). */
const TRIAL_END = "2026-11-04T12:00:00.000Z";

/** A typed §7.3 failure exactly as the api-client materializes it. */
function apiError(init: ApiErrorInit): ApiError {
  return new ApiError(init);
}

function renderStep(overrides: {
  startTrial?: TrialStepProps["startTrial"];
  navigate?: (to: string) => void;
} = {}) {
  const startTrial = overrides.startTrial ?? vi.fn().mockResolvedValue({
    trialStarted: true,
    trialEnd: TRIAL_END,
  });
  const navigate = overrides.navigate ?? vi.fn();
  render(
    <TrialStep
      workspace={WORKSPACE}
      startTrial={startTrial}
      navigate={navigate}
      nowIso={NOW_ISO}
    />,
  );
  return { startTrial, navigate };
}

describe("TrialStep — the Start view (§8.3, D-4)", () => {
  it("states the D-4 trial copy verbatim with one primary action", () => {
    renderStep();

    expect(screen.getByTestId("onboarding-trial-copy")).toHaveTextContent(
      "14 days free, then $29/mo. Card required today. Cancel anytime.",
    );
    expect(screen.getByText("Acme Films")).toBeInTheDocument();
    expect(screen.getByText("/w/acme-films")).toBeInTheDocument();
  });

  it("'Create workspace' exits straight to /w without touching the trial route", async () => {
    const { startTrial, navigate } = renderStep();

    await USER.click(screen.getByTestId("onboarding-trial-skip"));

    expect(startTrial).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/w");
  });
});

describe("TrialStep — typed arms (POST /v1/billing/trial)", () => {
  it("400 payment-method-required → honest inline guidance + a /w/billing link", async () => {
    const { navigate } = renderStep({
      startTrial: vi.fn().mockRejectedValue(
        apiError({
          status: 400,
          code: "VALIDATION_FAILED",
          message: "A payment method is required to start a trial.",
          hint: "Add a card first. The trial starts immediately and is not charged for its duration.",
          requestId: "req_card",
        }),
      ),
    });

    await USER.click(screen.getByRole("button", { name: "Start trial" }));

    const arm = await screen.findByTestId("onboarding-trial-error");
    expect(arm).toHaveAttribute("data-arm", "payment-method");
    expect(arm).toHaveAttribute("role", "alert");
    expect(arm).toHaveTextContent("A payment method is required to start a trial.");
    expect(arm).toHaveTextContent("Add a card in Billing first");
    expect(screen.getByTestId("onboarding-trial-billing-link")).toHaveAttribute(
      "href",
      "/w/billing",
    );
    // No navigation — the user must recover first.
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start trial" })).toBeEnabled();
  });

  it("403 card-already-trialed → one trial per card, billing link offered", async () => {
    renderStep({
      startTrial: vi.fn().mockRejectedValue(
        apiError({
          status: 403,
          code: "FORBIDDEN",
          message: "That payment method already started a trial.",
          hint: "Trials are limited to one per payment method.",
          requestId: "req_card_used",
        }),
      ),
    });

    await USER.click(screen.getByRole("button", { name: "Start trial" }));

    const arm = await screen.findByTestId("onboarding-trial-error");
    expect(arm).toHaveAttribute("data-arm", "card-trialed");
    expect(arm).toHaveTextContent("That payment method already started a trial.");
    expect(screen.getByTestId("onboarding-trial-billing-link")).toHaveAttribute(
      "href",
      "/w/billing",
    );
  });

  it("409 workspace-has-history → one trial per workspace, billing link offered", async () => {
    renderStep({
      startTrial: vi.fn().mockRejectedValue(
        apiError({
          status: 409,
          code: "CONFLICT",
          message: "This workspace already has a billing history.",
          hint: "Trials are limited to one per workspace. Choose a plan instead.",
          requestId: "req_hist",
        }),
      ),
    });

    await USER.click(screen.getByRole("button", { name: "Start trial" }));

    const arm = await screen.findByTestId("onboarding-trial-error");
    expect(arm).toHaveAttribute("data-arm", "workspace-history");
    expect(arm).toHaveTextContent("This workspace already has a billing history.");
    expect(screen.getByTestId("onboarding-trial-billing-link")).toHaveAttribute(
      "href",
      "/w/billing",
    );
  });

  it("any other failure → the bounded §7.3 fallback (message + hint + request id)", async () => {
    renderStep({
      startTrial: vi.fn().mockRejectedValue(
        apiError({
          status: 503,
          code: "SERVICE_UNAVAILABLE",
          message: "The database is not reachable right now.",
          hint: "Try again once the database is up.",
          requestId: "req_down",
        }),
      ),
    });

    await USER.click(screen.getByRole("button", { name: "Start trial" }));

    const arm = await screen.findByTestId("onboarding-trial-error");
    expect(arm).toHaveAttribute("data-arm", "unavailable");
    expect(arm).toHaveTextContent("The database is not reachable right now.");
    expect(arm).toHaveTextContent("Try again once the database is up.");
    expect(arm).toHaveTextContent("Request req_down");
    expect(screen.queryByTestId("onboarding-trial-billing-link")).not.toBeInTheDocument();
  });

  it("success → the trial-days notice, then /w", async () => {
    const { navigate } = renderStep();

    await USER.click(screen.getByRole("button", { name: "Start trial" }));

    const started = await screen.findByTestId("onboarding-trial-started");
    expect(started).toHaveAttribute("data-status", "started");
    expect(started).toHaveTextContent("Trial started.");
    // Exactly 14 days from the pinned clock, §14 date style.
    expect(started).toHaveTextContent("14 days free, until Nov 4, 2026.");
    expect(navigate).toHaveBeenCalledWith("/w");
    // A manual fallback exists while the navigation settles.
    expect(screen.getByTestId("onboarding-trial-continue")).toHaveAttribute("href", "/w");
  });

  it("locks the Start button while the trial request is in flight", async () => {
    let resolveTrial: (value: { trialStarted: true; trialEnd: string }) => void = () => {};
    const startTrial = vi.fn(
      () =>
        new Promise<{ trialStarted: true; trialEnd: string }>((resolve) => {
          resolveTrial = resolve;
        }),
    );
    renderStep({ startTrial });

    const button = screen.getByRole("button", { name: "Start trial" });
    await USER.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByTestId("button-loading")).toBeInTheDocument();

    resolveTrial({ trialStarted: true, trialEnd: TRIAL_END });
    await screen.findByTestId("onboarding-trial-started");
  });
});
