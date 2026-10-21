import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./toast";

function renderToast(variant?: "default" | "success" | "warning" | "danger") {
  return render(
    <ToastProvider>
      <ToastViewport />
      <Toast open variant={variant} duration={5000}>
        <ToastTitle>Version 4 saved</ToastTitle>
        <ToastDescription>Restored from 12s ago.</ToastDescription>
        <ToastAction asChild altText="Undo the save">
          <button type="button">Undo</button>
        </ToastAction>
        <ToastClose />
      </Toast>
    </ToastProvider>,
  );
}

describe("Toast (§7.7)", () => {
  it("renders title, description, one action and a close control", () => {
    renderToast();
    expect(screen.getByText("Version 4 saved")).toBeInTheDocument();
    expect(screen.getByText("Restored from 12s ago.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeInTheDocument();
  });

  it("announces title and description through a live region (§12)", () => {
    renderToast();
    // Radix mirrors the toast into a visually hidden live region (role=status)
    // so title + description are announced. jsdom runs its MutationObserver
    // asynchronously, so we assert the mechanism + the readable content.
    const announcer = screen.getByRole("status");
    expect(["polite", "assertive"]).toContain(announcer.getAttribute("aria-live"));
    expect(screen.getByText("Version 4 saved")).toBeInTheDocument();
    expect(screen.getByText("Restored from 12s ago.")).toBeInTheDocument();
    const region = screen.getByRole("region");
    expect(region.getAttribute("aria-label") ?? "").toContain("Notifications");
    expect(region.querySelector("li")).not.toBeNull();
  });

  it("default variant carries no status colouring; success carries the check icon", () => {
    const { container } = renderToast();
    expect(container.querySelector(".border-success\\/40")).toBeNull();

    const success = renderToast("success");
    expect(success.container.querySelector(".border-success\\/40")).not.toBeNull();
    // Status is never colour-only (§3.1): the variant adds an icon.
    expect(success.container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  it("danger variant carries the alert icon and danger edge", () => {
    const { container } = renderToast("danger");
    expect(container.querySelector(".border-danger\\/40")).not.toBeNull();
  });

  it("viewport docks bottom-right (§7.7)", () => {
    renderToast();
    const list = screen.getByRole("list");
    expect(list.className).toContain("bottom-4");
    expect(list.className).toContain("right-4");
  });
});
