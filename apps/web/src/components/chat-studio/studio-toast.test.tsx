/**
 * StudioToast tests — the window-event toast system (fire-anywhere → host
 * renders). Pins the wire contract (STUDIO_TOAST_EVENT + detail shape), the
 * 3-toast keep-latest cap, the 3000ms per-toast auto-dismiss, manual ✕
 * dismissal, the tone→token mapping (real theme.css tokens) and unmount
 * cleanup. jsdom; fake timers for the lifecycle suite, act() around every
 * window-event fire (the host's listener calls setState outside React).
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STUDIO_TOAST_EVENT,
  type StudioToastDetail,
  StudioToastHost,
  type StudioToastTone,
  fireStudioToast,
} from "./studio-toast";

/** Fire through the public API inside act (the host updates state on event). */
function fireToast(message: string, tone: StudioToastTone = "info"): void {
  act(() => {
    fireStudioToast(message, tone);
  });
}

describe("StudioToast — wire contract + render", () => {
  it("dispatches studio:chat-toast with an incrementing id, message and tone", () => {
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(STUDIO_TOAST_EVENT, listener);
    try {
      expect(STUDIO_TOAST_EVENT).toBe("studio:chat-toast");
      fireStudioToast("Saved", "success");
      fireStudioToast("Deleted", "danger");
      fireStudioToast("Default tone"); // tone defaults to "info"

      expect(listener).toHaveBeenCalledTimes(3);
      const events = listener.mock.calls.map((call) => call[0] as CustomEvent<StudioToastDetail>);
      const [first, second, third] = events;
      expect(first?.detail.message).toBe("Saved");
      expect(first?.detail.tone).toBe("success");
      expect(second?.detail.tone).toBe("danger");
      expect(third?.detail.tone).toBe("info");
      expect(second?.detail.id).toBe((first?.detail.id ?? 0) + 1);
      expect(third?.detail.id).toBe((second?.detail.id ?? 0) + 1);
    } finally {
      window.removeEventListener(STUDIO_TOAST_EVENT, listener);
    }
  });

  it("renders a fired toast — no prop threading, just the window event", () => {
    render(<StudioToastHost />);
    fireToast("Rendering cut…", "info");

    const toast = screen.getByTestId("studio-toast");
    expect(toast).toHaveTextContent("Rendering cut…");
    expect(toast).toHaveAttribute("data-tone", "info");
    expect(toast).toHaveAttribute("role", "status");
    expect(toast.className).toContain("bg-elevated");
    expect(toast.className).toContain("shadow-pop");
    // The fixed bottom-center stack itself:
    const stack = screen.getByTestId("studio-toast-host");
    expect(stack.className).toContain("bottom-24");
    expect(stack.className).toContain("z-50");
    expect(stack.className).toContain("pointer-events-none");
  });

  it("maps each tone to its real theme.css token classes", () => {
    render(<StudioToastHost />);
    fireToast("Saved", "success");
    fireToast("Deleted", "danger");

    const toasts = screen.getAllByTestId("studio-toast");
    const [success, danger] = toasts;
    expect(success).toHaveAttribute("data-tone", "success");
    expect(success?.className).toContain("border-signal");
    expect(success?.className).toContain("text-primary");
    // --color-danger → var(--danger) IS mapped in theme.css (no fallback needed):
    expect(danger).toHaveAttribute("data-tone", "danger");
    expect(danger?.className).toContain("text-danger");
    expect(danger?.className).toContain("border-danger");
  });

  it("removes a toast via its ✕ dismiss button (before any timer fires)", async () => {
    const user = userEvent.setup();
    render(<StudioToastHost />);
    fireToast("Saved", "success");

    await user.click(screen.getByTestId("studio-toast-dismiss"));
    expect(screen.queryByTestId("studio-toast")).not.toBeInTheDocument();

    // A second toast dismisses via fireEvent too (jsdom event, same handler):
    fireToast("Another");
    fireEvent.click(screen.getByTestId("studio-toast-dismiss"));
    expect(screen.queryByTestId("studio-toast")).not.toBeInTheDocument();
  });
});

describe("StudioToast — lifecycle (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("auto-dismisses each toast after 3000ms on independent timers", () => {
    render(<StudioToastHost />);
    fireToast("first");
    expect(screen.getByTestId("studio-toast")).toBeInTheDocument();

    // Per-toast timing: "first" dies at 3s even while newer toasts live on.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    fireToast("second");
    expect(screen.getAllByTestId("studio-toast")).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.getByText("second")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("first")).not.toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument(); // dies at t=4500

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.getByText("second")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId("studio-toast")).not.toBeInTheDocument();
  });

  it("keeps at most 3 toasts — the 4th drops the oldest (keep-latest)", () => {
    render(<StudioToastHost />);
    fireToast("one");
    fireToast("two");
    fireToast("three");
    fireToast("four");

    const messages = screen.getAllByTestId("studio-toast").map((toast) => toast.textContent);
    expect(messages).toEqual(["two", "three", "four"]);
    expect(screen.queryByText("one")).not.toBeInTheDocument();
  });

  it("cleans up listener + timers on unmount (fire-anywhere stays safe)", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<StudioToastHost />);
    fireToast("Leak check");
    expect(screen.getByTestId("studio-toast")).toBeInTheDocument();

    unmount();
    expect(removeSpy).toHaveBeenCalledWith(STUDIO_TOAST_EVENT, expect.any(Function));
    expect(screen.queryByTestId("studio-toast")).not.toBeInTheDocument();

    // The auto-dismiss timer was cleared with the host — advancing is a no-op.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // Firing while nobody listens must not throw or queue anything:
    expect(() => fireStudioToast("Nobody home")).not.toThrow();
    // A fresh host mounts clean — no resurrection of pre-unmount toasts.
    render(<StudioToastHost />);
    expect(screen.queryByTestId("studio-toast")).not.toBeInTheDocument();
    expect(screen.queryByText("Leak check")).not.toBeInTheDocument();
  });
});
