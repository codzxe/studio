// @studio/agent — typed error catalog for the run loop. Owner: W1-P (docs/AGENTS.md).
//
// Spec anchors:
//   §5.1  plan retry rule (invalid plan → one retry → clear failure)
//   §5.2  budgets are a feature, not an error (soft stop, partial commit)
//   §5.3  provider circuit breakers / failover
//   §5.7  prompt-injection stance (untrusted tool names/args are data)
//   §13.3 wire error codes are stable strings
//
// AGENTS.md: typed result envelopes `{ ok:false, code, message, hint, retryable? }`;
// never throw strings; never leak stack traces, absolute paths or internal ids.
import { z } from 'zod';
import type { ErrorCode } from '@studio/config';

/**
 * Stable agent-internal error codes. Add-only: never rename or reuse.
 * `invalid_transition` supports the §5.1 state machine guard (typed error on
 * every illegal transition attempt); the other eight are the run-loop codes
 * from the W1-P task contract.
 */
export const AGENT_ERROR_CODES = [
  // Planner output failed the §5.5 schema. §5.1: one retry with the validation
  // errors attached, then fail with a clear message.
  'plan_invalid',
  // A §5.2 tier budget was exhausted. NOT a hard error: stop cleanly, commit what
  // strengthened the document, charge partially, tell the user what was cut.
  'budget_exceeded_soft',
  // A tool exceeded its repair/retry budget (§6.3 "the worker enforces a retry budget").
  'tool_retry_exhausted',
  // §5.2 revision cap hit; §11.2: after the revision cap the run ships with warnings.
  'revision_limit_reached',
  // §3.4 wall-clock / run timeout (tier §5.2 wall clock column).
  'run_timeout',
  // The engine automation session died mid-run and could not be resumed (§3.2/§3.4).
  'engine_session_lost',
  // All providers for a model class have open circuit breakers (§5.3).
  'provider_unhealthy',
  // Model-proposed content matched the §5.7 injection stance and was rejected.
  'prompt_injection_suspected',
  // §5.1 guard: a state-machine transition that the loop table does not allow.
  'invalid_transition',
] as const satisfies readonly string[];

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export const AGENT_ERROR_CODE_SCHEMA = z.enum(AGENT_ERROR_CODES);

/** Failure envelope (AGENTS.md / §13.3 shape; codes are agent-internal). */
export interface AgentFailure {
  readonly ok: false;
  readonly code: AgentErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

export type AgentResult<T> = { readonly ok: true; readonly value: T } | AgentFailure;

export function agentOk<T>(value: T): AgentResult<T> {
  return { ok: true, value };
}

export interface AgentErrOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
}

/** Builds a typed failure envelope; optional fields are omitted when unset. */
export function agentErr(
  code: AgentErrorCode,
  message: string,
  options: AgentErrOptions = {},
): AgentResult<never> {
  const failure: { ok: false; code: AgentErrorCode; message: string; hint?: string; retryable?: boolean } = {
    ok: false,
    code,
    message,
  };
  if (options.hint !== undefined) {
    failure.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    failure.retryable = options.retryable;
  }
  return failure;
}

export function isAgentFailure<T>(result: AgentResult<T>): result is AgentFailure {
  return result.ok === false;
}

/**
 * Agent code → wire code (§13.3 stable catalog, owned by @studio/config).
 * Used when a run terminates and the failure must be surfaced over HTTP/SSE.
 */
export const AGENT_TO_WIRE_ERROR_CODE: Readonly<Record<AgentErrorCode, ErrorCode>> = {
  plan_invalid: 'validation_failed', // config catalog: "Plan or payload failed schema validation (§5.1)".
  budget_exceeded_soft: 'budget_exceeded', // config catalog: "Tier budget exhausted → clean stop, partial charge (§5.2)".
  tool_retry_exhausted: 'engine_timeout', // tool interaction failed past its retry budget (§6.3).
  revision_limit_reached: 'budget_exceeded', // revision cap → ship with warnings, partial outcome (§5.2/§11.2).
  run_timeout: 'engine_timeout', // §3.4: tool/render/run/session timeouts map to engine_timeout.
  engine_session_lost: 'engine_crashed', // session died mid-run (§3.2).
  provider_unhealthy: 'provider_unhealthy', // identical stable string in both catalogs (§5.3).
  prompt_injection_suspected: 'validation_failed', // untrusted model content rejected (§5.7).
  invalid_transition: 'conflict', // state-machine conflict (§5.1); HTTP 409.
};

/** Maps an agent error code onto the stable §13.3 wire catalog. */
export function toWireErrorCode(code: AgentErrorCode): ErrorCode {
  return AGENT_TO_WIRE_ERROR_CODE[code];
}
