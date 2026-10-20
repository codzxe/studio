import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { Badge, statusBadgeVariant } from "../src/components/badge.js";
import { Panel, PanelContent, PanelHeader } from "../src/components/panel.js";

describe("Badge", () => {
  it("renders the status-mapped variant class (§13.2)", () => {
    render(
      <Badge variant={statusBadgeVariant("executing")} data-testid="ui-badge-run">
        executing
      </Badge>,
    );
    expect(screen.getByTestId("ui-badge-run").className).toContain("bg-info/15");
  });

  it("renders the neutral class for unknown statuses via statusBadgeVariant", () => {
    render(<Badge variant={statusBadgeVariant("unexpected")} data-testid="ui-badge-x" />);
    expect(screen.getByTestId("ui-badge-x").className).toContain("bg-primary");
  });
});

describe("Panel", () => {
  it("toggles collapse via the header button and wires aria-expanded/aria-controls", async () => {
    const user = userEvent.setup();
    render(
      <Panel side="left" data-testid="ui-panel-layers">
        <PanelHeader title="Layers" data-testid="ui-panel-header" />
        <PanelContent data-testid="ui-panel-content">
          <div>Layer tree placeholder</div>
        </PanelContent>
      </Panel>,
    );

    const panel = screen.getByTestId("ui-panel-layers");
    expect(panel.getAttribute("data-state")).toBe("expanded");

    const toggle = screen.getByRole("button", { name: "Collapse panel" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("ui-panel-content")).toBeDefined();

    await user.click(toggle);
    expect(panel.getAttribute("data-state")).toBe("collapsed");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // collapsed content leaves the DOM (and the a11y tree) entirely
    expect(screen.queryByTestId("ui-panel-content")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand panel" })).toBeDefined();
  });

  it("keeps the title accessible when collapsed (sr-only heading)", async () => {
    const user = userEvent.setup();
    render(
      <Panel defaultCollapsed>
        <PanelHeader title="Versions" />
        <PanelContent>
          <div>history list</div>
        </PanelContent>
      </Panel>,
    );
    expect(screen.getByText("Versions")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Expand panel" }));
    expect(screen.getByText("Versions")).toBeDefined();
  });
});
