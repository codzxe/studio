// @studio/agent — §5.3 provider seam. Owner: W6-H (docs/AGENTS.md).
//
// Spec §5.3: "Maintain a provider abstraction (AI SDK) with per-provider
// circuit breakers and automatic failover to a second provider of the same
// class. Never hardcode a single vendor." THIS MODULE IS THE SEAM ONLY: it
// declares the interface the worker must satisfy per provider and the
// static-prefix cache adviser (§5.4). It NEVER imports a provider SDK — no
// `ai`, no `@ai-sdk/*`, no vendor REST clients (constraint §1.5-6: no free
// tiers for customer data; no OpenRouter in production).
//
// Model ids routed here come from router.ts (W1-P tables, Appendix C names);
// the worker owns real endpoints/ids per provider.
import { z } from "zod";
import type { ModelProviderId } from "../models.js";
import { RouterError } from "./router.js";

// --- §5.3 provider seam -------------------------------------------------------------

/** Token usage of one completion, as the worker reports it (§22: numbers, never content). */
export interface CompletionUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  /**
   * Tokens the provider served from its cache of the static prefix (§5.3
   * ≥60% cache-hit target). `0` when the provider does not report caching.
   */
  readonly cachedTokens: number;
}

/** One downscaled image attached to a request (§5.1: never full-resolution renders). */
export interface RequestImage {
  readonly data: Uint8Array;
  readonly mime: string;
}

/** A §5.3 model call. The §5.4 static prefix rides on `cacheablePrefix`. */
export interface CompletionRequest {
  /** §5.3 provider (dispatch key for the worker's factory). */
  readonly provider: ModelProviderId;
  /** Routed §5.3 model id (e.g. "gemini-3.8-flash", "claude-sonnet-5.5"). */
  readonly model: string;
  /** §5.4 items 4–6 (dynamic): document summary, brief, validator/critic reports. */
  readonly prompt: string;
  /**
   * §5.4 items 1–3 (static, cached per provider per §5.3): system prompt,
   * tool schemas, template manifest, style guide — see buildCacheablePrefix.
   * Providers with prompt caching (Anthropic/OpenAI/Gemini) anchor their
   * cache_control/prompt-cache blocks on this exact text.
   */
  readonly cacheablePrefix?: CacheablePrefix;
  /** Optional images for vision calls (critic renders; §5.1 downscaled). */
  readonly images?: readonly RequestImage[];
  /** JSON-mode request (§5.5 planner contract / §11.2 critic rubric). */
  readonly json?: boolean;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface CompletionResult {
  readonly text: string;
  readonly usage: CompletionUsage;
}

/**
 * Executor tool-loop stream events. The worker adapts the AI SDK's
 * part-streams (text deltas, tool calls, usage, finish) onto this union;
 * the run loop is the ONLY consumer.
 */
export type ProviderStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_call"; readonly tool: string; readonly args: unknown }
  | { readonly type: "usage"; readonly usage: CompletionUsage }
  | { readonly type: "done"; readonly text: string; readonly usage: CompletionUsage };

/**
 * THE provider seam (§5.3). One implementation per provider, produced by the
 * worker's factory. `complete` is the planner/critic path (single response);
 * `streamToolLoop` is the executor path (§5.1 loop: model → tool calls →
 * worker executes tools → feeds results back until `done`).
 *
 * CONTRACT (worker, composition root — this file never imports SDKs):
 *
 * 1. The worker reads provider API keys via @studio/config env parsing
 *    (GEMINI/ANTHROPIC/OPENAI/DEEPSEEK/FLUX_API_KEY + FLUX_BASE_URL) — a
 *    missing key means the provider is unconfigured; the router then fails
 *    over to the same-class fallback (§5.3) and providerHealth() reports
 *    `configured:false`.
 * 2. The worker wires the AI SDK per provider id (§5.3 "provider
 *    abstraction (AI SDK)"): `gemini` → Gemini SDK (gemini-3.8-flash text,
 *    gemini-2.5-flash-lite economy, gemini-3-pro-image finals),
 *    `anthropic` → Anthropic SDK (claude-haiku/sonnet/opus),
 *    `openai` → OpenAI SDK (gpt-5.6-terra, gpt-6-astra, gpt-image-1.5),
 *    `deepseek` → DeepSeek SDK (deepseek-v4.1-flash, incl. off-peak batch),
 *    `flux` → Flux REST/SDK (flux-2-schnell drafts).
 * 3. IMAGE ROUTES ride the tools-package seam, not this one: the worker's
 *    image adapter (flux / gemini-image) satisfies tools' `ImageProviderLike`
 *    for the ids the router resolves under roles imageDrafts/imageFinals.
 *    Text adapters satisfy ProviderLike for planner/executor/critic.
 * 4. Every implementation must honor `request.signal`, attach
 *    `request.cacheablePrefix` as the provider's cache-anchored static block,
 *    report honest `usage.cachedTokens` into the cache hooks (below), and map
 *    provider errors onto the worker's typed result envelopes — never leak
 *    keys, endpoints or raw provider payloads (§15.3).
 */
export interface ProviderLike {
  complete(request: CompletionRequest): Promise<CompletionResult>;
  streamToolLoop(request: CompletionRequest): AsyncIterable<ProviderStreamEvent>;
}

/** What the worker hands its factory per provider (from parsed env; no defaults). */
export interface ProviderRuntimeConfig {
  readonly provider: ModelProviderId;
  readonly apiKey: string;
  /** e.g. FLUX_BASE_URL; omitted when the provider has one canonical endpoint. */
  readonly baseUrl?: string;
  /** §5.3 off-peak batch endpoints for non-interactive jobs (50% discount). */
  readonly offPeakBatch?: boolean;
}

/**
 * Factory contract: the worker registers one adapter per configured provider.
 * The router's providerHealth() names what is configured; resolve() decides
 * the order; the factory turns a (provider, model) into a callable seam.
 */
export type ProviderAdapterFactory = (config: ProviderRuntimeConfig) => ProviderLike;

// --- §5.4 static-prefix cache adviser ----------------------------------------------

/**
 * §5.4 static prefix parts, in the exact order they are assembled — "Use
 * stable ordering and ids so the cache prefix never shifts mid-run."
 */
export const STATIC_PREFIX_PART_IDS = [
  "system_prompt",
  "tool_schemas",
  "template_manifest",
  "style_guide",
] as const;

export type StaticPrefixPartId = (typeof STATIC_PREFIX_PART_IDS)[number];

export const cacheablePrefixInputSchema = z.strictObject({
  /** §5.4 item 1: role, rules, tool-use policy, response format. Required. */
  systemPrompt: z.string().min(1),
  /** §5.4 item 1 (tool schemas): serialized tool registry, stable order. Required. */
  toolSchemas: z.string().min(1),
  /** §5.4 item 3: only the chosen template, per template version. */
  templateManifest: z.string().min(1).optional(),
  /** §5.4 item 2: workspace brand tokens, cached per workspace. */
  styleGuide: z.string().min(1).optional(),
});

export type CacheablePrefixInput = z.infer<typeof cacheablePrefixInputSchema>;

/** The §5.4 static prefix attached to CompletionRequest.cacheablePrefix. */
export interface CacheablePrefix {
  /** Which §5.4 parts are present, in assembly order. */
  readonly parts: readonly StaticPrefixPartId[];
  /** The exact stable text providers anchor their prompt cache on. */
  readonly text: string;
  readonly chars: number;
}

/** Deterministic part separator; fixed so cached text never shifts (§5.4). */
export const STATIC_PREFIX_SEPARATOR = "\n\n";

/**
 * Builds the §5.4 static prefix: system prompt + tool schemas (+ template
 * manifest + style guide when present), assembled in STATIC_PREFIX_PART_IDS
 * order. Pure and deterministic — identical inputs produce byte-identical
 * text, so one workspace/template keeps one provider cache entry per version.
 */
export function buildCacheablePrefix(input: CacheablePrefixInput): CacheablePrefix {
  const parsed = cacheablePrefixInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new RouterError(
      "cacheable prefix failed schema validation",
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  const parts: StaticPrefixPartId[] = [];
  const blocks: string[] = [];
  const push = (part: StaticPrefixPartId, text: string | undefined): void => {
    if (text === undefined) {
      return;
    }
    parts.push(part);
    blocks.push(text);
  };
  push("system_prompt", parsed.data.systemPrompt);
  push("tool_schemas", parsed.data.toolSchemas);
  push("template_manifest", parsed.data.templateManifest);
  push("style_guide", parsed.data.styleGuide);
  const text = blocks.join(STATIC_PREFIX_SEPARATOR);
  return Object.freeze({ parts: Object.freeze(parts), text, chars: text.length });
}

// --- §5.3 per-provider cache-hit tracking hooks --------------------------------------

/** §5.3: "aim for ≥60% cache-hit rate on standard runs". */
export const CACHE_HIT_TARGET = 0.6;

/**
 * Hooks every ProviderLike implementation reports cache outcomes through
 * (the worker passes its tracker in at composition time).
 */
export interface ProviderCacheHooks {
  onCacheHit(provider: ModelProviderId, cachedTokens: number): void;
  onCacheMiss(provider: ModelProviderId): void;
}

/** Per-provider §5.3 cache stats (§22: numbers only, never content). */
export interface ProviderCacheStats {
  readonly provider: ModelProviderId;
  readonly calls: number;
  readonly callsWithCacheHit: number;
  readonly cachedTokens: number;
  readonly hitRate: number | null;
  /** `hitRate >= CACHE_HIT_TARGET`; null before the first call. */
  readonly meetsTarget: boolean | null;
}

/**
 * Default ProviderCacheHooks implementation: per-provider hit/miss counters
 * and the ≥60% target verdict, frozen per snapshot. Sanitizes flaky telemetry
 * (NaN/negative → 0) exactly like budgets.ts — tracking must never throw.
 */
export class ProviderCacheTracker implements ProviderCacheHooks {
  private readonly providers = new Map<
    ModelProviderId,
    { calls: number; hits: number; cachedTokens: number }
  >();

  /** Adapter hook: one completed call's usage → hit or miss (§5.3). */
  record(provider: ModelProviderId, usage: CompletionUsage): void {
    const cachedTokens =
      Number.isFinite(usage.cachedTokens) && usage.cachedTokens > 0
        ? Math.floor(usage.cachedTokens)
        : 0;
    if (cachedTokens > 0) {
      this.onCacheHit(provider, cachedTokens);
    } else {
      this.onCacheMiss(provider);
    }
  }

  onCacheHit(provider: ModelProviderId, cachedTokens: number): void {
    const entry = this.entry(provider);
    entry.calls += 1;
    entry.hits += 1;
    entry.cachedTokens += Number.isFinite(cachedTokens) && cachedTokens > 0 ? cachedTokens : 0;
  }

  onCacheMiss(provider: ModelProviderId): void {
    this.entry(provider).calls += 1;
  }

  /** Frozen per-provider stats for health probes and run cost records (only
   * providers with at least one recorded call appear). */
  snapshot(): Readonly<Record<ModelProviderId, ProviderCacheStats>> {
    const stats = {} as Record<ModelProviderId, ProviderCacheStats>;
    for (const [provider, entry] of this.providers) {
      const hitRate = entry.calls > 0 ? entry.hits / entry.calls : null;
      stats[provider] = Object.freeze({
        provider,
        calls: entry.calls,
        callsWithCacheHit: entry.hits,
        cachedTokens: entry.cachedTokens,
        hitRate,
        meetsTarget: hitRate === null ? null : hitRate >= CACHE_HIT_TARGET,
      });
    }
    return Object.freeze(stats);
  }

  private entry(provider: ModelProviderId): { calls: number; hits: number; cachedTokens: number } {
    let entry = this.providers.get(provider);
    if (entry === undefined) {
      entry = { calls: 0, hits: 0, cachedTokens: 0 };
      this.providers.set(provider, entry);
    }
    return entry;
  }
}
