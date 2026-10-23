import { Brand } from "@studio/config";
import Link from "next/link";

/**
 * SiteFooter — §8.1 §11: product / resources / legal / licences / status /
 * changelog columns, signal dot + wordmark, honest footer copy. M9-E: the
 * pricing, FAQ, changelog and status links point at the REAL in-app routes.
 * W5-LINK: the "Documentation" external link is GONE — the docs host is a
 * Brand placeholder token (`docs.studio.example.com` resolves nowhere), and
 * M9 has no dead links; it returns when the docs site ships. The footer note
 * still covers the remaining launch-time tokens (contact addresses).
 */

const COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Pricing", href: "/pricing" },
      { label: "FAQ", href: "/faq" },
      { label: "The agent", href: "/#agent" },
      { label: "The editor", href: "/#product" },
      { label: "Changelog", href: "/changelog" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Support", href: `mailto:${Brand.contact.support}` },
      { label: "Status", href: "/status" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "/legal/terms" },
      { label: "Privacy", href: "/legal/privacy" },
      { label: "Licences", href: "/legal/licences" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer data-testid="landing-footer" className="border-t border-border bg-page py-16">
      <div className="mx-auto max-w-(--width-marketing-max) px-5 md:px-8 lg:px-12 xl:px-16">
        <div className="grid gap-12 md:grid-cols-[2fr_1fr_1fr_1fr]">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-pill bg-signal" />
              <span className="font-display text-title-l text-primary">{Brand.productName}</span>
            </div>
            <p className="max-w-[38ch] text-caption leading-relaxed text-muted">
              A composition editor with an agent that understands layers, keyframes and taste. Built
              on an open-source compositing engine — see the licences page.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <nav key={column.title} aria-label={column.title} className="flex flex-col gap-3">
              <h2 className="text-label uppercase tracking-[0.06em] text-muted">{column.title}</h2>
              <ul className="flex flex-col gap-2">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-body-s text-secondary transition-colors duration-120 hover:text-primary"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-16 flex flex-col gap-2 border-t border-border pt-8 text-caption text-muted md:flex-row md:items-center md:justify-between">
          <p>
            © {new Date().getFullYear()} {Brand.productName}. {Brand.titleTag}.
          </p>
          <p>
            This is a beta product. Prices, plans and placeholder links are finalised at launch.
          </p>
        </div>
      </div>
    </footer>
  );
}
