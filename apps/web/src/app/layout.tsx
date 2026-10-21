import { Brand } from "@studio/config";
import type { Metadata, Viewport } from "next";
import { Instrument_Sans, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Fonts (§4.1): display serif + UI sans + mono, loaded with next/font so
 * there is no layout shift. The next/font variables are mapped onto the
 * design-system stacks in globals.css (see packages/ui/README.md §2).
 * If Google Fonts is unreachable at build time, switch to the documented
 * @fontsource fallback (apps/web/README.md) — same variable names.
 */
const instrumentSerif = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-instrument-serif",
});

const instrumentSans = Instrument_Sans({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-instrument-sans",
});

const jetbrainsMono = JetBrains_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
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
      </body>
    </html>
  );
}
