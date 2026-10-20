// @studio/agent — §5.3 model router. Owner: W6-H (docs/AGENTS.md).
//
// Spec §5.3: "route by tier, workspace plan, and provider health. Maintain a
// provider abstraction (AI SDK) with per-provider circuit breakers and
// automatic failover to a second provider of the same class. Never hardcode a
// single vendor." Routing tables and the pure circuit-breaker state machine
// live in ../models.js (W1-P); this module owns the STATEFUL router:
//
//   - tier → routing class (§5.2: quick→economy, standard→default,
//     complex→default_plus, premium→premium, max→max; image tiers by role),
//   - per-provider circuit breakers (closed → open after N consecutive
//     failures inside a window → half_open after a cooldown → closed on
//     success), reusing models.js pure transitions,
//   - ordered [primary, fallback] resolution with same-class failover (§5.3),
//   - recordCall(provider, ok) breaker updates,
//   - providerHealth() snapshots for health probes,
//   - off-peak batch preference for non-interactive jobs (§5.3, 50% discount).
//
// The `plan` input is validated, recorded on the decision (run row
// `model_route jsonb`, §11 schema) and reserved for §14 plan-gated features:
// the router NEVER downgrades a §5.2 tier row by plan — a premium-tier run
// gets Sonnet-class on every plan; affordability is credit-side (§14.2).
import { PLAN_ID_SCHEMA, RUN_TIER_ID_SCHEMA, type PlanId, type RunTierId } from "@studio/config";
import { z } from "zod";
import type { Clock } from "../budgets.js";
import type { AgentFailure } from "../errors.js";
import {
  MODEL_PROVIDER_IDS,
  MODEL_ROUTE_ROLES,
  freshCircuitBreaker,
  halfOpenBreaker,
  resetBreaker,
  routeChain,
  shouldAttemptRequest,
  tripBreaker,
  type CircuitBreakerState,
  type ModelClass,
  type ModelProviderId,
  type ModelRoute,
  type ModelRouteRole,
  type ProviderFailure,
} from "../models.js";

// --- Policy defaults (§5.3; worker-tunable, never secrets) ------------------------

/** Consecutive failures (inside the window) that trip a breaker open. */
export const ROUTE_FAILURE_THRESHOLD_DEFAULT = 3;

/** Open → half_open cooldown before one probe request is allowed through. */
export const ROUTE_COOLDOWN_MS_DEFAULT = 30_000;

/** Failures must fall inside this window to still count as one streak (§5.3). */
export const ROUTE_FAILURE_WINDOW_MS_DEFAULT = 60_000;

/**
 * §5.2 rows 6–7 (image tiers) carry no interactive model class — the ROLE
 * selects the §5.3 row (imageDrafts → Flux 2 Schnell, imageFinals → Gemini 3
 * Pro Image). "default" is the neutral column those rows are read through;
 * see routeClassForTier.
 */
export const IMAGE_TIER_ROUTE_CLASS: Readonly<Record<"image_gen" | "image_gen_hd", ModelClass>> = {
  image_gen: "default",
  image_gen_hd: "default",
};

/** Tier → §5.3 routing class (quick→economy … max→max; image tiers by role). */
export function routeClassForTier(tier: RunTierId): ModelClass {
  switch (tier) {
    case "quick":
      return "economy";
    case "standard":
      return "default";
    case "complex":
      return "default_plus";
    case "premium":
      return "premium";
    case "max":
      return "max";
    case "image_gen":
    case "image_gen_hd":
      return IMAGE_TIER_ROUTE_CLASS[tier];
  }
}

/**
 * Programmer-error boundary for untyped (JS) callers and drifted inputs —
 * mirrors @studio/config `EnvFatalError`. Never thrown for reachable typed
 * states (a §5.3 "—" row or an exhausted chain is a decision, not an error).
 */
export class RouterError extends Error {
  readonly code = "router_invalid_input" as const;
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(`[agent/router] ${message}`);
    this.name = "RouterError";
    this.issues = issues;
  }
}

// --- Request / decision contracts -------------------------------------------------

/** §5.3 resolve() request: route by tier + workspace plan (+ batch mode). */
export const routeRequestSchema = z.strictObject({
  tier: RUN_TIER_ID_SCHEMA,
  plan: PLAN_ID_SCHEMA,
  /**
   * True for non-interactive jobs (exports, bulk variants): prefer off-peak
   * batch endpoints at 50% discount where offered (§5.3).
   */
  batch: z.boolean().optional(),
});

export type RouteRequest = z.infer<typeof routeRequestSchema>;

export const routeRoleSchema = z.enum(MODEL_ROUTE_ROLES);

export const modelRouterOptionsSchema = z.strictObject({
  /** Injectable wall clock (deterministic tests/replays; budgets.ts pattern). */
  clock: z
    .custom<Clock>((value) => typeof value === "function", { message: "clock must be a function" })
    .optional(),
  /**
   * Providers configured in this worker (from @studio/config
   * `configuredModelProviders(env)` — env keys GEMINI/ANTHROPIC/OPENAI/
   * DEEPSEEK/FLUX_API_KEY). `null`/omitted = no env gate (all routable);
   * unconfigured providers fail over to the same-class fallback (§5.3).
   */
  providers: z.array(z.enum(MODEL_PROVIDER_IDS)).nullable().optional(),
  /** Breaker policy (§5.3) — defaults above. */
  failureThreshold: z.number().int().min(1).optional(),
  cooldownMs: z.number().int().min(1).optional(),
  windowMs: z.number().int().min(1).optional(),
});

export type ModelRouterOptions = z.infer<typeof modelRouterOptionsSchema>;

/** One attemptable route, §5.3 order: routes[0] is the primary attempt. */
export interface ResolvedRoute extends ModelRoute {
  /** Position in the attempt order (§5.3 "ordered [primary, fallback]"). */
  readonly kind: "primary" | "fallback";
  /** Breaker status at resolve time (providerHealth() for the live value). */
  readonly breaker: CircuitBreakerState["status"];
  /** True when this attempt is the half_open probe (§5.3 cooldown elapsed). */
  readonly probing: boolean;
}

/** Why a §5.3 chain entry was not offered for this decision. */
export interface UnavailableRoute {
  readonly route: ModelRoute;
  readonly reason: "breaker_open" | "provider_unconfigured" | "class_mismatch";
}

/** resolve() output: everything the worker needs to call + log the route. */
export interface RouteDecision {
  readonly role: ModelRouteRole;
  readonly tier: RunTierId;
  readonly plan: PlanId;
  readonly modelClass: ModelClass;
  readonly batch: boolean;
  /** Ordered [primary, ...fallbacks], all the SAME class (§5.3). */
  readonly routes: readonly ResolvedRoute[];
  /** False when §5.3 has "—" for this role×class (e.g. critic on quick). */
  readonly roleRouted: boolean;
  /** The §5.3 table primary that was passed over (breaker open/unconfigured). */
  readonly failedOverFrom: ModelRoute | null;
  /** Chain entries skipped, with reasons (observability; no internals leak). */
  readonly unavailable: readonly UnavailableRoute[];
  /** Off-peak batch preference requested for a non-interactive job (§5.3). */
  readonly offPeakPreferred: boolean;
  /**
   * Set only when the role is routed but NO same-class provider is offerable
   * (all breakers open / providers unconfigured) — §5.3/§13.3 provider_unhealthy.
   */
  readonly failure: AgentFailure | null;
}

// --- Pure helpers ------------------------------------------------------------------

function sameRoute(a: ModelRoute, b: ModelRoute): boolean {
  return a.provider === b.provider && a.id === b.id;
}

/**
 * Stable partition putting off-peak batch endpoints first (§5.3: "prefer
 * off-peak batch endpoints for non-interactive jobs"); relative order is kept
 * inside each group so the §5.3 table order never shuffles otherwise.
 */
export function preferOffPeakRoutes<T extends { readonly offPeak?: boolean }>(
  routes: readonly T[],
): readonly T[] {
  const offPeak: T[] = [];
  const rest: T[] = [];
  for (const route of routes) {
    (route.offPeak === true ? offPeak : rest).push(route);
  }
  return [...offPeak, ...rest];
}

// --- Health snapshot ---------------------------------------------------------------

/** Read-only breaker/env view of one provider (for health probes). */
export interface ProviderHealthEntry {
  readonly provider: ModelProviderId;
  /** Env key configured in this worker (§5.3 provider health flag). */
  readonly configured: boolean;
  readonly breaker: CircuitBreakerState["status"];
  readonly consecutiveFailures: number;
  readonly lastFailureAt: number | null;
  readonly lastFailureCode: string | null;
  readonly openedAt: number | null;
  /** False while an open breaker's cooldown has not elapsed (§5.3). */
  readonly acceptingCalls: boolean;
  /** > 0 while an open breaker's cooldown is still running. */
  readonly cooldownRemainingMs: number;
}

/** providerHealth() output — frozen; probes must not advance breaker state. */
export interface ProviderHealthSnapshot {
  readonly at: number;
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly windowMs: number;
  readonly providers: Readonly<Record<ModelProviderId, ProviderHealthEntry>>;
  /** True when every CONFIGURED provider is refusing calls (§5.3). */
  readonly allDown: boolean;
}

// --- The router --------------------------------------------------------------------

/** Internal per-provider circuit: W1-P's pure state + the streak window. */
interface ProviderCircuit {
  breaker: CircuitBreakerState;
  /** Epoch ms of the first failure of the current streak; null when none. */
  streakStartedAt: number | null;
}

/**
 * Stateful §5.3 router. One instance lives in the worker; not thread-safe by
 * design (the run loop is single-owner — BudgetTracker precedent).
 */
export class ModelRouter {
  private readonly clock: Clock;
  private readonly configured: ReadonlySet<ModelProviderId> | null;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly windowMs: number;
  private readonly circuits = new Map<ModelProviderId, ProviderCircuit>();

  constructor(options: ModelRouterOptions = {}) {
    const parsed = modelRouterOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new RouterError(
        "router options failed schema validation",
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      );
    }
    this.clock = parsed.data.clock ?? (() => Date.now());
    this.configured =
      parsed.data.providers === null || parsed.data.providers === undefined
        ? null
        : new Set(parsed.data.providers);
    this.failureThreshold = parsed.data.failureThreshold ?? ROUTE_FAILURE_THRESHOLD_DEFAULT;
    this.cooldownMs = parsed.data.cooldownMs ?? ROUTE_COOLDOWN_MS_DEFAULT;
    this.windowMs = parsed.data.windowMs ?? ROUTE_FAILURE_WINDOW_MS_DEFAULT;
    for (const provider of MODEL_PROVIDER_IDS) {
      this.circuits.set(provider, { breaker: freshCircuitBreaker(), streakStartedAt: null });
    }
  }

  /**
   * Ordered [primary, fallback] for a role on this run's tier (§5.3): the
   * chain is ROLE_ROUTES × tier class; a provider is offered only when its
   * env key is configured and its breaker is closed/half_open (open →
   * same-class failover). Never throws for reachable typed states — a §5.3
   * "—" row returns roleRouted:false, an exhausted chain returns a
   * provider_unhealthy failure on the decision. Open breakers whose cooldown
   * has elapsed transition half_open here (this resolution IS the probe).
   */
  resolve(role: ModelRouteRole, request: RouteRequest): RouteDecision {
    const roleParsed = routeRoleSchema.safeParse(role);
    if (!roleParsed.success) {
      throw new RouterError(`unknown routing role: ${String(role)}`);
    }
    const parsed = routeRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new RouterError(
        "route request failed schema validation",
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      );
    }
    const { tier, plan } = parsed.data;
    const batch = parsed.data.batch === true;
    const now = this.clock();
    const modelClass = routeClassForTier(tier);
    const chain = routeChain(role, modelClass);

    if (chain.length === 0) {
      // §5.3 "—" row (e.g. critic on the quick tier): skipped, not an error.
      return this.decision(role, tier, plan, modelClass, batch, [], false, null, [], null);
    }

    // §5.3 failover is same-class only; guard against table drift.
    const candidates: ModelRoute[] = [];
    const unavailable: UnavailableRoute[] = [];
    for (const route of chain) {
      if (route.class === modelClass) {
        candidates.push(route);
      } else {
        unavailable.push({ route, reason: "class_mismatch" });
      }
    }
    const ordered = batch ? preferOffPeakRoutes(candidates) : candidates;

    const routes: ResolvedRoute[] = [];
    for (const route of ordered) {
      if (!this.isConfigured(route.provider)) {
        unavailable.push({ route, reason: "provider_unconfigured" });
        continue;
      }
      const circuit = this.circuitFor(route.provider);
      // Cooldown elapsed → half_open probe (this resolution starts the probe).
      if (circuit.breaker.status === "open") {
        circuit.breaker = halfOpenBreaker(circuit.breaker, now, this.cooldownMs);
      }
      if (!shouldAttemptRequest(circuit.breaker, now, this.cooldownMs)) {
        unavailable.push({ route, reason: "breaker_open" });
        continue;
      }
      routes.push({
        ...route,
        kind: routes.length === 0 ? "primary" : "fallback",
        breaker: circuit.breaker.status,
        probing: circuit.breaker.status === "half_open",
      });
    }

    const tablePrimary = chain[0];
    const failedOverFrom =
      tablePrimary !== undefined &&
      !routes.some((route) => sameRoute(route, tablePrimary)) &&
      unavailable.some((entry) => sameRoute(entry.route, tablePrimary))
        ? tablePrimary
        : null;

    const failure =
      routes.length > 0 || tablePrimary === undefined
        ? null
        : providerUnhealthyFailure(role, tier, modelClass, this.cooldownMs);

    return this.decision(
      role,
      tier,
      plan,
      modelClass,
      batch,
      routes,
      true,
      failedOverFrom,
      unavailable,
      failure,
    );
  }

  /**
   * Breaker update from one completed provider call (§5.3): success closes
   * from any state (including a half_open probe); a failure extends the
   * consecutive streak — trips `open` at the threshold, and a streak whose
   * failures no longer fall inside the window restarts at one. A failed
   * half_open probe re-opens immediately for a fresh cooldown.
   */
  recordCall(provider: ModelProviderId, ok: boolean, code = "provider_call_failed"): void {
    const circuit = this.circuitFor(provider);
    const now = this.clock();
    if (ok) {
      circuit.breaker = resetBreaker(circuit.breaker);
      circuit.streakStartedAt = null;
      return;
    }
    if (circuit.streakStartedAt === null) {
      circuit.streakStartedAt = now;
    } else if (now - circuit.streakStartedAt > this.windowMs) {
      // §5.3 "N consecutive failures in window": the old streak went stale.
      circuit.breaker = freshCircuitBreaker();
      circuit.streakStartedAt = now;
    }
    const failure: ProviderFailure = { at: now, provider, code };
    const next = tripBreaker(circuit.breaker, failure, now, this.failureThreshold);
    if (next.status === "open") {
      circuit.streakStartedAt = null; // the streak concluded by opening
    }
    circuit.breaker = next;
  }

  /**
   * Frozen per-provider snapshot for health probes (§5.3). Read-only: it does
   * NOT advance open→half_open — that transition happens in resolve(), which
   * is the act of starting a probe.
   */
  providerHealth(): ProviderHealthSnapshot {
    const now = this.clock();
    const entries = {} as Record<ModelProviderId, ProviderHealthEntry>;
    let configuredAccepting = 0;
    let configuredCount = 0;
    for (const provider of MODEL_PROVIDER_IDS) {
      const circuit = this.circuitFor(provider);
      const { breaker } = circuit;
      const acceptingCalls = shouldAttemptRequest(breaker, now, this.cooldownMs);
      const configured = this.isConfigured(provider);
      if (configured) {
        configuredCount += 1;
        if (acceptingCalls) {
          configuredAccepting += 1;
        }
      }
      entries[provider] = {
        provider,
        configured,
        breaker: breaker.status,
        consecutiveFailures: breaker.consecutiveFailures,
        lastFailureAt: breaker.lastFailure === null ? null : breaker.lastFailure.at,
        lastFailureCode: breaker.lastFailure === null ? null : breaker.lastFailure.code,
        openedAt: breaker.openedAt,
        acceptingCalls,
        cooldownRemainingMs:
          breaker.status === "open" && breaker.openedAt !== null
            ? Math.max(0, this.cooldownMs - (now - breaker.openedAt))
            : 0,
      };
    }
    return Object.freeze({
      at: now,
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      windowMs: this.windowMs,
      providers: Object.freeze(entries),
      allDown: configuredCount > 0 && configuredAccepting === 0,
    });
  }

  private isConfigured(provider: ModelProviderId): boolean {
    return this.configured === null || this.configured.has(provider);
  }

  private circuitFor(provider: ModelProviderId): ProviderCircuit {
    const circuit = this.circuits.get(provider);
    if (circuit === undefined) {
      // Typed callers cannot reach this; guards untyped/JS drift.
      throw new RouterError(`unknown model provider: ${String(provider)}`);
    }
    return circuit;
  }

  private decision(
    role: ModelRouteRole,
    tier: RunTierId,
    plan: PlanId,
    modelClass: ModelClass,
    batch: boolean,
    routes: readonly ResolvedRoute[],
    roleRouted: boolean,
    failedOverFrom: ModelRoute | null,
    unavailable: readonly UnavailableRoute[],
    failure: AgentFailure | null,
  ): RouteDecision {
    return Object.freeze({
      role,
      tier,
      plan,
      modelClass,
      batch,
      routes: Object.freeze(routes),
      roleRouted,
      failedOverFrom,
      unavailable: Object.freeze(unavailable),
      offPeakPreferred: batch,
      failure,
    });
  }
}

/** §5.3/§13.3 provider_unhealthy envelope — retryable once a cooldown elapses. */
function providerUnhealthyFailure(
  role: ModelRouteRole,
  tier: RunTierId,
  modelClass: ModelClass,
  cooldownMs: number,
): AgentFailure {
  return {
    ok: false,
    code: "provider_unhealthy",
    message:
      `No model provider is available for the ${role} route on the ${tier} tier ` +
      `(${modelClass} class): every same-class provider is unconfigured or has an ` +
      "open circuit breaker (§5.3).",
    hint:
      `Retry after the ${cooldownMs} ms breaker cooldown, or configure a second ` +
      "provider of the same class.",
    retryable: true,
  };
}
