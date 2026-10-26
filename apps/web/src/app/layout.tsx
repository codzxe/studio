import { Brand } from "@studio/config";
import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

/**
 * Fonts (§4.1): display serif + UI sans + mono, self-hosted with next/font so
 * there is no layout shift. Hermetic build: the .ttf binaries under ./fonts/
 * are provisioned by `pnpm fonts:web` (scripts/fetch-web-fonts.mjs) from the
 * pinned google/fonts commit, sha256-verified — NEVER committed (spec §1.5
 * rule 9). CI (web + e2e jobs) and `pnpm dev:ready` run the same fetch. This
 * replaced `next/font/google`, whose BUILD-time fonts.googleapis.com fetch
 * flaked on GitHub runners (2026-10-25/26: "next/font/google queries have
 * exactly one entry", 2 of 3 runs). The next/font variables keep the SAME
 * names as the google variant, so the globals.css stacks are unchanged.
 */
const instrumentSerif = localFont({
  src: [{ path: "./fonts/InstrumentSerif-Regular.ttf", weight: "400", style: "normal" }],
  display: "swap",
  variable: "--font-instrument-serif",
});

const instrumentSans = localFont({
  src: [{ path: "./fonts/InstrumentSans-Variable.ttf", weight: "400 700", style: "normal" }],
  display: "swap",
  variable: "--font-instrument-sans",
});

const jetbrainsMono = localFont({
  src: [{ path: "./fonts/JetBrainsMono-Variable.ttf", weight: "100 800", style: "normal" }],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: {
    default: Brand.titleTag,
    template: `%s — ${Brand.productName}`,
  },
  description: Brand.heroSubline,
  openGraph: {
    title: Brand.titleTag,
    description: Brand.heroSubline,
    siteName: Brand.productName,
    type: "website",
  },
};

export const viewport: Viewport = {
  // Law #8 documented exception: Viewport metadata compiles to the <meta name="theme-color">
  // tag, which cannot hold a CSS var — this hex IS the ink-0 token value; keep in sync.
  themeColor: "#070809", // ink-0 — dark is the only theme in v1 (§17)
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${instrumentSerif.variable} ${instrumentSans.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        {/* §12 — keyboard users land on content first. */}
        <a
          href="#main"
          className="skip-link bg-elevated border-border rounded-sm border px-4 py-2 text-body font-medium text-primary"
        >
          Skip to content
        </a>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
