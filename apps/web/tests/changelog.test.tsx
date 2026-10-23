import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ChangelogPage, { metadata } from "@/app/(marketing)/changelog/page";
import { RELEASES } from "@/components/marketing/changelog-releases";
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
 *
 * W2-B4 sync contract: the page's RELEASES literal is DERIVED from the
 * repository root CHANGELOG.md (render-time parsing was evaluated and
 * rejected — a verbatim render would surface upstream marks on a marketing
 * page, which ADR-0006/brandViolations ban, and would re-publish the
 * pre-pivot feature sections W4-KILL deliberately trims; see
 * components/marketing/changelog-releases.ts). The tests below parse the
 * real file and fail on drift: versions, dates, order, and the facts the
 * page restates must all be grounded in the file.
 */

// ---------------------------------------------------------------------------
// CHANGELOG.md parsing (the sync-test side of the contract)
// ---------------------------------------------------------------------------

/** apps/web/tests → the repository root (where CHANGELOG.md lives). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const CHANGELOG = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");

/** Hard line wraps collapsed — anchors match prose, not wrapping. */
function normalize(markdown: string): string {
  return markdown.replace(/\s+/g, " ");
}

/** `## [Unreleased]` / `## [0.1.0-beta.0] — 2026-10-21` → version + date. */
function parseVersionHeaders(markdown: string): { version: string; date: string | null }[] {
  const headers: { version: string; date: string | null }[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^## \[([^\]]+)\](?:\s+[—-]\s+(\d{4}-\d{2}-\d{2}))?\s*$/.exec(line);
    if (match !== null && match[1] !== undefined) {
      headers.push({ version: match[1], date: match[2] ?? null });
    }
  }
  return headers;
}

/** The file's body between one version header and the next (normalized). */
function sectionFor(markdown: string, version: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`## \\[${escaped}\\]([\\s\\S]*?)(?=## \\[|$)`).exec(markdown);
  return normalize(match?.[1] ?? "");
}

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

// ---------------------------------------------------------------------------
// CHANGELOG.md sync (W2-B4) — the literal must track the real file
// ---------------------------------------------------------------------------

describe("changelog page — CHANGELOG.md sync (W2-B4)", () => {
  it("renders exactly the file's releases, in file order, with the file's dates", () => {
    // The drift gate: a new/renamed/re-dated release in /CHANGELOG.md fails
    // here until the page's RELEASES catches up (and vice versa).
    expect(parseVersionHeaders(CHANGELOG)).toEqual(
      RELEASES.map((release) => ({ version: release.version, date: release.date })),
    );
  });

  it("grounds every restated fact in the file's section (nothing is added)", () => {
    // The facts the page's editorial summaries restate, pinned to the file's
    // own sections: if the FILE rewords a fact, the page (and this test) get
    // revisited — the page may never drift ahead of the record.
    const anchors: Record<string, readonly string[]> = {
      Unreleased: [
        "ADR-0006",
        "motion-graphics SaaS",
        "roles and invites",
        "single-writer edit lease",
        "show-once tokens",
        "append-only credit ledger",
        "Stripe billing",
        "self-hosted model gateway",
        "atomic",
        "Ships when it ships",
        "2026-10-23",
      ],
      "0.1.0-beta.0": ["agent-first, template-driven design editor", "147 commits", "872748fb"],
    };
    for (const release of RELEASES) {
      const section = sectionFor(CHANGELOG, release.version);
      expect(section.length, `section [${release.version}] exists in CHANGELOG.md`).toBeGreaterThan(
        0,
      );
      for (const anchor of anchors[release.version] ?? []) {
        expect(section, `[${release.version}] anchors on "${anchor}"`).toContain(anchor);
      }
    }
  });
});
