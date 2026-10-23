import { AuthOfflineNotice } from "@/components/auth/auth-offline-notice";
import { Brand } from "@studio/config";
import { FrameLine } from "@studio/ui";
import Link from "next/link";

/**
 * Auth split layout (§8.2): left 55% form on bg-app; right 45% a cinematic
 * panel on ink-0 (bg-page) with a frame line, a serif pull-quote and a tiny
 * caption. Below lg the panel collapses to a 16:9 banner above the form
 * (flex-col-reverse — the form stays first in DOM/reading order).
 *
 * M9-H: AuthOfflineNotice adds the §8.11 offline state to every auth page —
 * it renders null while online, so the visual layout is unchanged.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col-reverse lg:grid lg:grid-cols-[55fr_45fr]">
      <main id="main" className="flex flex-1 flex-col bg-app px-5 py-10 sm:px-8 lg:px-16 lg:py-12">
        <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-center gap-12 py-10">
          <AuthOfflineNotice />
          {children}
        </div>
        <p className="mx-auto w-full max-w-[480px] text-caption text-muted">
          By continuing you agree to the{" "}
          <Link
            href="/legal/terms"
            className="underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            terms
          </Link>{" "}
          and{" "}
          <Link
            href="/legal/privacy"
            className="underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            privacy policy
          </Link>
          .
        </p>
      </main>

      <aside
        aria-label={`${Brand.productName} — the approach`}
        className="relative flex aspect-video items-center justify-center border-b border-border bg-page px-8 lg:aspect-auto lg:min-h-svh lg:border-b-0 lg:border-l"
      >
        {/* w-auto overrides FrameLine's w-full: with left-6/right-6 insets the
            rule stretches between them (w-full would pin it to the containing
            block's width ON TOP of the left inset → 24px horizontal overflow
            at 320px, §12/§13 gate). */}
        <FrameLine
          label="00:00:00 — OPENING FRAME"
          className="absolute top-6 right-6 left-6 w-auto"
          draw
        />
        <figure className="flex max-w-[36ch] flex-col items-center gap-4 text-center">
          <blockquote className="font-display text-display-m text-balance text-primary">
            “Ask. Review the plan. Apply.”
          </blockquote>
          <figcaption className="text-caption text-muted">
            The agent&apos;s working thesis — {Brand.productName}, an agent motion suite.
          </figcaption>
        </figure>
      </aside>
    </div>
  );
}
