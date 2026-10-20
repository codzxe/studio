# RB-07 — Stripe webhook failures

- **Alert (§22):** Stripe webhook failures (missed deliveries, signature failures, or
  processing errors on `POST /v1/webhooks/stripe`).
- **Owner:** on-call engineer · **Severity:** critical (money state) · **Spec:** §22 alerts, §14.3 Stripe, §15.2 webhooks

## Symptom

Stripe reports delivery failures in the dashboard, the endpoint's 5xx rate rises, or
our metrics count `webhook_processing_failed` for events like `invoice.paid`,
`checkout.session.completed`, `customer.subscription.*`. Workspaces may show stale plan
state (paid users flagged as past-due, or trials not upgraded).

## Impact

**Webhooks are the only source of truth for subscription state** (§14.3). Missed events
mean wrong plan gating: customers locked out (failed payment read-only rules,
§14.3: grace day 3 → read-only, day 7 → runs blocked) or given credits they paid for
late. This is the one alert where user-visible billing correctness is at stake.

## Diagnosis

1. Endpoint health: `GET /v1/health/deep` (gateway) — recent 5xx from the Stripe route?
   Worker logs for the event-id idempotency table (`idempotency_keys`, W1-F) —
   duplicates rejected by design (§15.2: idempotent by event id).
2. Signature failures (400s): did `STRIPE_WEBHOOK_SECRET` rotate or diverge between
   `.env` files (ADR-0002: separate keys per environment — staging must use Stripe test
   keys, §17.5)? A secret mismatch fails *every* delivery loudly.
3. Processing failures (5xx): which handler? `invoice.paid` → credit grant + ledger;
   `customer.subscription.*` → plan row updates. Check Postgres availability and the
   append-only ledger constraint (duplicate key = already processed → ack and move on).
4. Stripe-side incident: check Stripe status; retries have a window (Stripe retries
   for ~3 days) — events are re-deliverable from the dashboard, so nothing is lost if
   we fix within the window.

## Fix

1. **Secret mismatch:** restore the correct `STRIPE_WEBHOOK_SECRET` per environment
   (§15.2 secrets are env-only; never in the repo), restart gateway, then replay
   failed events from the Stripe dashboard in order.
2. **Handler bug:** fix forward; Stripe's automatic retries will redeliver — verify
   each event id processes exactly once (§15.2) via the idempotency table before/after.
3. **Postgres down:** that's a deeper incident — after DB recovery, replay events
   (dashboard) and reconcile `subscriptions` against `GET /v1/usage`-side state.
4. **Reconciliation after a long outage:** walk Stripe's event list for the gap
   window, re-drive the same handlers, then run the ledger-vs-Stripe diff for the
   affected customers (manual credit adjustments go through `audit_log`, §15.4).

## Verification

- No failed deliveries for 24 h; endpoint 2xx rate 100 %; each replayed event id
  processed exactly once (no duplicate ledger entries — §14.2 r6 idempotency).
- Affected workspaces show correct plan/credits; a test purchase in Stripe test mode
  (staging, §17.5) flows checkout → webhook → ledger end-to-end.
- §22 metrics: credits reserved/committed continue matching ledger state.

## Postmortem

Record window, event ids replayed, root cause (secret rotation? handler? DB?), and
whether idempotency held. Add the failure mode as a test case (Stripe test-mode
fixtures). If the alert fired late, tune the §22 webhook-failure alert. Update
`docs/devlog.md`.
