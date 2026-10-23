/**
 * The /changelog page's release record (W2-B4) — DERIVED from the repository
 * root `/CHANGELOG.md`, not an independent restatement:
 *
 * - versions, dates and order MUST mirror the file's `## [version]` headers
 *   one-to-one;
 * - the summary paragraphs are the file's entries edited for public reading
 *   ONLY (internal codenames generalised per the naming policy, engineering
 *   detail trimmed) — nothing is added, and the page says so;
 * - the sync contract is enforced by the vitest test in
 *   `apps/web/tests/changelog.test.tsx`, which parses `/CHANGELOG.md` and
 *   fails when the file and this literal drift (new/renamed/re-dated
 *   releases, or a page summary that no longer rests on the file's facts).
 *
 * Why the page does not parse the file at render time (the evaluated and
 * rejected option): a verbatim render would surface the upstream editor's
 * marks on a marketing page (ADR-0006 bans upstream marks outside the
 * licence surfaces — `brandViolations()` gates the page today) and would
 * re-publish the pre-pivot feature sections that W4-KILL deliberately trims
 * to a historical note; a render-time `fs` read also does not survive the
 * Next standalone deploy bundle (repo files are not traced into the build).
 */

/** One titled entry list inside a release (Keep-a-Changelog `###` section). */
export interface ReleaseSection {
  readonly title: string;
  readonly entries: readonly string[];
}

export interface Release {
  readonly version: string;
  /** `null` = in progress (the unreleased entry) — no date is invented. */
  readonly date: string | null;
  readonly summary: readonly string[];
  readonly sections: readonly ReleaseSection[];
}

/**
 * The repo's real changelog content (see the module header). Mirrors
 * CHANGELOG.md's [Unreleased] and [0.1.0-beta.0] sections — the pre-pivot
 * baseline is a historical note only (its full engineering record stays in
 * the repository changelog).
 */
export const RELEASES: readonly Release[] = [
  {
    version: "Unreleased",
    date: null,
    summary: [
      "The pivot (ADR-0006, 2026-10-21): the product is an agentic motion-graphics SaaS built on a vendored open-source motion-graphics editor — compositions, a keyframe timeline, 3D and effects, running in the browser. The editor's UI is frozen exactly as upstream ships it; the agent chat is an additive overlay, never a redesign. Projects and compositions are the domain language.",
      "The rebuild on the post-pivot stack is real but unreleased: workspaces with roles and invites; projects, versions and a single-writer edit lease; comments and presence; share links with show-once tokens; uploads and cloud renders through an append-only credit ledger; Stripe billing; and the agent chat — a curated tool surface routed through the self-hosted model gateway and compiled server-side into atomic, undoable editor batches. Ships when it ships; no date is promised here.",
      "By user order on 2026-10-23 the pre-pivot archive was deleted; git history retains it. The entry below is kept for the record — nothing in it describes this product.",
    ],
    sections: [],
  },
  {
    version: "0.1.0-beta.0",
    date: "2026-10-21",
    summary: [
      "The beta baseline of the pre-pivot product — an agent-first, template-driven design editor around a different engine (pin 872748fb, ADR-0001; superseded by ADR-0006), aggregating 147 commits from the parallel build waves W0–W10.",
      "That stack was archived at the pivot and deleted by user order on 2026-10-23. The full engineering record — foundations, engine integration and patches, gateway, tools, agent runtime, templates, billing and QA — lives in the repository changelog. It stays here as history: none of its features (templates, PSD import, i18n) exist in this product.",
    ],
    sections: [],
  },
];
