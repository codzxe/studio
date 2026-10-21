// app/(app)/billing/checkout/cancelled — Stripe Checkout return target (the
// gateway's cancelUrl, §14.3). No charge was made and no session is
// created until the hosted page confirms, so this is a plain landing spot.

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Checkout cancelled",
};

const BACK_LINK_CLASS =
  "inline-flex h-9 items-center justify-center rounded-md border border-border px-4 text-sm font-medium transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function CheckoutCancelledPage() {
  return (
    <section aria-labelledby="checkout-cancelled-heading" className="max-w-xl">
      <h1 id="checkout-cancelled-heading" className="text-2xl font-semibold tracking-tight">
        Checkout cancelled
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        No charge was made — you can pick a plan or credit pack again whenever you&apos;re ready.
      </p>
      <p className="mt-4">
        <Link href="/billing" className={BACK_LINK_CLASS}>
          Back to billing
        </Link>
      </p>
    </section>
  );
}
