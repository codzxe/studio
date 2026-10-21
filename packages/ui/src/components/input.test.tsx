import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Input, SearchInput } from "./input";
import { Textarea } from "./textarea";

describe("Input", () => {
  it("associates the label above the control (§7.2 — never placeholder-only)", () => {
    render(<Input id="project-name" label="Project name" />);
    const input = screen.getByLabelText("Project name");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("id", "project-name");
  });

  it("links helper text via aria-describedby (§12)", () => {
    render(<Input id="slug" label="Slug" helperText="Lowercase, no spaces" />);
    const input = screen.getByLabelText("Slug");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const helper = screen.getByText("Lowercase, no spaces");
    expect(helper).toHaveAttribute("id", describedBy ?? "");
  });

  it("links errors via aria-describedby, marks invalid and announces (§12)", () => {
    render(<Input id="email" label="Email" error="Enter a valid email" />);
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toContain("-helper");
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("Enter a valid email");
    expect(error.getAttribute("id")).toBeTruthy();
    expect(describedBy).toContain(error.getAttribute("id") ?? "");
  });

  it("error takes the danger border colour and replaces the helper", () => {
    render(
      <Input id="email" label="Email" helperText="We never share it" error="Enter a valid email" />,
    );
    expect(screen.queryByText("We never share it")).not.toBeInTheDocument();
    const input = screen.getByLabelText("Email");
    expect(input.className).toContain("border-danger");
  });

  it("typing works end to end", async () => {
    const user = userEvent.setup();
    render(<Input label="Project name" />);
    const input = screen.getByLabelText("Project name");
    await user.type(input, "Launch film");
    expect(input).toHaveValue("Launch film");
  });

  it("SearchInput shows the leading icon affordance and ⌘K hint (§7.2)", () => {
    render(<SearchInput label="Search projects" placeholder="Search projects…" />);
    const input = screen.getByLabelText("Search projects");
    expect(input).toHaveAttribute("type", "search");
    expect(screen.getByText("⌘K")).toBeInTheDocument();
  });
});

describe("Textarea", () => {
  it("defaults to 3 rows (§7.2) and wires label + error", () => {
    render(<Textarea id="brief" label="Brief" error="Say one sentence" />);
    const textarea = screen.getByLabelText("Brief");
    expect(textarea).toHaveAttribute("rows", "3");
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Say one sentence");
  });
});
