/**
 * The in-app licences page tests (W2-06) — the §8.9 "Licences" surface
 * reuses the marketing legal-page shell and carries the SAME attribution
 * rows as `/legal/licences` (the sync pin: EffectCraft + the two font
 * licences with their pins, no invented rows).
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LicencesSettingsPage from "./page";

describe("settings licences page", () => {
  it("renders the legal-page shell with the attribution title", () => {
    render(<LicencesSettingsPage />);
    const shell = screen.getByTestId("settings-licences");
    expect(shell).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Licences and attribution" })).toBeInTheDocument();
  });

  it("carries the same three attribution rows as /legal/licences (sync pin)", () => {
    render(<LicencesSettingsPage />);
    const entries = screen.getByTestId("licences-entries");
    expect(within(entries).getByText("EffectCraft")).toBeInTheDocument();
    expect(within(entries).getByText("MIT OR Apache-2.0")).toBeInTheDocument();
    expect(within(entries).getByText("Instrument Serif · Instrument Sans")).toBeInTheDocument();
    expect(within(entries).getByText("JetBrains Mono")).toBeInTheDocument();
    // The EffectCraft vendored pin, verbatim.
    expect(
      within(entries).getByText("9db7f3b21700fd821f215782ed1c82afe077880f (v0.13.0)"),
    ).toBeInTheDocument();
    // Exactly three rows — nothing invented.
    expect(within(entries).getAllByRole("listitem")).toHaveLength(3);
  });

  it("links each row upstream with rel=license noreferrer", () => {
    render(<LicencesSettingsPage />);
    const upstream = screen.getAllByRole("link", { name: "Upstream project" });
    expect(upstream).toHaveLength(3);
    for (const link of upstream) {
      expect(link).toHaveAttribute("rel", "license noreferrer");
      expect(link).toHaveAttribute("target", "_blank");
    }
  });

  it("keeps the no-copyleft honesty statement and the cross-links", () => {
    render(<LicencesSettingsPage />);
    expect(screen.getByText(/No copyleft \(GPL\/AGPL\) component/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/legal/terms");
    expect(screen.getByRole("link", { name: "Licences" })).toHaveAttribute(
      "href",
      "/legal/licences",
    );
  });
});
