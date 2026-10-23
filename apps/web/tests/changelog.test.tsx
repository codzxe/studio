import ChangelogPage, { metadata } from "@/app/(marketing)/changelog/page";
import { brandViolations } from "@studio/config";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * /changelog contract (M9-E, AUD-5; rewritten post-pivot by W4-KILL, audit
 * REPLACE-5): the page renders the REAL repository record — the [Unreleased]
 * post-pivot rebuild (newest) and the 0.1.0-beta.0 baseline TRIMMED to a
 * historical note, because that entry describes the deleted pre-pivot
 * product. The pre-pivot feature sections (templates, PSD import, i18n, the
 * 872748fb engine) must never read as this product's features. No invented
 * future releases, no "documents" domain word (law #9), no fake entries.
 */

describe("changelog page", () => {
  it("has changelog metadata", () => {
    expect(metadata.title).toBe("Changelog");
    expect((metadata.description ?? "").length).toBeGreaterThan(0);
  });

  it("renders exactly the two real entries: the unreleased rebuild, then the historical baseline", () => {
    const { container } = render(<ChangelogPage />);
    const releases = Array.from(container.querySelectorAll('[data-testid^="changelog-release-"]'));
    expect(releases).toHaveLength(2); // no invented future entries

    // Newest first: [Unreleased] — in progress, no invented date.
    const unreleased = screen.getByTestId("changelog-release-Unreleased");
    expect(within(unreleased).getByRole("heading", { name: "Unreleased" })).toBeInTheDocument();
    expect(within(unreleased).getByText("In progress")).toBeInTheDocument();

    // Then the pre-pivot baseline, kept as history with its real date.
    const baseline = screen.getByTestId("changelog-release-0.1.0-beta.0");
    expect(within(baseline).getByRole("heading", { name: "0.1.0-beta.0" })).toBeInTheDocument();
    // §14 date format: "Oct 21, 2026".
    expect(within(baseline).getByText("Oct 21, 2026")).toBeInTheDocument();
  });

  it("tells the pivot story honestly: the pivot decision, the real rebuild, the purge", () => {
    render(<ChangelogPage />);
    const unreleased = screen.getByTestId("changelog-release-Unreleased");
    // The pivot decision + the frozen-editor rule (ADR-0006).
    expect(within(unreleased).getByText(/frozen exactly as upstream ships it/)).toBeInTheDocument();
    expect(within(unreleased).getByText(/Projects and compositions/)).toBeInTheDocument();
    // The rebuild describes what EXISTS (workspaces, leases, share links,
    // credit ledger, billing, agent chat) and stays honestly unreleased.
    expect(within(unreleased).getByText(/real but unreleased/)).toBeInTheDocument();
    expect(within(unreleased).getByText(/single-writer edit lease/)).toBeInTheDocument();
    expect(within(unreleased).getByText(/show-once tokens/)).toBeInTheDocument();
    expect(within(unreleased).getByText(/Ships when it ships/)).toBeInTheDocument();
    // The purge is stated, not hidden.
    expect(
      within(unreleased).getByText(/user order on 2026-10-23 the pre-pivot archive was deleted/),
    ).toBeInTheDocument();
  });

  it("keeps the pre-pivot baseline as HISTORY — its features are named as not existing", () => {
    render(<ChangelogPage />);
    const baseline = screen.getByTestId("changelog-release-0.1.0-beta.0");
    // The real record: the pre-pivot descriptor, engine pin, commit count.
    expect(
      within(baseline).getByText(/agent-first, template-driven design editor/),
    ).toBeInTheDocument();
    expect(within(baseline).getByText(/147 commits/)).toBeInTheDocument();
    // The honest disclaimer: the deleted features are named as absent, never
    // presented as shipped.
    expect(
      within(baseline).getByText(/none of its features \(templates, PSD import, i18n\) exist/),
    ).toBeInTheDocument();
    // The pre-pivot feature sections are GONE (they advertised deleted
    // features as this product's history in detail).
    const { container } = render(<ChangelogPage />);
    expect(container.textContent ?? "").not.toContain("Added — Templates & evals");
    expect(container.textContent ?? "").not.toContain("PSD experimental");
    expect(container.textContent ?? "").not.toContain("i18n scaffold");
    expect(container.querySelectorAll("h3").length).toBe(0); // no section lists remain
  });

  it("is brand-safe: internal codenames are generalised (ADR-0006), no 'documents' domain word", () => {
    const { container } = render(<ChangelogPage />);
    const text = container.textContent ?? "";
    expect(brandViolations(text)).toEqual([]);
    expect(text.toLowerCase()).not.toContain("photocraft");
    expect(text.toLowerCase()).not.toMatch(/\bdocuments?\b/);
    // The editorial note is honest about the light public-reading edits.
    expect(
      screen.getByText(/mirrors the changelog kept at the repository root/),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing is added/i)).toBeInTheDocument();
  });
});
