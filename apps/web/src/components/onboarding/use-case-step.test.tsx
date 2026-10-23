/**
 * UseCaseStep tests (W2-02; W5-03 honesty pass) — the §8.3 choice list
 * (motion graphics, title design, social video, product film, other), SKIP
 * semantics, and the honest NO-persistence contract: the orphaned
 * `studio.onboarding.usecase.v1` localStorage write is GONE (nothing ever
 * read it), so advancing — pick or skip — writes NOTHING anywhere.
 * Deterministic RTL; no network.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UseCaseStep } from "./use-case-step";

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

  it("the copy claims no effect: the pick changes nothing today", () => {
    render(<UseCaseStep onNext={vi.fn()} />);
    expect(
      screen.getByText("Optional — it changes nothing today. Skip it if you'd rather jump straight in."),
    ).toBeInTheDocument();
  });

  it("continuing advances with the choice and persists NOTHING (the orphaned key is dead)", async () => {
    const onNext = vi.fn();
    render(<UseCaseStep onNext={onNext} />);

    await USER.click(screen.getByTestId("onboarding-usecase-title-design"));
    await USER.click(screen.getByRole("button", { name: "Continue" }));

    expect(onNext).toHaveBeenCalledWith("title-design");
    // W5-03: `studio.onboarding.usecase.v1` had no consumer — nothing is
    // written, and no other key leaks in either.
    expect(localStorage.length).toBe(0);
  });

  it("skip is allowed: it advances without persisting anything", async () => {
    const onNext = vi.fn();
    render(<UseCaseStep onNext={onNext} />);

    await USER.click(screen.getByTestId("onboarding-usecase-skip"));

    expect(onNext).toHaveBeenCalledWith(null);
    expect(localStorage.length).toBe(0);
  });

  it("selecting and then skipping still persists nothing", async () => {
    const onNext = vi.fn();
    render(<UseCaseStep onNext={onNext} />);

    await USER.click(screen.getByTestId("onboarding-usecase-other"));
    await USER.click(screen.getByTestId("onboarding-usecase-skip"));

    expect(onNext).toHaveBeenCalledWith(null);
    expect(localStorage.length).toBe(0);
  });
});
