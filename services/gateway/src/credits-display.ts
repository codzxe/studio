// @studio/gateway — D-12 route-boundary credit-unit conversions.
//
// THE LAW (docs/DECISIONS.md D-12): the credit ledger stores integer
// MICROcredits — 1 credit = 1_000_000 µc, append-only bigint rows, no floats
// in ledger math. The chat and apply routes COMPUTE in whole credits (the
// §8.8 estimate/reserve heuristics, the LiteLLM usage math and the §8.6 plan
// `estimatedCredits` are all credit-unit surfaces, and the run ROW's
// reservedCredits/committedCredits columns are whole credits per the D-12
// row ruling) — so every ledger CALL converts whole credits → µc here, and
// every user-facing DISPLAY number converts µc → credits back. This module
// is the ONE shared conversion dialect for the gateway's run paths:
//
//   ledger-ward : creditsToLedgerMicrocredits(credits)  → integer µc amount
//   row/display : microcreditsToWholeCredits(µc)        → whole credits
//   SSE display : microcreditsToDisplayCredits(µc)      → whole credits,
//                 up to 2 decimals (the D-12 display rule)
//
// The display math mirrors @studio/config's `microcreditsToCredits`
// (Math.round(µc / 10_000) / 100) and the web billing kit's
// `microcreditsToCreditsDisplay` — never-throwing, because an SSE finalize
// must never lose a terminal event to a display conversion (a ledger balance
// can never be negative, D-12; a hostile/legacy magnitude degrades to a
// rounded display instead of a crash).
//
// M6-K finding (documented, not fixed here — law #12): routes/credits.ts and
// the billing-state route surface RAW µc on the wire by documented contract
// ("Raw ledger numbers in µc — the same units as GET /v1/credits (D-12)",
// BillingState.credits) and convert nothing; the web billing kit converts at
// the UI boundary. The run-path display surface that carries whole credits is
// the §7.4 SSE `credits` event, converted here.

import { MICROCREDITS_PER_CREDIT } from "@studio/config";

export { MICROCREDITS_PER_CREDIT };

/**
 * Whole credits → the integer µc amount a ledger call takes (D-12).
 *
 * `Math.round` per the ruling, then the config-dialect epsilon round-trip
 * rejects sub-µc precision without breaking on binary-float artifacts of
 * legitimate amounts — mirroring @studio/config's `creditsToMicrocredits`.
 * Every caller computes `credits` from integer-valued helpers
 * (`estimateRunCredits`/`reserveAmountFor`, `committedCreditsFor` usage math,
 * `planCreditsOf`), so the product is an exact integer; the guards make a
 * non-integer, sub-µc or unsafe product a LOUD programming error instead of a
 * silent wrong-magnitude ledger row (the exact whole-credit-magnitude bug
 * this module exists to prevent: a run on a µc-granted workspace used to
 * commit "7" µc instead of 7 credits).
 */
export function creditsToLedgerMicrocredits(credits: number): number {
  const micro = Math.round(credits * MICROCREDITS_PER_CREDIT);
  if (
    !Number.isFinite(credits) ||
    credits < 0 ||
    !Number.isSafeInteger(micro) ||
    Math.abs(micro / MICROCREDITS_PER_CREDIT - credits) > 1e-9
  ) {
    throw new RangeError(
      `credit amounts must convert to a safe integer microcredit amount (D-12): ${credits}`,
    );
  }
  return micro;
}

/**
 * Ledger µc → whole credits (the run-row / event magnitude). Exact for the
 * credit-multiple magnitudes the ledger-ward conversion above writes; total
 * (never throws) so a finalize path can always derive its display number.
 */
export function microcreditsToWholeCredits(microcredits: number): number {
  if (!Number.isFinite(microcredits)) return 0;
  return Math.round(microcredits / MICROCREDITS_PER_CREDIT);
}

/**
 * Ledger µc → whole credits with up to 2 decimals — the D-12 display rule
 * for user-facing surfaces (the §7.4 SSE `credits` event balance):
 * `Math.round(µc / 10_000) / 100`, identical to @studio/config's
 * `microcreditsToCredits`, but total (a display conversion never throws).
 */
export function microcreditsToDisplayCredits(microcredits: number): number {
  if (!Number.isFinite(microcredits)) return 0;
  return Math.round(microcredits / 10_000) / 100;
}
