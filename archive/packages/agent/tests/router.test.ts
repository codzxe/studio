// W6-H — §5.3 model router: tier routing table, circuit breakers, same-class
// failover, health snapshots, off-peak batch preference, and the provider
// seam (§5.4 static-prefix cache adviser + cache-hit tracking hooks).
import { describe, expect, it } from "vitest";
import * as budgetsModule from "../src/budgets.js";
import * as errorsModule from "../src/errors.js";
import {
  MODEL_CLASS_IDS,
  MODEL_ROUTE_ROLES,
  type ModelClass,
  type ModelRouteRole,
  ROLE_ROUTES,
  TIER_MODEL_CLASS,
  routeChain,
} from "../src/models.js";
import * as modelsModule from "../src/models.js";
import * as routerBarrel from "../src/router/index.js";
import {
  CACHE_HIT_TARGET,
  type CacheablePrefix,
  type CompletionRequest,
  type CompletionResult,
  type CompletionUsage,
  type ProviderCacheStats,
  ProviderCacheTracker,
  type ProviderLike,
  type ProviderStreamEvent,
  STATIC_PREFIX_SEPARATOR,
  buildCacheablePrefix,
} from "../src/router/provider-adapter.js";
import {
  IMAGE_TIER_ROUTE_CLASS,
  ModelRouter,
  ROUTE_COOLDOWN_MS_DEFAULT,
  ROUTE_FAILURE_THRESHOLD_DEFAULT,
  ROUTE_FAILURE_WINDOW_MS_DEFAULT,
  type RouteDecision,
  type RouteRequest,
  RouterError,
  preferOffPeakRoutes,
  routeClassForTier,
} from "../src/router/router.js";

// --- fixtures ------------------------------------------------------------------------

/** Deterministic injectable clock (budgets.test.ts pattern). */
function fakeClock(startAtMs = 0): { clock: () => number; set: (ms: number) => void } {
  let now = startAtMs;
  return {
    clock: () => now,
    set: (ms: number) => {
      now = ms;
    },
  };
}

const INTERACTIVE_TIERS = ["quick", "standard", "complex", "premium", "max"] as const;
type InteractiveTier = (typeof INTERACTIVE_TIERS)[number];

const EXPECTED_CLASS: Readonly<Record<InteractiveTier, ModelClass>> = {
  quick: "economy",
  standard: "default",
  complex: "default_plus",
  premium: "premium",
  max: "max",
};

/** §5.3 routing table primaries (W1-P ids, Appendix C names). `null` = "—". */
const EXPECTED_PRIMARY: Readonly<
  Record<ModelRouteRole, Readonly<Record<InteractiveTier, string | null>>>
> = {
  planner: {
    quick: "gemini-2.5-flash-lite",
    standard: "gemini-3.8-flash",
    complex: "gemini-3.8-flash",
    premium: "claude-sonnet-5.5",
    max: "claude-opus-5.5",
  },
  executor: {
    quick: "deepseek-v4.1-flash", // §5.3 economy executor (off-peak)
    standard: "gemini-3.8-flash",
    complex: "gemini-3.8-flash",
    premium: "claude-sonnet-5.5",
    max: "claude-opus-5.5",
  },
  critic: {
    quick: null, // §5.3: "— (skip for quick tier)"
    standard: "gemini-3.8-flash",
    complex: "gemini-3.8-flash",
    premium: "claude-sonnet-5.5",
    max: "claude-opus-5.5",
  },
  imageDrafts: {
    quick: "flux-2-schnell",
    standard: "flux-2-schnell",
    complex: "flux-2-schnell",
    premium: "flux-2-schnell",
    max: "gemini-3-pro-image",
  },
  imageFinals: {
    quick: null, // §5.3: "—" quick tier ships draft quality
    standard: "gemini-3-pro-image",
    complex: "gemini-3-pro-image",
    premium: "gemini-3-pro-image",
    max: "gpt-image-1.5",
  },
};

const req = (tier: RouteRequest["tier"], plan: RouteRequest["plan"] = "pro"): RouteRequest => ({
  tier,
  plan,
});

function healthyRouter(): ModelRouter {
  return new ModelRouter({ clock: fakeClock(1_000).clock });
}

// --- §5.3 routing table: 5 roles × 5 tiers -------------------------------------------

describe("router: §5.3 routing table (5 roles × 5 tiers)", () => {
  for (const role of MODEL_ROUTE_ROLES) {
    for (const tier of INTERACTIVE_TIERS) {
      it(`${role} × ${tier} → ${EXPECTED_CLASS[tier]}/${EXPECTED_PRIMARY[role][tier] ?? "—"}`, () => {
        const router = healthyRouter();
        const decision = router.resolve(role, req(tier));

        expect(decision.role).toBe(role);
        expect(decision.tier).toBe(tier);
        expect(decision.modelClass).toBe(EXPECTED_CLASS[tier]);
        expect(decision.plan).toBe("pro");
        expect(decision.batch).toBe(false);

        const expected = EXPECTED_PRIMARY[role][tier];
        if (expected === null) {
          // §5.3 "—" row: skipped for this class, but NOT an error.
          expect(decision.roleRouted).toBe(false);
          expect(decision.routes).toHaveLength(0);
          expect(decision.failure).toBeNull();
          expect(decision.failedOverFrom).toBeNull();
          expect(decision.unavailable).toHaveLength(0);
          return;
        }

        expect(decision.roleRouted).toBe(true);
        expect(decision.routes[0]?.id).toBe(expected);
        expect(decision.routes[0]?.provider).toBe(
          ROLE_ROUTES[role][EXPECTED_CLASS[tier]]?.provider,
        );
        expect(decision.routes[0]?.kind).toBe("primary");
        expect(decision.routes[0]?.breaker).toBe("closed");
        expect(decision.routes[0]?.probing).toBe(false);
        expect(decision.failure).toBeNull();
        expect(decision.failedOverFrom).toBeNull();

        // Failover is same-class (§5.3) and a second vendor always exists.
        for (const route of decision.routes) {
          expect(route.class).toBe(decision.modelClass);
        }
        expect(decision.routes.length).toBeGreaterThanOrEqual(2);
        expect(decision.routes[1]?.kind).toBe("fallback");
        expect(new Set(decision.routes.map((route) => route.provider)).size).toBeGreaterThanOrEqual(
          2,
        );
      });
    }
  }

  it("pins the fallback ids of the §5.3 failover pairs", () => {
    const router = healthyRouter();
    // §5.3's only explicit pair: economy planner "Gemini 2.5 Flash-Lite / DeepSeek V4.1 Flash".
    expect(router.resolve("planner", req("quick")).routes.map((r) => r.id)).toEqual([
      "gemini-2.5-flash-lite",
      "deepseek-v4.1-flash",
    ]);
    expect(router.resolve("planner", req("standard")).routes.map((r) => r.id)).toEqual([
      "gemini-3.8-flash",
      "claude-haiku-4.5",
    ]);
    expect(router.resolve("executor", req("quick")).routes.map((r) => r.id)).toEqual([
      "deepseek-v4.1-flash",
      "gemini-2.5-flash-lite",
    ]);
    expect(router.resolve("imageFinals", req("max")).routes.map((r) => r.id)).toEqual([
      "gpt-image-1.5",
      "gemini-3-pro-image",
    ]);
    expect(router.resolve("imageDrafts", req("max")).routes.map((r) => r.id)).toEqual([
      "gemini-3-pro-image",
      "flux-2-schnell",
    ]);
  });

  it("routeClassForTier matches the W1-P TIER_MODEL_CLASS for the five interactive tiers", () => {
    for (const tier of INTERACTIVE_TIERS) {
      expect(routeClassForTier(tier)).toBe(TIER_MODEL_CLASS[tier]);
      expect(routeClassForTier(tier)).toBe(EXPECTED_CLASS[tier]);
    }
  });

  it("image tiers (§5.2 rows 6–7) route by role through the neutral default column", () => {
    const router = healthyRouter();
    expect(routeClassForTier("image_gen")).toBe(IMAGE_TIER_ROUTE_CLASS.image_gen);
    expect(routeClassForTier("image_gen_hd")).toBe(IMAGE_TIER_ROUTE_CLASS.image_gen_hd);

    // Row 6: image gen (1024²) = Flux-class → drafts.
    const drafts = router.resolve("imageDrafts", req("image_gen"));
    expect(drafts.modelClass).toBe("default");
    expect(drafts.routes[0]?.id).toBe("flux-2-schnell");
    expect(drafts.routes[0]?.provider).toBe("flux");

    // Row 7: image gen HD = Gemini/GPT Image class → finals.
    const finals = router.resolve("imageFinals", req("image_gen_hd"));
    expect(finals.modelClass).toBe("default");
    expect(finals.routes[0]?.id).toBe("gemini-3-pro-image");
  });

  it("plan is recorded but NEVER downgrades a §5.2 tier row (affordability is credit-side, §14.2)", () => {
    const router = healthyRouter();
    for (const tier of INTERACTIVE_TIERS) {
      for (const role of MODEL_ROUTE_ROLES) {
        const starter = router.resolve(role, req(tier, "starter"));
        const pro = router.resolve(role, req(tier, "pro"));
        const business = router.resolve(role, req(tier, "business"));
        expect(starter.routes.map((r) => r.id)).toEqual(pro.routes.map((r) => r.id));
        expect(pro.routes.map((r) => r.id)).toEqual(business.routes.map((r) => r.id));
        expect(pro.plan).toBe("pro");
      }
    }
  });
});

// --- §5.3 never-single-vendor ---------------------------------------------------------

describe("router: §5.3 never hardcode a single vendor", () => {
  it("every routed (role × class) chain offers ≥2 distinct provider vendors", () => {
    for (const role of MODEL_ROUTE_ROLES) {
      for (const modelClass of MODEL_CLASS_IDS) {
        if (ROLE_ROUTES[role][modelClass] === null) {
          continue; // §5.3 "—" row
        }
        const chain = routeChain(role, modelClass);
        expect(chain.length).toBeGreaterThanOrEqual(2);
        const providers = chain.map((route) => route.provider);
        expect(new Set(providers).size).toBeGreaterThanOrEqual(2);
        expect(providers[0]).not.toBe(providers[1]); // failover = a SECOND vendor
      }
    }
  });

  it("exports nothing that collides with the W1 lineage module exports", () => {
    // The hard gate for the full src/index.ts barrel is compile-time TS4078;
    // this pins the reachable W1 modules (budgets/errors/models — the naming
    // domains the router lives next to: Clock, agentErr, ModelRoute, …).
    for (const sibling of [budgetsModule, errorsModule, modelsModule]) {
      const overlap = Object.keys(routerBarrel).filter((key) => key in sibling);
      expect(overlap).toEqual([]);
    }
  });
});

// --- §5.3 circuit breakers + failover -------------------------------------------------

describe("router: §5.3 circuit breakers and same-class failover", () => {
  it("failover on an open breaker stays in the SAME class (§5.3)", () => {
    const { clock, set } = fakeClock(1_000);
    const router = new ModelRouter({ clock });
    set(1_000);
    router.recordCall("gemini", false, "provider_500");
    router.recordCall("gemini", false, "provider_500");
    router.recordCall("gemini", false, "provider_500"); // trips open (threshold 3)

    const decision = router.resolve("planner", req("standard"));
    expect(decision.routes[0]?.provider).toBe("anthropic");
    expect(decision.routes[0]?.id).toBe("claude-haiku-4.5");
    expect(decision.routes[0]?.class).toBe("default"); // same class as the primary
    expect(decision.routes[0]?.kind).toBe("primary");
    expect(decision.failedOverFrom).toMatchObject({ provider: "gemini", id: "gemini-3.8-flash" });
    expect(decision.unavailable).toContainEqual({
      route: expect.objectContaining({ provider: "gemini", id: "gemini-3.8-flash" }),
      reason: "breaker_open",
    });
    expect(decision.failure).toBeNull();
    // The healthy fallback's own breaker is untouched.
    expect(router.providerHealth().providers.anthropic.breaker).toBe("closed");
  });

  it("fails over to a configured second vendor when the primary is unconfigured", () => {
    const router = new ModelRouter({
      clock: fakeClock(0).clock,
      providers: ["anthropic", "openai"], // no GEMINI_API_KEY in this worker
    });
    const decision = router.resolve("planner", req("standard"));
    expect(decision.routes[0]?.provider).toBe("anthropic");
    expect(decision.routes[0]?.id).toBe("claude-haiku-4.5");
    expect(decision.failedOverFrom).toMatchObject({ provider: "gemini" });
    expect(decision.unavailable).toContainEqual({
      route: expect.objectContaining({ provider: "gemini" }),
      reason: "provider_unconfigured",
    });
  });

  it("never offers an unconfigured provider, even as the max-tier fallback", () => {
    const openaiOnly = new ModelRouter({ providers: ["openai"] });
    const finals = openaiOnly.resolve("imageFinals", req("max"));
    expect(finals.routes.map((r) => `${r.provider}:${r.id}`)).toEqual(["openai:gpt-image-1.5"]);

    const geminiOnly = new ModelRouter({ providers: ["gemini"] });
    const finalsHd = geminiOnly.resolve("imageFinals", req("max"));
    expect(finalsHd.routes.map((r) => `${r.provider}:${r.id}`)).toEqual([
      "gemini:gemini-3-pro-image",
    ]);
  });

  it("breaker lifecycle: N failures → open → cooldown → half_open → closed (§5.3)", () => {
    const { clock, set } = fakeClock(1_000);
    const router = new ModelRouter({ clock });

    // Two consecutive failures: still closed, primary still offered.
    router.recordCall("gemini", false, "provider_500");
    router.recordCall("gemini", false, "provider_500");
    let health = router.providerHealth();
    expect(health.providers.gemini.breaker).toBe("closed");
    expect(health.providers.gemini.consecutiveFailures).toBe(2);
    expect(router.resolve("planner", req("standard")).routes[0]?.provider).toBe("gemini");

    // Third failure inside the window trips the breaker open.
    router.recordCall("gemini", false, "provider_500");
    health = router.providerHealth();
    expect(health.providers.gemini.breaker).toBe("open");
    expect(health.providers.gemini.openedAt).toBe(1_000);
    expect(health.providers.gemini.acceptingCalls).toBe(false);
    expect(health.providers.gemini.cooldownRemainingMs).toBe(ROUTE_COOLDOWN_MS_DEFAULT);
    expect(health.providers.gemini.lastFailureCode).toBe("provider_500");
    expect(router.resolve("planner", req("standard")).routes[0]?.provider).toBe("anthropic");

    // Mid-cooldown: still open, remaining cooldown ticks down.
    set(10_000);
    health = router.providerHealth();
    expect(health.providers.gemini.breaker).toBe("open");
    expect(health.providers.gemini.cooldownRemainingMs).toBe(21_000);
    expect(router.resolve("planner", req("standard")).routes[0]?.provider).toBe("anthropic");

    // Cooldown elapsed: health stays read-only (open, but accepting calls)…
    set(31_000);
    health = router.providerHealth();
    expect(health.providers.gemini.breaker).toBe("open");
    expect(health.providers.gemini.acceptingCalls).toBe(true);
    expect(health.providers.gemini.cooldownRemainingMs).toBe(0);

    // …resolve() is the act of starting the half_open probe (§5.3).
    const probe = router.resolve("planner", req("standard"));
    expect(probe.routes[0]?.provider).toBe("gemini");
    expect(probe.routes[0]?.breaker).toBe("half_open");
    expect(probe.routes[0]?.probing).toBe(true);
    expect(router.providerHealth().providers.gemini.breaker).toBe("half_open");

    // Probe succeeds → closed again, streak reset.
    router.recordCall("gemini", true);
    health = router.providerHealth();
    expect(health.providers.gemini.breaker).toBe("closed");
    expect(health.providers.gemini.consecutiveFailures).toBe(0);
    expect(health.providers.gemini.lastFailureCode).toBeNull();
    expect(router.resolve("planner", req("standard")).routes[0]?.provider).toBe("gemini");
  });

  it("a failed half_open probe re-opens immediately for a fresh cooldown", () => {
    const { clock, set } = fakeClock(1_000);
    const router = new ModelRouter({ clock });
    for (let i = 0; i < ROUTE_FAILURE_THRESHOLD_DEFAULT; i += 1) {
      router.recordCall("gemini", false);
    }
    set(1_000 + ROUTE_COOLDOWN_MS_DEFAULT);
    expect(router.resolve("planner", req("standard")).routes[0]?.probing).toBe(true);

    router.recordCall("gemini", false, "provider_500");
    const health = router.providerHealth();
    expect(health.providers.gemini.breaker).toBe("open");
    expect(health.providers.gemini.openedAt).toBe(31_000); // cooldown restarted
    expect(health.providers.gemini.consecutiveFailures).toBe(4);
    expect(health.providers.gemini.acceptingCalls).toBe(false);
    expect(router.resolve("planner", req("standard")).routes[0]?.provider).toBe("anthropic");
  });

  it("success closes a breaker from ANY state (an in-flight recovery is honored)", () => {
    const { clock } = fakeClock(5_000);
    const router = new ModelRouter({ clock });
    for (let i = 0; i < ROUTE_FAILURE_THRESHOLD_DEFAULT; i += 1) {
      router.recordCall("anthropic", false);
    }
    expect(router.providerHealth().providers.anthropic.breaker).toBe("open");
    router.recordCall("anthropic", true);
    expect(router.providerHealth().providers.anthropic.breaker).toBe("closed");
  });

  it("failures only count as consecutive inside the window (§5.3 'in window')", () => {
    const { clock, set } = fakeClock(0);
    const router = new ModelRouter({ clock, windowMs: 1_000 });
    router.recordCall("gemini", false);
    set(900);
    router.recordCall("gemini", false);
    expect(router.providerHealth().providers.gemini.consecutiveFailures).toBe(2);

    // Boundary: exactly windowMs after the streak start still counts…
    set(1_000);
    router.recordCall("gemini", false);
    expect(router.providerHealth().providers.gemini.breaker).toBe("open");

    // …but a streak that spans past the window restarts at one.
    const { clock: clock2, set: set2 } = fakeClock(0);
    const router2 = new ModelRouter({ clock: clock2, windowMs: 1_000 });
    router2.recordCall("gemini", false);
    set2(900);
    router2.recordCall("gemini", false);
    set2(5_000); // 5000 - 0 > 1000 → stale streak
    router2.recordCall("gemini", false);
    expect(router2.providerHealth().providers.gemini.breaker).toBe("closed");
    expect(router2.providerHealth().providers.gemini.consecutiveFailures).toBe(1);
  });

  it("all providers down → provider_unhealthy failure (retryable, §13.3 shape)", () => {
    const { clock } = fakeClock(1_000);
    const router = new ModelRouter({ clock, providers: ["gemini", "anthropic"] });
    for (const provider of ["gemini", "anthropic"] as const) {
      for (let i = 0; i < ROUTE_FAILURE_THRESHOLD_DEFAULT; i += 1) {
        router.recordCall(provider, false);
      }
    }
    const decision = router.resolve("planner", req("standard"));
    expect(decision.roleRouted).toBe(true);
    expect(decision.routes).toHaveLength(0);
    expect(decision.failedOverFrom).toMatchObject({ provider: "gemini" });
    expect(decision.failure).not.toBeNull();
    expect(decision.failure?.ok).toBe(false);
    expect(decision.failure?.code).toBe("provider_unhealthy");
    expect(decision.failure?.retryable).toBe(true);
    expect(decision.failure?.message).toContain("§5.3");
    expect(decision.failure?.hint).toBeDefined();
    expect("value" in (decision.failure ?? {})).toBe(false);
    expect(router.providerHealth().allDown).toBe(true);
  });

  it("unhealthy failure names the tier/role/class without leaking internals", () => {
    const router = new ModelRouter({ clock: fakeClock(0).clock, providers: [] });
    const decision = router.resolve("critic", req("complex"));
    expect(decision.failure?.message).toContain("critic");
    expect(decision.failure?.message).toContain("complex");
    expect(decision.failure?.message).toContain("default_plus");
    // §5.3 "—" rows never produce failures.
    expect(router.resolve("critic", req("quick")).failure).toBeNull();
  });
});

// --- §5.3 providerHealth() snapshots --------------------------------------------------

describe("router: providerHealth() snapshot for health probes", () => {
  it("fresh snapshot: every provider configured, closed and accepting", () => {
    const router = healthyRouter();
    const health = router.providerHealth();
    expect(health.at).toBe(1_000);
    expect(health.failureThreshold).toBe(ROUTE_FAILURE_THRESHOLD_DEFAULT);
    expect(health.cooldownMs).toBe(ROUTE_COOLDOWN_MS_DEFAULT);
    expect(health.windowMs).toBe(ROUTE_FAILURE_WINDOW_MS_DEFAULT);
    expect(health.allDown).toBe(false);
    expect(Object.keys(health.providers)).toEqual([
      "gemini",
      "anthropic",
      "openai",
      "deepseek",
      "flux",
    ]);
    for (const entry of Object.values(health.providers)) {
      expect(entry.configured).toBe(true);
      expect(entry.breaker).toBe("closed");
      expect(entry.consecutiveFailures).toBe(0);
      expect(entry.lastFailureAt).toBeNull();
      expect(entry.lastFailureCode).toBeNull();
      expect(entry.openedAt).toBeNull();
      expect(entry.acceptingCalls).toBe(true);
      expect(entry.cooldownRemainingMs).toBe(0);
    }
    expect(Object.isFrozen(health)).toBe(true);
    expect(Object.isFrozen(health.providers)).toBe(true);
  });

  it("honors the configured-providers gate from worker env (§5.3 health flags)", () => {
    const router = new ModelRouter({
      clock: fakeClock(0).clock,
      providers: ["gemini", "deepseek"],
    });
    const health = router.providerHealth();
    expect(health.providers.gemini.configured).toBe(true);
    expect(health.providers.deepseek.configured).toBe(true);
    expect(health.providers.anthropic.configured).toBe(false);
    expect(health.providers.openai.configured).toBe(false);
    expect(health.providers.flux.configured).toBe(false);
    expect(health.allDown).toBe(false);
  });

  it("allDown only counts CONFIGURED providers (an empty worker is not 'down')", () => {
    const empty = new ModelRouter({ providers: [] });
    expect(empty.providerHealth().allDown).toBe(false);

    const geminiOnly = new ModelRouter({ clock: fakeClock(0).clock, providers: ["gemini"] });
    for (let i = 0; i < ROUTE_FAILURE_THRESHOLD_DEFAULT; i += 1) {
      geminiOnly.recordCall("gemini", false);
    }
    expect(geminiOnly.providerHealth().allDown).toBe(true);
  });

  it("policy defaults are the documented §5.3 constants", () => {
    expect(ROUTE_FAILURE_THRESHOLD_DEFAULT).toBe(3);
    expect(ROUTE_COOLDOWN_MS_DEFAULT).toBe(30_000);
    expect(ROUTE_FAILURE_WINDOW_MS_DEFAULT).toBe(60_000);
    const tuned = new ModelRouter({ failureThreshold: 5, cooldownMs: 60_000, windowMs: 5_000 });
    const health = tuned.providerHealth();
    expect(health.failureThreshold).toBe(5);
    expect(health.cooldownMs).toBe(60_000);
    expect(health.windowMs).toBe(5_000);
  });
});

// --- §5.3 off-peak batch preference ---------------------------------------------------

describe("router: off-peak batch endpoints for non-interactive jobs (§5.3)", () => {
  it("batch requests flag the preference and keep the §5.3 table order otherwise", () => {
    const router = healthyRouter();
    const interactive = router.resolve("executor", req("quick"));
    expect(interactive.batch).toBe(false);
    expect(interactive.offPeakPreferred).toBe(false);
    // §5.3 pins the economy executor to the off-peak DeepSeek endpoint for ALL runs.
    expect(interactive.routes[0]?.id).toBe("deepseek-v4.1-flash");
    expect(interactive.routes[0]?.offPeak).toBe(true);

    const batchRun = router.resolve("executor", req("quick", "pro"));
    const batch = router.resolve("executor", { tier: "quick", plan: "pro", batch: true });
    expect(batch.batch).toBe(true);
    expect(batch.offPeakPreferred).toBe(true);
    expect(batch.routes.map((r) => r.id)).toEqual(batchRun.routes.map((r) => r.id));
  });

  it("preferOffPeakRoutes is a stable partition (off-peak endpoints jump the queue)", () => {
    type RouteLike = { readonly id: string; readonly offPeak?: boolean };
    const routes: readonly RouteLike[] = [
      { id: "a" },
      { id: "b", offPeak: true },
      { id: "c" },
      { id: "d", offPeak: true },
    ];
    const flipped = preferOffPeakRoutes(routes);
    expect(flipped.map((route) => route.id)).toEqual(["b", "d", "a", "c"]);
    // Untouched when nothing is off-peak.
    const plain: readonly RouteLike[] = [{ id: "a" }, { id: "b" }];
    expect(preferOffPeakRoutes(plain).map((route) => route.id)).toEqual(["a", "b"]);
  });
});

// --- §5.4 static-prefix cache adviser + §5.3 cache-hit hooks ---------------------------

describe("provider-adapter: §5.4 static-prefix cache adviser", () => {
  const fullInput = {
    systemPrompt: "You are the studio planner.",
    toolSchemas: '{"tools":[{"name":"template.apply"}]}',
    templateManifest: "instagram-post@3",
    styleGuide: "palette:#F4E7D3",
  };

  it("assembles §5.4 parts in fixed order with a deterministic separator", () => {
    const prefix = buildCacheablePrefix(fullInput);
    expect(prefix.parts).toEqual([
      "system_prompt",
      "tool_schemas",
      "template_manifest",
      "style_guide",
    ]);
    expect(prefix.text).toBe(
      [
        fullInput.systemPrompt,
        fullInput.toolSchemas,
        fullInput.templateManifest,
        fullInput.styleGuide,
      ].join(STATIC_PREFIX_SEPARATOR),
    );
    expect(prefix.chars).toBe(prefix.text.length);
    expect(STATIC_PREFIX_SEPARATOR).toBe("\n\n");
  });

  it("identical inputs produce byte-identical prefixes (cache never shifts, §5.4)", () => {
    const first: CacheablePrefix = buildCacheablePrefix(fullInput);
    const second: CacheablePrefix = buildCacheablePrefix(fullInput);
    expect(first.text).toBe(second.text);
    expect(first.parts).toEqual(second.parts);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.parts)).toBe(true);
  });

  it("omits absent parts (style guide / manifest are workspace-dependent)", () => {
    const prefix = buildCacheablePrefix({
      systemPrompt: "sys",
      toolSchemas: "schemas",
    });
    expect(prefix.parts).toEqual(["system_prompt", "tool_schemas"]);
    expect(prefix.text).toBe(`sys${STATIC_PREFIX_SEPARATOR}schemas`);
    expect(prefix.text).not.toContain("palette");
  });

  it("refuses malformed prefixes with the typed RouterError (zod boundary)", () => {
    expect(() => buildCacheablePrefix({ systemPrompt: "", toolSchemas: "s" })).toThrow(RouterError);
    expect(() =>
      buildCacheablePrefix({ systemPrompt: "s", toolSchemas: "t", extra: "x" } as never),
    ).toThrow(RouterError);
  });
});

describe("provider-adapter: ProviderLike seam + cache-hit tracking hooks (§5.3 ≥60%)", () => {
  class CapturingProvider implements ProviderLike {
    readonly requests: CompletionRequest[] = [];

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      this.requests.push(request);
      return {
        text: `via ${request.model}`,
        usage: {
          tokensIn: 100,
          tokensOut: 20,
          cachedTokens: request.cacheablePrefix === undefined ? 0 : 80,
        },
      };
    }

    async *streamToolLoop(request: CompletionRequest): AsyncIterable<ProviderStreamEvent> {
      this.requests.push(request);
      yield { type: "text_delta", text: '{"steps":[' };
      yield { type: "tool_call", tool: "template.apply", args: {} };
      yield {
        type: "done",
        text: "done",
        usage: { tokensIn: 100, tokensOut: 20, cachedTokens: 80 },
      };
    }
  }

  it("passes the §5.4 prefix through the seam verbatim and tracks the cache hit", async () => {
    const router = healthyRouter();
    const provider = new CapturingProvider();
    const tracker = new ProviderCacheTracker();
    const decision = router.resolve("executor", req("standard"));

    const route = decision.routes[0];
    expect(route).toBeDefined();
    if (route === undefined) {
      throw new Error("route must exist");
    }
    const prefix = buildCacheablePrefix({
      systemPrompt: "system",
      toolSchemas: "schemas",
      styleGuide: "brand tokens",
    });
    const result = await provider.complete({
      provider: route.provider,
      model: route.id,
      prompt: "the brief (§5.4 item 5)",
      cacheablePrefix: prefix,
      json: true,
    });

    expect(result.text).toBe("via gemini-3.8-flash");
    const seen = provider.requests[0];
    expect(seen?.cacheablePrefix?.text).toBe(prefix.text); // cache anchor, verbatim
    expect(seen?.prompt).toBe("the brief (§5.4 item 5)"); // dynamic part stays separate
    expect(seen?.provider).toBe("gemini");
    expect(seen?.json).toBe(true);

    tracker.record(route.provider, result.usage);
    const stats: ProviderCacheStats | undefined = tracker.snapshot()[route.provider];
    expect(stats).toMatchObject({
      provider: "gemini",
      calls: 1,
      callsWithCacheHit: 1,
      cachedTokens: 80,
      hitRate: 1,
      meetsTarget: true,
    });
  });

  it("streams the executor tool loop as an AsyncIterable of the event union", async () => {
    const provider = new CapturingProvider();
    const events: ProviderStreamEvent[] = [];
    for await (const event of provider.streamToolLoop({
      provider: "gemini",
      model: "gemini-3.8-flash",
      prompt: "brief",
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(["text_delta", "tool_call", "done"]);
    expect(events[0]).toEqual({ type: "text_delta", text: '{"steps":[' });
    expect(events[1]).toEqual({ type: "tool_call", tool: "template.apply", args: {} });
    expect(events[2]).toMatchObject({ type: "done", text: "done" });
    expect(provider.requests[0]?.cacheablePrefix).toBeUndefined();
  });

  it("cache tracker aggregates per-provider hit rates against the ≥60% target", () => {
    const tracker = new ProviderCacheTracker();
    const usage = (cachedTokens: number): CompletionUsage => ({
      tokensIn: 50,
      tokensOut: 10,
      cachedTokens,
    });
    tracker.record("gemini", usage(70));
    tracker.record("gemini", usage(60));
    tracker.record("gemini", usage(0)); // miss
    const stats = tracker.snapshot().gemini;
    expect(stats.calls).toBe(3);
    expect(stats.callsWithCacheHit).toBe(2);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
    expect(stats.meetsTarget).toBe(true);

    tracker.record("anthropic", usage(0));
    tracker.record("anthropic", usage(0));
    const below = tracker.snapshot().anthropic;
    expect(below.hitRate).toBe(0);
    expect(below.meetsTarget).toBe(false);
    expect(Object.isFrozen(tracker.snapshot())).toBe(true);
  });

  it("hooks sanitize flaky telemetry (NaN/negative → miss; tracking never throws)", () => {
    const tracker = new ProviderCacheTracker();
    tracker.record("openai", { tokensIn: Number.NaN, tokensOut: 1, cachedTokens: Number.NaN });
    tracker.record("openai", { tokensIn: 10, tokensOut: 1, cachedTokens: -5 });
    tracker.onCacheHit("flux", 0); // zero cached tokens still counts as a call
    const stats = tracker.snapshot();
    expect(stats.openai).toMatchObject({ calls: 2, callsWithCacheHit: 0, meetsTarget: false });
    expect(stats.flux).toMatchObject({ calls: 1, callsWithCacheHit: 1, cachedTokens: 0 });
    expect(CACHE_HIT_TARGET).toBe(0.6);
  });
});

// --- input validation (typed boundaries) ----------------------------------------------

describe("router: zod-validated boundaries (AGENTS.md)", () => {
  it("rejects unknown tiers, plans, roles, providers and options", () => {
    const router = healthyRouter();
    expect(() => router.resolve("planner", req("mega" as never))).toThrow(RouterError);
    expect(() => router.resolve("planner", req("standard", "free" as never))).toThrow(RouterError);
    expect(() =>
      router.resolve("planner", { tier: "standard", plan: "pro", nope: true } as never),
    ).toThrow(RouterError);
    expect(() => router.resolve("auditor" as never, req("standard"))).toThrow(RouterError);
    expect(() => router.recordCall("vertex" as never, true)).toThrow(RouterError);
    expect(() => new ModelRouter({ failureThreshold: 0 })).toThrow(RouterError);
    expect(() => new ModelRouter({ cooldownMs: 0 })).toThrow(RouterError);
    expect(() => new ModelRouter({ windowMs: 0 })).toThrow(RouterError);
    expect(() => new ModelRouter({ clock: "not-a-function" as never })).toThrow(RouterError);
  });

  it("decisions are frozen snapshots (health probes + SSE can hold them)", () => {
    const decision: RouteDecision = healthyRouter().resolve("planner", req("standard"));
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.routes)).toBe(true);
    expect(Object.isFrozen(decision.unavailable)).toBe(true);
  });
});
