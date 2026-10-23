/**
 * WorkspaceRail tests (W2-01, §8.4) — the four destinations (and ONLY those),
 * the active item (2px signal left border + bg-elevated + aria-current), the
 * collapse toggle (240px ↔ 64px) with localStorage persistence under the D-10
 * key `studio.shell.rail.v1`, and keyboard activation of the toggle. The
 * pathname is injected through the next/navigation mock (house pattern);
 * localStorage is spied (jsdom's real store, seeded per test).
 */

import { WorkspaceRail, RAIL_STORAGE_KEY } from "@/components/shell/workspace-rail";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pathname } = vi.hoisted(() => ({ pathname: { current: "/w" } }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const getItemSpy = vi.spyOn(Storage.prototype, "getItem");
const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

function rail(): HTMLElement {
  return screen.getByTestId("workspace-rail");
}

function activeCount(): number {
  return document.querySelectorAll('[data-active="true"]').length;
}

beforeEach(() => {
  pathname.current = "/w";
  window.localStorage.clear();
  getItemSpy.mockClear();
  setItemSpy.mockClear();
});

describe("WorkspaceRail — destinations (§8.4: exactly these four)", () => {
  it("renders Dashboard, Projects, Billing, Settings with their hrefs", () => {
    render(<WorkspaceRail />);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByTestId("rail-dashboard")).toHaveAttribute("href", "/w");
    expect(screen.getByTestId("rail-projects")).toHaveAttribute("href", "/w/projects");
    expect(screen.getByTestId("rail-billing")).toHaveAttribute("href", "/w/billing");
    expect(screen.getByTestId("rail-settings")).toHaveAttribute("href", "/w/settings");
    expect(screen.queryByText("Assets")).not.toBeInTheDocument();
    expect(screen.queryByText("Templates")).not.toBeInTheDocument();
  });
});

describe("WorkspaceRail — active item", () => {
  it.each([
    { path: "/w", testid: "rail-dashboard" },
    { path: "/w/projects", testid: "rail-projects" },
    { path: "/w/projects/some-project", testid: "rail-projects" },
    { path: "/w/billing", testid: "rail-billing" },
    { path: "/w/settings/members", testid: "rail-settings" },
  ])("marks $testid active for $path (and only it)", ({ path, testid }) => {
    pathname.current = path;
    render(<WorkspaceRail />);
    const active = screen.getByTestId(testid);
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active).toHaveAttribute("data-active", "true");
    expect(active.className).toContain("border-signal");
    expect(active.className).toContain("bg-elevated");
    expect(activeCount()).toBe(1);
  });

  it("lights no item for project hub routes (they are not sections)", () => {
    pathname.current = "/w/launch-film/history";
    render(<WorkspaceRail />);
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
  });
});

describe("WorkspaceRail — collapse + persistence (D-10)", () => {
  it("toggles to collapsed on click, persists, and keeps the sr-only label", async () => {
    const user = userEvent.setup();
    render(<WorkspaceRail />);
    const toggle = screen.getByTestId("rail-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-label", "Collapse sidebar");

    await user.click(toggle);
    expect(rail()).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByTestId("rail-dashboard")).toHaveTextContent("Dashboard");
    expect(screen.getByTestId("rail-dashboard").className).toContain("justify-center");
    expect(setItemSpy).toHaveBeenCalledWith(RAIL_STORAGE_KEY, "collapsed");
    expect(screen.getByTestId("rail-toggle")).toHaveAttribute("aria-label", "Expand sidebar");
  });

  it("toggles back to expanded and persists the expanded value", async () => {
    const user = userEvent.setup();
    render(<WorkspaceRail />);
    await user.click(screen.getByTestId("rail-toggle"));
    await user.click(screen.getByTestId("rail-toggle"));
    expect(rail()).not.toHaveAttribute("data-collapsed");
    expect(setItemSpy).toHaveLastCalledWith(RAIL_STORAGE_KEY, "expanded");
  });

  it("restores the persisted collapsed state on mount", () => {
    window.localStorage.setItem(RAIL_STORAGE_KEY, "collapsed");
    render(<WorkspaceRail />);
    // The stored value applies right after mount (the first paint always
    // matches the server: expanded — then the effect collapses).
    expect(getItemSpy).toHaveBeenCalledWith(RAIL_STORAGE_KEY);
    expect(rail()).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByTestId("rail-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("ignores hostile stored values (anything but 'collapsed' → expanded)", () => {
    window.localStorage.setItem(RAIL_STORAGE_KEY, "yes");
    render(<WorkspaceRail />);
    expect(rail()).not.toHaveAttribute("data-collapsed");
    expect(screen.getByTestId("rail-toggle")).toHaveAttribute("aria-expanded", "true");
  });
});

describe("WorkspaceRail — keyboard", () => {
  it("Enter on the focused toggle collapses (a real button, no pointer needed)", async () => {
    const user = userEvent.setup();
    render(<WorkspaceRail />);
    screen.getByTestId("rail-toggle").focus();
    await user.keyboard("{Enter}");
    expect(rail()).toHaveAttribute("data-collapsed", "true");
    expect(setItemSpy).toHaveBeenCalledWith(RAIL_STORAGE_KEY, "collapsed");
  });
});
