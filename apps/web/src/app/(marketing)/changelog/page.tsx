import { RELEASES } from "@/components/marketing/changelog-releases";
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
 *
 * The release data lives in `components/marketing/changelog-releases.ts`
 * (W2-B4): derived from the repository root CHANGELOG.md and kept in sync by
 * the vitest test in tests/changelog.test.tsx, which parses the file and
 * fails on version/date/fact drift (see that module's header for why the
 * page does not parse the file at render time).
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
