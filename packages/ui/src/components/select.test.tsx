import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./select";

/**
 * jsdom cannot exercise Radix Select's pointer-capture open path (no real
 * pointer capture) — the mouse journey is covered by the app's Playwright
 * e2e. The unit suite pins the keyboard-first a11y path, which is the §12
 * requirement.
 */
function renderSelect(
  root: { value?: string; defaultValue?: string; onValueChange?: (v: string) => void } = {},
  trigger: Record<string, unknown> = {},
) {
  return render(
    <Select {...root}>
      <SelectTrigger label="Plan" placeholder="Select a plan" {...(trigger as object)}>
        {/* no children → SelectValue renders the placeholder / selected label */}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="starter">Starter</SelectItem>
        <SelectItem value="pro">Pro</SelectItem>
        <SelectItem value="studio">Studio</SelectItem>
      </SelectContent>
    </Select>,
  );
}

describe("Select (§7.2 — custom popover, not native)", () => {
  it("renders a labelled combobox trigger with the selected value", () => {
    renderSelect({ defaultValue: "pro" });
    const trigger = screen.getByRole("combobox", { name: "Plan" });
    expect(trigger).toHaveTextContent("Pro");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Shows the closed affordance icon (decorative — label carries the name).
    expect(trigger.querySelector("svg")).not.toBeNull();
  });

  it("shows the placeholder until a value is selected (never blank)", () => {
    renderSelect();
    expect(screen.getByRole("combobox", { name: "Plan" })).toHaveTextContent("Select a plan");
  });

  it("opens a listbox via keyboard with options inside (§7.2/§15)", async () => {
    const user = userEvent.setup();
    renderSelect({ defaultValue: "starter" });
    const trigger = screen.getByRole("combobox", { name: "Plan" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox");
    expect(listbox).toHaveAttribute("data-state", "open");
    // The previously-selected option is marked aria-selected (§12).
    expect(screen.getByRole("option", { name: "Starter" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: "Studio" })).toBeInTheDocument();
  });

  it("keyboard: arrows move the highlight, Enter selects, trigger updates (§12)", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSelect({ onValueChange });
    const trigger = screen.getByRole("combobox", { name: "Plan" });
    trigger.focus();
    await user.keyboard("{ArrowDown}"); // opens, highlights Starter
    let highlighted = screen.getByRole("listbox").querySelector("[data-highlighted]");
    expect(highlighted?.textContent).toBe("Starter");
    await user.keyboard("{ArrowDown}"); // highlights Pro
    highlighted = screen.getByRole("listbox").querySelector("[data-highlighted]");
    expect(highlighted?.textContent).toBe("Pro");
    await user.keyboard("{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("pro");
    expect(trigger).toHaveTextContent("Pro");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Escape closes the listbox without changing the value", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSelect({ defaultValue: "starter", onValueChange });
    const trigger = screen.getByRole("combobox", { name: "Plan" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("labels, helper and error wire through aria-describedby / aria-invalid (§12)", () => {
    renderSelect({}, { id: "plan", helperText: "Change any time" });
    const trigger = screen.getByRole("combobox", { name: "Plan" });
    const describedBy = trigger.getAttribute("aria-describedby") ?? "";
    expect(describedBy).toBeTruthy();
    expect(screen.getByText("Change any time")).toHaveAttribute("id", describedBy);
  });

  it("error: aria-invalid, role=alert and the danger border (§7.2/§12)", () => {
    renderSelect({}, { id: "plan", error: "Payment required" });
    const trigger = screen.getByRole("combobox", { name: "Plan" });
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Payment required");
    expect(trigger.className).toContain("border-danger");
  });

  it("required forwards aria-required to the trigger", () => {
    renderSelect({}, { id: "plan", required: true });
    expect(screen.getByRole("combobox", { name: "Plan" })).toHaveAttribute("aria-required", "true");
  });

  it("trigger sizes map to 32/36/44 like Input (§7.2)", () => {
    const { rerender } = render(
      <Select defaultValue="starter">
        <SelectTrigger id="plan" label="Plan" triggerSize="sm" />
        <SelectContent>
          <SelectItem value="starter">Starter</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByRole("combobox").className).toContain("h-8");
    rerender(
      <Select defaultValue="starter">
        <SelectTrigger id="plan" label="Plan" triggerSize="lg" />
        <SelectContent>
          <SelectItem value="starter">Starter</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByRole("combobox").className).toContain("h-11");
  });

  it("disabled trigger: not keyboard-openable, opacity .45 (§7.2)", () => {
    renderSelect({}, { id: "plan", disabled: true });
    const trigger = screen.getByRole("combobox", { name: "Plan" });
    expect(trigger).toBeDisabled();
    expect(trigger.className).toContain("opacity-45");
  });
});
