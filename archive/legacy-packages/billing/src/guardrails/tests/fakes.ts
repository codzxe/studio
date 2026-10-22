// In-memory seam fakes + GuardrailResult helpers for the guardrails tests
// (AGENTS.md: deterministic, no network, no DB). Seam calls are counted so
// the tests can assert gate ordering (kill switches before counters) and
// short-circuiting, mirroring limits/tests/fakes.ts.

import type { ModelProviderClass } from "@studio/config";
import type { DailySpendSeams } from "../daily-caps.js";
import type { DemoWorkspaceSeams } from "../demo-workspace.js";
import type { ProviderHealthSeams } from "../provider-killswitch.js";
import type { GuardrailFailure, GuardrailResult } from "../types.js";

/** A fixed wall clock: `atUtc("2027-03-14")` → epoch ms. */
export function atUtc(iso: string): number {
  return new Date(`${iso}T00:00:00.000Z`).getTime();
}

// ---------------------------------------------------------------------------
// DailySpendGuard seams
// ---------------------------------------------------------------------------

export class InMemoryDailySpendSeams implements DailySpendSeams {
  /** spend per org, USD cents. */
  readonly spend = new Map<string, number>();
  /** The `kill_switched` flag set (§18.4 admin kill switch). */
  readonly disabled = new Set<string>();
  nowMs: number;
  /** When true, spendToday() rejects (fail-open coverage). */
  throwSpend = false;
  /** When true, isDisabled() rejects (fail-open coverage). */
  throwDisabled = false;
  readonly calls = { spendToday: 0, isDisabled: 0 };

  constructor(nowMs: number = atUtc("2027-03-14")) {
    this.nowMs = nowMs;
  }

  now(): number {
    return this.nowMs;
  }

  async spendToday(orgId: string): Promise<number> {
    this.calls.spendToday += 1;
    if (this.throwSpend) {
      throw new Error("usage_daily rollup unavailable");
    }
    return this.spend.get(orgId) ?? 0;
  }

  async isDisabled(orgId: string): Promise<boolean> {
    this.calls.isDisabled += 1;
    if (this.throwDisabled) {
      throw new Error("workspaces table unavailable");
    }
    return this.disabled.has(orgId);
  }
}

// ---------------------------------------------------------------------------
// DemoWorkspacePolicy seams
// ---------------------------------------------------------------------------

export class InMemoryDemoSeams implements DemoWorkspaceSeams {
  runsToday = 0;
  nowMs: number;
  /** §18.4 workspace kill switch for the demo org (optional seam). */
  demoOrgDisabled = false;
  throwCounter = false;
  readonly calls = { countRunsToday: 0, isDisabled: 0 };

  constructor(nowMs: number = atUtc("2027-03-14")) {
    this.nowMs = nowMs;
  }

  now(): number {
    return this.nowMs;
  }

  async countRunsToday(): Promise<number> {
    this.calls.countRunsToday += 1;
    if (this.throwCounter) {
      throw new Error("demo counter unavailable");
    }
    return this.runsToday;
  }

  async isDisabled(orgId: string): Promise<boolean> {
    this.calls.isDisabled += 1;
    return this.demoOrgDisabled && orgId === "demo-workspace";
  }
}

// ---------------------------------------------------------------------------
// ProviderHealthPolicy seams
// ---------------------------------------------------------------------------

export class InMemoryProviderHealthSeams implements ProviderHealthSeams {
  /** DB-backed admin kill-switch flags per provider. */
  readonly disabled = new Set<ModelProviderClass>();
  throwFlags = false;
  readonly calls: Partial<Record<ModelProviderClass, number>> = {};

  async isProviderDisabled(provider: ModelProviderClass): Promise<boolean> {
    this.calls[provider] = (this.calls[provider] ?? 0) + 1;
    if (this.throwFlags) {
      throw new Error("provider health table unavailable");
    }
    return this.disabled.has(provider);
  }
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

export function expectOk<T>(result: GuardrailResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  }
  return result.value;
}

export function expectErr<T>(result: GuardrailResult<T>): GuardrailFailure {
  if (result.ok) {
    throw new Error(`expected failure, got ok: ${JSON.stringify(result.value)}`);
  }
  return result;
}
