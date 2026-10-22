/**
 * ChatFooter tests (M4-G2) — the §3.5 status line: model label, credit
 * estimate (with the metering tooltip), shortcut hint — one 28px muted line.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatFooter } from "./footer";

afterEach(() => {
  cleanup();
});

describe("ChatFooter", () => {
  it("renders all three segments joined by '·' on one muted line", () => {
    render(
      <ChatFooter modelLabel="Smart" creditEstimate="~12 credits" shortcutHint="⌘↵ to send" />,
    );
    const footer = screen.getByTestId("chat-footer");
    expect(screen.getByTestId("chat-footer-model")).toHaveTextContent("Smart");
    expect(screen.getByTestId("chat-footer-credits")).toHaveTextContent("~12 credits");
    expect(screen.getByTestId("chat-footer-shortcut")).toHaveTextContent("⌘↵ to send");
    expect(footer).toHaveTextContent("Smart · ~12 credits · ⌘↵ to send");
    expect(footer.className).toContain("h-7");
    expect(footer.className).toContain("text-muted");
  });

  it("carries the metering tooltip on the credit estimate", () => {
    render(
      <ChatFooter modelLabel="Fast" creditEstimate="~2 credits" shortcutHint="Ctrl+↵ to send" />,
    );
    expect(screen.getByTestId("chat-footer-credits")).toHaveAttribute(
      "title",
      "Estimate; actual usage is metered",
    );
    expect(screen.getByTestId("chat-footer")).toHaveTextContent(
      "Fast · ~2 credits · Ctrl+↵ to send",
    );
  });
});
