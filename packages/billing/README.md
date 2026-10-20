# @studio/billing

Pure billing domain for the studio SaaS (spec §14 + §5.2 + §24.4): the credits
ledger (reserve → commit | refund), plan gating, the one-time trial, tier cost
resolution and failure/refund policy. **Zero runtime dependencies beyond `zod`
and the `@studio/config` constants.** There is no database code here — all state
goes through the `LedgerStore` seam, so the Drizzle-backed repo layer can land
in a later wave without touching this package's semantics.

## §14.2 deduction rules — the exact contract

| # | Rule (spec) | Implementation |
|---|---|---|
| 1 | On run creation **reserve** the tier's base cost and check the balance. Insufficient → 402, the run never starts. | `reserveCredits` — the hold is a ledger row `{kind:"reserve", delta:-A}` so the available balance drops immediately and concurrent runs cannot over-commit. Shortfall → `insufficient_credits` + top-up hint, nothing appended. |
| 2 | On success **commit** — charge the actual cost (multipliers included; images charged per image produced). | `commitReservation` — one settlement row `{kind:"commit", delta: A − charged}` releases the hold and applies the charge atomically. `charged` defaults to `A`; a §5.2 budget stop passes a smaller value; a §24.4 grace retry passes `0`. Never more than the hold (excess is clamped). |
| 3 | Failure/cancel before any mutating command → **release the full reservation**. | `releaseReservation` with the default zero charge → refund row `{kind:"refund", delta:+A}`; net ledger effect zero. |
| 4 | Failure after partial progress → **charge at most half the base**, release the rest. | `releaseReservation({amountCharged})` — clamped to `maxPartialFailureCharge(A) = ⌊A/2⌋` (§14.2 rule 4 constant `0.5` in `@studio/config`); refund row carries `A − charged`. |
| 5 | Repairs/retries within the tier never cost extra. **Our bug** caused a failure → refund fully, flag for review. | One commit per run covers all repair cycles. `classifyRefund("our_bug") = "full_refund"` → release with zero charge even after progress. |
| 6 | Each phase carries an `idempotency_key` derived from `run_id + phase`; the ledger rejects duplicates. | Keys `` `${runId}:reserve` `` / `` `${runId}:commit` `` / `` `${runId}:refund` ``; a second call with the same key is a **no-op returning the outcome** (`duplicate: true`). The DB unique `(idempotency_key, kind)` index (packages/db) is the backstop. |
| 7 | Daily workspace cap (default 2× monthly plan credits), alert at 80%. | `dailySpendPolicy(planCode)` → `{capCredits, alertAtCredits}` (§14.2 rule 7). Enforcement belongs to the gateway/worker; this is the policy source. |

## Ledger model (one append per phase — auditable, crash-safe)

A standard run (A = 2) for a workspace holding 10 credits:

| Phase | Ledger row | Running balance | Net |
|---|---|---|---|
| grant | `{kind:"grant", delta:+10}` | 10 | — |
| `reserveCredits` | `{kind:"reserve", delta:-2, key:"run:reserve"}` | 8 | hold taken (§3.3 step 2) |
| `commitReservation` (full) | `{kind:"commit", delta:0, key:"run:commit"}` | 8 | paid exactly 2 (§3.3 step 6) |
| — or §5.2 budget stop, charge 1 | `{kind:"commit", delta:+1}` | 9 | paid 1 |
| — or `releaseReservation` (clean failure) | `{kind:"refund", delta:+2, key:"run:refund"}` | 10 | paid 0 (§3.3 step 7) |
| — or §14.2 rule 4, partial charge 1 | `{kind:"refund", delta:+1}` | 9 | paid 1 |

Invariants (enforced by tests, mirrored by the in-memory fake):

- **Exactly-once per phase** — every phase is a *single* append, so a crash
  between phases leaves a derivable state (`reservationStatus`: `none → held →
  committed | released`) and a same-key retry replays the outcome. Retries never
  double-charge (§3.4).
- **Balance never negative** — the only negative append is the reserve, which is
  balance-checked first; all terminal deltas are ≥ 0.
- **Terminals are mutually exclusive** — commit after release (or vice versa)
  is a `conflict`; both are idempotent no-ops when replayed.
- **Append-only** — nothing is ever updated or deleted (§12.2); corrections
  are new `adjustment` rows by the repo layer.

## Trial (§1.4, §14.1)

`trialGrant(orgId, ledger)` grants the one-time 30 credits through the ledger
(key `trial-grant:<orgId>`, kind `grant`). The second call for the same
workspace grants **nothing** (`granted:false, duplicate:true`) — a
double-clicked signup or a replayed webhook cannot mint trial credits twice.
There is no free tier (§1.4); account-level email/payment-fingerprint dedupe
happens at signup, this is the last line of defence.

## Policy (§5.2 / §24.4 / §14.4)

- `creditsForRun(tier)` — quick 1, standard 2, complex 5, **premium 4**
  (standard ×2), **max 8** (standard ×4, §14.4), image 1, image HD 2.
  `creditsForImages(count, {hd})` for per-image charges.
- `classifyRefund(cause)` → `full_refund` (user cancel, our provider failure,
  our bug) | `partial` (failures after partial progress) | `none`
  (§5.2 budget stop is a clean stop, not a failure).
- `isFreeRetry(cause, retryAttempt)` — the **first** retry caused by our
  provider failure is free (`retry_grace: 1`); the free retry commits a zero
  charge. Retries after our own bug are normal paid runs (rule 5 refunds the
  failed attempt).
- §14.4 guardrails (pure predicates for the monitoring stack):
  workspace COGS > 35% of revenue, a run > 3× its tier average, platform COGS
  > 25% of MRR.

## Plans (§14.1)

`@studio/config` owns the numbers (Zod-validated at import): `PLANS`
starter/pro/business — $30/$60/$120 per month → 100/250/600 credits, extra
seat +$8 — plus `PLAN_LIMITS` (seats 1/3/10, concurrent runs 1/3/6, canvas
32/64/128 MP). This package adds `PLAN_CATALOG` (the joined view),
`canRunTier(balance, tier)`, `seatPlanLimits(planCode)` and
`dailySpendPolicy(planCode)`.

> Contract note: the task sketch named `PLAN_PRICING` / `starter|pro|max`;
> the landed `@studio/config` export is `PLANS` with ids
> `starter|pro|business` and field `extraSeatPriceUsdCents` (`max` is a run
> tier, not a plan). Adjusted accordingly.

## Stripe (§14.3) — not in this package

Webhooks are the only source of truth for subscription state; failed payments
follow the 7-day grace ladder (read-only after day 3, 15-credit holding state,
90-day deletion notice). Those flows live with the gateway/webhook services;
this package is the pure money math they call.

## Storage implementation notes (for the repo-layer agent)

`LedgerStore` implementations must: reject duplicate `(idempotencyKey, kind)`
appends (DB unique index), keep `balance_after` per row auditable, scope by
`organizationId` (§12.2), and wrap "check balance + append" for `reserveCredits`
in one transaction. `findByIdempotency` is key-scoped, not org-scoped — run ids
are globally unique, and callers must replay **identical arguments** on retry
(Stripe-style idempotency contract).
