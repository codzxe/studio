// app/(app)/billing — placeholder (W8-A). TODO(billing wave): plans + credit
// packs mirroring §14.1 exactly, the append-only credit ledger page
// (GET /v1/credits), Stripe Checkout / customer portal entry points (§14.3)
// and daily usage rollups (GET /v1/usage).

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Billing",
};

export default function BillingPage() {
  return (
    <section aria-labelledby="billing-heading" className="max-w-3xl">
      <h1 id="billing-heading" className="text-2xl font-semibold tracking-tight">
        Billing
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Plans, credit packs and your credit ledger will live here — this placeholder keeps the
        shell navigable.
      </p>
    </section>
  );
}
