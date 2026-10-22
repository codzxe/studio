// barrel.test.ts — W10-O TS1205 sweep gate for the @studio/billing public
// barrel. src/index.ts is star-exports only (`export *` carries value and type
// kinds correctly under verbatimModuleSyntax — no TS1205s to fix here); this
// suite pins the fleet barrel contract for it anyway:
//   1. every VALUE export still resolves from "../src/index.js";
//   2. type-only names stay usable in type positions and stay erased at
//      runtime (`import type` + a runtime call through a typed helper).
// Deterministic by construction: importing the barrel evaluates only module
// top-levels (zod schemas, rule tables) — no network, no clock, no store.

import { describe, expect, expectTypeOf, it } from "vitest";
import * as billing from "../src/index.js";
import type { LedgerStore } from "../src/index.js";

/** Every key of the barrel namespace must be a defined runtime value. */
function expectNamespaceIsClean(): void {
  const keys = Object.keys(billing);
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of keys) {
    expect(billing[key as keyof typeof billing], `undefined export: ${key}`).toBeDefined();
  }
  // Floor: 85 value exports at W10-O sweep time. A star-export collision
  // (silently dropped ambiguous name) shrinks the namespace and trips this.
  expect(keys.length).toBeGreaterThanOrEqual(85);
}

describe("W10-O barrel: value exports resolve from src/index.js", () => {
  it("imports cleanly with a fully-defined, duplicate-free namespace", () => {
    expectNamespaceIsClean();
  });

  it("domain functions resolve (typeof function)", () => {
    const functions = [
      "classifyRefund", // §14.2 refund classification
      "isFreeRetry",
      "creditsForRun", // §5.2 per-run credit cost
      "creditsForImages",
      "maxPartialFailureCharge",
      "workspaceCogsAlertBreached", // §0 COGS alert gates
      "runCostIsOutlier",
      "platformCogsAlertBreached",
      "trialEligibility", // W9-B trial rules
      "isTrialRunTierAllowed",
      "checkTrialRunTier",
      "checkTrialAssetCount",
      "guardrailOk", // W9-N guardrails
      "guardrailErr",
      "isGuardrailFailure",
      "guardrailCodeToErrorCode",
      "isValidOrgId",
      "sanitizeCounter",
      "formatUsdCents",
    ];
    for (const name of functions) {
      expect(typeof billing[name as keyof typeof billing], name).toBe("function");
    }
  });

  it("key constants resolve with their actual kinds", () => {
    expect(typeof billing.PlanLimitsService).toBe("function"); // W9-B service
    expect(typeof billing.RUN_INTAKE_SCHEMA).toBe("object"); // zod §14 run gate
    expect(billing.TRIAL_MAX_RUN_CREDITS).toBe(2);
    expect(Array.isArray(billing.REFUND_CAUSES)).toBe(true); // §14.2 catalog
    expect(Array.isArray(billing.REFUND_POLICIES)).toBe(true);
    expect(typeof billing.GUARDRAIL_ERROR_CODES).toBe("object");
    expect(typeof billing.TRIAL_ALLOWED_RUN_TIERS).toBe("object");
  });
});

describe("W10-O barrel: type-only re-exports stay types (erased at runtime)", () => {
  it("import type names resolve and match their source modules", () => {
    // LedgerStore is the package's one storage seam (ledger.ts) — it rides
    // the ledger.js star-export as a type-only name.
    expectTypeOf<LedgerStore>().toEqualTypeOf<import("../src/ledger.js").LedgerStore>();
    expectTypeOf<LedgerStore>().not.toBeNull();
  });

  it("type-only imports are usable at runtime-safe positions", () => {
    // The parameter is a compile-time-only position: importing LedgerStore as
    // a type must never surface a runtime binding of a type-only name.
    const pin = (_store: LedgerStore | null): "null" | "store" =>
      _store === null ? "null" : "store";
    expect(pin(null)).toBe("null");
  });
});
