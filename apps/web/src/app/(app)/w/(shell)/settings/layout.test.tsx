/**
 * Settings sub-nav tests (W2-06) — the six §8.9 destinations + the Billing
 * cross-link, active-section highlighting (aria-current, §12) and the `?ws`
 * seam preservation (sub-navigation must not strand the workspace context).
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isNavActive } from "./layout";

// The setup file mocks next/navigation app-wide; per the setup contract,
// per-file re-mocks (hoisted) override it — the pathname/searchParams are
// steered per-test through mutable holders.
let pathnameHolder = "/w/settings";
let wsHolder: string | null = null;

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameHolder,
  useSearchParams: () => new URLSearchParams(wsHolder === null ? {} : { ws: wsHolder }),
}));

import SettingsLayout from "./layout";

const DESTINATIONS = [
  { testid: "settings-nav-general", label: "General", href: "/w/settings" },
  { testid: "settings-nav-members", label: "Members", href: "/w/settings/members" },
  { testid: "settings-nav-api-keys", label: "API keys", href: "/w/settings/api-keys" },
  { testid: "settings-nav-models", label: "Models", href: "/w/settings/models" },
  { testid: "settings-nav-audit", label: "Audit", href: "/w/settings/audit" },
  { testid: "settings-nav-licences", label: "Licences", href: "/w/settings/licences" },
  { testid: "settings-nav-billing", label: "Billing", href: "/w/billing" },
] as const;

function renderLayout(): void {
  render(
    <SettingsLayout>
      <p data-testid="settings-child">content</p>
    </SettingsLayout>,
  );
}

beforeEach(() => {
  pathnameHolder = "/w/settings";
  wsHolder = null;
});

describe("settings layout — sub-nav", () => {
  it("renders the six settings destinations plus the Billing cross-link", () => {
    renderLayout();
    for (const destination of DESTINATIONS) {
      const link = screen.getByTestId(destination.testid);
      expect(link).toHaveTextContent(destination.label);
      expect(link).toHaveAttribute("href", destination.href);
    }
    expect(screen.getByRole("navigation", { name: "Settings" })).toBeInTheDocument();
  });

  it("renders children inside the content column", () => {
    renderLayout();
    expect(screen.getByTestId("settings-child")).toBeInTheDocument();
    expect(screen.getByTestId("settings-content")).toContainElement(
      screen.getByTestId("settings-child"),
    );
  });

  it("marks only the current section aria-current=page (§12)", () => {
    pathnameHolder = "/w/settings/members";
    renderLayout();
    expect(screen.getByTestId("settings-nav-members")).toHaveAttribute("aria-current", "page");
    for (const destination of DESTINATIONS) {
      if (destination.testid === "settings-nav-members") continue;
      expect(screen.getByTestId(destination.testid)).not.toHaveAttribute("aria-current");
    }
  });

  it("General is exact-match only — /w/settings/members does not light it up", () => {
    pathnameHolder = "/w/settings/members";
    renderLayout();
    expect(screen.getByTestId("settings-nav-general")).not.toHaveAttribute("aria-current");
    expect(screen.getByTestId("settings-nav-general")).not.toHaveAttribute("data-active");
  });

  it("preserves ?ws on every sub-nav link (the workspace-switcher seam)", () => {
    wsHolder = "second-studio";
    renderLayout();
    for (const destination of DESTINATIONS) {
      expect(screen.getByTestId(destination.testid)).toHaveAttribute(
        "href",
        `${destination.href}?ws=second-studio`,
      );
    }
  });

  it("encodes hostile ?ws values instead of injecting query structure", () => {
    wsHolder = "a b&ws=evil";
    renderLayout();
    expect(screen.getByTestId("settings-nav-members")).toHaveAttribute(
      "href",
      "/w/settings/members?ws=a%20b%26ws%3Devil",
    );
  });
});

describe("isNavActive — section matching", () => {
  const general = { key: "general", label: "General", href: "/w/settings", exact: true };
  const members = { key: "members", label: "Members", href: "/w/settings/members" };

  it("exact items match their path only", () => {
    expect(isNavActive("/w/settings", general)).toBe(true);
    expect(isNavActive("/w/settings/members", general)).toBe(false);
  });

  it("section items own their subtree", () => {
    expect(isNavActive("/w/settings/members", members)).toBe(true);
    expect(isNavActive("/w/settings/members/deep", members)).toBe(true);
    expect(isNavActive("/w/settings", members)).toBe(false);
  });
});
