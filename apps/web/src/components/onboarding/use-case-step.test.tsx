/**
 * UseCaseStep tests (W2-02) — the §8.3 choice list (motion graphics, title
 * design, social video, product film, other), SKIP semantics, and the honest
 * local-only persistence: `studio.onboarding.usecase.v1` and NOTHING else.
 * Deterministic RTL; no network.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USE_CASE_STORAGE_KEY, UseCaseStep } from "./use-case-step";

const USER = userEvent.setup();

const CHOICES = [
  { id: "motion-graphics", label: "Motion graphics" },
  { id: "title-design", label: "Title design" },
  { id: "social-video", label: "Social video" },
  { id: "product-film", label: "Product film" },
  { id: "other", label: "Other" },
] as const;

beforeEach(() => {
  localStorage.clear();
});

describe("UseCaseStep", () => {
  it("offers the five §8.3 choices, none selected, Continue disabled until one is", async () => {
    const onNext = vi.fn();
    render(<UseCaseStep onNext={onNext} />);

    for (const choice of CHOICES) {
      const button = screen.getByTestId(`onboarding-usecase-${choice.id}`);
      expect(button).toHaveTextContent(choice.label);
      expect(button).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    await USER.click(screen.getByTestId("onboarding-usecase-social-video"));
    expect(screen.getByTestId("onboarding-usecase-social-video")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("continuing persists the choice to localStorage ONLY — no backend field, no fake write", async () => {
    const onNext = vi.fn();
    render(<UseCaseStep onNext={onNext} />);

    await USER.click(screen.getByTestId("onboarding-usecase-title-design"));
    await USER.click(screen.getByRole("button", { name: "Continue" }));

    expect(onNext).toHaveBeenCalledWith("title-design");
    expect(localStorage.getItem(USE_CASE_STORAGE_KEY)).toBe("title-design");
    // The storage key is the ONLY thing written — nothing else leaks in.
    expect(localStorage.length).toBe(1);
  });

  it("skip is allowed: it advances without persisting anything", async () => {
    const onNext = vi.fn();
    render(<UseCaseStep onNext={onNext} />);

    await USER.click(screen.getByTestId("onboarding-usecase-skip"));

    expect(onNext).toHaveBeenCalledWith(null);
    expect(localStorage.getItem(USE_CASE_STORAGE_KEY)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("selecting and then skipping still persists nothing", async () => {
    const onNext = vi.fn();
    render(<UseCaseStep onNext={onNext} />);

    await USER.click(screen.getByTestId("onboarding-usecase-other"));
    await USER.click(screen.getByTestId("onboarding-usecase-skip"));

    expect(onNext).toHaveBeenCalledWith(null);
    expect(localStorage.getItem(USE_CASE_STORAGE_KEY)).toBeNull();
  });
});
