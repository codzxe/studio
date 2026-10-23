/**
 * OnboardingFlow tests (W2-02) — §8.3 sequencing over ONE Card: the
 * 3-segment progress LINE (not numbered circles), step 1 → 2 → 3 via the
 * injected port (workspace create → use case → trial start), and the
 * terminal navigation to /w. Deterministic RTL + fake ports; no network.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlow, type OnboardingPort } from "./onboarding-flow";

const USER = userEvent.setup();

const WORKSPACE = {
  id: "ws_new",
  name: "Acme Films",
  slug: "acme-films",
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
};

const TRIAL_END = new Date(Date.now() + 14 * 86_400_000).toISOString();

function fakePort(overrides: Partial<OnboardingPort> = {}): OnboardingPort {
  return {
    createWorkspace: vi.fn().mockResolvedValue(WORKSPACE),
    startTrial: vi.fn().mockResolvedValue({ trialStarted: true, trialEnd: TRIAL_END }),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

/** Drives the flow from step 1 to the Start step with a chosen use case. */
async function advanceToStart(
  port: OnboardingPort,
  useCase: string | null,
  navigate: (to: string) => void,
) {
  render(<OnboardingFlow api={port} navigate={navigate} />);

  await USER.type(screen.getByLabelText(/^Workspace name/), "Acme Films!");
  await USER.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByTestId("onboarding-usecase")).toBeInTheDocument();

  if (useCase !== null) {
    await USER.click(screen.getByTestId(`onboarding-usecase-${useCase}`));
    await USER.click(screen.getByRole("button", { name: "Continue" }));
  } else {
    await USER.click(screen.getByTestId("onboarding-usecase-skip"));
  }
  return screen.findByTestId("onboarding-trial");
}

describe("OnboardingFlow — the §8.3 shell", () => {
  it("renders ONE card with a 3-segment line (no numbered circles) starting on Workspace", () => {
    render(<OnboardingFlow api={fakePort()} navigate={vi.fn()} />);

    expect(screen.getByTestId("onboarding-card")).toBeInTheDocument();
    // Exactly three segments, first current, the rest todo.
    expect(screen.getByTestId("onboarding-segment-1")).toHaveAttribute("data-state", "current");
    expect(screen.getByTestId("onboarding-segment-2")).toHaveAttribute("data-state", "todo");
    expect(screen.getByTestId("onboarding-segment-3")).toHaveAttribute("data-state", "todo");
    expect(screen.getAllByTestId(/^onboarding-segment-/)).toHaveLength(3);
    // Labels are words, never numbers.
    for (const label of ["Workspace", "Use case", "Start"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Step 1 content is mounted (the slug seam is wired live).
    expect(screen.getByLabelText(/^Slug/)).toHaveValue("");
  });

  it("sequences Workspace → Use case → Start, marking segments done as steps complete", async () => {
    const port = fakePort();
    render(<OnboardingFlow api={port} navigate={vi.fn()} />);

    // Step 1: the slug derives live from the name (slug.ts finally wired).
    await USER.type(screen.getByLabelText(/^Workspace name/), "Acme Films!");
    expect(screen.getByLabelText(/^Slug/)).toHaveValue("acme-films");

    await USER.click(screen.getByRole("button", { name: "Continue" }));
    expect(port.createWorkspace).toHaveBeenCalledWith({ name: "Acme Films!", slug: "acme-films" });

    // Step 2: use case — segment 1 done, segment 2 current.
    expect(await screen.findByTestId("onboarding-usecase")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-segment-1")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("onboarding-segment-2")).toHaveAttribute("data-state", "current");
    expect(screen.getByTestId("onboarding-segment-3")).toHaveAttribute("data-state", "todo");

    await USER.click(screen.getByTestId("onboarding-usecase-motion-graphics"));
    await USER.click(screen.getByRole("button", { name: "Continue" }));
    expect(localStorage.getItem("studio.onboarding.usecase.v1")).toBe("motion-graphics");

    // Step 3: Start — segments 1+2 done, segment 3 current, still ONE card.
    expect(await screen.findByTestId("onboarding-trial")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-segment-1")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("onboarding-segment-2")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("onboarding-segment-3")).toHaveAttribute("data-state", "current");
    expect(screen.getAllByTestId("onboarding-card")).toHaveLength(1);
  });

  it("keeps the flow on step 2 (no premature Start) when the workspace create rejects", async () => {
    const port = fakePort({
      createWorkspace: vi.fn().mockRejectedValue(new Error("offline")),
    });
    render(<OnboardingFlow api={port} navigate={vi.fn()} />);

    await USER.type(screen.getByLabelText(/^Workspace name/), "Acme Films!");
    await USER.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByTestId("onboarding-workspace-error")).toBeInTheDocument();
    expect(screen.queryByTestId("onboarding-usecase")).not.toBeInTheDocument();
    expect(screen.getByTestId("onboarding-segment-1")).toHaveAttribute("data-state", "current");
  });

  it("runs the trial start on the created workspace and lands on /w with the trial notice", async () => {
    const port = fakePort();
    const navigate = vi.fn();
    await advanceToStart(port, "product-film", navigate);

    await USER.click(screen.getByRole("button", { name: "Start trial" }));

    expect(vi.mocked(port.startTrial)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(port.startTrial).mock.calls[0]?.[0]).toBe("ws_new");
    const started = await screen.findByTestId("onboarding-trial-started");
    expect(started).toHaveAttribute("data-status", "started");
    expect(started).toHaveTextContent(/days free, until /);
    expect(navigate).toHaveBeenCalledWith("/w");
  });

  it("exits to /w without starting a trial when 'Create workspace' is chosen", async () => {
    const port = fakePort();
    const navigate = vi.fn();
    await advanceToStart(port, null, navigate);

    await USER.click(screen.getByTestId("onboarding-trial-skip"));

    expect(port.startTrial).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/w");
  });
});
