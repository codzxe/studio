// Marketing route group layout (W8-M) — shared chrome for the marketing
// sub-pages this wave owns (legal stubs, status stub). The home page
// (`app/page.tsx`) is NOT inside this group and composes its own chrome,
// so there is no route conflict (Next.js forbids two page files at `/`).
//
// Spec §16.2: legal pages, status page and footer with legal links are
// part of the marketing site.

import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { Footer } from "@/components/marketing/footer";
import { SITE_NAME } from "@/components/marketing/site";

export const metadata: Metadata = {
  // Pages in this group define their own titles; this is only the fallback.
  title: SITE_NAME,
};

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        {/* TODO(branding): placeholder wordmark — replace with real logo. */}
        <Link href="/" className="font-mono text-lg font-semibold tracking-tight">
          {SITE_NAME}
        </Link>
        <Link
          href="/sign-in"
          className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground"
        >
          Sign in
        </Link>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
      <Footer />
    </div>
  );
}
