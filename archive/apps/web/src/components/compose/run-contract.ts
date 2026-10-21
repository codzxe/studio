// apps/web — compose wire contract + pre-run cost display (W8-D).
//
// Pure module, no React imports: the tier cost table, the Zod schema for the
// POST /v1/runs 201 response, the typed error mapping (§13.3 → UI states),
// the brief validator and the idempotency-key mint are all defined here so
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
//
// Read-side contracts (catalog cards, documents, credits) were originally
// NOT mirrored here (the W8-D draft routed them through the shared Wave-8
// hooks), but the composer imports them from THIS module — the drift W8-O
// flagged as the apps/web typecheck break. W10-F reconciled: the wire
// schemas below alias the CANONICAL coarse mirrors in src/lib/api/
// schema-mirror.ts (W8-O) so the shapes stay pinned in one place
// (non-strict: unknown fields strip, never blank a page — §13.3), and the
// query keys follow the frozen conventions in src/lib/api/hooks.ts.

import { z } from "zod";
import {
  type ApiError,
  creditsSchema,
  documentCardSchema,
  documentListEnvelopeSchema,
  documentVersionCardSchema,
  isApiError,
  templateCardsEnvelopeSchema,
} from "../../src/lib/api";

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

// The run timeline lives at /runs/[id] (W8-E, landed) — this builder is the
// composer's one navigation seam to it. A plain string because only the
// call site knows the run id (no route type for dynamic values needed).
export function runTimelineHref(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}

/**
 * The §14.2 top-up path: the billing page (W8-A placeholder → the billing
 * wave's plans, credit packs and ledger). typedRoutes-safe as a constant
 * string typed `string`, so the CTA compiles while the page fills in.
 */
export const CREDITS_ROUTE: string = "/billing";

// ---------------------------------------------------------------------------
// Composer read-side contracts (W10-F reconciliation — see the header note)
// ---------------------------------------------------------------------------

/** `GET /v1/templates` discovery cards (§7.4) — NOT the full manifests. */
export const templatesResponseSchema = templateCardsEnvelopeSchema;

/** `GET /v1/documents` page — cursor paging, newest first (§13.1). */
export const documentsResponseSchema = documentListEnvelopeSchema;

/**
 * `GET /v1/credits` — the workspace balance (§14.1). Coarse on purpose: the
 * paged ledger rows strip; the composer renders the balance only.
 */
export const creditsResponseSchema = creditsSchema;

/**
 * `POST /v1/documents` 201 (§13.1): the created card plus the initial
 * version stub — NOT the detail envelope (no latest_version on create).
 */
export const createDocumentResponseSchema = z.object({
  ok: z.literal(true),
  document: documentCardSchema,
  version: documentVersionCardSchema,
});

export type CreateDocumentResponse = z.infer<typeof createDocumentResponseSchema>;

/** The composer's template card — re-exported from the shared mirror. */
export type { TemplateCard } from "../../src/lib/api";

// --- Query keys (frozen to the src/lib/api/hooks.ts family shapes) ----------

/**
 * Unfiltered catalog read — the ["catalog","templates"] family prefix of
 * the gallery's param-keyed entries (W8-J queryKeys.catalog.templates).
 */
export const TEMPLATES_QUERY_KEY = ["catalog", "templates"] as const;

/**
 * The composer's document list — identical to queryKeys.documents.lists, so
 * the post-create invalidation refreshes EVERY list entry.
 */
export const DOCUMENTS_QUERY_KEY = ["documents", "list"] as const;

/**
 * The composer's balance read — inside the ["session"] family so the shell's
 * refreshSession() invalidates it with the badge (W8-A contract).
 */
export const CREDITS_QUERY_KEY = ["session", "credits"] as const;

// ---------------------------------------------------------------------------
// Wire schema — POST /v1/runs (§13.1; the composer's only own write contract)
// ---------------------------------------------------------------------------

/** POST /v1/runs 201 response (routes/runs.ts, W4-G). */
export const createRunResponseSchema = z
  .object({
    run_id: z.string().min(1),
    status: z.string().min(1),
    credits_reserved: z.number().int().nonnegative(),
  })
  .strict();

export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;

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
