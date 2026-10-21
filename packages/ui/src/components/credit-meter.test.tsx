import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CreditMeter } from "./credit-meter";

describe("CreditMeter (§7.11)", () => {
  it("always shows the numeric balance next to the meter (§7.11)", () => {
    render(<CreditMeter used={200} included={3200} />);
    const meter = screen.getByRole("meter", { name: "Credits used this cycle" });
    expect(meter).toHaveAttribute("aria-valuenow", "200");
    expect(meter).toHaveAttribute("aria-valuemax", "3200");
    expect(screen.getByText("3,000")).toBeInTheDocument();
    expect(screen.getByText("credits")).toBeInTheDocument();
  });

  it("healthy: success track, no alert label", () => {
    const { container } = render(<CreditMeter used={100} included={1000} state="healthy" />);
    expect(container.querySelector(".bg-success")).not.toBeNull();
    expect(screen.queryByText("Low")).not.toBeInTheDocument();
    expect(screen.queryByText("Out of credits")).not.toBeInTheDocument();
  });

  it("low: warning track + label (never colour-only, §3.1)", () => {
    const { container } = render(<CreditMeter used={950} included={1000} state="low" />);
    expect(container.querySelector(".bg-warning")).not.toBeNull();
    expect(screen.getByText("Low")).toBeInTheDocument();
  });

  it("exhausted: danger track + label", () => {
    const { container } = render(<CreditMeter used={1000} included={1000} state="exhausted" />);
    expect(container.querySelector(".bg-danger")).not.toBeNull();
    expect(screen.getByText("Out of credits")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("derives the state when not provided", () => {
    const { container, rerender } = render(<CreditMeter used={500} included={1000} />);
    expect(container.querySelector(".bg-success")).not.toBeNull();

    rerender(<CreditMeter used={1000} included={1000} />);
    expect(screen.getByText("Out of credits")).toBeInTheDocument();

    rerender(<CreditMeter used={990} included={1000} />);
    expect(screen.getByText("Low")).toBeInTheDocument();
  });

  it("renders the top-up CTA when provided", async () => {
    const user = userEvent.setup();
    const onTopUp = vi.fn();
    render(<CreditMeter used={950} included={1000} onTopUp={onTopUp} />);
    await user.click(screen.getByRole("button", { name: "Buy credits" }));
    expect(onTopUp).toHaveBeenCalledTimes(1);
  });
});
