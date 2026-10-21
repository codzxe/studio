// Terms of service — HONEST PLACEHOLDER (W8-M).
//
// TODO(legal-review): every section below is a plain-language summary of the
// product rules as specified (§14, §10.3, §1.4), written so the page cannot
// mislead while real counsel-reviewed terms are pending. It is NOT legal
// advice and must not ship to production unchanged. A human reviewer must
// confirm: legal entity + jurisdiction, final pack-expiry wording, refund
// policy wording, and the disclaimer block.

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of service",
  description: "Placeholder terms of service — plain-language product rules, pending legal review.",
};

const SECTIONS: readonly { readonly heading: string; readonly body: readonly string[] }[] = [
  {
    heading: "Accounts and the trial",
    body: [
      "New accounts receive a one-time 30-credit trial grant. No card is required, and the trial is limited to one per account (email and payment-fingerprint dedupe).",
      "There is no free tier: after the trial, using the service requires a paid plan.",
    ],
  },
  {
    heading: "Plans and credits",
    body: [
      "Plans: Starter $30/mo (100 credits), Pro $60/mo (250 credits), Max $120/mo (600 credits). Every plan includes the full editor; plans differ in credits, seats (1/3/10, extra seats +$8/mo), concurrent runs (1/3/6) and maximum canvas size (32/64/128 MP).",
      "One credit equals $0.10 of list price. Quick edit runs cost 1 credit, standard runs 2, complex runs 5; premium and max model routes multiply the tier's cost by 2 and 4; generated images cost 1 credit per image at 1024² and 2 per HD image.",
      "Credit packs: $10 per 100 credits. Packs do not expire while you are subscribed; expiry after cancellation follows the wording confirmed in review. TODO(legal-review): final expiry wording.",
    ],
  },
  {
    heading: "Failed runs and refunds",
    body: [
      "Runs reserve their credit cost up front and commit only on success. A failure before any document change releases the full reservation; a partial failure charges at most half the run's cost. Failures caused by our bug are refunded in full. Repairs and retries within a run never cost extra.",
    ],
  },
  {
    heading: "Exports",
    body: [
      "The native .pcraft format is lossless and round-trip-perfect. PNG and JPG exports are exact renders. PSD export is experimental — best-effort, always accompanied by a fidelity report; we never promise a perfect PSD.",
      "Re-downloading an existing export is free; new renders at new sizes are credit events.",
    ],
  },
  {
    heading: "Payments",
    body: [
      "Subscriptions and packs are billed via Stripe. Card data never touches our servers. Failed payments enter a 7-day grace period (workspace read-only after day 3, runs blocked after day 7), then a 15-credit read-only holding state. We never delete documents for non-payment without 90 days' notice.",
    ],
  },
  {
    heading: "Your content",
    body: [
      "You keep ownership of what you create. We process your content only to provide the service (see the privacy page): no training on your data, no free-tier model routes, no resale of your work.",
    ],
  },
] as const;

export default function TermsPage() {
  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-14" data-testid="marketing-legal-terms">
      <p className="inline-block rounded-full border border-border bg-surface-muted px-3 py-1 font-mono text-xs text-muted-foreground">
        placeholder — pending legal review
      </p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Terms of service</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Plain-language summary of the product rules. This page is a placeholder
        until legal review completes — it is informative, not a binding
        agreement.
      </p>
      <div className="mt-10 space-y-8">
        {SECTIONS.map((section) => (
          <div key={section.heading}>
            <h2 className="text-lg font-semibold">{section.heading}</h2>
            <div className="mt-2 space-y-2">
              {section.body.map((paragraph) => (
                <p key={paragraph} className="text-sm leading-relaxed text-muted-foreground">
                  {paragraph}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
