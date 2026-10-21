import { Brand } from "@studio/config";
import { FrameLine } from "@studio/ui";
import Link from "next/link";

/**
 * Shared shell for the legal pages (§8.9-adjacent editorial): prose max-width
 * 720px (§5.1), frame-line label, honest beta note. NO lorem ipsum — every
 * page carries its own real (if concise) copy.
 */

export function LegalPage({
  testid,
  title,
  intro,
  children,
}: {
  testid: string;
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testid}
      className="mx-auto w-full max-w-(--width-prose-max) px-5 py-20 md:px-8 xl:py-28"
    >
      <p className="text-label uppercase tracking-[0.06em] text-muted">
        {Brand.productName} — Legal
      </p>
      <h1 className="mt-4 font-display text-display-m text-balance text-primary">{title}</h1>
      <p className="mt-4 text-body-l leading-relaxed text-secondary">{intro}</p>

      <div className="mt-8 border border-border bg-panel p-4 text-body-s text-secondary rounded-md">
        This is a beta product; final terms are being reviewed. This page is the working draft we
        operate under today — clear about what the service does, without legalese.
      </div>

      <div className="mt-12 flex flex-col gap-10">{children}</div>

      <div className="mt-16">
        <FrameLine label="END — LEGAL" draw />
        <p className="mt-6 text-caption text-muted">
          Questions about this page?{" "}
          <a
            href={`mailto:${Brand.contact.support}`}
            className="text-secondary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            {Brand.contact.support}
          </a>
        </p>
      </div>
    </div>
  );
}

/** One legal section: numbered heading + paragraphs. */
export function LegalSection({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-baseline gap-3 text-title-m text-primary">
        <span className="tabular text-mono text-muted">{n}</span>
        {title}
      </h2>
      <div className="flex flex-col gap-3 text-body leading-relaxed text-secondary">{children}</div>
    </section>
  );
}

/** Cross-link row at the bottom of legal pages. */
export function LegalCrossLinks() {
  return (
    <p className="text-caption text-muted">
      See also:{" "}
      <Link href="/legal/terms" className="underline underline-offset-3 hover:text-signal">
        Terms
      </Link>
      {" · "}
      <Link href="/legal/privacy" className="underline underline-offset-3 hover:text-signal">
        Privacy
      </Link>
      {" · "}
      <Link href="/legal/licences" className="underline underline-offset-3 hover:text-signal">
        Licences
      </Link>
    </p>
  );
}
