import { MarketingPage, MarketingSection } from "@/components/marketing/marketing-page";
import { pageMetadata } from "@/lib/seo";
import { Brand } from "@studio/config";

export const metadata = pageMetadata({
  title: "Changelog",
  description: `Every notable change to ${Brand.productName}, newest first — the post-pivot rebuild in progress, the pre-pivot beta kept as history, never as a feature list.`,
  path: "/changelog",
});

/**
 * /changelog — renders the REAL repository changelog (M9-E, AUD-5), rewritten
 * post-pivot (W4-KILL, audit REPLACE-5): the newest entry is the honest
 * unreleased record of THIS product (the pivot decision + the rebuild that
 * exists today, per ADR-0006 and the [Unreleased] section of CHANGELOG.md),
 * and the 0.1.0-beta.0 baseline is trimmed to a short HISTORICAL note — that
 * entry describes the deleted pre-pivot product (archive purged by user
 * order 2026-10-23), so it must never read as a list of this product's
 * features. NOTHING is added; no future entries or dates exist until the
 * work ships.
 */

/** §14 date format: ISO → "Oct 21, 2026". */
function formatReleaseDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface ReleaseSection {
  readonly title: string;
  readonly entries: readonly string[];
}

interface Release {
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
const RELEASES: readonly Release[] = [
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
] as const;

/**
 * /changelog — the engineering record as an editorial page (M9-E): one
 * FrameLine per release (§2.3), entries faithful to CHANGELOG.md, and an
 * honest note about the light public-reading edits. No invented future
 * releases — when the repo changelog grows, this data grows with it.
 */
export default function ChangelogPage() {
  return (
    <MarketingPage
      testid="changelog-page"
      kicker={`${Brand.productName} — Changelog`}
      title="What changed, and when."
      intro="The engineering record of every notable change, newest first — edited only to generalise internal codenames. The post-pivot rebuild is unreleased; the pre-pivot beta baseline below is history, not a feature list."
    >
      {RELEASES.map((release, index) => (
        <MarketingSection
          key={release.version}
          label={`00:00:${String(index + 1).padStart(2, "0")} — RELEASE ${release.version}`}
        >
          <article
            data-testid={`changelog-release-${release.version}`}
            className="flex flex-col gap-8"
          >
            <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-4">
              <h2 className="font-display text-title-l tabular text-primary">{release.version}</h2>
              <p className="tabular text-mono text-muted">
                {release.date === null ? "In progress" : formatReleaseDate(release.date)}
              </p>
            </header>
            {release.summary.map((paragraph) => (
              <p key={paragraph} className="max-w-[80ch] text-body leading-relaxed text-secondary">
                {paragraph}
              </p>
            ))}
            {release.sections.map((section) => (
              <section key={section.title} className="flex flex-col gap-3">
                <h3 className="text-label uppercase tracking-[0.06em] text-muted">
                  {section.title}
                </h3>
                <ul className="flex flex-col gap-2">
                  {section.entries.map((entry) => (
                    <li
                      key={entry}
                      className="flex max-w-[80ch] gap-3 text-body-s leading-relaxed text-secondary"
                    >
                      <span aria-hidden="true" className="mt-0.5 text-disabled">
                        —
                      </span>
                      <span>{entry}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </article>
        </MarketingSection>
      ))}

      <MarketingSection label="END — CHANGELOG">
        <p className="max-w-[68ch] text-body-s leading-relaxed text-secondary">
          This page mirrors the changelog kept at the repository root: internal codenames are
          generalised per the naming policy and a few engineering-only details are trimmed — nothing
          is added, and nothing ships here before it ships in the product.
        </p>
      </MarketingSection>
    </MarketingPage>
  );
}
