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
// Full RenderResult (unmount included) for the regression tests below.
function renderFieldFull(overrides: Record<string, unknown> = {}) {
  const props = {
    label: "Workspace name",
    helperText: "Lowercase, no spaces",
    ...overrides,
  } as React.ComponentProps<typeof Field>;
  return render(<Field {...props}>{(control) => <input type="text" {...control} />}</Field>);
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
    // The error node is the ONLY described-by target: the helper id left
    // aria-describedby together with the unmounted helper node (M9-A
    // dangling-reference fix — pinned hard, no longer tolerated).
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(" ")).toEqual([error.getAttribute("id")]);
    // The visible helper is replaced by the error.
    expect(screen.queryByText("Lowercase, no spaces")).not.toBeInTheDocument();
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

  it("regression (M9-A dangling-ref fix): error present → aria-describedby holds ONLY the error id; error absent + helper → helper id present", () => {
    // Error shown (helperText still provided): the helper node is unmounted,
    // so its id must leave aria-describedby with it — the error id is the
    // sole remaining target, never a reference to a missing node.
    const errored = renderFieldFull({ id: "ws-reg", error: "Name already taken" });
    expect(errored.container.querySelector("input")?.getAttribute("aria-describedby")).toBe(
      "ws-reg-error",
    );
    errored.unmount();

    // No error: the mounted helper is the described-by target again.
    const helped = renderFieldFull({ id: "ws-reg" });
    expect(helped.container.querySelector("input")?.getAttribute("aria-describedby")).toBe(
      "ws-reg-helper",
    );
    expect(screen.getByText("Lowercase, no spaces").getAttribute("id")).toBe("ws-reg-helper");
  });
});
