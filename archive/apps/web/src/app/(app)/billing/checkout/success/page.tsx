// app/(app)/billing/checkout/success — Stripe Checkout return target (the
// gateway's successUrl, §14.3). Webhooks are the only source of truth for
// subscription state, so this page only lands the user back in the app:
// the balance and ledger refresh once `checkout.session.completed` applies
// the subscription or pack credits. The session_id query param is internal
// (§13.3 — no internal ids on screens) and is deliberately not displayed.

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Checkout complete",
};

const BACK_LINK_CLASS =
  "inline-flex h-9 items-center justify-center rounded-md border border-border px-4 text-sm font-medium transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function CheckoutSuccessPage() {
  return (
    <section aria-labelledby="checkout-success-heading" className="max-w-xl">
      <h1 id="checkout-success-heading" className="text-2xl font-semibold tracking-tight">
        Checkout complete
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Thanks — your subscription or credit pack is applied as soon as Stripe confirms the
        payment, usually within a minute. Nothing else to do here.
      </p>
      <p className="mt-4">
        <Link href="/billing" className={BACK_LINK_CLASS}>
          Back to billing
        </Link>
      </p>
    </section>
  );
}
