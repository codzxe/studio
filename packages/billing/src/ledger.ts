// @studio/billing — the credits ledger: reserve → commit | refund (§14.2).
//
// Spec anchors:
//   §3.3   steps 2/6/7 — gateway reserves before enqueue; worker commits on
//           success; any failure refunds the reservation
//   §3.4   failure semantics — retries never double-charge; partial failure
//           refunds; timeout → cancel, rollback, refund
//   §12.1  credit_ledger kinds grant/run_hold/run_commit/run_refund/pack/admin
//   §12.2  ledger rows are append-only; balance is derived from the sum
//   §14.2  deduction rules — see README.md for the exact rules table
//   §24.4  first provider-failure retry is free (see policy.ts isFreeRetry)
//   §25.8  reservations are committed/refunded transactionally with
//           idempotency keys, "or the first angry email becomes forensics week"
//
// LEDGER MODEL (one append per phase, exactly-once per key):
//   reserve row  { kind: "reserve", delta: -A, key: `${runId}:reserve` }
//                — the hold immediately reduces the available balance, so
//                concurrent runs cannot over-commit (§14.2 rule 1).
//   commit row   { kind: "commit",  delta: A - charge, key: `${runId}:commit` }
//                — the settlement: releases the held A and applies the actual
//                  charge in ONE append-only row. delta 0 for a full charge
//                  (the hold simply becomes the spend); positive on a §5.2
//                  budget-stop partial charge (the uncharged remainder returns).
//   refund row   { kind: "refund",  delta: A - p, key: `${runId}:refund` }
//                — the release: +A for a clean failure (rule 3: "release the
//                  full reservation"); A - p when §14.2 rule 4 permits a partial
//                  charge p ≤ half the base. This row never carries a spend —
//                  commit and refund are mutually exclusive terminals.
//
// Because every phase is a single append, a crash between phases leaves the
// reservation in a derivable state ('held' | 'committed' | 'released') and a
// retry with the same key replays the same outcome — never double-charging and
// never stranding a hold. Every terminal delta is non-negative, so the running
// org balance can never dip below zero (the only negative append, reserve, is
// balance-checked first).

import { type Result, err, isFailure, ok } from "@studio/config";
import { z } from "zod";

import { maxPartialFailureCharge } from "./policy.js";

// ---------------------------------------------------------------------------
// Ledger store seam (§12.1/§12.2) — structural, decoupled from @studio/db
// ---------------------------------------------------------------------------

/**
 * Append-only ledger kinds (§12.1: grant / run_hold / run_commit / run_refund /
 * pack / admin, in the names the landed schema uses — packages/db billing.ts).
 */
export const CREDIT_LEDGER_KINDS = [
  "reserve",
  "commit",
  "refund",
  "adjustment",
  "grant",
  "pack",
] as const satisfies readonly string[];

export type CreditLedgerKind = (typeof CREDIT_LEDGER_KINDS)[number];

/**
 * One money event. Positive delta = credits in (grant, pack, refund);
 * negative = credits out (reserve, adjustment). `balanceAfter` bookkeeping,
 * ids and timestamps belong to the storage implementation.
 */
export interface CreditLedgerEntry {
  readonly organizationId: string;
  readonly delta: number;
  readonly kind: CreditLedgerKind;
  /** §14.2 rule 6: derived from run_id + phase; duplicates are rejected. */
  readonly idempotencyKey: string;
  readonly runId?: string;
  readonly note?: string;
  readonly createdBy?: string;
}

/**
 * The minimal storage seam for the billing domain. Implementations (the
 * Drizzle-backed repo layer) MUST:
 *   - reject a duplicate (idempotencyKey, kind) append — the DB enforces this
 *     with the unique index on credit_ledger (packages/db, W1-F);
 *   - compute `balance_after` per row so the running balance stays auditable;
 *   - scope every read/write by organizationId (§12.2 tenant root);
 *   - wrap "check balance + append" in one transaction for reserveCredits, so
 *     two concurrent reserves cannot both pass the sufficiency check.
 */
export interface LedgerStore {
  /** Appends one entry; MUST reject a duplicate (idempotencyKey, kind). */
  append(entry: CreditLedgerEntry): Promise<void>;
  /** The organization's current balance: the sum of all appended deltas. */
  balanceAfter(organizationId: string): Promise<number>;
  /** Whether an entry with this (idempotencyKey, kind) already exists. */
  findByIdempotency(idempotencyKey: string, kind: CreditLedgerKind): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// §14.2 rule 6 — idempotency keys derived from run_id + phase
// ---------------------------------------------------------------------------

export function reserveKey(runId: string): string {
  return `${runId}:reserve`;
}

export function commitKey(runId: string): string {
  return `${runId}:commit`;
}

export function refundKey(runId: string): string {
  return `${runId}:refund`;
}

// ---------------------------------------------------------------------------
// Request schemas (Zod at every boundary; the gateway may reuse these)
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(200);
const creditsSchema = z.number().int().positive();

export const RESERVE_CREDITS_SCHEMA = z
  .object({
    organizationId: idSchema,
    runId: idSchema,
    /** The tier's base cost to hold (§14.2 rule 1). */
    amount: creditsSchema,
  })
  .strict();

export const COMMIT_RESERVATION_SCHEMA = z
  .object({
    organizationId: idSchema,
    runId: idSchema,
    /** The amount originally reserved (the hold being settled). */
    amount: creditsSchema,
    /**
     * The actual cost to charge. Defaults to the full hold (§14.2 rule 2).
     * Smaller on a §5.2 budget stop; 0 for a §24.4 grace retry. Never more
     * than the hold — exceeding a budget is a partial-charge feature, and a
     * charge above the reservation is clamped, never exceeded.
     */
    amountCharged: z.number().int().min(0).optional(),
  })
  .strict();

export const RELEASE_RESERVATION_SCHEMA = z
  .object({
    organizationId: idSchema,
    runId: idSchema,
    /** The amount originally reserved. */
    amount: creditsSchema,
    /**
     * §14.2 rule 4: charge for partial progress when the run failed after
     * mutating commands. Capped at half the base (see maxPartialFailureCharge).
     * 0 — the default — releases the full reservation (rules 3 and 5).
     */
    amountCharged: z.number().int().min(0).optional(),
  })
  .strict();

export type ReserveCreditsRequest = z.infer<typeof RESERVE_CREDITS_SCHEMA>;
export type CommitReservationRequest = z.infer<typeof COMMIT_RESERVATION_SCHEMA>;
export type ReleaseReservationRequest = z.infer<typeof RELEASE_RESERVATION_SCHEMA>;

/** Parses a request against its schema; never throws — failures are envelopes. */
function parseRequest<T>(schema: z.ZodType<T>, input: unknown): Result<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return ok(parsed.data);
  }
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  return err("validation_failed", "Billing request failed schema validation.", {
    hint: issues,
  });
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export interface ReservationOutcome {
  readonly organizationId: string;
  readonly runId: string;
  /** Credits held. */
  readonly amount: number;
  /** True when this call was an idempotent replay (no ledger change). */
  readonly duplicate: boolean;
}

export interface CommitOutcome {
  readonly organizationId: string;
  readonly runId: string;
  readonly amountReserved: number;
  /** Credits actually charged (≤ the hold). */
  readonly amountCharged: number;
  readonly duplicate: boolean;
}

export interface ReleaseOutcome {
  readonly organizationId: string;
  readonly runId: string;
  readonly amountReserved: number;
  /** 0 for a full refund; ≤ half the base per §14.2 rule 4. */
  readonly amountCharged: number;
  /** Credits returned to the balance: amountReserved − amountCharged. */
  readonly amountRefunded: number;
  readonly duplicate: boolean;
}

/**
 * The reservation lifecycle, derived purely from ledger rows (§3.3):
 * `none` → `held` (reserve row) → `committed` (commit row) | `released`
 * (refund row). Money terminals are mutually exclusive; a partial-charge
 * release keeps the run's failure status in agent_runs — the ledger only
 * speaks money.
 */
export type ReservationStatus = "none" | "held" | "committed" | "released";

// ---------------------------------------------------------------------------
// §14.2 rule 1 — reserve
// ---------------------------------------------------------------------------

/**
 * Holds `amount` credits for a run and checks the balance (§14.2 rule 1):
 * the hold is a ledger charge, so concurrent reservations cannot over-commit.
 * Insufficient balance → `insufficient_credits` (HTTP 402) with a top-up hint;
 * nothing is appended and the run must never start.
 *
 * Idempotent: a second call with the same runId replays the reservation
 * outcome without a second hold. Callers must replay identical arguments on
 * retry (Stripe-style idempotency contract).
 */
export async function reserveCredits(
  store: LedgerStore,
  request: ReserveCreditsRequest,
): Promise<Result<ReservationOutcome>> {
  const parsed = parseRequest(RESERVE_CREDITS_SCHEMA, request);
  if (isFailure(parsed)) {
    return parsed;
  }
  const { organizationId, runId, amount } = parsed.value;
  const key = reserveKey(runId);

  if (await store.findByIdempotency(key, "reserve")) {
    return ok({ organizationId, runId, amount, duplicate: true });
  }

  // §14.2 rule 1: check the balance; the run never starts on a shortfall.
  const balance = await store.balanceAfter(organizationId);
  if (balance < amount) {
    return err(
      "insufficient_credits",
      `This run needs ${amount} credits but the workspace has ${balance} available.`,
      {
        hint: "Top up credits or upgrade your plan, then retry. The run was not started.",
      },
    );
  }

  await store.append({
    organizationId,
    delta: -amount,
    kind: "reserve",
    idempotencyKey: key,
    runId,
    note: `hold ${amount} credits for run`,
  });
  return ok({ organizationId, runId, amount, duplicate: false });
}

// ---------------------------------------------------------------------------
// §14.2 rule 2 / §5.2 — commit
// ---------------------------------------------------------------------------

/**
 * Settles the reservation on success (§3.3 step 6, §14.2 rule 2): releases the
 * hold and charges the actual cost in one append-only settlement row. On a §5.2
 * budget stop, pass a smaller `amountCharged` (never more than the hold —
 * excess is clamped). A §24.4 grace retry commits 0.
 *
 * Idempotent: a second call with the same runId replays the outcome without a
 * second charge. Committing a run that was already released is a `conflict`.
 */
export async function commitReservation(
  store: LedgerStore,
  request: CommitReservationRequest,
): Promise<Result<CommitOutcome>> {
  const parsed = parseRequest(COMMIT_RESERVATION_SCHEMA, request);
  if (isFailure(parsed)) {
    return parsed;
  }
  const { organizationId, runId, amount } = parsed.value;
  const cKey = commitKey(runId);
  const fKey = refundKey(runId);

  if (await store.findByIdempotency(fKey, "refund")) {
    return err("conflict", "This run's credits were already released; it cannot be committed.", {
      hint: "The run already failed and was refunded — check its terminal state.",
    });
  }

  if (await store.findByIdempotency(cKey, "commit")) {
    // §3.4: retries never double-charge.
    const amountCharged = Math.min(parsed.value.amountCharged ?? amount, amount);
    return ok({ organizationId, runId, amountReserved: amount, amountCharged, duplicate: true });
  }

  if (!(await store.findByIdempotency(reserveKey(runId), "reserve"))) {
    return err("conflict", "No credit reservation exists for this run.", {
      hint: "Reserve credits before committing (§14.2 rule 1).",
    });
  }

  // §5.2: charge at most what was held; a charge never exceeds the reservation.
  const amountCharged = Math.min(parsed.value.amountCharged ?? amount, amount);

  await store.append({
    organizationId,
    delta: amount - amountCharged, // settlement: release the hold, apply the charge
    kind: "commit",
    idempotencyKey: cKey,
    runId,
    note: `settle hold: release ${amount}, charge ${amountCharged}`,
  });
  return ok({ organizationId, runId, amountReserved: amount, amountCharged, duplicate: false });
}

// ---------------------------------------------------------------------------
// §14.2 rules 3-5 — release / refund
// ---------------------------------------------------------------------------

/**
 * Releases the reservation on failure or cancel (§3.3 step 7, §14.2 rules 3-5):
 * appends one refund row returning the uncharged part of the hold. With the
 * default zero charge this is a full release (rule 3) — including failures
 * caused by our own bug, which refund fully even after partial progress
 * (rule 5, driven by classifyRefund in policy.ts). A partial-progress charge
 * (rule 4) is capped at half the reserved base.
 *
 * Idempotent: a second call with the same runId replays the outcome without a
 * second refund. Releasing a run that was already committed is a `conflict`.
 */
export async function releaseReservation(
  store: LedgerStore,
  request: ReleaseReservationRequest,
): Promise<Result<ReleaseOutcome>> {
  const parsed = parseRequest(RELEASE_RESERVATION_SCHEMA, request);
  if (isFailure(parsed)) {
    return parsed;
  }
  const { organizationId, runId, amount } = parsed.value;
  const rKey = reserveKey(runId);
  const cKey = commitKey(runId);
  const fKey = refundKey(runId);

  if (await store.findByIdempotency(fKey, "refund")) {
    // Idempotent replay — the reservation was already released.
    const amountCharged = Math.min(
      parsed.value.amountCharged ?? 0,
      maxPartialFailureCharge(amount),
    );
    return ok({
      organizationId,
      runId,
      amountReserved: amount,
      amountCharged,
      amountRefunded: amount - amountCharged,
      duplicate: true,
    });
  }

  if (await store.findByIdempotency(cKey, "commit")) {
    return err("conflict", "This run's credits were already committed; they cannot be released.", {
      hint: "The run already succeeded — refunds of committed charges are adjustments.",
    });
  }

  if (!(await store.findByIdempotency(rKey, "reserve"))) {
    return err("conflict", "No credit reservation exists for this run.", {
      hint: "Reserve credits before releasing (§14.2 rule 1).",
    });
  }

  // §14.2 rule 4: charge at most half the base; the clamp is the documented
  // ceiling, and the outcome reports the charged amount actually applied.
  const amountCharged = Math.min(parsed.value.amountCharged ?? 0, maxPartialFailureCharge(amount));

  await store.append({
    organizationId,
    delta: amount - amountCharged, // release the hold, keep the partial charge
    kind: "refund",
    idempotencyKey: fKey,
    runId,
    note: `release hold ${amount}, charge ${amountCharged} (partial)`,
  });
  return ok({
    organizationId,
    runId,
    amountReserved: amount,
    amountCharged,
    amountRefunded: amount - amountCharged,
    duplicate: false,
  });
}

// ---------------------------------------------------------------------------
// Derived reservation state (repo layer + debugging aid)
// ---------------------------------------------------------------------------

/** Derives the reservation lifecycle state from the three phase keys. */
export async function reservationStatus(
  store: LedgerStore,
  runId: string,
): Promise<ReservationStatus> {
  const reserved = await store.findByIdempotency(reserveKey(runId), "reserve");
  if (!reserved) {
    return "none";
  }
  if (await store.findByIdempotency(commitKey(runId), "commit")) {
    return "committed";
  }
  if (await store.findByIdempotency(refundKey(runId), "refund")) {
    return "released";
  }
  return "held";
}
