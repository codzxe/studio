// CTA banner (W8-M) — final call-to-action band above the footer. Copy is
// metered and honest (§16.2): one-time 30-credit trial, no card, no free
// tier (§1.4); plans from $30/mo (§14.1); costs shown before sign-up.

import Link from "next/link";

export function CtaBanner() {
  return (
    <section
      className="mx-auto w-full max-w-6xl px-6 py-14"
      data-testid="marketing-cta-banner"
    >
      <div className="rounded-lg border border-border bg-surface-muted px-6 py-10 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">
          Start with 30 credits, on us
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          A one-time trial grant — no card required. After that, plans start at
          $30/mo and every action&apos;s credit cost is visible before you spend
          anything. There is no free tier.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/sign-up"
            className="rounded-md bg-accent px-5 py-3 text-sm font-semibold text-accent-foreground transition hover:opacity-90"
          >
            Create your account
          </Link>
          <Link
            href="/sign-in"
            className="rounded-md border border-border bg-surface px-5 py-3 text-sm font-semibold transition hover:bg-surface"
          >
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}
