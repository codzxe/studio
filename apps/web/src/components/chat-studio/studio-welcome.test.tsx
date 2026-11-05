/**
 * StudioWelcome tests (the chat-first hero) — the eyebrow, the FIXED display
 * headline with its signal-italic accent word, the sub copy, the composer
 * pass-through (`children`, sandwiched between sub copy and suggestions),
 * the suggestion grid's pick gesture (reports the passed suffix, not the
 * composite testid) and the Recent chip row's max-3 cap, open gesture and
 * empty-state hiding. Deterministic; no network; jsdom.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { StudioWelcome, type StudioWelcomeProps } from "./studio-welcome";

const base = (): StudioWelcomeProps => ({
  projectName: "Pause",
  suggestions: [
    {
      icon: <span>✂</span>,
      title: "Product cut",
      detail: "A 15s launch film from a single prompt",
      testid: "product-cut",
    },
    { title: "Logo loop", detail: "A seamless 4s identity loop", testid: "logo-loop" },
    { title: "Type-on-title", detail: "Kinetic type that lands on the beat", testid: "type-title" },
    {
      title: "Texture pass",
      detail: "Grain, glow and chroma on the last shot",
      testid: "texture-pass",
    },
  ],
  onPickSuggestion: vi.fn(),
  recentThreads: [],
  onOpenThread: vi.fn(),
});

const fiveThreads = [
  { id: "t1", title: "Launch film" },
  { id: "t2", title: "Logo loop" },
  { id: "t3", title: "Old draft" },
  { id: "t4", title: "Ancient" },
  { id: "t5", title: "Texture study" },
] as const;

describe("StudioWelcome — hero copy", () => {
  it("renders the eyebrow, the fixed display headline and the sub copy", () => {
    render(<StudioWelcome {...base()} />);

    const eyebrow = screen.getByTestId("studio-welcome-eyebrow");
    expect(eyebrow.textContent).toContain("STUDIO — PAUSE");
    expect(eyebrow.className).toContain("text-hint");
    expect(eyebrow.className).toContain("tracking-wide");

    const headline = screen.getByRole("heading", { level: 1 });
    expect(headline).toHaveTextContent("What are we making?");
    expect(headline.className).toContain("font-display");
    expect(headline.className).toContain("text-display-xl");
    const accent = within(headline).getByText("making");
    expect(accent.tagName).toBe("EM");
    expect(accent.className).toContain("italic");
    expect(accent.className).toContain("text-signal");

    expect(screen.getByText(/builds every layer, keyframe and effect/)).toBeInTheDocument();
    expect(screen.getByText(/stays out of sight/)).toBeInTheDocument();

    const root = screen.getByTestId("studio-welcome");
    expect(root.className).toContain("justify-center");
  });

  it("renders the composer stack through children, sandwiched in the middle", () => {
    render(
      <StudioWelcome {...base()}>
        <div data-testid="composer">composer</div>
      </StudioWelcome>,
    );

    const composer = screen.getByTestId("composer");
    expect(composer).toBeInTheDocument();
    const subCopy = screen.getByText(/stays out of sight/);
    const grid = screen.getByTestId("studio-welcome-suggestion-product-cut").parentElement;
    expect(composer.previousElementSibling).toBe(subCopy);
    expect(composer.nextElementSibling).toBe(grid);
  });
});

describe("StudioWelcome — suggestions", () => {
  it("renders one card per suggestion under the composite testid", () => {
    render(<StudioWelcome {...base()} />);
    const card = screen.getByTestId("studio-welcome-suggestion-product-cut");
    expect(card).toHaveTextContent("Product cut");
    expect(card).toHaveTextContent("A 15s launch film from a single prompt");
    expect(screen.getByTestId("studio-welcome-suggestion-logo-loop")).toBeInTheDocument();
    expect(screen.getByTestId("studio-welcome-suggestion-type-title")).toBeInTheDocument();
    expect(screen.getByTestId("studio-welcome-suggestion-texture-pass")).toBeInTheDocument();
  });

  it("picking a card reports the suggestion's own testid suffix", async () => {
    const user = userEvent.setup();
    const onPickSuggestion = vi.fn();
    render(<StudioWelcome {...base()} onPickSuggestion={onPickSuggestion} />);

    await user.click(screen.getByTestId("studio-welcome-suggestion-logo-loop"));
    expect(onPickSuggestion).toHaveBeenCalledOnce();
    expect(onPickSuggestion).toHaveBeenCalledWith("logo-loop");
  });

  it("gives the optional icon slot the signal accent (and none without an icon)", () => {
    render(<StudioWelcome {...base()} />);

    const withIcon = screen.getByTestId("studio-welcome-suggestion-product-cut");
    expect(withIcon.textContent).toContain("✂");
    const slot = withIcon.querySelector("[aria-hidden='true']");
    expect(slot?.className).toContain("text-signal");

    const bare = screen.getByTestId("studio-welcome-suggestion-logo-loop");
    expect(bare.querySelector("[aria-hidden='true']")).toBeNull();
  });
});

describe("StudioWelcome — recent threads", () => {
  it("shows at most three chips and opens the clicked thread", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    render(<StudioWelcome {...base()} recentThreads={fiveThreads} onOpenThread={onOpenThread} />);

    const row = screen.getByTestId("studio-welcome-recent");
    const chips = within(row).getAllByTestId("studio-welcome-recent-chip");
    expect(chips).toHaveLength(3);
    expect(chips.map((chip) => chip.getAttribute("data-thread-id"))).toEqual(["t1", "t2", "t3"]);

    await user.click(within(row).getByText("Logo loop"));
    expect(onOpenThread).toHaveBeenCalledOnce();
    expect(onOpenThread).toHaveBeenCalledWith("t2");
  });

  it("hides the Recent row while the project has no threads", () => {
    render(<StudioWelcome {...base()} recentThreads={[]} />);
    expect(screen.queryByTestId("studio-welcome-recent")).not.toBeInTheDocument();
  });
});
