// Marketing landing (W8-M) — spec §16.2 option (a): marketing routes live
// inside this Next app, and `/` stays the landing page. This file only
// composes the owned components in `components/marketing/`.
//
// §16.2 section order, enforced here: hero (layers-panel capture
// placeholder) → proof strip → template gallery → before/after → pricing
// (mirrors §14 exactly) → FAQ → security & privacy → changelog → footer.
//
// TODO(§16.2 later waves): sticky site header with nav; interactive demo
// (static wasm editor + capped "try the agent" flow on the shared demo
// workspace §18.4 — never paid AI calls from the marketing site); OG/meta
// images, sitemap and robots.txt (owned by the metadata wave).

import type { Metadata } from "next";
import Link from "next/link";

import { BeforeAfter } from "@/components/marketing/before-after";
import { Changelog } from "@/components/marketing/changelog";
import { CtaBanner } from "@/components/marketing/cta-banner";
import { Faq } from "@/components/marketing/faq";
import { Footer } from "@/components/marketing/footer";
import { Hero } from "@/components/marketing/hero";
import { Pricing } from "@/components/marketing/pricing";
import { ProofStrip } from "@/components/marketing/proof-strip";
import { Security } from "@/components/marketing/security";
import { SITE_NAME } from "@/components/marketing/site";
import { TemplateGallery } from "@/components/marketing/template-gallery";

export const metadata: Metadata = {
  // Root layout (another wave's file) carries the default title/description;
  // the home route pins its own title. canonical/OG land with the metadata wave.
  title: `${SITE_NAME} — prompt to layered design`,
};

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* TODO(§16.2): sticky site header with section nav. */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        {/* TODO(branding): placeholder wordmark — replace with real logo. */}
        <span className="font-mono text-lg font-semibold tracking-tight">{SITE_NAME}</span>
        <Link
          href="/sign-in"
          className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground"
        >
          Sign in
        </Link>
      </header>

      <main className="flex flex-1 flex-col">
        {/* §16.2 order: 1 hero · 2 proof strip · 3 template gallery ·
            4 before/after · 5 pricing · 6 FAQ · 7 security+privacy ·
            8 changelog — then the CTA band and footer. */}
        <Hero />
        <ProofStrip />
        <TemplateGallery />
        <BeforeAfter />
        <Pricing />
        <Faq />
        <Security />
        <Changelog />
        <CtaBanner />
      </main>

      <Footer />
    </div>
  );
}
