/**
 * ChatBanner + RunPausedBanner tests (M4-F) — kinds, chrome, action/dismiss
 * wiring, and the §8.4 pause copy. Deterministic; no network; jsdom.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatBanner, type ChatBannerProps } from "./banners";

const KINDS = ["info", "warning", "error", "success"] as const;

describe("ChatBanner", () => {
  it.each(KINDS)("kind %s renders data-kind, an icon and the message (never colour-only)", (kind) => {
    render(<ChatBanner kind={kind} message="Something happened." />);
    const banner = screen.getByTestId("chat-banner");
    expect(banner).toHaveAttribute("data-kind", kind);
    expect(banner).toHaveTextContent("Something happened.");
    // The status icon is always present alongside the tone.
    expect(banner.querySelector("svg")).not.toBeNull();
  });

  it("maps each kind to its documented tone (info neutral, warning amber, error red, success green)", () => {
    const tones: Record<(typeof KINDS)[number], string> = {
      info: "border-border",
      warning: "border-warning/40",
      error: "border-danger/40",
      success: "border-success/40",
    };
    for (const kind of KINDS) {
      const { unmount } = render(<ChatBanner kind={kind} message="m" />);
      expect(screen.getByTestId("chat-banner").className).toContain(tones[kind]);
      unmount();
    }
  });

  it("announces errors as role=alert and the rest as role=status", () => {
    const { unmount } = render(<ChatBanner kind="error" message="m" />);
    expect(screen.getByTestId("chat-banner")).toHaveAttribute("role", "alert");
    unmount();
    const { unmount: unmount2 } = render(<ChatBanner kind="info" message="m" />);
    expect(screen.getByTestId("chat-banner")).toHaveAttribute("role", "status");
    unmount2();
  });

  it("renders the action button only when both label and handler exist, and wires it", () => {
    const onAction = vi.fn();
    const { rerender } = render(
      <ChatBanner kind="success" message="Saved." actionLabel="View" onAction={onAction} />,
    );
    fireEvent.click(screen.getByTestId("chat-banner-action"));
    expect(onAction).toHaveBeenCalledTimes(1);

    rerender(<ChatBanner kind="success" message="Saved." actionLabel="View" />);
    expect(screen.queryByTestId("chat-banner-action")).not.toBeInTheDocument();

    rerender(<ChatBanner kind="success" message="Saved." onAction={onAction} />);
    expect(screen.queryByTestId("chat-banner-action")).not.toBeInTheDocument();
  });

  it("renders the dismiss control only when onDismiss exists, and wires it", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <ChatBanner kind="warning" message="Switched to a backup model." onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByTestId("chat-banner-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    rerender(<ChatBanner kind="warning" message="Switched to a backup model." />);
    expect(screen.queryByTestId("chat-banner-dismiss")).not.toBeInTheDocument();
  });

  it("satisfies the pinned ChatBannerProps shape at compile time", () => {
    const props: ChatBannerProps = { kind: "info", message: "m" };
    expect(props.kind).toBe("info");
  });
});

describe("RunPausedBanner", () => {
  it("shows the §8.4 pause copy as a warning banner with Retry wired to onRetry", () => {
    const onRetry = vi.fn();
    render(<RunPausedBanner onRetry={onRetry} />);

    const banner = screen.getByTestId("chat-banner-run-paused");
    expect(banner).toHaveTextContent("Run paused. Check your connection.");
    const inner = banner.querySelector('[data-kind="warning"]');
    expect(inner).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("carries the exact RUN_PAUSED_ERROR message from the chat engine", async () => {
    const { RUN_PAUSED_ERROR } = await import("@/lib/chat/run-state");
    render(<RunPausedBanner onRetry={() => {}} />);
    expect(screen.getByTestId("chat-banner-run-paused")).toHaveTextContent(RUN_PAUSED_ERROR.message);
  });
});
