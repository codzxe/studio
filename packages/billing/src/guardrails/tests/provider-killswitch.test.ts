// The provider-class kill switch (§5.3 health routing + §21 revoke-provider-
// key drill): class membership + preference order, tier→class mapping, the
// env drain list, same-class failover, class-wide disable → failover class
// → typed providers_disabled, and fail-open seams.

import {
  MODEL_PROVIDER_CLASSES,
  RUN_TIER_IDS,
  type ModelProviderClass,
} from "@studio/config";
import { describe, expect, it } from "vitest";
import {
  CIRCUIT_CLASS_FAILOVER,
  CIRCUIT_CLASS_PROVIDERS,
  PROVIDER_CIRCUIT_CLASSES,
  ProviderHealthPolicy,
  TIER_CIRCUIT_CLASS,
  parseDisabledProviders,
  DISABLED_PROVIDERS_ENV_VAR,
} from "../provider-killswitch.js";
import {
  InMemoryProviderHealthSeams,
  expectErr,
  expectOk,
} from "./fakes.js";

const TEXT_PROVIDERS = CIRCUIT_CLASS_PROVIDERS.text;

function makePolicy(
  init: { dbDisabled?: readonly ModelProviderClass[]; envDisabled?: readonly ModelProviderClass[] } = {},
): { policy: ProviderHealthPolicy; seams: InMemoryProviderHealthSeams } {
  const seams = new InMemoryProviderHealthSeams();
  for (const provider of init.dbDisabled ?? []) {
    seams.disabled.add(provider);
  }
  const policy = new ProviderHealthPolicy(seams, { envDisabled: init.envDisabled });
  return { policy, seams };
}

// ---------------------------------------------------------------------------
// §5.3 tables
// ---------------------------------------------------------------------------

describe("circuit class tables (§5.3)", () => {
  it("classes: text, image_draft, image_final", () => {
    expect(PROVIDER_CIRCUIT_CLASSES).toEqual(["text", "image_draft", "image_final"]);
  });

  it("every class member is a configured provider class (one env key per provider, §5.3)", () => {
    for (const circuitClass of PROVIDER_CIRCUIT_CLASSES) {
      for (const provider of CIRCUIT_CLASS_PROVIDERS[circuitClass]) {
        expect(MODEL_PROVIDER_CLASSES).toContain(provider);
      }
    }
  });

  it("preference order follows the §5.3 default columns: text→gemini, drafts→flux, finals→gemini", () => {
    expect(TEXT_PROVIDERS[0]).toBe("gemini");
    expect(CIRCUIT_CLASS_PROVIDERS.image_draft).toEqual(["flux"]);
    expect(CIRCUIT_CLASS_PROVIDERS.image_final[0]).toBe("gemini");
    expect(CIRCUIT_CLASS_PROVIDERS.image_final).toContain("openai");
  });

  it("every run tier maps to exactly one circuit class", () => {
    expect(TIER_CIRCUIT_CLASS).toEqual({
      quick: "text",
      standard: "text",
      complex: "text",
      premium: "text",
      max: "text",
      image_gen: "image_draft",
      image_gen_hd: "image_final",
    });
    expect(Object.keys(TIER_CIRCUIT_CLASS).length).toBe(RUN_TIER_IDS.length);
  });

  it("failover classes: HD finals degrade to drafts; text and drafts have none", () => {
    expect(CIRCUIT_CLASS_FAILOVER.image_final).toBe("image_draft");
    expect(CIRCUIT_CLASS_FAILOVER.text).toBeNull();
    expect(CIRCUIT_CLASS_FAILOVER.image_draft).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Env drain list (§21 drill lever)
// ---------------------------------------------------------------------------

describe("parseDisabledProviders (env drain list)", () => {
  it("names the env var", () => {
    expect(DISABLED_PROVIDERS_ENV_VAR).toBe("PROVIDERS_DISABLED");
  });

  const rows = [
    { raw: undefined, expected: [] },
    { raw: "", expected: [] },
    { raw: "   ", expected: [] },
    { raw: "anthropic", expected: ["anthropic"] },
    { raw: "anthropic,openai", expected: ["anthropic", "openai"] },
    { raw: " anthropic ,  openai ", expected: ["anthropic", "openai"] },
    { raw: "Anthropic,ANTHROPIC", expected: ["anthropic"] }, // case-insensitive, deduped
  ] as const;
  for (const row of rows) {
    it(`${JSON.stringify(row.raw)} → [${row.expected.join(", ")}]`, () => {
      expect(parseDisabledProviders(row.raw)).toEqual(row.expected);
    });
  }

  it("fails fast on an unknown provider — a typo must not quietly drain nothing", () => {
    expect(() => parseDisabledProviders("anthropic,typo")).toThrow(/unknown provider/);
  });
});

// ---------------------------------------------------------------------------
// Same-class failover (§5.3) — the §21 revoke-provider-key drill outcome
// ---------------------------------------------------------------------------

describe("single-provider disable → same-class failover (§21 drill)", () => {
  it("all enabled: every tier routes to its class's §5.3 primary", async () => {
    const { policy } = makePolicy();
    expect(expectOk(await policy.resolveForTier("standard")).provider).toBe("gemini");
    expect(expectOk(await policy.resolveForTier("premium")).provider).toBe("gemini");
    expect(expectOk(await policy.resolveForTier("image_gen")).provider).toBe("flux");
    expect(expectOk(await policy.resolveForTier("image_gen_hd")).provider).toBe("gemini");
  });

  it("§21 drill: revoking the Anthropic key (DB flag) fails premium runs over to Gemini — no customer impact", async () => {
    const { policy } = makePolicy({ dbDisabled: ["anthropic"] });
    const route = expectOk(await policy.resolveForTier("premium"));
    expect(route).toEqual({
      tier: "premium",
      circuitClass: "text",
      provider: "gemini",
      degradedFromClass: null,
    });
    expect(route.degradedFromClass).toBeNull(); // same-class failover is NOT degradation
  });

  it("env drain list and DB flags union: either lever disables a provider", async () => {
    const { policy } = makePolicy({ envDisabled: ["gemini"] });
    expect(await policy.isProviderEnabled("gemini")).toBe(false);
    const route = expectOk(await policy.resolveForTier("standard"));
    expect(route.provider).toBe("anthropic"); // next in §5.3 preference order
    expect(route.degradedFromClass).toBeNull();
  });

  it("selectProvider honours a healthy preferred provider and fails over past a disabled one", async () => {
    const { policy } = makePolicy({ dbDisabled: ["openai"] });
    expect(expectOk(await policy.selectProvider("image_final", { preferred: "openai" }))).toBe("gemini");
    expect(expectOk(await policy.selectProvider("image_final", { preferred: "gemini" }))).toBe("gemini");
  });

  it("enabledProviders keeps §5.3 preference order after filtering", async () => {
    const { policy } = makePolicy({ dbDisabled: ["gemini", "openai"] });
    expect(await policy.enabledProviders("text")).toEqual(["anthropic", "deepseek"]);
    expect(await policy.enabledProviders("image_final")).toEqual([]);
    expect(await policy.circuitClassDisabled("image_final")).toBe(true);
    expect(await policy.circuitClassDisabled("text")).toBe(false);
  });

  it("fails OPEN when the DB flag seam is down (runtime breaker stays authoritative)", async () => {
    const { policy, seams } = makePolicy();
    seams.throwFlags = true;
    expect(await policy.isProviderEnabled("anthropic")).toBe(true);
    const route = expectOk(await policy.resolveForTier("standard"));
    expect(route.provider).toBe("gemini");
  });
});

// ---------------------------------------------------------------------------
// Class-wide disable → failover class → typed providers_disabled (§5.3/§21)
// ---------------------------------------------------------------------------

describe("class-wide disable (typed providers_disabled)", () => {
  it("every text provider disabled → text tiers rejected with providers_disabled", async () => {
    const { policy } = makePolicy({
      dbDisabled: ["gemini", "anthropic", "openai", "deepseek"],
    });
    const failure = expectErr(await policy.resolveForTier("standard"));
    expect(failure.code).toBe("providers_disabled");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("text");
    expect(failure.hint).toContain("Operations must re-enable");
  });

  it("image_final drained → image_gen_hd DEGRADES to the image_draft failover class", async () => {
    const { policy } = makePolicy({ dbDisabled: ["gemini", "openai"] });
    const route = expectOk(await policy.resolveForTier("image_gen_hd"));
    expect(route).toEqual({
      tier: "image_gen_hd",
      circuitClass: "image_draft",
      provider: "flux",
      degradedFromClass: "image_final",
    });
  });

  it("image_final AND its failover drained → image_gen_hd rejected (failover also named in the hint)", async () => {
    const { policy } = makePolicy({
      dbDisabled: ["gemini", "openai", "flux"],
    });
    const failure = expectErr(await policy.resolveForTier("image_gen_hd"));
    expect(failure.code).toBe("providers_disabled");
    expect(failure.hint).toContain("image_final");
    expect(failure.hint).toContain("image_draft");
    expect(failure.retryable).toBe(false);
  });

  it("image_draft drained → image_gen rejected (no failover class exists)", async () => {
    const { policy } = makePolicy({ dbDisabled: ["flux"] });
    const failure = expectErr(await policy.resolveForTier("image_gen"));
    expect(failure.code).toBe("providers_disabled");
    expect(failure.hint).not.toContain("failover class"); // text/drafts have no failover
  });

  it("unknown tiers fail validation before any seam call", async () => {
    const { policy, seams } = makePolicy();
    const failure = expectErr(
      await policy.resolveForTier("god-mode" as Parameters<typeof policy.resolveForTier>[0]),
    );
    expect(failure.code).toBe("validation_failed");
    expect(Object.keys(seams.calls).length).toBe(0);
  });
});
