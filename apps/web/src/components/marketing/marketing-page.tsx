import { FrameLine } from "@studio/ui";
import Link from "next/link";

/**
 * Shared editorial shell for the marketing content pages — pricing, FAQ,
 * changelog, status (§8.1's sibling surfaces, M9-E). Strong left edge (§5.2),
 * prose or marketing width (§5.1), overline + serif title + one-line intro in
 * the landing's voice. Tokens only; no raw hex anywhere.
 */

export function MarketingPage({
  testid,
  kicker,
  title,
  intro,
  children,
  narrow = false,
}: {
  /** Section test id — the page tests pin structure on it. */
  testid: string;
  /** §4.2 overline, e.g. "Studio — Pricing" (callers build it from Brand tokens). */
  kicker: string;
  /** Serif page title (§4.2 display-m — short, never body copy). */
  title: string;
  /** One-sentence intro, ≤ 68ch (§4.2). */
  intro: string;
  children: React.ReactNode;
  /** Constrain to the 720px prose width instead of the 1200px marketing width. */
  narrow?: boolean;
}) {
  return (
    <div
      data-testid={testid}
      className={`mx-auto w-full px-5 py-20 md:px-8 xl:py-28 ${
        narrow ? "max-w-(--width-prose-max)" : "max-w-(--width-marketing-max)"
      }`}
    >
      <p className="text-label uppercase tracking-[0.06em] text-muted">{kicker}</p>
      <h1 className="mt-4 font-display text-display-m text-balance text-primary">{title}</h1>
      <p className="mt-4 max-w-[68ch] text-body-l leading-relaxed text-secondary">{intro}</p>
      <div className="mt-12 flex flex-col gap-16">{children}</div>
    </div>
  );
}

/** One framed block inside a marketing page: frame line (§2.3) + content. */
export function MarketingSection({
  label,
  title,
  children,
}: {
  /** Timecode label, e.g. "00:00:01 — THE PLANS". */
  label: string;
  /** Optional block heading (h2). */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-8">
      <FrameLine label={label} draw />
      {title !== undefined ? <h2 className="text-title-l text-primary">{title}</h2> : null}
      {children}
    </section>
  );
}

/** Inline text link in marketing copy (§4.3: paper, underline, hover signal). */
export function MarketingLink({
  href,
  children,
  external = false,
}: {
  href: string;
  children: React.ReactNode;
  /** External links (currently mailto contacts) open in a new tab. */
  external?: boolean;
}) {
  const className =
    "text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal";
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
