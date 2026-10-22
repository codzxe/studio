/**
 * ModelPicker tests (M4-G2) — the entitlement-driven picker semantics pinned
 * by the M4-SEAMS Wave-2 contract + addendum item 7 (trial ⇒ exactly
 * [studio-fast]; single-model plans render gracefully). Deterministic RTL
 * against jsdom: the @studio/ui popover is real Radix, driven by user-event;
 * no network, no timers to fake.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ModelsListEntry,
  ModelPicker,
  modelDisplayName,
  modelTierLabel,
} from "./model-picker";

afterEach(() => {
  cleanup();
});

const FAST: ModelsListEntry = {
  id: "studio-fast",
  tier: "fast",
  use: "Cheap planning, classification, quick edits",
  creditsPer1kInput: 0.01,
  creditsPer1kOutput: 0.03,
};

const SMART: ModelsListEntry = {
  id: "studio-smart",
  tier: "smart",
  use: "Main agent, multi-step edits, tool use",
  creditsPer1kInput: 0.1,
  creditsPer1kOutput: 0.4,
};

const TWO_MODELS: readonly ModelsListEntry[] = [FAST, SMART];

async function openPicker(models: readonly ModelsListEntry[] = TWO_MODELS): Promise<void> {
  const user = userEvent.setup();
  render(<ModelPicker models={models} activeModelId={null} onPick={vi.fn()} />);
  await user.click(screen.getByTestId("chat-model-button"));
}

// ---------------------------------------------------------------------------
// Trigger states (entitlement surface lifecycle)
// ---------------------------------------------------------------------------

describe("ModelPicker — trigger", () => {
  it("shows the active model's display name on the compact trigger", () => {
    render(<ModelPicker models={TWO_MODELS} activeModelId="studio-smart" onPick={vi.fn()} />);
    const trigger = screen.getByTestId("chat-model-button");
    expect(trigger).toHaveTextContent("Smart");
    expect(trigger).not.toHaveTextContent("Model…");
    expect(trigger).toBeEnabled();
  });

  it("models===null renders the inert 'Model…' placeholder (surface loading)", () => {
    render(<ModelPicker models={null} activeModelId={null} onPick={vi.fn()} />);
    const trigger = screen.getByTestId("chat-model-button");
    expect(trigger).toHaveTextContent("Model…");
    expect(trigger).toBeDisabled();
  });

  it("models===[] hides the picker entirely (surface empty/failed)", () => {
    const { container } = render(<ModelPicker models={[]} activeModelId={null} onPick={vi.fn()} />);
    expect(screen.queryByTestId("chat-model-button")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("activeModelId outside the entitled list falls back to 'Model…'", () => {
    render(<ModelPicker models={[FAST]} activeModelId="studio-vision" onPick={vi.fn()} />);
    expect(screen.getByTestId("chat-model-button")).toHaveTextContent("Model…");
  });
});

// ---------------------------------------------------------------------------
// Popover: open, entries, pick, close, active ring
// ---------------------------------------------------------------------------

describe("ModelPicker — popover", () => {
  it("opens on click and lists every entitled model with tier, use and credit rate", async () => {
    await openPicker();
    const popover = screen.getByTestId("chat-model-popover");
    const fast = within(popover).getByTestId("chat-model-option-studio-fast");
    const smart = within(popover).getByTestId("chat-model-option-studio-smart");
    expect(fast).toHaveTextContent("Fast");
    expect(fast).toHaveTextContent(FAST.use);
    expect(fast).toHaveTextContent("≈0.01–0.03 cr /1k tokens");
    expect(smart).toHaveTextContent("Smart");
    expect(smart).toHaveTextContent(SMART.use);
    expect(smart).toHaveTextContent("≈0.1–0.4 cr /1k tokens");
    // Tier tag renders per model (§3.1 "model name, tier and credit rate").
    expect(within(fast).getByTestId("chat-model-tier-studio-fast")).toHaveTextContent("Fast");
    expect(within(smart).getByTestId("chat-model-tier-studio-smart")).toHaveTextContent("Smart");
  });

  it("renders a flat rate when input and output costs match", async () => {
    const flat: ModelsListEntry = {
      id: "studio-flat",
      tier: "fast",
      use: "Flat-rate test model",
      creditsPer1kInput: 1,
      creditsPer1kOutput: 1,
    };
    await openPicker([flat]);
    expect(screen.getByText("≈1 cr /1k tokens")).toBeInTheDocument();
  });

  it("marks the active model's row with the --signal ring only", async () => {
    const user = userEvent.setup();
    render(
      <ModelPicker models={TWO_MODELS} activeModelId="studio-smart" onPick={vi.fn()} />,
    );
    await user.click(screen.getByTestId("chat-model-button"));
    const active = screen.getByTestId("chat-model-option-studio-smart");
    const idle = screen.getByTestId("chat-model-option-studio-fast");
    expect(active).toHaveAttribute("data-active");
    expect(active.className).toContain("ring-signal");
    expect(idle).not.toHaveAttribute("data-active");
    expect(idle.className).not.toContain("ring-signal");
  });

  it("picking a model calls onPick(id) and closes the popover", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<ModelPicker models={TWO_MODELS} activeModelId="studio-smart" onPick={onPick} />);
    await user.click(screen.getByTestId("chat-model-button"));
    await user.click(screen.getByTestId("chat-model-option-studio-fast"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("studio-fast");
    expect(screen.queryByTestId("chat-model-popover")).not.toBeInTheDocument();
  });

  it("closes on Escape without picking", async () => {
    const user = userEvent.setup();
    render(<ModelPicker models={TWO_MODELS} activeModelId={null} onPick={vi.fn()} />);
    await user.click(screen.getByTestId("chat-model-button"));
    expect(screen.getByTestId("chat-model-popover")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("chat-model-popover")).not.toBeInTheDocument();
  });

  it("single-model plan: locked selected row + 'Your plan includes this model', no pick", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<ModelPicker models={[FAST]} activeModelId="studio-fast" onPick={onPick} />);
    await user.click(screen.getByTestId("chat-model-button"));
    const popover = screen.getByTestId("chat-model-popover");
    expect(within(popover).getByTestId("chat-model-locked-note")).toHaveTextContent(
      "Your plan includes this model",
    );
    const option = within(popover).getByTestId("chat-model-option-studio-fast");
    expect(option.className).toContain("ring-signal");
    expect(within(popover).queryAllByRole("button")).toHaveLength(0);
    await user.click(option); // the locked row is not a control — nothing happens
    expect(onPick).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Display-name + tier-label vectors (reused by M4-J's footer)
// ---------------------------------------------------------------------------

describe("modelDisplayName", () => {
  it("maps the three §8.2 studio aliases", () => {
    expect(modelDisplayName("studio-fast")).toBe("Fast");
    expect(modelDisplayName("studio-smart")).toBe("Smart");
    expect(modelDisplayName("studio-vision")).toBe("Vision");
  });

  it("prettifies unknown ids and passes empties through", () => {
    expect(modelDisplayName("gpt-4o-mini")).toBe("Gpt 4o Mini");
    expect(modelDisplayName("my_custom model")).toBe("My Custom Model");
    expect(modelDisplayName("")).toBe("");
  });
});

describe("modelTierLabel", () => {
  it("capitalizes wire tiers and prettifies unknown ones", () => {
    expect(modelTierLabel("fast")).toBe("Fast");
    expect(modelTierLabel("smart")).toBe("Smart");
    expect(modelTierLabel("vision")).toBe("Vision");
    expect(modelTierLabel("experimental")).toBe("Experimental");
  });
});
