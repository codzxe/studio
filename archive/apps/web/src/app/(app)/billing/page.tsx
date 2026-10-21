// app/(app)/billing — plans, credits and the append-only credit ledger
// (W8-K, spec §14). Server shell only: every data surface below is a client
// component in components/billing/* talking to the gateway through the
// typed client (§13). Route pieces:
//   - current plan card + manage-in-portal CTA (§14.3)
//   - balance + 30-day spend summary (GET /v1/credits, /credits/summary)
//   - §14.1 plan grid + credit pack → POST /v1/billing/checkout
//   - cursor-paged ledger (GET /v1/credits, §14.2 kinds)
// Stripe Checkout returns the browser to /billing/checkout/success or
// /billing/checkout/cancelled (§14.3) — webhooks, never the return trip,
// apply subscriptions and pack credits.

import type { Metadata } from "next";
import { CreditsSummary } from "@/components/billing/credits-summary";
import { CurrentPlanCard } from "@/components/billing/current-plan-card";
import { LedgerTable } from "@/components/billing/ledger-table";
import { PlanCardsSection } from "@/components/billing/plan-cards";

export const metadata: Metadata = {
  title: "Billing",
};

export default function BillingPage() {
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Plans, credit packs and every credit movement for this workspace.
        </p>
      </header>
      <CurrentPlanCard />
      <CreditsSummary />
      <PlanCardsSection />
      <LedgerTable />
    </div>
  );
}
