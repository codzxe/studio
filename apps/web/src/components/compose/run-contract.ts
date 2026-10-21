// apps/web — compose wire contract + pre-run cost display (W8-D).
//
// Pure module, no React imports: the tier cost table, the Zod schemas for the
// three gateway reads and two mutations the composer makes, the typed error
// mapping (§13.3 → UI states) and the small validators are all defined here so
// the colocated run-contract.test.ts covers them hermetically (no network,
// no DOM) and use-run-create.ts stays a thin React binding.
//
// Spec anchors:
//   §5.2  run tiers + budgets (credits, model class, tool-call caps, clocks)
//   §14.1 premium ×2 / max ×4 multiply the base tier; §14.4 pins 4 / 8 credits
//   §16.2 truthfulness — the cost of every action in credits, before it runs
//   §13.1 POST /v1/runs body (camelCase per gateway CREATE_RUN_BODY_SCHEMA,
//         W4-G: { documentId, prompt≤8000, tier, templateId?, assetIds≤16 })
//   §13.3 error envelopes — flat `{ ok:false, code, message, hint, retryable }`
//   §3.4  idempotency — same key replays the same run, never a second charge
//
// TODO(sync, @studio/config): packages/config/src/constants/tiers.ts is the
// authoritative §5.2 table (RESOLVED_TIERS resolves premium→4 / max→8 the same
// way). Import it directly once TS-source workspace packages are wired into
// Vitest aliases (same TODO as src/lib/api.ts's §13.2 event mirror); until
// then this local mirror is pinned against it by the colocated test.

import { z } from "zod";
import { type ApiError, isApiError } from "../../src/lib/api";

// ---------------------------------------------------------------------------
// Prompt + attachment caps (gateway CREATE_RUN_BODY_SCHEMA, W4-G)
// ---------------------------------------------------------------------------

/** §5.7: user content is capped, never trusted. */
export const PROMPT_MAX_CHARS = 8000;

/** Gateway `assetIds` array cap (≤16). */
export const MAX_ASSET_ATTACHMENTS = 16;

/** Document display name cap (gateway createBodySchema, W4-F). */
export const DOCUMENT_NAME_MAX_CHARS = 200;

export interface BriefValidation {
  readonly ok: boolean;
  /** First problem to show under the textarea; null when the brief is valid. */
  readonly error: string | null;
}

/** Pure brief check mirroring the gateway rules: non-blank, ≤8000 chars. */
export function validateBrief(prompt: string): BriefValidation {
  if (prompt.trim().length === 0) {
    return { ok: false, error: "Describe what you want the agent to make." };
  }
  if (prompt.length > PROMPT_MAX_CHARS) {
    return { ok: false, error: `Keep the brief under ${PROMPT_MAX_CHARS} characters.` };
  }
  return { ok: true, error: null };
}

// ---------------------------------------------------------------------------
// Tier cost table — §5.2 rows 1–5 (the five agent-run tiers the gateway's
// RUN_QUEUE_TIERS accepts; image tiers are not agent runs). Credit values are
// the RESOLVED costs the gateway reserves (creditsForRun): premium/max are
// ×2/×4 over their standard base (§14.1/§14.4).
// ---------------------------------------------------------------------------

/** The tiers POST /v1/runs accepts (gateway RUN_QUEUE_TIERS, W4-G). */
export const COMPOSABLE_TIERS = ["quick", "standard", "complex", "premium", "max"] as const;

export type ComposableTier = (typeof COMPOSABLE_TIERS)[number];

export interface TierCostInfo {
  readonly tier: ComposableTier;
  /** Resolved credit cost reserved on run creation (§14.2 rule 1). */
  readonly credits: number;
  /**
   * True for the multiplied tiers — shown as "×2/×4 standard" alongside the
   * resolved cost so §16.2 truthfulness holds without hiding the multiplier.
   */
  readonly multiplied: boolean;
  /** §5.2 model class label, user-facing. */
  readonly modelLabel: string;
  /** §5.2 tool-call cap (resolved: standard × multiplier for premium/max). */
  readonly toolCallCap: number;
  /** §5.2 revisions. */
  readonly revisions: number;
  /** §5.2 wall clock, whole minutes (user-facing display unit). */
  readonly wallClockMin: number;
  /** One-line description of what the tier is for (§5.2 row labels). */
  readonly summary: string;
}

const TIER_COST_TABLE: Readonly<Record<ComposableTier, TierCostInfo>> = {
  quick: {
    tier: "quick",
    credits: 1,
    multiplied: false,
    modelLabel: "Economy model",
    toolCallCap: 6,
    revisions: 1,
    wallClockMin: 2,
    summary: "Quick edits — change text, colours or fix details.",
  },
  standard: {
    tier: "standard",
    credits: 2,
    multiplied: false,
    modelLabel: "Default model",
    toolCallCap: 12,
    revisions: 2,
    wallClockMin: 5,
    summary: "Standard generation with planning and validation.",
  },
  complex: {
    tier: "complex",
    credits: 5,
    multiplied: false,
    modelLabel: "Default+ model, more planning",
    toolCallCap: 24,
    revisions: 2,
    wallClockMin: 10,
    summary: "Dense, multi-part layouts and longer briefs.",
  },
  premium: {
    tier: "premium",
    credits: 4,
    multiplied: true,
    modelLabel: "Sonnet-class model",
    toolCallCap: 18,
    revisions: 2,
    wallClockMin: 10,
    summary: "×2 standard — a stronger model for harder briefs.",
  },
  max: {
    tier: "max",
    credits: 8,
    multiplied: true,
    modelLabel: "Opus-class model",
    toolCallCap: 24,
    revisions: 3,
    wallClockMin: 15,
    summary: "×4 standard — frontier model, most revisions.",
  },
};

export const TIER_COSTS: readonly TierCostInfo[] = COMPOSABLE_TIERS.map(
  (tier) => TIER_COST_TABLE[tier],
);

/** §5.2/§14.1 credit cost for a tier — what the gateway reserves (§14.2 r1). */
export function creditsForTier(tier: ComposableTier): number {
  return TIER_COST_TABLE[tier].credits;
}

/** True when the workspace balance cannot cover the tier's reservation. */
export function isTierUnaffordable(tier: ComposableTier, balance: number | undefined): boolean {
  return balance !== undefined && balance < creditsForTier(tier);
}

// ---------------------------------------------------------------------------
// Routes (single home; the run timeline + credits pages belong to other
// Wave-8 owners — see each constant's owner note).
// ---------------------------------------------------------------------------

// TODO(wiring W8-E): the run timeline page owns /runs/[id]; this builder is
// the one navigation seam the composer needs. It stays a plain string because
// experimental.typedRoutes only types existing routes (next.config.ts W1-K).
export function runTimelineHref(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}

// TODO(wiring, billing wave): the credits/top-up page is not in this repo yet;
// a native <a> is used for the CTA so typedRoutes never blocks the link.
export const CREDITS_ROUTE: string = "/credits";

// React Query cache keys shared by the composer's reads (useQuery in the
// page) and the run-creation mutation (balance invalidation §14.2 r1). Plain
// frozen data, colocated with the wire contract they validate.
export const TEMPLATES_QUERY_KEY = ["compose", "templates"] as const;
export const DOCUMENTS_QUERY_KEY = ["compose", "documents"] as const;
export const CREDITS_QUERY_KEY = ["compose", "credits"] as const;

// ---------------------------------------------------------------------------
// Wire schemas — Zod at every boundary (gateway §13.1 shapes, exact fields)
// ---------------------------------------------------------------------------

/** GET /v1/templates card (services/catalog.ts TemplateCard, W4-J). */
export const templateCardSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().min(1),
    /** The immutable `id@version` pin (§7.2) — always explicit in replies. */
    ref: z.string().min(1),
    name: z.string().min(1),
    tags: z.array(z.string()),
    canvas: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    slots: z.array(z.string()),
  })
  .strict();

export type TemplateCard = z.infer<typeof templateCardSchema>;

export const templatesResponseSchema = z
  .object({ templates: z.array(templateCardSchema) })
  .strict();

/** GET /v1/documents row (routes/documents.ts toDocumentDto, W4-F). */
export const documentDtoSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    width_px: z.number().int().positive(),
    height_px: z.number().int().positive(),
    current_revision: z.number().int().nonnegative(),
    template_id: z.string().nullable(),
    created_by: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    archived_at: z.string().nullable(),
  })
  .strict();

export type DocumentDto = z.infer<typeof documentDtoSchema>;

export const documentsResponseSchema = z
  .object({
    ok: z.literal(true),
    documents: z.array(documentDtoSchema),
    next_cursor: z.string().nullable().optional(),
  })
  .strict();

/** GET /v1/credits — only the balance is consumed here (§13.1). */
export const creditsResponseSchema = z
  .object({
    balance: z.number(),
    ledger: z
      .object({
        // Row shape is the credits surface's contract (W4-M), not the
        // composer's — kept unknown so the balance read never breaks on it.
        rows: z.array(z.unknown()),
        next_cursor: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export type CreditsResponse = z.infer<typeof creditsResponseSchema>;

/** POST /v1/runs 201 response (routes/runs.ts, W4-G). */
export const createRunResponseSchema = z
  .object({
    run_id: z.string().min(1),
    status: z.string().min(1),
    credits_reserved: z.number().int().nonnegative(),
  })
  .strict();

export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;

/** POST /v1/documents 201 response (routes/documents.ts, W4-F). */
export const createDocumentResponseSchema = z
  .object({
    ok: z.literal(true),
    document: documentDtoSchema,
    version: z
      .object({
        id: z.string().min(1),
        revision: z.number().int().nonnegative(),
        label: z.string(),
        created_by: z.string(),
        created_at: z.string(),
      })
      .strict(),
  })
  .strict();

export type CreateDocumentResponse = z.infer<typeof createDocumentResponseSchema>;

/** POST /v1/runs request body (camelCase, gateway CREATE_RUN_BODY_SCHEMA). */
export interface CreateRunRequest {
  readonly documentId: string;
  readonly prompt: string;
  readonly tier: ComposableTier;
  readonly templateId?: string;
  readonly assetIds?: readonly string[];
}

// ---------------------------------------------------------------------------
// Typed error mapping — §13.3 envelopes → the composer's UI states
// ---------------------------------------------------------------------------

/** The UI states the composer can render for a failed run creation. */
export type RunCreateError =
  /** 402 insufficient_credits / plan_limit (§14.2 rule 1) → credits CTA. */
  | { readonly kind: "insufficient_credits"; readonly message: string; readonly hint?: string }
  /** 429 rate_limited → show the retry-after window (§13.3 + RFC Retry-After). */
  | {
      readonly kind: "rate_limited";
      readonly message: string;
      readonly hint?: string;
      readonly retryAfterSec: number | null;
    }
  /** 401/403 — no session or no write access on the workspace (§15). */
  | { readonly kind: "auth"; readonly message: string; readonly hint?: string }
  /** 400/422 validation — fix the form, retry freely. */
  | { readonly kind: "validation"; readonly message: string; readonly hint?: string }
  /** 409 conflict — e.g. an archived document (W4-G). */
  | { readonly kind: "conflict"; readonly message: string; readonly hint?: string }
  /** 404 — the target document is gone or belongs to another tenant (§12.2). */
  | { readonly kind: "not_found"; readonly message: string; readonly hint?: string }
  /** Transport failure — the gateway was unreachable. */
  | { readonly kind: "network"; readonly message: string; readonly retryable: true }
  /** 5xx — transient server side; safe to retry after a moment. */
  | { readonly kind: "server"; readonly message: string; readonly retryable: true }
  /** Anything unrecognized — collapsed, no internals leaked (§13.3). */
  | { readonly kind: "unknown"; readonly message: string };

const GENERIC_RUN_ERROR = "Could not start the run. Please try again.";

/**
 * Parses the retry-after window out of a `rate_limited` hint/message. The
 * gateway's rate limiter writes "… Retry after Ns." into the hint
 * (middleware/rate-limit.ts + services/limiter.ts callers) — the browser
 * client does not surface response headers, so the envelope text is the
 * contract for the 429 display.
 */
export function parseRetryAfterSeconds(text: string | undefined): number | null {
  if (text === undefined) {
    return null;
  }
  const match = /retry after (\d+)\s*s/i.exec(text);
  return match === null ? null : Number.parseInt(match[1] ?? "", 10);
}

/** Narrow an unknown throw into a RunCreateError — never leaks internals. */
export function mapRunCreateError(error: unknown): RunCreateError {
  if (!isApiError(error)) {
    // Schema-drift ZodErrors and coding bugs collapse to the generic state;
    // stack traces / internals never reach the UI (§13.3).
    return { kind: "unknown", message: GENERIC_RUN_ERROR };
  }
  const apiError: ApiError = error;
  if (apiError.status === 0 || apiError.code === "network_error") {
    return {
      kind: "network",
      message: "Could not reach the server. Check your connection and retry.",
      retryable: true,
    };
  }
  if (
    apiError.status === 402 ||
    apiError.code === "insufficient_credits" ||
    apiError.code === "plan_limit"
  ) {
    // §14.2 rule 1: the run never started — the message names the shortfall.
    return { kind: "insufficient_credits", message: apiError.message, hint: apiError.hint };
  }
  if (apiError.status === 429 || apiError.code === "rate_limited") {
    return {
      kind: "rate_limited",
      message: apiError.message,
      hint: apiError.hint,
      retryAfterSec: parseRetryAfterSeconds(apiError.hint ?? apiError.message),
    };
  }
  if (
    apiError.status === 401 ||
    apiError.status === 403 ||
    apiError.code === "unauthorized" ||
    apiError.code === "forbidden"
  ) {
    return { kind: "auth", message: apiError.message, hint: apiError.hint };
  }
  if (apiError.status === 409 || apiError.code === "conflict") {
    return { kind: "conflict", message: apiError.message, hint: apiError.hint };
  }
  if (apiError.status === 404 || apiError.code === "not_found") {
    return { kind: "not_found", message: apiError.message, hint: apiError.hint };
  }
  if (apiError.status === 400 || apiError.status === 422) {
    return { kind: "validation", message: apiError.message, hint: apiError.hint };
  }
  if (apiError.status >= 500) {
    return { kind: "server", message: apiError.message, retryable: true };
  }
  return { kind: "unknown", message: GENERIC_RUN_ERROR };
}

// ---------------------------------------------------------------------------
// Idempotency (§3.4)
// ---------------------------------------------------------------------------

/**
 * Client-generated idempotency key for one run-intent (§13 preamble). Reused
 * across retries of the SAME submit so the gateway replays the same run
 * instead of charging twice; the composer mints a fresh one per new submit.
 */
export function createRunIdempotencyKey(): string {
  return crypto.randomUUID();
}
