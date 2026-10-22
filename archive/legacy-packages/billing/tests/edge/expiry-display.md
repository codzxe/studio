# Credits expiry display — implementation spec (W10-C)

**Status:** SPEC, implementation-ready. Owner tasks at the bottom.
**Anchors:** §14.1 (plans/credits; "monthly credits do not roll over"; packs
"never expiring while subscribed, expiry stated in the ToS"; trial = one-time
30 credits), §14.3 (webhooks are the only source of truth for subscription
state), §12.1/§12.2 (ledger kinds; append-only rows; balance ≡ Σ deltas),
§19 Phase 4 ("billing edge cases: … credits expiry display …").
**Why it lives here:** this file is the §19 Phase 4 edge-case spec written next
to the edge tests (`tests/edge/`), so the implementer can port its acceptance
table directly.

## 1. The three credit pools

| Pool | Ledger rows | Expiry | Rollover |
| --- | --- | --- | --- |
| **plan (monthly)** | `kind='grant'` appended by the `invoice.paid` bridge (`stripe:${eventId}` key) | end of the current subscription period | **none** — unspent credits are void at period rollover (§14.1) |
| **pack** | `kind='pack'` (checkout credit pack, $10 / 100 credits) | none **while subscribed**; after cancellation expiry is a ToS decision — PLACEHOLDER default 90 days, aligned with the §14.3 90-day document-retention notice | keeps forever while subscribed |
| **trial** | `kind='grant'`, trial provenance; eligibility/one-per-account in `src/limits/trial-rules.ts` | trial end (no card required, §14.1) | one-time grant |

## 2. Ledger changes needed (packages/db owner — forward-only migration)

Today grant rows carry no expiry dimension, so "expiring" cannot be displayed
or swept honestly. Additive, append-only-friendly columns on `credit_ledger`:

- `grant_source text` — `'plan' | 'pack' | 'trial' | 'holding'`; NULL for run
  rows (reserve/commit/refund/adjustment).
- `period_key text` — e.g. `'2026-03'` for plan grants; NULL otherwise.
- `expires_at timestamptz` — plan grants: the subscription's
  `current_period_end`; packs: NULL while subscribed; trial: trial end.

The `invoice.paid` webhook path (gateway `billing-complete/ledger-bridge.ts`)
stamps plan grants with all three. Webhooks remain the only source of truth for
period timing (§14.3) — never derive `expires_at` client-side or from a cron's
opinion of "a month".

**Rollover is an append, never an UPDATE (§12.2):** at period rollover the
worker appends `kind='adjustment'` rows with `delta = -(remaining plan credits
for that period)`, idempotency key `expiry:${organizationId}:${periodKey}`.
The void is auditable; credits never silently vanish from the sum.

## 3. Display contract (the rules the UI must hold)

1. **Total credits = Σ unexpired pool remainders − open holds/charges**, and
   it MUST equal `LedgerStore.balanceAfter` (§12.2). The pool split is a *view*
   over the same sum — never a second source of truth.
2. **Monthly credits say "resets on \<period-end date\>", never "expires"** —
   they reset at rollover; they do not vanish mid-cycle. No mid-cycle
   countdown copy.
3. **Packs never show expiry copy while the subscription is active** (§14.1).
4. **Spend order: monthly burns before packs** (packs are the buffer). The
   display and the spend-attribution fold must agree (see §4).
5. **Expiring-soon:** show "X plan credits reset in N days" only when
   `0 < N ≤ 3`; trial: "Y trial credits expire \<date\>".
6. **Zero states:** no subscription + no packs → `0` + upgrade CTA; the
   §14.3 15-credit holding state renders as its own `holding` pool.
7. **Never imply rollover.** At rollover the badge drops by the voided amount —
   that is the product (§14.1), so the copy must not apologize with math.

## 4. The ledger query (expiry-aware split + spend order)

Pool remainders (SQL sketch; the repo layer ports this):

```sql
-- pools: unexpired credits-in, grouped by source and expiry bucket
SELECT grant_source, expires_at, SUM(delta) AS pool_remaining
FROM credit_ledger
WHERE organization_id = $1
  AND grant_source IS NOT NULL
  AND (expires_at IS NULL OR expires_at > now())
GROUP BY grant_source, expires_at
HAVING SUM(delta) <> 0;   -- fully-consumed pools drop out
```

Spend attribution (monthly-first): fold the run rows (reserve/commit/refund)
in append order (the `created_at,id` keyset W4-M paginates by) against the
pool stack `[plan (oldest expires_at first), trial, pack]`, decrementing
pool remainders by each charged amount. Invariant: attribution total ≡
`−Σ run-row deltas` ≡ `balance − Σ(grants+packs)` — see the acceptance tests.

Daily expiry sweep (worker cron, pure UTC day math — W4-M `dayKeyUtc` precedent,
injectable clock):

```sql
-- expired pool remainders to void (plan/trial only; packs have NULL expires_at)
SELECT organization_id, grant_source, expires_at, SUM(delta) AS remaining
FROM credit_ledger
WHERE kind IN ('grant','pack') AND expires_at IS NOT NULL AND expires_at <= now()
GROUP BY organization_id, grant_source, expires_at
HAVING SUM(delta) > 0;
-- for each row: append adjustment −remaining, key expiry:${org}:${period_key}
```

## 5. API + UI wiring

- `GET /v1/credits` (gateway `routes/credits.ts`, W4-M) keeps the flat
  `balance` as the authoritative number and adds
  `pools: [{ source: 'plan'|'pack'|'trial'|'holding', remaining: number, resets_at: string|null }]`
  — snake_case wire, per the W4-M wire-contract conventions.
- Web (`apps/web`): `components/billing/credits-summary.tsx` +
  `use-billing.ts` render the pools and the §3 copy rules;
  `components/shell/credits-badge.tsx` keeps showing only the flat total.
- `GET /v1/credits/summary` `open_holds` already reports in-flight holds —
  the "resets in N days" copy must subtract them the same way §3 rule 1 does.

## 6. Acceptance tests (port into `tests/edge/` or gateway tests)

1. **Split-sums invariant:** Σ pool remainders − open holds === `balanceAfter`
   across randomized run boards (property test).
2. **Rollover void:** expired plan remainder voided exactly once (idempotency
   key replay); packs and trial untouched by a plan rollover.
3. **Spend order:** charges consume plan first, packs only at plan = 0;
   attribution total === −Σ run deltas.
4. **Display copy table:** monthly / pack / trial / holding / zero states per
   §3 rules 1-7 (rules-as-table, one row per rule).
5. **Webhook stamping:** `invoice.paid` → grant row carries
   `grant_source='plan'`, `period_key`, `expires_at=current_period_end`.

## 7. Owners / touch list

| Change | Owner path (not W10-C's to edit) |
| --- | --- |
| `credit_ledger` columns + migration | `packages/db/src/schema/billing.ts` (db owner) |
| stamp grants on `invoice.paid` | `apps/gateway/src/services/billing-complete/ledger-bridge.ts` |
| pools payload on `GET /v1/credits` | `apps/gateway/src/routes/credits.ts` |
| pools UI + copy | `apps/web/src/components/billing/*` |
| daily expiry sweep job | `apps/worker` (cron) |

**Open decisions (product):** pack expiry after cancellation (PLACEHOLDER 90d
above); holding-pool naming on the wire; whether trial credits show a distinct
color/state or share the plan pool copy.
