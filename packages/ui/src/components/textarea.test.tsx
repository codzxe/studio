import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Textarea } from "./textarea";

describe("Textarea (§7.2 — min 3 rows, auto-grow in chat)", () => {
  it("defaults to 3 rows and associates its label (never placeholder-only)", () => {
    render(<Textarea id="brief" label="Brief" />);
    const textarea = screen.getByLabelText("Brief");
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea).toHaveAttribute("rows", "3");
  });

  it("allows a custom row count for taller briefs", () => {
    render(<Textarea id="brief" label="Brief" rows={6} />);
    expect(screen.getByLabelText("Brief")).toHaveAttribute("rows", "6");
  });

  it("links helper text via aria-describedby (§12)", () => {
    render(<Textarea id="brief" label="Brief" helperText="One sentence is enough" />);
    const textarea = screen.getByLabelText("Brief");
    const describedBy = textarea.getAttribute("aria-describedby") ?? "";
    expect(describedBy).toBeTruthy();
    expect(screen.getByText("One sentence is enough")).toHaveAttribute("id", describedBy);
  });

  it("errors: aria-invalid, role=alert, danger border (§12)", () => {
    render(<Textarea id="brief" label="Brief" error="Say what to build" />);
    const textarea = screen.getByLabelText("Brief");
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(textarea.className).toContain("border-danger");
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("Say what to build");
    expect((textarea.getAttribute("aria-describedby") ?? "").split(" ")).toContain(
      error.getAttribute("id"),
    );
  });

  it("required marks the control and the label", () => {
    render(<Textarea id="brief" label="Brief" required />);
    expect(screen.getByLabelText(/Brief/)).toHaveAttribute("required");
  });

  it("disabled: not editable, opacity .45 (§7.2)", async () => {
    const user = userEvent.setup();
    render(<Textarea id="brief" label="Brief" disabled />);
    const textarea = screen.getByLabelText("Brief");
    expect(textarea).toBeDisabled();
    expect(textarea.className).toContain("opacity-45");
    await user.type(textarea, "hello");
    expect(textarea).toHaveValue("");
  });

  it("typing works end to end when enabled", async () => {
    const user = userEvent.setup();
    render(<Textarea id="brief" label="Brief" />);
    const textarea = screen.getByLabelText("Brief");
    await user.type(textarea, "A neon title over the city skyline.");
    expect(textarea).toHaveValue("A neon title over the city skyline.");
  });

  it("autoGrow sizes the height to the content (controlled value, §7.2 chat)", () => {
    const view = render(
      <Textarea id="chat" label="Message" autoGrow value="" onChange={() => {}} />,
    );
    const textarea = screen.getByLabelText("Message");
    // autoGrow reserves no scrollbars and switches to content sizing.
    expect(textarea.className).toContain("overflow-hidden");
    // jsdom's scrollHeight is always 0; stub it, then let the value change
    // re-run the height effect and prove it follows the content.
    Object.defineProperty(textarea, "scrollHeight", { value: 42 });
    view.rerender(<Textarea id="chat" label="Message" autoGrow value="a" onChange={() => {}} />);
    expect(textarea).toHaveValue("a");
    expect(textarea.style.height).toBe("42px");
  });
});
