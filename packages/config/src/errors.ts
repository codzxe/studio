// @studio/config — error code catalog and Result envelopes.
// Spec §13.3: codes are stable strings; envelope `{ error: { code, message,
// hint?, retryable, docs_url? } }`; never leak internal ids or stack traces.
// §4/AGENTS.md: typed result envelopes `{ ok:false, code, message, hint, retryable? }`.
import { z } from 'zod';

/**
 * Stable error codes (§13.3 + worked examples §24.4 + §15).
 * Add-only: never rename or reuse an existing code.
 */
export const ERROR_CODES = [
  // Validation / user input (§13.3: HTTP 400).
  'text_overflow', // Engine text does not fit its bounds after layout.fitText.
  'unknown_slots', // Plan references slot names the template does not define.
  'invalid_slots', // Slot values fail the template's slot schema (§13.3).
  'validation_failed', // Plan or payload failed schema validation (§5.1).
  'budget_exceeded', // Tier budget exhausted → clean stop, partial charge (§5.2).
  // Payment / credits (§13.3: HTTP 402).
  'insufficient_credits', // Balance below reservation; run never starts (§14.2 rule 1).
  'plan_limit', // Workspace hit a plan gate (seats, concurrent runs, canvas).
  // Auth / tenancy (§13.3: 401/403; §15 cross-tenant tests).
  'unauthorized', // Missing or invalid session/API key.
  'forbidden', // Authenticated but not allowed (RBAC).
  'cross_tenant_denied', // Access across workspace boundary denied (§15).
  'not_found', // Unknown id (never confirm existence to strangers).
  'conflict', // Version/idempotency conflict.
  // Rate limiting (§13.3: HTTP 429).
  'rate_limited', // Too many requests.
  'quota_exceeded', // Daily/workspace quota cap hit (§14.2 rule 7).
  // Cost-abuse guardrails (W9-N bridge map; §18.4/§16.2).
  'cost_cap_reached', // Workspace hit its daily provider-spend cap (§18.4; resets 00:00 UTC).
  'demo_cap_reached', // Shared demo workspace exhausted its N runs/day budget (§16.2).
  'disabled_workspace', // Admin kill switch is set for the workspace (§18.4).
  'demo_disabled', // Demo flow's global kill switch (DEMO_ENABLED) is off (§16.2).
  'providers_disabled', // Every provider of the routing class disabled, no failover (§5.3).
  // Agent/tool swap points adopted from the W6/W7 flags (add-only, W10-F).
  'repair_plan_invalid', // Repair-model output failed the §23.4/§5.5 schema (§5.1 retry rule).
  'critique_parse_failed', // vision_critique: the model reply was unparseable after its retry.
  'export_failed', // export_document: the export pipeline failed (retryable per pipeline code).
  'image_upscale_limit', // §7.3: the image would be upscaled past the 200% hard limit.
  'unknown_component', // §8.3: no component matches the id (candidates pinned in the hint).
  'unknown_component_vars', // §8.4: unknown variable names (allowed list in the hint).
  'tool_retry_exhausted', // §6.3: a tool interaction failed past its retry budget.
  // Engine / providers (§13.3: HTTP 503 engine, §24.4).
  'engine_unavailable', // No engine session can be allocated/served.
  'engine_timeout', // Tool/render/run/session timeout (§3.4).
  'engine_crashed', // Engine died mid-run; replay/resume failed.
  'image_provider_error', // Image provider failed all retries (§24.4, retryable).
  'provider_unhealthy', // Model provider circuit breaker open (§5.3).
  // Internal (§13.3: HTTP 500).
  'storage_error', // S3/R2 read/write failure.
  'internal_error', // Unexpected; logged with run id, no details leaked.
] as const satisfies readonly string[];

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_CODE_SCHEMA = z.enum(ERROR_CODES);

/** Failure envelope fields (§13.3). */
export interface Failure {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
  readonly docsUrl?: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | Failure;

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export interface ErrOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
  readonly docsUrl?: string;
}

/** Builds a typed failure envelope; optional fields are omitted when unset. */
export function err(code: ErrorCode, message: string, options: ErrOptions = {}): Result<never> {
  const failure: {
    ok: false;
    code: ErrorCode;
    message: string;
    hint?: string;
    retryable?: boolean;
    docsUrl?: string;
  } = { ok: false, code, message };
  if (options.hint !== undefined) {
    failure.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    failure.retryable = options.retryable;
  }
  if (options.docsUrl !== undefined) {
    failure.docsUrl = options.docsUrl;
  }
  return failure;
}

export function isFailure<T>(result: Result<T>): result is Failure {
  return result.ok === false;
}

/** HTTP status classes per §13.3. */
export type HttpErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500 | 503;

/** Stable code → HTTP status mapping (§13.3). */
export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, HttpErrorStatus>> = {
  text_overflow: 400,
  unknown_slots: 400,
  invalid_slots: 400,
  validation_failed: 400,
  budget_exceeded: 400,
  insufficient_credits: 402,
  plan_limit: 402,
  unauthorized: 401,
  forbidden: 403,
  cross_tenant_denied: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  quota_exceeded: 429,
  cost_cap_reached: 429, // quota class (§14.2 rule 7 daily cap, W9-N bridge target)
  demo_cap_reached: 429, // quota class (N runs/day platform-wide)
  disabled_workspace: 403, // forbidden class (admin kill switch)
  demo_disabled: 403, // forbidden class (global demo kill switch)
  providers_disabled: 503, // provider routing failure family (§5.3)
  repair_plan_invalid: 400, // validation class (§5.1 plan retry rule)
  critique_parse_failed: 400, // validation class (unparseable model reply)
  export_failed: 500, // export pipeline failure (retryable per pipeline code)
  image_upscale_limit: 400, // §7.3 hard-limit refusal (user input validation)
  unknown_component: 400, // §8.3 catalog lookup refusal
  unknown_component_vars: 400, // §8.4 variable allow-list refusal
  tool_retry_exhausted: 503, // §3.4 timeout family (§6.3 retry budget spent)
  engine_unavailable: 503,
  engine_timeout: 503,
  engine_crashed: 503,
  image_provider_error: 503,
  provider_unhealthy: 503,
  storage_error: 500,
  internal_error: 500,
};

export function httpStatusFor(code: ErrorCode): HttpErrorStatus {
  return HTTP_STATUS_BY_ERROR_CODE[code];
}

/** Zod schema for the wire error envelope `{ error: { code, message, hint?, retryable, docs_url? } }` (§13.3). */
export const ERROR_ENVELOPE_SCHEMA = z
  .object({
    error: z
      .object({
        code: ERROR_CODE_SCHEMA,
        message: z.string(),
        hint: z.string().optional(),
        retryable: z.boolean(),
        docs_url: z.string().url().optional(),
      })
      .strict(),
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof ERROR_ENVELOPE_SCHEMA>;
