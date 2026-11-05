/**
 * StudioMessageToolbar tests — the assistant-row hover toolbar: hidden until
 * the parent row's group hover/focus state, clipboard copy with the "Copied"
 * confirmation (1.6s, fake timers), host-wired Download forwarding the raw
 * text, the `run:…{last 6}` chip (informational, never a button) and the
 * minimal no-optional-props mount. Deterministic; no network; jsdom.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StudioMessageToolbar } from "./studio-message-toolbar";

/** Stub navigator.clipboard (jsdom ships none) and hand back the write spy. */
function stubClipboard(): ReturnType<typeof vi.fn<(text: string) => Promise<void>>> {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("StudioMessageToolbar — visibility", () => {
  it("renders hidden until the parent row's group hover/focus state", () => {
    render(<StudioMessageToolbar text="Hello horizon" />);
    const toolbar = screen.getByTestId("studio-message-toolbar");
    expect(toolbar.className).toContain("opacity-0");
    expect(toolbar.className).toContain("group-hover:opacity-100");
    expect(toolbar.className).toContain("focus-within:opacity-100");
  });
});

describe("StudioMessageToolbar — copy", () => {
  it("writes the text to navigator.clipboard and flips data-copied for 1.6s", async () => {
    vi.useFakeTimers();
    const writeText = stubClipboard();

    render(<StudioMessageToolbar text="Render the horizon" />);
    const button = screen.getByTestId("studio-message-copy");
    expect(button).toHaveAttribute("aria-label", "Copy message");
    expect(button).toHaveAttribute("data-copied", "false");

    fireEvent.click(button);
    // Flush the clipboard promise chain (microtasks under fake timers).
    await act(async () => {});

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("Render the horizon");
    expect(button).toHaveAttribute("aria-label", "Copied");
    expect(button).toHaveAttribute("data-copied", "true");

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(button).toHaveAttribute("aria-label", "Copy message");
    expect(button).toHaveAttribute("data-copied", "false");
  });
});

describe("StudioMessageToolbar — download", () => {
  it("forwards the message text to the host's onExportOne", async () => {
    const user = userEvent.setup();
    const onExportOne = vi.fn();
    render(<StudioMessageToolbar text="Export me" onExportOne={onExportOne} />);

    const button = screen.getByTestId("studio-message-download");
    expect(button).toHaveAttribute("aria-label", "Download message");
    await user.click(button);
    expect(onExportOne).toHaveBeenCalledTimes(1);
    expect(onExportOne).toHaveBeenCalledWith("Export me");
  });
});

describe("StudioMessageToolbar — run chip", () => {
  it("renders the last-6 run suffix with the full id as tooltip — not a button", () => {
    render(<StudioMessageToolbar text="Hello horizon" runId="run_8f3ac91bd24e" />);
    const chip = screen.getByTestId("studio-message-run-chip");
    expect(chip).toHaveTextContent("run:…1bd24e");
    expect(chip).toHaveAttribute("title", "run_8f3ac91bd24e");
    expect(chip.tagName).not.toBe("BUTTON");
    expect(chip.getAttribute("role")).toBeNull();
  });
});

describe("StudioMessageToolbar — minimal mount", () => {
  it("renders without the optional props — copy only, no dead affordances", () => {
    render(<StudioMessageToolbar text="Just text" />);
    expect(screen.getByTestId("studio-message-copy")).toBeInTheDocument();
    expect(screen.queryByTestId("studio-message-download")).not.toBeInTheDocument();
    expect(screen.queryByTestId("studio-message-run-chip")).not.toBeInTheDocument();
    // Copy stays safe to click even with the legacy clipboard fallback.
    expect(() => fireEvent.click(screen.getByTestId("studio-message-copy"))).not.toThrow();
  });
});
