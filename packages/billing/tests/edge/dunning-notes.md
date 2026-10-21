# Dunning flow + tax/invoice placeholders — implementation spec (W10-C)

**Status:** SPEC, implementation-ready. Owner tasks at the bottom.
**Anchors:** §14.3 (failed payments: "7-day grace (workspace becomes read-only
after day 3, runs blocked after day 7), then downgrade to a 15-credit holding
state (documents retained read-only). Never delete customer documents for
non-payment without 90-day notice"; Stripe Tax; webhooks are the only source
of truth: `invoice.paid`, `customer.subscription.*`,
`checkout.session.completed`), §19 Phase 4 ("billing edge cases: dunning,
refunds, credits expiry display, tax, invoices, exports"), §13.3 error codes,
runbook RB-07 (Stripe webhook failures).

## 1. Subscription status mapping (webhook-driven only)

Stripe events are the ONLY writers of subscription state (§14.3). The workspace
experience is a **derived** value, never a second stored opinion.

| Stripe event | `subscriptions.status` | derived billing state |
| --- | --- | --- |
| `invoice.paid` | `active` | `active` |
| `invoice.payment_failed` (first) | `past_due` (+ `dunning_started_at` = event time) | `grace` (day 0) |
| `invoice.paid` during dunning | `active`, `dunning_started_at` cleared | `active` — instant recovery |
| `customer.subscription.deleted` | `canceled` | `canceled` |
| `checkout.session.completed` | `active` | `active` (trial→paid) |
| `customer.subscription.updated` | `active` | `active` (plan change) |

Derived state — a pure function, `packages/billing` home (sibling of
`policy.ts`; no clocks inside, `now` injected — W4-M injectable-clock precedent):

```ts
export type BillingState = "active" | "grace" | "read_only" | "downgraded" | "canceled";

export function billingState(input: {
  readonly status: "active" | "past_due" | "canceled" | "none";
  readonly dunningStartedAt: number | null; // ms epoch; set by the FIRST payment_failed
  readonly now: number;
}): BillingState;
// past_due: < 72h → grace | 72h..168h → read_only | ≥ 168h (7 days, §14.3) → downgraded
// none (packs only, no subscription) → active — balance still gates runs (§14.2 rule 1)
```

## 2. Workspace capability matrix (enforcement)

| state | view/export docs | edit docs / upload | agent runs | credits |
| --- | --- | --- | --- | --- |
| `active` | yes | yes | yes | plan pools (§14.1) |
| `grace` (day 0–3) | yes | yes | yes | full — grace means grace (§14.3 "7-day grace") |
| `read_only` (day 3–7) | yes | **no** | yes (recommended reading below) | reserve still allowed |
| `downgraded` (day 7+) | yes (read-only) | no | **no** | 15-credit holding grant |
| `canceled` | yes (read-only) | no | no | holding state + packs |

**AMBIGUITY FLAG (product decision, one table row to flip):** §14.3's literal
words separate "read-only after day 3" from "runs blocked after day 7", which
reads as: runs keep working while documents are frozen. Recommended default
implemented above: day 3 = edits/uploads frozen (an agent run is not a document
edit); day 7 = runs blocked + holding downgrade. The stricter reading (runs
blocked from day 3) is a one-row change in ONE gateway gate — keep the whole
matrix behind that single gate so no archaeology is needed either way.

Enforcement points (gateway):

- One middleware computes `billingState` per request context (auth-context +
  rate-limit precedents). Runs `POST` → typed 402 envelope with
  `hint: "Fix your payment method"` when runs are blocked; document/command/
  upload routes → typed 409/403 read-only envelope (§13.3 codes, no internals
  leaked).
- The gate runs BEFORE `reserveCredits` — the money ledger stays §14.2-exact;
  dunning is a policy layer above it.
- Stripe smart retries: schedule inside the window (e.g. +1d, +3d, +5d, final
  day 7) so the last retry lands before downgrade. RB-07 owns webhook-failure
  handling; never poll Stripe for state.

## 3. Downgrade + the 15-credit holding state (day 7)

- On downgrade: append a holding grant — `kind='grant'`,
  `idempotency_key: holding:${orgId}:${periodKey}`, 15 credits,
  `grant_source='holding'` (see `expiry-display.md` pools). Seats → 1,
  concurrent runs → blocked anyway, documents retained read-only.
- **Credits already granted are never revoked** (fleet precedent: the
  ledger-bridge worklog) — the holding grant ADDS; open holds settle normally.
- Re-activation at any point in the ladder: `invoice.paid` → `active`,
  capabilities restored immediately, `dunning_started_at` cleared, holding
  credits stay (no clawback).
- **Late `invoice.paid` after `customer.subscription.deleted`** (the webhook
  wave's flagged edge): the money grant lands (append-only ledger, credits
  never revoked) but the subscription row stays `canceled` — a paid invoice
  does NOT resurrect a canceled subscription; only `checkout.session.completed`
  does. `billingState` still gates runs from `canceled`.

## 4. Timing + jobs

- `dunning_started_at` is set on the FIRST `invoice.payment_failed`
  (idempotent by Stripe event id — webhook idempotency precedent).
- Day-3 / day-7 / day-90 transitions are cron sweeps over
  `(status, dunning_started_at)` with pure UTC day math (W4-M `dayKeyUtc`
  precedent); injectable clock in tests.
- Email copy placeholders: day 0 "payment failed — retrying", day 3 "your
  workspace is read-only", day 6 "final notice", day 7 "downgraded",
  day-90-minus-notice "documents scheduled for archival". **Never delete
  documents for non-payment before notice + 90 days (§14.3)** — and no
  document-deletion code path exists inside billing, by design.

## 5. Tax + invoices (placeholders — §14.3, §19 Phase 4)

- **Stripe Tax:** enable on the Stripe account + `automatic_tax` on
  subscription/checkout prices; prices displayed inclusive where required
  (§14.3). NO custom tax engine in this repo; we store only what support and
  export need. PLACEHOLDER: tax-exempt customers (certificate handling) is a
  post-beta follow-up.
- **Invoices:** Stripe-hosted invoice objects are the invoice of record. The
  DB keeps a thin projection `billing_invoices` (PLACEHOLDER schema:
  `stripe_invoice_id` unique, `organization_id`, `period_key`,
  `amount_due_cents`, `tax_cents`, `total_cents`, `status`,
  `hosted_invoice_url`) populated by `invoice.*` webhooks — same
  event-id idempotency as the subscription rows.
- **Invoice export = the W9-H CSV.** One CSV path for billing data: invoice
  rows reuse the W9-H usage/ledger CSV exporter (the W4-M lineage: `GET
  /v1/usage` UTC-day rollups + `(created_at,id)` keyset ledger pagination), NOT
  a second exporter. Invoice-view columns: `period`, `stripe_invoice_id`,
  `credits_granted`, `credits_spent` (−Σ run-row deltas for the period),
  `amount_cents`, `tax_cents`, `total_cents`, `status`. NOTE (W10-C
  authoring time): W9-H was not yet in the worklog — the export owner must
  reconcile the exact path/shape and update this section.

## 6. Acceptance tests (for the implementer)

1. `billingState` table: every (status, dunning age) row incl. exact 72h/168h
   boundaries, clock injection, `none` and `canceled` rows.
2. Capability gate: runs POST 402 + edit 409 envelopes per state; `active`
   requests never consult the matrix twice (perf + behavior).
3. Recovery: paid-during-grace restores instantly; no duplicate holding grants
   (idempotency key replay); no clawback of previously granted credits.
4. Late-paid-after-canceled: grant lands, status stays `canceled`.
5. 90-day sweep: notice precedes any archival; zero document-deletion paths in
   billing code.
6. Tax/invoice projection: `invoice.paid` → upsert keyed by
   `stripe_invoice_id`; CSV export reads the projection + ledger fold.

## 7. Owners / touch list

| Change | Owner path (not W10-C's to edit) |
| --- | --- |
| `billingState` pure fn + tests | `packages/billing/src/policy.ts` (billing owner; ports §1/§6) |
| `subscriptions.dunning_started_at`, `billing_invoices` | `packages/db/src/schema/billing.ts` (db owner) |
| capability gate + Stripe smart retries/tax settings | `apps/gateway/src/middleware/*`, `src/services/stripe.ts` |
| day sweeps + dunning emails | `apps/worker` (cron) |
| invoice CSV columns | W9-H export owner (reconcile §5) |
