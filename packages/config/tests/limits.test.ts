import { describe, expect, it } from 'vitest';
import {
  AGENT_OBSERVE_PREVIEW_PX,
  CRASH_RECOVERY_WINDOW_SECONDS,
  ENGINE_CRASH_RESUME_LIMIT,
  ENGINE_MAX_CANVAS_MEGAPIXELS,
  ENGINE_PNG_MAX_BYTES,
  ENGINE_PREVIEW_MAX_PX,
  ENGINE_REPLY_MAX_BYTES,
  IMAGE_GENERATION_EDGE_PX,
  MAX_MUTATING_COMMANDS_PER_RUN,
  MAX_REPAIR_CYCLES,
  MAX_UPLOAD_BYTES,
  PLAN_RETRY_LIMIT,
  MAX_UPLOAD_MEGAPIXELS,
  PLAN_LIMITS,
  PLAN_LIMITS_SCHEMA,
  PREVIEW_DEFAULT_WIDTH_PX,
  QUEUE_JOB_RETRIES,
  UPLOAD_MIME_TYPES,
  UPLOAD_MIME_TYPE_SCHEMA,
  planLimits,
} from '../src/index.js';

describe('limits: uploads (§20.2)', () => {
  it('caps uploads at 25 MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });

  it('rejects image bombs above 60 MP', () => {
    expect(MAX_UPLOAD_MEGAPIXELS).toBe(60);
  });

  it('accepts exactly JPEG and PNG', () => {
    expect([...UPLOAD_MIME_TYPES]).toEqual(['image/jpeg', 'image/png']);
    expect(UPLOAD_MIME_TYPE_SCHEMA.safeParse('image/png').success).toBe(true);
    expect(UPLOAD_MIME_TYPE_SCHEMA.safeParse('image/webp').success).toBe(false);
  });
});

describe('limits: engine automation budgets (§2.2 budgets.rs)', () => {
  it('reply limit is 8 MiB', () => {
    expect(ENGINE_REPLY_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it('PNG output limit is 5 MiB', () => {
    expect(ENGINE_PNG_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('preview long edge is capped at 2048 px', () => {
    expect(ENGINE_PREVIEW_MAX_PX).toBe(2048);
  });

  it('hard canvas ceiling is 64 MP (§2.3)', () => {
    expect(ENGINE_MAX_CANVAS_MEGAPIXELS).toBe(64);
  });

  it('agent observe renders ≤1024 px; document previews default to 1024 (§5.1/§13.1)', () => {
    expect(AGENT_OBSERVE_PREVIEW_PX).toBe(1024);
    expect(PREVIEW_DEFAULT_WIDTH_PX).toBe(1024);
    expect(IMAGE_GENERATION_EDGE_PX).toBe(1024); // §5.2 image tiers are 1024²
  });
});

describe('limits: run caps (§5.1/§3.4/§20.13)', () => {
  it('repair cycles are capped at 2 (then succeeded_with_warnings)', () => {
    expect(MAX_REPAIR_CYCLES).toBe(2);
  });

  it('an invalid plan gets exactly one retry (§5.1)', () => {
    expect(PLAN_RETRY_LIMIT).toBe(1);
  });

  it('queue jobs retry ×3; engine crash resumes once (§3.4)', () => {
    expect(QUEUE_JOB_RETRIES).toBe(3);
    expect(ENGINE_CRASH_RESUME_LIMIT).toBe(1);
  });

  it('a killed run recovers within 60 s (§20.13)', () => {
    expect(CRASH_RECOVERY_WINDOW_SECONDS).toBe(60);
  });

  it('mutating commands per run are capped (§5.7 policy)', () => {
    expect(MAX_MUTATING_COMMANDS_PER_RUN).toBeGreaterThan(0);
  });
});

describe('limits: per-plan gates (§14.1)', () => {
  it('seats are 1/3/10 and concurrent sessions 1/3/6 across plans', () => {
    expect(PLAN_LIMITS.starter).toEqual({
      seats: 1,
      concurrentRuns: 1,
      concurrentSessions: 1,
      maxCanvasMegapixels: 32,
    });
    expect(PLAN_LIMITS.pro.seats).toBe(3);
    expect(PLAN_LIMITS.pro.concurrentSessions).toBe(3);
    expect(PLAN_LIMITS.business.seats).toBe(10);
    expect(PLAN_LIMITS.business.concurrentRuns).toBe(6);
    expect(PLAN_LIMITS.business.concurrentSessions).toBe(6);
  });

  it('max canvas per plan is 32/64/128 MP (§14.1)', () => {
    expect(PLAN_LIMITS.starter.maxCanvasMegapixels).toBe(32);
    expect(PLAN_LIMITS.pro.maxCanvasMegapixels).toBe(64);
    expect(PLAN_LIMITS.business.maxCanvasMegapixels).toBe(128);
  });

  it('limits grow monotonically with the plan ladder', () => {
    for (const field of [
      'seats',
      'concurrentRuns',
      'concurrentSessions',
      'maxCanvasMegapixels',
    ] as const) {
      expect(PLAN_LIMITS.starter[field]).toBeLessThanOrEqual(PLAN_LIMITS.pro[field]);
      expect(PLAN_LIMITS.pro[field]).toBeLessThanOrEqual(PLAN_LIMITS.business[field]);
    }
  });

  it('the limits table is schema-valid and planLimits() is total', () => {
    expect(PLAN_LIMITS_SCHEMA.safeParse(PLAN_LIMITS).success).toBe(true);
    for (const plan of ['starter', 'pro', 'business'] as const) {
      expect(planLimits(plan).seats).toBeGreaterThan(0);
    }
  });
});
