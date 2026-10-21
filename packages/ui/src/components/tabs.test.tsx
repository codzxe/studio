import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

function renderTabs(variant?: "underline" | "pill") {
  return render(
    <Tabs defaultValue="overview">
      <TabsList variant={variant}>
        <TabsTrigger value="overview" variant={variant}>
          Overview
        </TabsTrigger>
        <TabsTrigger value="versions" variant={variant}>
          Versions
        </TabsTrigger>
        <TabsTrigger value="renders" variant={variant}>
          Renders
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview">Overview panel</TabsContent>
      <TabsContent value="versions">Versions panel</TabsContent>
      <TabsContent value="renders">Renders panel</TabsContent>
    </Tabs>,
  );
}

describe("Tabs (§7.4)", () => {
  it("renders tab semantics and activates on click", async () => {
    const user = userEvent.setup();
    renderTabs();
    expect(screen.getByRole("tab", { selected: true, name: "Overview" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    expect(screen.getByRole("tab", { selected: true, name: "Versions" })).toBeInTheDocument();
    expect(screen.getByText("Versions panel")).toBeVisible();
  });

  it("supports arrow-key navigation with automatic activation (§7.4)", async () => {
    const user = userEvent.setup();
    renderTabs();
    const first = screen.getByRole("tab", { name: "Overview" });
    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Versions" })).toHaveFocus();
    expect(screen.getByText("Versions panel")).toBeVisible();
  });

  it("supports Home/End jumps (§7.4)", async () => {
    const user = userEvent.setup();
    renderTabs();
    screen.getByRole("tab", { name: "Overview" }).focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Renders" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
  });

  it("underline variant: active tab = paper text + 2px signal underline", () => {
    renderTabs("underline");
    const active = screen.getByRole("tab", { selected: true, name: "Overview" });
    expect(active.className).toContain("text-primary");
    expect(active.className).toContain("after:bg-signal");
  });

  it("pill variant: active tab uses an elevated pill", () => {
    renderTabs("pill");
    const active = screen.getByRole("tab", { selected: true, name: "Overview" });
    expect(active.className).toContain("rounded-pill");
    expect(active.className).toContain("data-[state=active]:bg-elevated");
  });

  it("keyboard navigation never silently drops handlers (smoke)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Tabs defaultValue="a" onValueChange={onSelect}>
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">A panel</TabsContent>
        <TabsContent value="b">B panel</TabsContent>
      </Tabs>,
    );
    screen.getByRole("tab", { name: "A" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});
