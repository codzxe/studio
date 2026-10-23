import { Brand } from "@studio/config";
import { FrameLine } from "@studio/ui";

import { LegalCrossLinks, LegalPage, LegalSection } from "@/components/marketing/legal-page";
import { OSS_ATTRIBUTIONS } from "@/components/marketing/oss-attributions";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Licences and attribution",
  description:
    "The open-source software and fonts this workspace's product is built on, with links to upstream projects and their licences.",
  path: "/w/settings/licences",
});

/**
 * The in-app licences page (W2-06, §8.9 "Licences: open-source notices,
 * EffectCraft attribution, font licences") — the marketing
 * `/legal/licences` content reused IN-APP through the shared
 * `components/marketing/legal-page.tsx` shell (the manifest's sanctioned
 * reuse).
 *
 * The attribution rows (incl. the vendored editor's exact upstream pin) come
 * from the shared `components/marketing/oss-attributions.ts` module — ONE
 * copy for this page and the marketing licences page, so an upstream pin
 * bump is a single edit; the per-page tests pin the three rows. This is the
 * one place in the commercial UI where the upstream editor's real name is
 * legitimate (brand.ts: "attribution files and licences pages legitimately
 * mention the upstream marks").
 */

export default function LicencesSettingsPage() {
  return (
    <LegalPage
      testid="settings-licences"
      title="Licences and attribution"
      intro="This product is built on open-source software. This page lists the pieces you touch directly; every runtime dependency, licence text and vendor pin is tracked in the source repository."
    >
      <LegalSection n="01" title="Open-source components">
        <p>
          The editor is a real open-source application, used under the terms of its permissive
          licence and pinned to an exact upstream release. Its UI is frozen — it is served as-is and
          never reskinned.
        </p>
        <ul className="mt-2 flex flex-col" data-testid="licences-entries">
          {OSS_ATTRIBUTIONS.map((row) => (
            <li
              key={row.component}
              className="flex flex-col gap-2 border-b border-border py-5 first:border-t"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <span className="text-body font-medium text-primary">{row.component}</span>
                <span className="text-caption text-muted">{row.license}</span>
              </div>
              <p className="text-body-s text-secondary">{row.role}</p>
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <a
                  href={row.upstream}
                  className="text-body-s text-ice underline underline-offset-3 transition-colors duration-120 hover:text-primary"
                  rel="license noreferrer"
                  target="_blank"
                >
                  Upstream project
                </a>
                <span className="font-mono text-caption tabular text-muted">{row.pin}</span>
              </div>
            </li>
          ))}
        </ul>
      </LegalSection>

      <LegalSection n="02" title="Everything else">
        <p>
          Runtime dependencies are pinned in the repository lockfile and must pass a
          permissive-licence gate (MIT, Apache-2.0, BSD, ISC, MPL-2.0 unmodified) before they can
          ship. The full attribution — including every dependency row, infrastructure images and
          licence texts — lives in ATTRIBUTION.md and the LICENSES/ directory of the source
          repository.
        </p>
        <p>
          No copyleft (GPL/AGPL) component is linked into the product.{" "}
          <a
            href={`mailto:${Brand.contact.support}`}
            className="underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            Ask us
          </a>{" "}
          for the machine-readable licence manifest if you need it for your own compliance work.
        </p>
      </LegalSection>

      <div className="mt-2">
        <FrameLine label="00:00:13 — ATTRIBUTION" draw />
      </div>

      <LegalCrossLinks />
    </LegalPage>
  );
}
