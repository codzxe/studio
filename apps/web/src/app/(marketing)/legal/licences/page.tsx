import { LegalCrossLinks, LegalPage, LegalSection } from "@/components/marketing/legal-page";
import { OSS_ATTRIBUTIONS } from "@/components/marketing/oss-attributions";
import { pageMetadata } from "@/lib/seo";
import { Brand } from "@studio/config";
import { FrameLine } from "@studio/ui";

export const metadata = pageMetadata({
  title: "Licences and Attribution",
  description:
    "The open-source software and fonts Studio is built on, with links to upstream projects and their licences.",
  path: "/legal/licences",
});

/**
 * Open-source attribution page (docs/legal/license-audit.md, ATTRIBUTION.md).
 * The attribution table (incl. the vendored editor's exact upstream pin) is
 * the shared `components/marketing/oss-attributions.ts` module — ONE copy,
 * consumed by this page and the in-app settings licences page. This is the
 * one place in the commercial UI where the upstream editor's real name is
 * legitimate (packages/config/src/brand.ts: "attribution files and licences
 * pages legitimately mention the upstream marks").
 */

export default function LicencesPage() {
  return (
    <LegalPage
      testid="legal-licences"
      title="Licences and attribution"
      intro="Studio is built on open-source software. This page lists the pieces a customer touches directly; every runtime dependency, licence text and vendor pin is tracked in the repository."
    >
      <LegalSection n="01" title="Open-source components">
        <p>
          The editor is a real open-source application, used under the terms of its permissive
          licence and pinned to an exact upstream release. Its UI is frozen — we serve it as-is and
          do not reskin it.
        </p>
        {/* Editorial stacked rows instead of a 5-column table — the page's
            prose width (720px) can't carry five columns legibly. */}
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
