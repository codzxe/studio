// In-memory seam fakes + Result helpers for the limits tests (AGENTS.md:
// pure, deterministic, no network, no DB). Seam calls are counted so the
// tests can assert ordering and short-circuiting of the composite intake
// (§13 flow: static gates before the counter seam, one call per request).

import type { Failure, Result } from "@studio/config";
import { PlanLimitsService, type LimitsSeams } from "../limits-service.js";

export interface FakeSeamsInit {
  /** Subscription plan code, or null for a trial workspace. */
  readonly planCode?: string | null;
  readonly activeRuns?: number;
  readonly sessions?: number;
  readonly seats?: number;
}

export class InMemoryLimitsSeams implements LimitsSeams {
  planCode: string | null;
  activeRuns: number;
  sessions: number;
  seats: number;
  /** Last org id passed to any seam — the service must thread it through. */
  lastOrgId: string | null = null;
  readonly calls = {
    getSubscription: 0,
    countActiveRuns: 0,
    countSessions: 0,
    countSeats: 0,
  };

  constructor(init: FakeSeamsInit = {}) {
    this.planCode = init.planCode ?? null;
    this.activeRuns = init.activeRuns ?? 0;
    this.sessions = init.sessions ?? 0;
    this.seats = init.seats ?? 0;
  }

  async getSubscription(orgId: string): Promise<{ readonly planCode: string } | null> {
    this.calls.getSubscription += 1;
    this.lastOrgId = orgId;
    return this.planCode === null ? null : { planCode: this.planCode };
  }

  async countActiveRuns(orgId: string): Promise<number> {
    this.calls.countActiveRuns += 1;
    this.lastOrgId = orgId;
    return this.activeRuns;
  }

  async countSessions(orgId: string): Promise<number> {
    this.calls.countSessions += 1;
    this.lastOrgId = orgId;
    return this.sessions;
  }

  async countSeats(orgId: string): Promise<number> {
    this.calls.countSeats += 1;
    this.lastOrgId = orgId;
    return this.seats;
  }
}

/** Convenience: a PlanLimitsService over fresh in-memory seams. */
export function makeService(init: FakeSeamsInit = {}): {
  readonly service: PlanLimitsService;
  readonly seams: InMemoryLimitsSeams;
} {
  const seams = new InMemoryLimitsSeams(init);
  return { service: new PlanLimitsService(seams), seams };
}

export function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  }
  return result.value;
}

export function expectErr<T>(result: Result<T>): Failure {
  if (result.ok) {
    throw new Error(`expected failure, got ok: ${JSON.stringify(result.value)}`);
  }
  return result;
}
