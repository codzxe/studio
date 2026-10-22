/**
 * ToolCard tests (M4-F) — friendly names, collapsed/expand, status marks,
 * failure-message extraction, result preview truncation, clipboard + fallback,
 * and the render_preview image rule. Deterministic; no network; jsdom.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCardState } from "@/lib/chat/types";
import { TOOL_CARD_LABELS, ToolCard } from "./tool-card";

function card(overrides: Partial<ToolCardState> = {}): ToolCardState {
  return { toolCallId: "tc_1", name: "studio.get_context", status: "done", ...overrides };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
});

describe("ToolCard — labels", () => {
  it("maps every registered tool to its friendly name", () => {
    expect(TOOL_CARD_LABELS["studio.get_context"]).toBe("Inspect project");
    expect(TOOL_CARD_LABELS["studio.list_layers"]).toBe("List layers");
    expect(TOOL_CARD_LABELS["studio.get_properties"]).toBe("Read properties");
    expect(TOOL_CARD_LABELS["studio.plan_edit"]).toBe("Plan edit");
    expect(TOOL_CARD_LABELS["studio.render_preview"]).toBe("Render preview");
  });

  it("renders the friendly name; unknown ids fall back to the raw name", () => {
    const first = render(<ToolCard card={card()} />);
    expect(screen.getByText("Inspect project")).toBeInTheDocument();
    first.unmount();

    const second = render(<ToolCard card={card({ name: "studio.unknown_tool" })} />);
    expect(screen.getByText("studio.unknown_tool")).toBeInTheDocument();
    second.unmount();

    render(<ToolCard card={card({ name: "" })} />);
    expect(screen.getByText("Tool call")).toBeInTheDocument();
  });
});

describe("ToolCard — collapsed line", () => {
  it("is collapsed by default and expands/collapses via the toggle button", () => {
    render(
      <ToolCard card={card({ args: { include: ["projectSummary"] }, result: { comps: 3 } })} />,
    );
    const toggle = screen.getByTestId("tool-card-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("tool-card-details")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("tool-card-details")).toBeInTheDocument();
    expect(screen.getByTestId("tool-card-args")).toBeInTheDocument();
    expect(screen.getByTestId("tool-card-result")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tool-card-toggle"));
    expect(screen.queryByTestId("tool-card-details")).not.toBeInTheDocument();
  });

  it("shows an 80-char-capped result summary on the collapsed line", () => {
    const long = "x".repeat(120);
    render(<ToolCard card={card({ result: { note: long } })} />);
    const summary = screen.getByTestId("tool-card-summary");
    expect(summary.textContent).toHaveLength(81); // 80 chars + ellipsis
    expect(summary.textContent?.endsWith("…")).toBe(true);
    expect(summary.textContent?.startsWith('{"note":"xxxx')).toBe(true);
  });

  it("shows the full short result as the summary when under the cap", () => {
    render(<ToolCard card={card({ result: { projectSummary: { comps: 3 } } })} />);
    expect(screen.getByTestId("tool-card-summary").textContent).toBe(
      '{"projectSummary":{"comps":3}}',
    );
  });

  it("shows no summary slot when there is no result yet", () => {
    render(<ToolCard card={card({ status: "running", result: undefined })} />);
    expect(screen.queryByTestId("tool-card-summary")).not.toBeInTheDocument();
  });
});

describe("ToolCard — status marks", () => {
  it("running and queued show a spinner and dim the card", () => {
    const first = render(<ToolCard card={card({ status: "running" })} />);
    expect(screen.getByTestId("tool-card").className).toContain("opacity-75");
    expect(screen.getByTestId("tool-card").querySelector("output[aria-label]")).not.toBeNull();
    first.unmount();

    render(<ToolCard card={card({ status: "queued" })} />);
    expect(screen.getByTestId("tool-card").className).toContain("opacity-75");
    expect(screen.getByTestId("tool-card").querySelector("output[aria-label]")).not.toBeNull();
  });

  it("done shows ✓ and failed shows ! plus the extracted human message", () => {
    const first = render(
      <ToolCard card={card({ status: "done", result: { ok: true } })} />,
    );
    expect(screen.getByTestId("tool-card-status-mark")).toHaveTextContent("✓");
    first.unmount();

    render(
      <ToolCard
        card={card({
          status: "failed",
          result: { error: "TOOL_FAILED", message: "The editor did not respond." },
        })}
      />,
    );
    expect(screen.getByTestId("tool-card-status-mark")).toHaveTextContent("!");
    expect(screen.getByTestId("tool-card-summary").textContent).toBe(
      "The editor did not respond.",
    );
  });

  it("falls back to the error code when the failure shape carries no message", () => {
    render(
      <ToolCard card={card({ status: "failed", result: { error: "EDITOR_DISCONNECTED" } })} />,
    );
    expect(screen.getByTestId("tool-card-summary").textContent).toBe("EDITOR_DISCONNECTED");
  });
});

describe("ToolCard — copy", () => {
  const payloadArgs = { include: ["projectSummary"] };
  const payloadResult = { projectSummary: { comps: 3 } };

  it("copies args + result via navigator.clipboard and flips to Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<ToolCard card={card({ args: payloadArgs, result: payloadResult })} />);
    fireEvent.click(screen.getByTestId("tool-card-toggle"));
    fireEvent.click(screen.getByTestId("tool-card-copy"));
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify(
        { name: "studio.get_context", args: payloadArgs, result: payloadResult },
        null,
        2,
      ),
    );
    await waitFor(() => expect(screen.getByTestId("tool-card-copy")).toHaveTextContent("Copied"));
  });

  it("falls back to the legacy textarea path when clipboard is unavailable", () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    render(<ToolCard card={card({ args: payloadArgs, result: payloadResult })} />);
    fireEvent.click(screen.getByTestId("tool-card-toggle"));
    fireEvent.click(screen.getByTestId("tool-card-copy"));
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(screen.getByTestId("tool-card-copy")).toHaveTextContent("Copied");
  });

  it("stays on Copy when every write path fails", () => {
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    render(<ToolCard card={card({ args: payloadArgs, result: payloadResult })} />);
    fireEvent.click(screen.getByTestId("tool-card-toggle"));
    fireEvent.click(screen.getByTestId("tool-card-copy"));
    expect(screen.getByTestId("tool-card-copy")).toHaveTextContent("Copy");
  });
});

describe("ToolCard — render_preview image rule", () => {
  it("renders pngBase64 as an <img> data: URL, never as base64 text", () => {
    const png = "aGVsbG8=";
    render(
      <ToolCard
        card={card({
          name: "studio.render_preview",
          args: { comp: "Main", time: 1.5 },
          result: { comp: "Main", time: 1.5, width: 800, height: 450, pngBase64: png },
        })}
      />,
    );
    // The collapsed summary never prints the blob.
    expect(screen.getByTestId("tool-card-summary").textContent).not.toContain(png);
    expect(screen.getByTestId("tool-card-summary").textContent).toContain("PNG");

    fireEvent.click(screen.getByTestId("tool-card-toggle"));
    const image = screen.getByTestId("tool-card-image");
    expect(image).toHaveAttribute("src", `data:image/png;base64,${png}`);
    expect(image).toHaveAttribute("alt", "Rendered preview");
    // The mono result block shows the size marker, not the base64.
    expect(screen.getByTestId("tool-card-result").textContent).not.toContain(png);
    expect(screen.getByTestId("tool-card-result").textContent).toContain("PNG");
  });
});
