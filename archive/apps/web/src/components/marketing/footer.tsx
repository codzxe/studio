// Footer (W8-M) — spec §16.2 section 9 + plumbing: footer with legal pages,
// a public status page link, and the no-cookie analytics note. Legal pages
// are honest placeholders pending review (TODO(legal-review) in their files).

import Link from "next/link";
import { SITE_NAME } from "./site";

const PRODUCT_LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: "/#pricing", label: "Pricing" },
  { href: "/#templates", label: "Templates" },
  { href: "/#before-after", label: "Flat vs. layers" },
  { href: "/#faq", label: "FAQ" },
  { href: "/#changelog", label: "Changelog" },
] as const;

const LEGAL_LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: "/legal/terms", label: "Terms of service" },
  { href: "/legal/privacy", label: "Privacy" },
  { href: "/status", label: "Status page" },
] as const;

export function Footer() {
  return (
    <footer
      className="border-t border-border py-10"
      data-testid="marketing-footer"
    >
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-6 sm:grid-cols-3">
        <div>
          <p className="font-mono text-sm font-semibold tracking-tight">{SITE_NAME}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Prompt to layered design. Every result is an editable layered
            document — never a flat AI image.
          </p>
        </div>
        <nav aria-label="Product">
          <p className="text-xs font-semibold text-muted-foreground">Product</p>
          <ul className="mt-2 space-y-1.5">
            {PRODUCT_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="text-sm underline-offset-4 hover:underline">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Legal">
          <p className="text-xs font-semibold text-muted-foreground">Legal &amp; status</p>
          <ul className="mt-2 space-y-1.5">
            {LEGAL_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="text-sm underline-offset-4 hover:underline">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="mx-auto mt-8 w-full max-w-6xl px-6">
        <p className="text-xs text-muted-foreground">
          This site uses cookie-free analytics — no cookies, no cross-site
          tracking (see the privacy page).
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          © {new Date().getFullYear()} {SITE_NAME}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
