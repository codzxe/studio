import ChangelogPage, { metadata } from "@/app/(marketing)/changelog/page";
import { brandViolations } from "@studio/config";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * /changelog contract (M9-E, AUD-5): the page renders the REAL repository
 * changelog — [0.1.0-beta.0] of 2026-10-21, the only release that exists —
 * with its real sections, faithfully reproduced (internal codenames
 * generalised per ADR-0006, which the brand-safety test pins). No invented
 * future releases, no "documents" domain word (law #9), no fake entries.
 */

describe("changelog page", () => {
  it("has changelog metadata", () => {
    expect(metadata.title).toBe("Changelog");
    expect((metadata.description ?? "").length).toBeGreaterThan(0);
  });

  it("renders exactly the one real release, with the real version and date", () => {
    const { container } = render(<ChangelogPage />);
    const releases = Array.from(container.querySelectorAll('[data-testid^="changelog-release-"]'));
    expect(releases).toHaveLength(1); // no invented future entries
    const release = screen.getByTestId("changelog-release-0.1.0-beta.0");
    expect(within(release).getByRole("heading", { name: "0.1.0-beta.0" })).toBeInTheDocument();
    // §14 date format: "Oct 21, 2026".
    expect(within(release).getByText("Oct 21, 2026")).toBeInTheDocument();
    expect(screen.getByText(/One release so far/i)).toBeInTheDocument();
  });

  it("carries the real summary and every real section, including the limitations", () => {
    render(<ChangelogPage />);
    // The real opening sentence + the real commit count from CHANGELOG.md.
    expect(screen.getByText(/First beta baseline of the studio SaaS/)).toBeInTheDocument();
    expect(
      screen.getByText(/147 commits from the parallel build waves W0–W10/),
    ).toBeInTheDocument();
    for (const section of [
      "Added — Foundations (W0–W1)",
      "Added — Engine integration (W2)",
      "Added — Engine patches (W2–W3, ADR-0001 policy)",
      "Added — Gateway (W4, W10-G)",
      "Added — Tools (W5)",
      "Added — Agent runtime (W6–W7)",
      "Added — Templates & evals (W3, W7)",
      "Added — Web app (W8)",
      "Added — Billing & observability (W9–W10)",
      "Added — Infra & QA (W9–W10)",
      "Known Limitations",
      "Security",
    ]) {
      expect(
        screen.getByRole("heading", { name: section }),
        `missing changelog section: ${section}`,
      ).toBeInTheDocument();
    }
    // Known Limitations is reproduced, not sanitised away.
    expect(screen.getByText(/CI workflows staged pending token scope/)).toBeInTheDocument();
    expect(
      screen.getByText(/Redaction: run\/SSE events, audit logs and error envelopes/),
    ).toBeInTheDocument();
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
