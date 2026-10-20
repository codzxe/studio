import { describe, expect, it } from 'vitest';
import {
  SSE_EVENT_SCHEMA,
  SSE_EVENT_TYPE_KEYS,
  SSE_EVENT_TYPE_SCHEMA,
  SSE_EVENT_TYPES,
  SSE_EVENT_TYPE_VALUES,
  isSseEventType,
  type SseEventType,
} from '../src/index.js';

// §13.2 exact list.
const SPEC_EVENT_TYPES: readonly SseEventType[] = [
  'run.queued',
  'run.started',
  'run.plan',
  'step.started',
  'step.finished',
  'preview.updated',
  'validate.report',
  'critique.report',
  'credits.reserved',
  'credits.charged',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
];

describe('events: §13.2 SSE catalogue', () => {
  it('exposes exactly the 13 spec event types', () => {
    expect([...SSE_EVENT_TYPE_KEYS]).toEqual([...SPEC_EVENT_TYPES]);
    expect(SSE_EVENT_TYPE_VALUES).toHaveLength(13);
  });

  it('every event type string is unique', () => {
    const unique = new Set<string>(SSE_EVENT_TYPE_VALUES);
    expect(unique.size).toBe(SSE_EVENT_TYPE_VALUES.length);
  });

  it('named constants cover the same set as the wire list', () => {
    expect(new Set<string>(SSE_EVENT_TYPE_VALUES)).toEqual(new Set<string>(SPEC_EVENT_TYPES));
    expect(SSE_EVENT_TYPES.runQueued).toBe('run.queued');
    expect(SSE_EVENT_TYPES.creditsCharged).toBe('credits.charged');
    expect(SSE_EVENT_TYPES.runCancelled).toBe('run.cancelled');
  });

  it('the Zod enum accepts every spec type and rejects anything else', () => {
    for (const type of SPEC_EVENT_TYPES) {
      expect(SSE_EVENT_TYPE_SCHEMA.safeParse(type).success, `reject ${type}`).toBe(true);
    }
    expect(SSE_EVENT_TYPE_SCHEMA.safeParse('run.planning').success).toBe(false);
    expect(SSE_EVENT_TYPE_SCHEMA.safeParse('').success).toBe(false);
  });

  it('isSseEventType guards untrusted values', () => {
    expect(isSseEventType('step.finished')).toBe(true);
    expect(isSseEventType('step.moved')).toBe(false);
    expect(isSseEventType(42)).toBe(false);
    expect(isSseEventType(null)).toBe(false);
  });

  it('SSE_EVENT_SCHEMA validates the wire shape { seq, run_id, at, type, payload }', () => {
    const parsed = SSE_EVENT_SCHEMA.safeParse({
      seq: 1,
      run_id: 'run_123',
      at: '2026-01-01T00:00:00.000Z',
      type: 'run.queued',
      payload: { tier: 'standard' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.at).toBeInstanceOf(Date);
      expect(parsed.data.seq).toBe(1);
    }
  });

  it('SSE_EVENT_SCHEMA is strict about unknown fields', () => {
    const parsed = SSE_EVENT_SCHEMA.safeParse({
      seq: 1,
      run_id: 'run_123',
      at: new Date(),
      type: 'run.queued',
      payload: {},
      extra: 'nope',
    });
    expect(parsed.success).toBe(false);
  });
});
