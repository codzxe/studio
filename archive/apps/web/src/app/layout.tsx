// Root layout (W1-K) — marketing and product UI live in this one Next app
// (spec §16.2 option (a); ADR-0002). Fonts: CSS system stack only (see
// globals.css) — no font files are ever committed (docs/AGENTS.md).

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

// TODO(branding): "Layerly" is a temporary neutral working name (W1-K);
// the forbidden names (PhotoCraft/ArtCraft/Photoshop/Cursor, §1.5) and the
// internal codename never appear in user-facing strings.
const SITE_NAME = "Layerly";

export const metadata: Metadata = {
  title: {
    default: `${SITE_NAME} — prompt to layered document`,
    template: `%s — ${SITE_NAME}`,
  },
  description:
    "Describe the outcome and AI agents compose a real layered document — text, photos, shapes and masks you can open, refine by hand or by chat, version and export.",
  // TODO(§16.2 plumbing wave): metadataBase (NEXT_PUBLIC_APP_URL), OG/Twitter
  // images, sitemap.ts, robots.ts, favicon — land with the marketing build-out.
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
