// @studio/billing — the provider-class kill switch (W9-N).
//
// Spec anchors:
//   §5.3   model routing — "route by tier, workspace plan, and provider health…
//          per-provider circuit breakers and automatic failover to a second
//          provider of the same class. Never hardcode a single vendor."
//   §21    chaos drill "revoke provider key" — scripted drill + expected
//          outcome: a revoked key must fail runs over to the same-class
//          fallback; when every provider of a class is drained, the tier is
//          routed to its failover class or rejected with a typed error.
//   §18.4  "hard spend caps at every provider" — this switch is the ops half
//          of that: it drains a vendor immediately, without waiting for the
//          runtime breaker to trip on live failures.
//
// SCOPE (vs @studio/agent ModelRouter, W6-H): the runtime per-PROVIDER circuit
// breaker (failure streaks, cooldowns, half-open probes) lives in
// packages/agent — it answers "is this provider healthy RIGHT NOW". This
// policy is the ADMIN/ops layer beneath it, env- and/or DB-backed: it answers
// "has operations deliberately disabled this provider". A provider is
// routable when BOTH layers agree; this module only owns the deliberate side.
//
// Terminology: a PROVIDER is a vendor key (@studio/config ModelProviderClass —
// gemini/anthropic/openai/deepseek/flux, one env key each, §5.3). A CIRCUIT
// CLASS is the §5.3 routing family the failover rule talks about ("a second
// provider of the same class"): text (planner/executor/critic), image_draft
// (Flux-class drafts) and image_final (Gemini/GPT image finals, §5.2 rows 6-7).
//
// Failure mode: the DB seam fails OPEN (provider treated as enabled) — the
// §5.3 runtime breaker and the §14.2 reservation gate remain authoritative;
// a kill-switch outage must not become "no provider is routable" (which would
// turn an ops-flag blip into a full-run outage).

import {
  MODEL_PROVIDER_CLASSES,
  RUN_TIER_ID_SCHEMA,
  type ModelProviderClass,
  type RunTierId,
} from "@studio/config";
import { z } from "zod";

import {
  guardrailErr,
  guardrailOk,
  type GuardrailResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Circuit classes (§5.3 routing families)
// ---------------------------------------------------------------------------

/**
 * The §5.3 failover families a kill switch can drain wholesale. Distinct from
 * @studio/config's per-vendor ModelProviderClass: "class" in §5.3's failover
 * rule ("a second provider of the same class") means these families.
 */
export const PROVIDER_CIRCUIT_CLASSES = ["text", "image_draft", "image_final"] as const;

export type ProviderCircuitClass = (typeof PROVIDER_CIRCUIT_CLASSES)[number];

export const PROVIDER_CIRCUIT_CLASS_SCHEMA = z.enum(PROVIDER_CIRCUIT_CLASSES);

/**
 * Class membership + preference order (§5.3 table, default column first):
 *
 *   text         gemini (default) → anthropic (premium/max) → openai → deepseek
 *   image_draft  flux (§5.3 image drafts: Flux 2 Schnell on every tier)
 *   image_final  gemini (Gemini 3 Pro Image) → openai (GPT Image 1.5 HD)
 *
 * The first ENABLED entry is the class's failover target; §5.3's "second
 * provider of the same class" is the next enabled entry after the primary.
 */
export const CIRCUIT_CLASS_PROVIDERS: Readonly<
  Record<ProviderCircuitClass, readonly ModelProviderClass[]>
> = {
  text: ["gemini", "anthropic", "openai", "deepseek"],
  image_draft: ["flux"],
  image_final: ["gemini", "openai"],
};

/**
 * Which circuit class a run tier's PRIMARY route needs (§5.2/§5.3): text
 * tiers route planner/executor/critic on the text class; image_gen drafts on
 * Flux; image_gen_hd renders finals on Gemini/GPT image. A text-tier run
 * that also drafts images degrades role-by-role in the §5.3 router (W6-H) —
 * this policy gates the tier's primary class only.
 */
export const TIER_CIRCUIT_CLASS: Readonly<Record<RunTierId, ProviderCircuitClass>> = {
  quick: "text",
  standard: "text",
  complex: "text",
  premium: "text",
  max: "text",
  image_gen: "image_draft",
  image_gen_hd: "image_final",
};

/**
 * Where a tier routes when its ENTIRE class is disabled (§5.3 "failover to a
 * second provider of the same class" has no second provider left to try):
 * HD image finals degrade to the standard draft pipeline (§5.2 rows 6-7);
 * text and drafts have no cross-class substitute, so they are rejected.
 */
export const CIRCUIT_CLASS_FAILOVER: Readonly<Record<ProviderCircuitClass, ProviderCircuitClass | null>> = {
  text: null,
  image_draft: null,
  image_final: "image_draft",
};

// ---------------------------------------------------------------------------
// Env seam — the deliberate drain list
// ---------------------------------------------------------------------------

/**
 * The env var carrying a comma-separated list of deliberately disabled
 * providers (§21 drill: `PROVIDERS_DISABLED=anthropic` drains the vendor
 * before its key is revoked). Env PARSING belongs to @studio/config
 * (fail-fast, §4) — `parseDisabledProviders` is the pure parser for the
 * config owner to wire; flag noted in the worklog.
 */
export const DISABLED_PROVIDERS_ENV_VAR = "PROVIDERS_DISABLED";

const providerEnum = z.enum(MODEL_PROVIDER_CLASSES);

/**
 * Parses the drain list: comma-separated @studio/config provider ids,
 * case-insensitive, whitespace-trimmed, duplicates collapsed. An unknown
 * provider FAILS FAST — a typo in an ops lever must never quietly disable
 * the wrong vendor (or nothing at all).
 */
export function parseDisabledProviders(raw: string | undefined): readonly ModelProviderClass[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  const seen = new Set<ModelProviderClass>();
  for (const token of raw.split(",")) {
    const candidate = token.trim().toLowerCase();
    if (candidate === "") {
      continue;
    }
    const parsed = providerEnum.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(
        `[billing/guardrails] unknown provider in ${DISABLED_PROVIDERS_ENV_VAR}: "${token.trim()}"`,
      );
    }
    seen.add(parsed.data);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Seams + verdicts
// ---------------------------------------------------------------------------

/** Everything the policy needs from the outside world (injected). */
export interface ProviderHealthSeams {
  /**
   * DB-backed admin kill-switch flag per provider (§21 revoke-provider-key
   * drill: revoking a key flips this so the vendor drains immediately).
   * True = operations disabled the provider.
   */
  isProviderDisabled(provider: ModelProviderClass): Promise<boolean>;
}

/** A tier's viable route after the kill-switch filters (§5.3). */
export interface ProviderRoute {
  readonly tier: RunTierId;
  /** The class the tier's primary route needs. */
  readonly circuitClass: ProviderCircuitClass;
  /** The provider to attempt (first enabled in §5.3 preference order). */
  readonly provider: ModelProviderClass;
  /**
   * Set when the primary class was fully disabled and the tier was routed to
   * its failover class (§5.3): e.g. image_gen_hd degraded to image_draft.
   * Null on a normal route.
   */
  readonly degradedFromClass: ProviderCircuitClass | null;
}

// ---------------------------------------------------------------------------
// ProviderHealthPolicy
// ---------------------------------------------------------------------------

/**
 * The env/DB-backed provider kill switch (§5.3 health routing, §21 drill).
 * A provider is disabled when EITHER the env drain list OR the DB admin flag
 * says so; the §5.3 runtime breaker (W6-H) is a separate, additional gate.
 */
export class ProviderHealthPolicy {
  private readonly seams: ProviderHealthSeams;
  private readonly envDisabled: ReadonlySet<ModelProviderClass>;

  constructor(
    seams: ProviderHealthSeams,
    options: { readonly envDisabled?: readonly ModelProviderClass[] } = {},
  ) {
    this.seams = seams;
    this.envDisabled = new Set(options.envDisabled ?? []);
  }

  /** Is this provider routable? (env drain list ∪ DB admin flag, fail-open on seam error.) */
  async isProviderEnabled(provider: ModelProviderClass): Promise<boolean> {
    if (this.envDisabled.has(provider)) {
      return false;
    }
    try {
      return !(await this.seams.isProviderDisabled(provider));
    } catch {
      // Fail open: the runtime breaker (§5.3, @studio/agent) still gates
      // live health; an admin-flag outage must not drain every tier.
      return true;
    }
  }

  /** Enabled providers of a circuit class, in §5.3 preference order. */
  async enabledProviders(circuitClass: ProviderCircuitClass): Promise<readonly ModelProviderClass[]> {
    const enabled: ModelProviderClass[] = [];
    for (const provider of CIRCUIT_CLASS_PROVIDERS[circuitClass]) {
      if (await this.isProviderEnabled(provider)) {
        enabled.push(provider);
      }
    }
    return enabled;
  }

  /** Is EVERY provider of the class disabled? (Health probes/dashboards, §22.) */
  async circuitClassDisabled(circuitClass: ProviderCircuitClass): Promise<boolean> {
    return (await this.enabledProviders(circuitClass)).length === 0;
  }

  /**
   * One provider for a caller to attempt, honouring §5.3 same-class
   * failover: `preferred` when it is enabled, else the first enabled entry
   * of the class's preference order, else a typed `providers_disabled`
   * failure naming the class. The @studio/agent router (W6-H) uses this to
   * pre-filter its route chains.
   */
  async selectProvider(
    circuitClass: ProviderCircuitClass,
    options: { readonly preferred?: ModelProviderClass } = {},
  ): Promise<GuardrailResult<ModelProviderClass>> {
    const enabled = await this.enabledProviders(circuitClass);
    const preferred = options.preferred;
    if (preferred !== undefined && enabled.includes(preferred)) {
      return guardrailOk(preferred);
    }
    const first = enabled[0];
    if (first !== undefined) {
      return guardrailOk(first);
    }
    return guardrailErr("providers_disabled", `No ${circuitClass} provider is enabled.`, {
      hint: `All ${circuitClass} providers are disabled (§5.3). Operations must re-enable one before this route can run.`,
      retryable: false,
    });
  }

  /**
   * The tier-level §5.3 gate (the §21 drill's terminal outcome):
   *
   *   1. the tier's primary class still has an enabled provider → normal
   *      route (same-class failover already applied by preference order);
   *   2. the primary class is drained but the tier has a failover class
   *      with an enabled provider → DEGRADED route (facts.degradedFromClass
   *      set — e.g. image_gen_hd on the image_draft pipeline);
   *   3. both drained → typed `providers_disabled` rejection (not
   *      retryable: re-enabling is an ops action, not a cooldown).
   */
  async resolveForTier(tier: RunTierId): Promise<GuardrailResult<ProviderRoute>> {
    const parsed = RUN_TIER_ID_SCHEMA.safeParse(tier);
    if (!parsed.success) {
      return guardrailErr("validation_failed", "Unknown run tier.", {
        hint: "The tier must be one of the §5.2 run tiers.",
        retryable: false,
      });
    }
    const runTier = parsed.data;
    const circuitClass = TIER_CIRCUIT_CLASS[runTier];

    const primary = await this.selectProvider(circuitClass);
    if (primary.ok) {
      return guardrailOk({
        tier: runTier,
        circuitClass,
        provider: primary.value,
        degradedFromClass: null,
      });
    }

    const failoverClass = CIRCUIT_CLASS_FAILOVER[circuitClass];
    if (failoverClass !== null) {
      const failover = await this.selectProvider(failoverClass);
      if (failover.ok) {
        return guardrailOk({
          tier: runTier,
          circuitClass: failoverClass,
          provider: failover.value,
          degradedFromClass: circuitClass,
        });
      }
    }

    const viaFailover = failoverClass !== null ? `, and its failover class (${failoverClass}) is also disabled` : "";
    return guardrailErr(
      "providers_disabled",
      `Every provider of the ${circuitClass} class is disabled.`,
      {
        hint: `This run tier cannot start: the ${circuitClass} provider class is disabled${viaFailover}. Operations must re-enable a provider (§5.3 routing).`,
        retryable: false,
      },
    );
  }
}
