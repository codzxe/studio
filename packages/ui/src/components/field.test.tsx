import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./field";

/** Field wires label/helper/error into any control via a render prop. */
function renderField(overrides: Record<string, unknown> = {}) {
  const props = {
    label: "Workspace name",
    helperText: "Lowercase, no spaces",
    ...overrides,
  } as React.ComponentProps<typeof Field>;
  const { container } = render(
    <Field {...props}>{(control) => <input type="text" {...control} />}</Field>,
  );
  return { container };
}

describe("Field (§7.2/§12 — label above, aria wiring, never placeholder-only)", () => {
  it("passes a stable id to the control and labels it via htmlFor", () => {
    renderField();
    const input = screen.getByLabelText("Workspace name");
    expect(input.getAttribute("id")).toBeTruthy();
    const label = screen.getByText("Workspace name");
    expect(label.tagName).toBe("LABEL");
    expect(label.getAttribute("for")).toBe(input.getAttribute("id"));
  });

  it("uses a useId-derived id when none is given, so label ↔ control stay linked", () => {
    const { container } = renderField();
    const input = container.querySelector("input");
    const label = container.querySelector("label");
    expect(input?.id).toBe(label?.getAttribute("for"));
  });

  it("honours an explicit id (stable label ↔ control links)", () => {
    const { container } = renderField({ id: "ws-name" });
    expect(container.querySelector("input")?.id).toBe("ws-name");
    expect(container.querySelector("label")?.getAttribute("for")).toBe("ws-name");
  });

  it("links helper text via aria-describedby (§12)", () => {
    renderField();
    const input = screen.getByLabelText("Workspace name");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    const helper = screen.getByText("Lowercase, no spaces");
    expect(describedBy).toBeTruthy();
    expect(helper.getAttribute("id")).toBe(describedBy);
  });

  it("errors: announced via role=alert, aria-invalid set, helper replaced (§12)", () => {
    renderField({ error: "Name already taken", helperText: "Lowercase, no spaces" });
    const input = screen.getByLabelText("Workspace name");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("Name already taken");
    // The error node is one of the described-by targets (§12).
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(" ")).toContain(error.getAttribute("id"));
    // The visible helper is replaced by the error.
    expect(screen.queryByText("Lowercase, no spaces")).not.toBeInTheDocument();
    // NOTE (found while writing this suite, reported to worklog): aria-describedby
    // still references `${id}-helper` even though the helper node is removed when
    // an error is shown — a dangling reference (minor a11y bug, fix owed to a
    // later wave; not pinned as correct here, only tolerated).
  });

  it("errors carry the danger colour and the alert icon (§7.2)", () => {
    renderField({ error: "Name already taken" });
    const error = screen.getByRole("alert");
    expect(error.className).toContain("text-danger");
    expect(error.querySelector("svg")).not.toBeNull();
  });

  it("required: control required + danger asterisk in the label (decorative)", () => {
    const { container } = renderField({ required: true });
    // The label text is “Workspace name *” — match on the words, not the full string.
    const input = screen.getByLabelText(/Workspace name/);
    expect(input).toHaveAttribute("required");
    const asterisk = container.querySelector("label span");
    expect(asterisk?.getAttribute("aria-hidden")).toBe("true");
    expect(asterisk?.textContent).toBe("*");
  });
});
