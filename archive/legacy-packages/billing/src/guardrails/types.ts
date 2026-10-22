// @studio/billing — guardrail result envelope (W9-N).
//
// Spec anchors:
//   §13.3  error envelope `{ ok:false, code, message, hint?, retryable? }` —
//          codes are stable strings, add-only
//   §18.4  free-tier/demo budget guardrails (daily caps, kill switches)
//   §22    "cost per day > budget" alert family
//
// The guardrails module is the COST-ABUSE layer: daily spend caps, the
// workspace kill switch, the demo-workspace policy and the provider-class
// kill switch. Its failures need codes the §13.3 catalog does not carry yet
// (`cost_cap_reached`, `disabled_workspace`, `providers_disabled`, …), so this
// module owns a guardrail-scoped envelope with the same SHAPE as
// @studio/config's `Result` plus one optional structured field:
//
//   `resetAtIso` — ISO-8601 UTC instant when the blocking window ends
//   (daily caps reset at 00:00 UTC), for callers that render countdowns or
//   set `Retry-After`-style headers.
//
// Until the @studio/config owner extends ERROR_CODES (flagged in the worklog:
// add-only catalog, §13.3), `guardrailCodeToErrorCode()` bridges every code to
// its nearest existing §13.3 code so the gateway error-mapper can render these
// failures TODAY without edits outside this module.

import type { ErrorCode } from "@studio/config";

/**
 * Guardrail error codes (§13.3 shape; add-only, never rename/reuse).
 *
 *   `validation_failed`   bad input at the guardrail boundary (400 family).
 *   `cost_cap_reached`    workspace hit its daily provider-spend cap
 *                         (§18.4/§14.2 r7); resets at next UTC midnight.
 *   `disabled_workspace`  the admin `kill_switched` flag is set for the
 *                         workspace (§18.4: admin can disable a workspace).
 *   `demo_disabled`       the demo flow's global kill switch (DEMO_ENABLED)
 *                         is off (§16.2/§18.4).
 *   `demo_cap_reached`    the shared demo workspace exhausted its N runs/day
 *                         platform-wide budget (§16.2/§18.4).
 *   `providers_disabled`  every provider of the tier's routing class is
 *                         disabled and no failover class is available (§5.3;
 *                         the §21 revoke-provider-key drill outcome).
 */
export const GUARDRAIL_ERROR_CODES = [
  "validation_failed",
  "cost_cap_reached",
  "disabled_workspace",
  "demo_disabled",
  "demo_cap_reached",
  "providers_disabled",
] as const satisfies readonly string[];

export type GuardrailErrorCode = (typeof GUARDRAIL_ERROR_CODES)[number];

/** Failure envelope — @studio/config `Failure` shape + `resetAtIso`. */
export interface GuardrailFailure {
  readonly ok: false;
  readonly code: GuardrailErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
  /** When the blocking window ends (typed caps only): ISO-8601 UTC instant. */
  readonly resetAtIso?: string;
}

/** The guardrails' Result: same shape as @studio/config `Result` + resetAtIso. */
export type GuardrailResult<T> = { readonly ok: true; readonly value: T } | GuardrailFailure;

export function guardrailOk<T>(value: T): GuardrailResult<T> {
  return { ok: true, value };
}

export interface GuardrailErrOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
  /** ISO-8601 UTC instant when the blocking window ends (caps/kill windows). */
  readonly resetAtIso?: string;
}

/** Builds a typed guardrail failure; optional fields are omitted when unset. */
export function guardrailErr<T = never>(
  code: GuardrailErrorCode,
  message: string,
  options: GuardrailErrOptions = {},
): GuardrailResult<T> {
  const failure: {
    ok: false;
    code: GuardrailErrorCode;
    message: string;
    hint?: string;
    retryable?: boolean;
    resetAtIso?: string;
  } = { ok: false, code, message };
  if (options.hint !== undefined) {
    failure.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    failure.retryable = options.retryable;
  }
  if (options.resetAtIso !== undefined) {
    failure.resetAtIso = options.resetAtIso;
  }
  return failure;
}

export function isGuardrailFailure<T>(result: GuardrailResult<T>): result is GuardrailFailure {
  return result.ok === false;
}

/**
 * Bridge to the §13.3 catalog (gateway error-mapper): the nearest existing
 * `ErrorCode` for each guardrail code, so guardrail failures render with the
 * right HTTP status today. When the @studio/config owner adds the W9-N codes
 * to ERROR_CODES (add-only), this map collapses to identity.
 */
export const GUARDRAIL_CODE_TO_ERROR_CODE: Readonly<Record<GuardrailErrorCode, ErrorCode>> = {
  validation_failed: "validation_failed", // 400
  cost_cap_reached: "quota_exceeded", // 429 — §14.2 rule 7 daily/workspace cap
  disabled_workspace: "forbidden", // 403 — admin-disabled workspace
  demo_disabled: "forbidden", // 403 — global demo kill switch
  demo_cap_reached: "quota_exceeded", // 429 — N runs/day platform-wide
  providers_disabled: "provider_unhealthy", // 503 — §5.3 routing failure family
};

/** Nearest §13.3 code for a guardrail code (see the map above). */
export function guardrailCodeToErrorCode(code: GuardrailErrorCode): ErrorCode {
  return GUARDRAIL_CODE_TO_ERROR_CODE[code];
}

// ---------------------------------------------------------------------------
// Shared pure helpers
// ---------------------------------------------------------------------------

const ORG_ID_MIN = 1;
const ORG_ID_MAX = 200;

/** Shape-only org id check (plans.ts trialOrgSchema precedent; uuid-ness is the HTTP boundary's job). */
export function isValidOrgId(orgId: string): boolean {
  return typeof orgId === "string" && orgId.length >= ORG_ID_MIN && orgId.length <= ORG_ID_MAX;
}

/**
 * Sanitizes a money/counter seam reading (limits-service `sanitizeCount`
 * precedent): a broken counter (negative/NaN/fractional) is an internal bug —
 * clamp to 0 and fail-soft. The authoritative money gate is the §14.2
 * reserve/commit transaction, not this abuse-protection layer.
 */
export function sanitizeCounter(raw: number): number {
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

/** Formats integer USD cents as a `$X.YY` string for user-facing hints. */
export function formatUsdCents(cents: number): string {
  const safe = Number.isSafeInteger(cents) ? cents : 0;
  const sign = safe < 0 ? "-" : "";
  const abs = Math.abs(safe);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
