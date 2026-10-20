import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_CODE_SCHEMA,
  ERROR_ENVELOPE_SCHEMA,
  HTTP_STATUS_BY_ERROR_CODE,
  err,
  httpStatusFor,
  isFailure,
  ok,
  type ErrorCode,
} from '../src/index.js';

describe('errors: catalog (§13.3 + §24.4)', () => {
  it('codes are unique', () => {
    expect(new Set<string>(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('contains the task-mandated codes', () => {
    const required: ErrorCode[] = [
      'text_overflow',
      'unknown_slots',
      'invalid_slots',
      'insufficient_credits',
      'image_provider_error',
      'engine_unavailable',
      'rate_limited',
      'cross_tenant_denied',
      'quota_exceeded',
      'plan_limit',
    ];
    for (const code of required) {
      expect(ERROR_CODES, `missing code: ${code}`).toContain(code);
    }
  });

  it('rejects unknown codes at the boundary', () => {
    expect(ERROR_CODE_SCHEMA.safeParse('oops_unknown').success).toBe(false);
    expect(ERROR_CODE_SCHEMA.safeParse('rate_limited').success).toBe(true);
  });

  it('every code maps to a sane HTTP status (§13.3)', () => {
    for (const code of ERROR_CODES) {
      const status = httpStatusFor(code);
      expect(HTTP_STATUS_BY_ERROR_CODE[code]).toBe(status);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThanOrEqual(503);
    }
  });

  it('maps the spec’s class examples correctly', () => {
    expect(httpStatusFor('text_overflow')).toBe(400);
    expect(httpStatusFor('unauthorized')).toBe(401);
    expect(httpStatusFor('insufficient_credits')).toBe(402); // 402 payment/credits required
    expect(httpStatusFor('cross_tenant_denied')).toBe(403); // 403 permission
    expect(httpStatusFor('not_found')).toBe(404); // 404 not found
    expect(httpStatusFor('conflict')).toBe(409); // 409 conflict
    expect(httpStatusFor('rate_limited')).toBe(429); // 429 rate limit
    expect(httpStatusFor('engine_unavailable')).toBe(503); // 503 engine unavailable
    expect(httpStatusFor('internal_error')).toBe(500); // 500 unexpected
  });
});

describe('errors: result envelopes (§4/§13.3)', () => {
  it('ok() wraps a value', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
    expect(isFailure(result)).toBe(false);
  });

  it('err() produces the minimal envelope', () => {
    const result = err('engine_unavailable', 'No engine session is free');
    expect(result).toEqual({
      ok: false,
      code: 'engine_unavailable',
      message: 'No engine session is free',
    });
    expect(isFailure(result)).toBe(true);
  });

  it('err() attaches hint, retryable and docsUrl only when provided', () => {
    const full = err('image_provider_error', 'Image provider failed', {
      hint: 'Retry is free once (§24.4).',
      retryable: true,
      docsUrl: 'https://docs.example.com/runs#retry',
    });
    expect(full).toEqual({
      ok: false,
      code: 'image_provider_error',
      message: 'Image provider failed',
      hint: 'Retry is free once (§24.4).',
      retryable: true,
      docsUrl: 'https://docs.example.com/runs#retry',
    });

    const partial = err('rate_limited', 'Slow down', { retryable: false });
    expect('hint' in partial).toBe(false);
    expect('docsUrl' in partial).toBe(false);
    if (isFailure(partial)) {
      expect(partial.retryable).toBe(false);
    }
  });
});

describe('errors: wire envelope (§13.3)', () => {
  it('validates `{ error: { code, message, hint?, retryable, docs_url? } }`', () => {
    const parsed = ERROR_ENVELOPE_SCHEMA.safeParse({
      error: {
        code: 'insufficient_credits',
        message: 'Not enough credits for a standard run',
        hint: 'Top up or switch to the quick tier.',
        retryable: false,
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error.code).toBe('insufficient_credits');
      expect(parsed.data.error.retryable).toBe(false);
    }
  });

  it('rejects unknown codes and malformed envelopes', () => {
    expect(ERROR_ENVELOPE_SCHEMA.safeParse({ error: { code: 'nope', message: 'x', retryable: false } }).success).toBe(false);
    expect(ERROR_ENVELOPE_SCHEMA.safeParse({ code: 'rate_limited', message: 'x', retryable: false }).success).toBe(false);
  });
});
