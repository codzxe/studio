// @studio/agent — model routing tables (§5.3). Owner: W1-P (docs/AGENTS.md).
//
// §5.3 routing table (role × class):
//   | Role          | Default              | Economy                        | Premium         | Max            |
//   | planner       | Gemini 3.8 Flash     | Gemini 2.5 Flash-Lite / DS 4.1F | Claude Sonnet 5.5 | Claude Opus 5.5 |
//   | executor      | Gemini 3.8 Flash     | DeepSeek V4.1 Flash (off-peak) | Claude Sonnet 5.5 | Claude Opus 5.5 |
//   | critic (vision)| Gemini 3.8 Flash    | — (skip for quick tier)        | Claude Sonnet 5.5 | Claude Opus 5.5 |
//   | imageDrafts   | Flux 2 Schnell       | Flux 2 Schnell                 | Flux 2 Schnell   | Gemini 3 Pro Image |
//   | imageFinals   | Gemini 3 Pro Image   | —                              | Gemini 3 Pro Image | GPT Image 1.5 HD |
//
// Rules: route by tier, workspace plan and provider health; per-provider circuit
// breakers; automatic failover to a second provider of the same class; never
// hardcode a single vendor. Model ids here are PLACEHOLDERS (names grounded in
// Appendix C) — the provider abstraction (Wave 2) owns real ids/endpoints; the
// class/role/provider structure is the contract.
//
// NOTE: provider ids align with @studio/config `ModelProviderClass` ('gemini' |
// 'anthropic' | 'openai' | 'deepseek' | 'flux'; env keys GEMINI/ANTHROPIC/…),
// NOT the 'vertex' naming from the task sketch — one provider taxonomy repo-wide.
import type { ModelProviderClass, RunTierId } from '@studio/config';

/**
 * Routing classes — the §5.2 tier "Model class" column (rows 1–5): the five
 * interactive tiers. Distinct from @studio/config `MODEL_CLASSES`, which names
 * model families (sonnet/opus/flux/…): premium ≡ sonnet-class, max ≡ opus-class.
 */
export const MODEL_CLASS_IDS = ['economy', 'default', 'default_plus', 'premium', 'max'] as const;

export type ModelClass = (typeof MODEL_CLASS_IDS)[number];

/** Provider ids — identical strings to @studio/config `ModelProviderClass`. */
export const MODEL_PROVIDER_IDS = ['gemini', 'anthropic', 'openai', 'deepseek', 'flux'] as const;

export type ModelProviderId = ModelProviderClass;

/** The five §5.3 roles. */
export const MODEL_ROUTE_ROLES = ['planner', 'executor', 'critic', 'imageDrafts', 'imageFinals'] as const;

export type ModelRouteRole = (typeof MODEL_ROUTE_ROLES)[number];

/**
 * One routable model endpoint. `class` is the routing class of the entry itself
 * (per the task contract: e.g. `{ provider:'gemini', id:'gemini-3.8-flash', class:'default' }`).
 * `vision` marks multimodal endpoints (§5.3 critic); `offPeak` marks batch
 * off-peak endpoints (§5.3: "prefer off-peak batch endpoints, 50% discount").
 */
export interface ModelRoute {
  readonly provider: ModelProviderId;
  readonly id: string;
  readonly class: ModelClass;
  readonly vision?: boolean;
  readonly offPeak?: boolean;
}

/** Tier → routing class (§5.2 rows 1–5). Image tiers route by role only. */
export const TIER_MODEL_CLASS: Readonly<Record<RunTierId, ModelClass | null>> = {
  quick: 'economy',
  standard: 'default',
  complex: 'default_plus',
  premium: 'premium',
  max: 'max',
  image_gen: null, // image roles are picked by the image pipeline (§5.2 rows 6–7)
  image_gen_hd: null,
};

/** Primary model per (role, class). `null` = the role is skipped for that class. */
export const ROLE_ROUTES: Readonly<Record<ModelRouteRole, Readonly<Record<ModelClass, ModelRoute | null>>>> = {
  planner: {
    economy: { provider: 'gemini', id: 'gemini-2.5-flash-lite', class: 'economy' }, // §5.3: "Gemini 2.5 Flash-Lite / …"
    default: { provider: 'gemini', id: 'gemini-3.8-flash', class: 'default' },
    default_plus: { provider: 'gemini', id: 'gemini-3.8-flash', class: 'default_plus' }, // §5.2: default+ with more planning
    premium: { provider: 'anthropic', id: 'claude-sonnet-5.5', class: 'premium' },
    max: { provider: 'anthropic', id: 'claude-opus-5.5', class: 'max' },
  },
  executor: {
    economy: { provider: 'deepseek', id: 'deepseek-v4.1-flash', class: 'economy', offPeak: true }, // §5.3: off-peak
    default: { provider: 'gemini', id: 'gemini-3.8-flash', class: 'default' },
    default_plus: { provider: 'gemini', id: 'gemini-3.8-flash', class: 'default_plus' },
    premium: { provider: 'anthropic', id: 'claude-sonnet-5.5', class: 'premium' },
    max: { provider: 'anthropic', id: 'claude-opus-5.5', class: 'max' },
  },
  critic: {
    economy: null, // §5.3: "— (skip for quick tier)"
    default: { provider: 'gemini', id: 'gemini-3.8-flash', class: 'default', vision: true },
    default_plus: { provider: 'gemini', id: 'gemini-3.8-flash', class: 'default_plus', vision: true },
    premium: { provider: 'anthropic', id: 'claude-sonnet-5.5', class: 'premium', vision: true },
    max: { provider: 'anthropic', id: 'claude-opus-5.5', class: 'max', vision: true },
  },
  imageDrafts: {
    economy: { provider: 'flux', id: 'flux-2-schnell', class: 'economy' },
    default: { provider: 'flux', id: 'flux-2-schnell', class: 'default' },
    default_plus: { provider: 'flux', id: 'flux-2-schnell', class: 'default_plus' },
    premium: { provider: 'flux', id: 'flux-2-schnell', class: 'premium' },
    max: { provider: 'gemini', id: 'gemini-3-pro-image', class: 'max' }, // §5.3 max drafts
  },
  imageFinals: {
    economy: null, // §5.3: "—" quick tier ships draft quality (1024²)
    default: { provider: 'gemini', id: 'gemini-3-pro-image', class: 'default' },
    default_plus: { provider: 'gemini', id: 'gemini-3-pro-image', class: 'default_plus' },
    premium: { provider: 'gemini', id: 'gemini-3-pro-image', class: 'premium' },
    max: { provider: 'openai', id: 'gpt-image-1.5', class: 'max' }, // §5.3: "GPT Image 1.5 HD"
  },
};

/**
 * §5.3 failover pairs: ordered same-class fallbacks per (role, class), tried
 * after the primary when its circuit breaker is open or the call fails.
 * Placeholder ids (Appendix C); §5.3's only explicit pair is the economy
 * planner (Gemini 2.5 Flash-Lite / DeepSeek V4.1 Flash) — the rest are same-class
 * second vendors chosen per Appendix C notes ("Premium alternative", "Frontier").
 */
export const FAILOVER_PAIRS: Readonly<
  Record<ModelRouteRole, Readonly<Partial<Record<ModelClass, readonly ModelRoute[]>>>>
> = {
  planner: {
    economy: [{ provider: 'deepseek', id: 'deepseek-v4.1-flash', class: 'economy' }], // §5.3 explicit
    default: [{ provider: 'anthropic', id: 'claude-haiku-4.5', class: 'default' }],
    default_plus: [{ provider: 'anthropic', id: 'claude-haiku-4.5', class: 'default_plus' }],
    premium: [{ provider: 'openai', id: 'gpt-5.6-terra', class: 'premium' }], // Appendix C: "Premium alternative"
    max: [{ provider: 'openai', id: 'gpt-6-astra', class: 'max' }], // Appendix C: "Frontier; not default"
  },
  executor: {
    economy: [{ provider: 'gemini', id: 'gemini-2.5-flash-lite', class: 'economy' }],
    default: [{ provider: 'anthropic', id: 'claude-haiku-4.5', class: 'default' }],
    default_plus: [{ provider: 'anthropic', id: 'claude-haiku-4.5', class: 'default_plus' }],
    premium: [{ provider: 'openai', id: 'gpt-5.6-terra', class: 'premium' }],
    max: [{ provider: 'openai', id: 'gpt-6-astra', class: 'max' }],
  },
  critic: {
    default: [{ provider: 'anthropic', id: 'claude-haiku-4.5', class: 'default', vision: true }],
    default_plus: [{ provider: 'anthropic', id: 'claude-haiku-4.5', class: 'default_plus', vision: true }],
    premium: [{ provider: 'openai', id: 'gpt-5.6-terra', class: 'premium', vision: true }],
    max: [{ provider: 'openai', id: 'gpt-6-astra', class: 'max', vision: true }],
  },
  imageDrafts: {
    economy: [{ provider: 'gemini', id: 'gemini-3-pro-image', class: 'economy' }],
    default: [{ provider: 'gemini', id: 'gemini-3-pro-image', class: 'default' }],
    default_plus: [{ provider: 'gemini', id: 'gemini-3-pro-image', class: 'default_plus' }],
    premium: [{ provider: 'gemini', id: 'gemini-3-pro-image', class: 'premium' }],
    max: [{ provider: 'flux', id: 'flux-2-schnell', class: 'max' }], // availability fallback
  },
  imageFinals: {
    default: [{ provider: 'openai', id: 'gpt-image-1.5', class: 'default' }], // Appendix C: "Alternative finals"
    default_plus: [{ provider: 'openai', id: 'gpt-image-1.5', class: 'default_plus' }],
    premium: [{ provider: 'openai', id: 'gpt-image-1.5', class: 'premium' }],
    max: [{ provider: 'gemini', id: 'gemini-3-pro-image', class: 'max' }],
  },
};

/** Primary route for a (role, class); `null` when §5.3 skips the role there. */
export function routeFor(role: ModelRouteRole, modelClass: ModelClass): ModelRoute | null {
  return ROLE_ROUTES[role][modelClass];
}

/** True when §5.3 defines a model for the (role, class) pair. */
export function isRoleEnabled(role: ModelRouteRole, modelClass: ModelClass): boolean {
  return routeFor(role, modelClass) !== null;
}

/** Ordered failover chain for a (role, class); empty when there is none. */
export function failoverChain(role: ModelRouteRole, modelClass: ModelClass): readonly ModelRoute[] {
  return FAILOVER_PAIRS[role][modelClass] ?? [];
}

/** Primary + failovers, §5.3 order; empty array when the role is skipped. */
export function routeChain(role: ModelRouteRole, modelClass: ModelClass): readonly ModelRoute[] {
  const primary = routeFor(role, modelClass);
  return primary === null ? [] : [primary, ...failoverChain(role, modelClass)];
}

// --- Circuit breakers (§5.3: per-provider, with failover) -------------------------

/** Circuit states per §5.3: closed (healthy) → open (tripped) → half_open (probing). */
export type CircuitBreakerStatus = 'closed' | 'open' | 'half_open';

/** One recorded provider failure (code is a stable provider error code). */
export interface ProviderFailure {
  readonly at: number; // epoch ms
  readonly provider: ModelProviderId;
  readonly code: string;
}

/** Circuit-breaker state for one provider (§5.3). */
export interface CircuitBreakerState {
  readonly status: CircuitBreakerStatus;
  readonly lastFailure: ProviderFailure | null;
  readonly consecutiveFailures: number;
  /** Epoch ms when the breaker tripped (`null` unless status is/was open). */
  readonly openedAt: number | null;
}

/** A fresh healthy breaker. */
export function freshCircuitBreaker(): CircuitBreakerState {
  return { status: 'closed', lastFailure: null, consecutiveFailures: 0, openedAt: null };
}

/** Records a failure; trips the breaker `open` at `failureThreshold` (default 3). */
export function tripBreaker(
  state: CircuitBreakerState,
  failure: ProviderFailure,
  now: number,
  failureThreshold = 3,
): CircuitBreakerState {
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures >= failureThreshold) {
    return { status: 'open', lastFailure: failure, consecutiveFailures, openedAt: now };
  }
  return { ...state, lastFailure: failure, consecutiveFailures };
}

/** Lets one probe request through after the open→half_open cooldown elapses. */
export function halfOpenBreaker(state: CircuitBreakerState, now: number, cooldownMs: number): CircuitBreakerState {
  if (state.status !== 'open' || state.openedAt === null) {
    return state;
  }
  return now - state.openedAt >= cooldownMs ? { ...state, status: 'half_open' } : state;
}

/** Successful call: closes the breaker again from any state. */
export function resetBreaker(state: CircuitBreakerState): CircuitBreakerState {
  return freshCircuitBreaker();
}

/** Routing decision helper: may we attempt a call on this provider right now? */
export function shouldAttemptRequest(state: CircuitBreakerState, now: number, cooldownMs: number): boolean {
  switch (state.status) {
    case 'closed':
      return true;
    case 'half_open':
      return true; // one probe in flight
    case 'open':
      return state.openedAt !== null && now - state.openedAt >= cooldownMs;
  }
}
