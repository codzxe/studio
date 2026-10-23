import { Brand } from "@studio/config";
import { buttonVariants } from "@studio/ui";
import Link from "next/link";

/**
 * SiteHeader — §8.1 marketing chrome. Signal dot + serif wordmark
 * (§2.3 signature elements), quiet nav, one ghost + one primary action.
 * Links point at the landing's in-page sections and the auth pages.
 */

const NAV_LINKS = [
  { label: "Product", href: "/#product" },
  { label: "Agents", href: "/#agent" },
  { label: "Work", href: "/#work" },
  // M9-E: /pricing is a real page now — the nav points at the catalog-derived
  // spread instead of the landing's teaser anchor (§8.1 nav stays 4 items).
  { label: "Pricing", href: "/pricing" },
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-app">
      <div className="mx-auto flex h-16 max-w-(--width-marketing-max) items-center justify-between gap-6 px-5 md:px-8 lg:px-12 xl:px-16">
        <Link
          href="/"
          className="flex items-center gap-2.5"
          aria-label={`${Brand.productName} — home`}
        >
          {/* §2.3 the signal dot — small accent, never a glowing orb. */}
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-pill bg-signal" />
          <span className="font-display text-title-l leading-none text-primary">
            {Brand.productName}
          </span>
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="text-body text-secondary transition-colors duration-120 hover:text-primary"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link href="/sign-in" className={buttonVariants({ variant: "ghost", size: "lg" })}>
            Sign in
          </Link>
          <Link href="/sign-up" className={buttonVariants({ variant: "primary", size: "lg" })}>
            Start trial
          </Link>
        </div>
      </div>
    </header>
  );
}
