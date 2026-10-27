/**
 * EditorTopBar tests (w3-b05, seamless app+editor merge) — the persistent
 * SaaS-brand bar above the editor iframe:
 *
 *   chrome    → product mark → /w, breadcrumb project → /w/:slug/history,
 *               "Editor" as the current crumb, long names truncate
 *   the way back → the Dashboard action navigates through the app router
 *               (next/navigation mocked, the top-bar/palette house pattern),
 *               and every route follows the one dashboardHref seam
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorTopBar } from "./editor-top-bar";

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/w/test-project/editor",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  routerPush.mockClear();
});

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

describe("EditorTopBar — chrome", () => {
  it("carries the product mark linking to the dashboard and the project → Editor breadcrumb", () => {
    render(<EditorTopBar projectName="Launch Film" projectSlug="launch-film" />);

    // The §2.3 product mark — the shell TopBar's exact pattern and label.
    const brand = screen.getByRole("link", { name: "Studio — dashboard" });
    expect(brand).toHaveAttribute("href", "/w");
    expect(screen.getByTestId("editor-top-bar")).toHaveTextContent("Studio");

    // Breadcrumb: the project crumb links to its history hub, "Editor" is the
    // current page.
    const crumb = screen.getByRole("link", { name: "Launch Film" });
    expect(crumb).toHaveAttribute("href", "/w/launch-film/history");
    const current = screen.getByTestId("editor-breadcrumb-editor");
    expect(current).toHaveTextContent("Editor");
    expect(current).toHaveAttribute("aria-current", "page");
  });

  it("truncates long project names so the breadcrumb never pushes the bar apart", () => {
    render(
      <EditorTopBar
        projectName="An extremely long production name that would otherwise overflow the bar"
        projectSlug="long"
      />,
    );
    expect(screen.getByTestId("editor-breadcrumb-project")).toHaveClass("truncate");
    // The full name stays available on hover.
    expect(screen.getByTestId("editor-breadcrumb-project")).toHaveAttribute(
      "title",
      "An extremely long production name that would otherwise overflow the bar",
    );
  });
});

// ---------------------------------------------------------------------------
// The way back — the product owner's ask
// ---------------------------------------------------------------------------

describe("EditorTopBar — the way back to the dashboard", () => {
  it("navigates to /w through the app router", () => {
    render(<EditorTopBar projectName="P" projectSlug="p" />);
    fireEvent.click(screen.getByTestId("editor-dashboard-link"));
    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith("/w");
  });

  it("follows a custom dashboard href on both the brand link and the action", () => {
    render(<EditorTopBar projectName="P" projectSlug="p" dashboardHref="/w/projects" />);
    expect(screen.getByRole("link", { name: "Studio — dashboard" })).toHaveAttribute(
      "href",
      "/w/projects",
    );
    fireEvent.click(screen.getByTestId("editor-dashboard-link"));
    expect(routerPush).toHaveBeenCalledWith("/w/projects");
  });
});
