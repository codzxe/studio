// wiring-check tests (W9-A) — table-driven, pure, hermetic (AGENTS.md law).
//
// Covers the startup audit contract:
//   §4      fail-fast — a missing STRIPE_PRICE_* env or a NoopStripe provider
//           in production must refuse to start with the typed
//           `stripe_not_configured` error + setup hint;
//   §14.1   env → plan-code → config mapping resolves to 100/250/600 credits;
//   §14.3   STRIPE_PRICE_STARTER/PRO/MAX env names (plus the W1-B aliases).

import { describe, expect, it } from "vitest";
import { AppError } from "../../../middleware/error-mapper.js";
import { NoopStripe, type StripeLike } from "../../stripe.js";
import {
  auditStripeWiring,
  configPlanForWireCode,
  guardStripeWiring,
  monthlyCreditsForWireCode,
  type StripeWiringFinding,
} from "../wiring-check.js";

/** A minimal non-Noop provider standing in for createStripeSdk's result. */
const sdkLikeStripe: StripeLike = {
  constructEvent(): never {
    throw new Error("unused in the audit");
  },
  createCheckoutSession: async () => ({ url: "https://checkout.example", sessionId: "cs_test" }),
  createPortalSession: async () => ({ url: "https://portal.example" }),
  upsertCustomer: async () => ({ customerId: "cus_test" }),
};

const PRICE_ENV_OK: Readonly<Record<string, string>> = {
  STRIPE_PRICE_STARTER: "price_starter",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_MAX: "price_max",
};

function findingsOf(
  env: Readonly<Record<string, string | undefined>>,
  stripe: StripeLike,
  nodeEnv: string,
): readonly StripeWiringFinding[] {
  return auditStripeWiring({ env, stripe, nodeEnv }).findings;
}

describe("auditStripeWiring — env → plan-code → config (§14.1/§14.3)", () => {
  it("resolves the full STRIPE_PRICE_* mapping to §14.1 credit grants", () => {
    const audit = auditStripeWiring({
      env: PRICE_ENV_OK,
      stripe: sdkLikeStripe,
      nodeEnv: "production",
    });
    expect(audit.ok).toBe(true);
    expect(audit.findings).toEqual([]);
    expect(audit.noopProvider).toBe(false);
    expect(audit.planCredits).toEqual({ starter: 100, pro: 250, max: 600 });
    expect(audit.priceMap).toMatchObject({
      starter: "price_starter",
      pro: "price_pro",
      max: "price_max",
    });
  });

  it("accepts the W1-B PLAN_*_CREDITS aliases for the same tiers", () => {
    const audit = auditStripeWiring({
      env: {
        STRIPE_PRICE_PLAN_100_CREDITS: "price_a",
        STRIPE_PRICE_PLAN_250_CREDITS: "price_b",
        STRIPE_PRICE_PLAN_120_CREDITS: "price_c",
      },
      stripe: sdkLikeStripe,
      nodeEnv: "production",
    });
    expect(audit.ok).toBe(true);
    expect(audit.priceMap).toMatchObject({ starter: "price_a", pro: "price_b", max: "price_c" });
  });

  const missingEnvCases: ReadonlyArray<{
    readonly name: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  }> = [
    { name: "no env at all", env: {} },
    {
      name: "missing STRIPE_PRICE_STARTER",
      env: { STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_MAX: "price_max" },
    },
    {
      name: "missing STRIPE_PRICE_PRO",
      env: { STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_MAX: "price_max" },
    },
    {
      name: "missing STRIPE_PRICE_MAX",
      env: { STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_PRO: "price_pro" },
    },
  ];
  for (const c of missingEnvCases) {
    it(`fails fast when ${c.name} (§4)`, () => {
      const audit = auditStripeWiring({ env: c.env, stripe: sdkLikeStripe, nodeEnv: "production" });
      expect(audit.ok).toBe(false);
      expect(audit.priceMap).toBeNull();
      expect(audit.planCredits).toBeNull();
      const finding = audit.findings.find((f) => f.code === "price_env_missing");
      expect(finding).toBeDefined();
      expect(finding?.hint).toContain("STRIPE_PRICE_");
    });
  }
});

describe("auditStripeWiring — NoopStripe in production (§4 fail-fast)", () => {
  const noopCases: ReadonlyArray<{
    readonly name: string;
    readonly nodeEnv: string;
    readonly fatal: boolean;
  }> = [
    { name: "refuses production", nodeEnv: "production", fatal: true },
    { name: "allows development", nodeEnv: "development", fatal: false },
    { name: "allows test", nodeEnv: "test", fatal: false },
  ];
  for (const c of noopCases) {
    it(c.name, () => {
      const audit = auditStripeWiring({
        env: PRICE_ENV_OK,
        stripe: new NoopStripe(),
        nodeEnv: c.nodeEnv,
      });
      expect(audit.noopProvider).toBe(true);
      expect(audit.ok).toBe(!c.fatal);
      const finding = audit.findings.find((f) => f.code === "stripe_not_configured");
      if (c.fatal) {
        // Typed error + setup hint per §4 — not a stack trace or an internal id.
        expect(finding).toBeDefined();
        expect(finding?.message).toContain("NoopStripe");
        expect(finding?.hint).toContain("createStripeSdk");
        expect(finding?.hint).toContain("STRIPE_SECRET_KEY");
      } else {
        expect(finding).toBeUndefined();
      }
    });
  }
});

describe("auditStripeWiring — price-id ↔ plan-code dedup", () => {
  const duplicateCases: ReadonlyArray<{
    readonly name: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly expectPlanCode: string;
  }> = [
    {
      name: "starter and pro share a price id",
      env: { ...PRICE_ENV_OK, STRIPE_PRICE_PRO: "price_starter" },
      expectPlanCode: "pro",
    },
    {
      name: "pack reuses the starter price",
      env: { ...PRICE_ENV_OK, STRIPE_PRICE_PACK: "price_starter" },
      expectPlanCode: "pack",
    },
    {
      name: "seat reuses the max price",
      env: { ...PRICE_ENV_OK, STRIPE_PRICE_EXTRA_SEAT: "price_max" },
      expectPlanCode: "seat",
    },
  ];
  for (const c of duplicateCases) {
    it(c.name, () => {
      const audit = auditStripeWiring({ env: c.env, stripe: sdkLikeStripe, nodeEnv: "development" });
      expect(audit.ok).toBe(false);
      const finding = audit.findings.find((f) => f.code === "duplicate_price_id");
      expect(finding).toBeDefined();
      expect(finding?.planCode).toBe(c.expectPlanCode);
    });
  }

  it("unique prices across all five products pass the dedup", () => {
    const audit = auditStripeWiring({
      env: {
        ...PRICE_ENV_OK,
        STRIPE_PRICE_PACK: "price_pack",
        STRIPE_PRICE_EXTRA_SEAT: "price_seat",
      },
      stripe: sdkLikeStripe,
      nodeEnv: "development",
    });
    expect(audit.ok).toBe(true);
    expect(findingsOf(PRICE_ENV_OK, sdkLikeStripe, "development")).toEqual([]);
  });
});

describe("guardStripeWiring — the §4 refuse-to-start gate", () => {
  it("returns the audit when the wiring is correct", () => {
    const audit = guardStripeWiring({ env: PRICE_ENV_OK, stripe: sdkLikeStripe, nodeEnv: "production" });
    expect(audit.ok).toBe(true);
  });

  it("throws the typed stripe_not_configured error for production NoopStripe", () => {
    let caught: unknown = null;
    try {
      guardStripeWiring({ env: PRICE_ENV_OK, stripe: new NoopStripe(), nodeEnv: "production" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    const appError = caught as AppError;
    expect(appError.code).toBe("stripe_not_configured");
    expect(appError.status).toBe(503);
    expect(appError.hint).toContain("createStripeSdk");
    expect(appError.retryable).toBe(false);
  });

  it("throws price_env_missing (the first finding) when the env is absent", () => {
    let caught: unknown = null;
    try {
      guardStripeWiring({ env: {}, stripe: sdkLikeStripe, nodeEnv: "production" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("price_env_missing");
  });
});

describe("wire ↔ config plan mapping (mirror of stripe.ts's private table)", () => {
  it("maps max to the config business tier and its §14.1 credits", () => {
    expect(configPlanForWireCode("starter")).toBe("starter");
    expect(configPlanForWireCode("pro")).toBe("pro");
    expect(configPlanForWireCode("max")).toBe("business");
    expect(monthlyCreditsForWireCode("starter")).toBe(100);
    expect(monthlyCreditsForWireCode("pro")).toBe(250);
    expect(monthlyCreditsForWireCode("max")).toBe(600);
  });
});
