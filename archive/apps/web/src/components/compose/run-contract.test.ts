/**
 * Pure-logic tests for the compose wire contract (W8-D): the §5.2/§14.1
 * tier cost table (the pre-run credit display, §16.2), the gateway wire
 * schemas, the brief validator and the §13.3 error-envelope mapping
 * (402 → credits CTA, 429 → retry-after). Hermetic — no network, no DOM.
 *
 * Mirrors the gateway sources these were transcribed from:
 *   apps/gateway/src/services/runs.ts (CREATE_RUN_BODY_SCHEMA + failure codes)
 *   apps/gateway/src/services/catalog.ts (TemplateCard)
 *   packages/config/src/constants/tiers.ts (RESOLVED_TIERS premium→4 / max→8)
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError } from "../../src/lib/api";
import {
  CREDITS_ROUTE,
  type ComposableTier,
  MAX_ASSET_ATTACHMENTS,
  PROMPT_MAX_CHARS,
  TIER_COSTS,
  createDocumentResponseSchema,
  createRunIdempotencyKey,
  createRunResponseSchema,
  creditsForTier,
  creditsResponseSchema,
  documentsResponseSchema,
  isTierUnaffordable,
  mapRunCreateError,
  parseRetryAfterSeconds,
  runTimelineHref,
  templatesResponseSchema,
  validateBrief,
} from "./run-contract";

// ---------------------------------------------------------------------------
// §5.2/§14.1 tier cost table — the pre-run display must match the gateway
// (creditsForRun / RESOLVED_TIERS) exactly, or the 402 would surprise users.
// ---------------------------------------------------------------------------

describe("tier cost table (§5.2 rows, §14.1 multipliers)", () => {
  const expectedCredits: Readonly<Record<ComposableTier, number>> = {
    quick: 1,
    standard: 2,
    complex: 5,
    premium: 4, // ×2 standard (§14.4 pins premium at 4 credits)
    max: 8, // ×4 standard (§14.4 pins max at 8 credits)
  };

  it.each(Object.entries(expectedCredits))("%s costs %i credits", (tier, credits) => {
    expect(creditsForTier(tier as ComposableTier)).toBe(credits);
  });

  it("exposes exactly the five agent-run tiers the gateway accepts, in §5.2 order", () => {
    expect(TIER_COSTS.map((info) => info.tier)).toEqual([
      "quick",
      "standard",
      "complex",
      "premium",
      "max",
    ]);
  });

  it("marks only premium/max as multiplied tiers (§14.1)", () => {
    const multiplied = TIER_COSTS.filter((info) => info.multiplied).map((info) => info.tier);
    expect(multiplied).toEqual(["premium", "max"]);
  });

  it("carries resolved §5.2 budgets: tool calls, revisions, wall clock", () => {
    const byTier = new Map(TIER_COSTS.map((info) => [info.tier, info]));
    // quick 6 / standard 12 / complex 24 / premium 18 (12×1.5) / max 24 (12×2)
    expect(byTier.get("quick")?.toolCallCap).toBe(6);
    expect(byTier.get("standard")?.toolCallCap).toBe(12);
    expect(byTier.get("complex")?.toolCallCap).toBe(24);
    expect(byTier.get("premium")?.toolCallCap).toBe(18);
    expect(byTier.get("max")?.toolCallCap).toBe(24);
    // 1 / 2 / 2 / 2 / 3 revisions; 2 / 5 / 10 / 10 / 15 min wall clock
    expect(TIER_COSTS.map((info) => info.revisions)).toEqual([1, 2, 2, 2, 3]);
    expect(TIER_COSTS.map((info) => info.wallClockMin)).toEqual([2, 5, 10, 10, 15]);
  });

  it("flags a tier unaffordable only when the balance is below its cost", () => {
    expect(isTierUnaffordable("premium", 4)).toBe(false); // exactly enough
    expect(isTierUnaffordable("premium", 3)).toBe(true);
    expect(isTierUnaffordable("standard", undefined)).toBe(false); // unknown ≠ blocked
  });
});

// ---------------------------------------------------------------------------
// Brief validator — mirrors the gateway prompt rules (W4-G CREATE_RUN body)
// ---------------------------------------------------------------------------

describe("validateBrief", () => {
  it.each([
    ["empty", "", false],
    ["whitespace-only", "   \n\t ", false],
    ["normal brief", "A café menu with a Friday special", true],
    ["exactly at the cap", "a".repeat(PROMPT_MAX_CHARS), true],
    ["over the cap", "a".repeat(PROMPT_MAX_CHARS + 1), false],
  ] as const)("%s → valid=%s", (_name, prompt, valid) => {
    expect(validateBrief(prompt).ok).toBe(valid);
    expect(validateBrief(prompt).error === null).toBe(valid);
  });

  it("pins the gateway caps the form relies on", () => {
    expect(PROMPT_MAX_CHARS).toBe(8000); // §13.1 prompt ≤ 8000
    expect(MAX_ASSET_ATTACHMENTS).toBe(16); // assetIds ≤ 16 (W4-G)
  });
});

// ---------------------------------------------------------------------------
// Wire schemas — fixtures mirror the gateway serializers exactly
// ---------------------------------------------------------------------------

describe("wire schemas", () => {
  const templateCard = {
    id: "instagram-post",
    version: 3,
    ref: "instagram-post@3",
    name: "Instagram Post — Promo",
    tags: ["social", "promo", "square"],
    canvas: { width: 1080, height: 1080 },
    slots: ["photo", "headline", "subhead", "badge", "logo"],
  };

  const documentDto = {
    id: "9f1d2b3c-1111-4000-8000-000000000001",
    name: "Friday promo",
    width_px: 1080,
    height_px: 1080,
    current_revision: 2,
    template_id: "instagram-post@3",
    created_by: "user-1",
    created_at: "2026-02-01T10:00:00.000Z",
    updated_at: "2026-02-01T11:00:00.000Z",
    archived_at: null,
  };

  it("parses a GET /v1/templates page (W4-J TemplateCard)", () => {
    const parsed = templatesResponseSchema.parse({ templates: [templateCard] });
    expect(parsed.templates[0]?.ref).toBe("instagram-post@3");
  });

  it("rejects a template card with drifted fields", () => {
    expect(() =>
      templatesResponseSchema.parse({
        templates: [{ ...templateCard, thumbnail: "thumb.png" }],
      }),
    ).toThrow();
  });

  it("parses GET /v1/documents rows (W4-F toDocumentDto)", () => {
    const parsed = documentsResponseSchema.parse({
      ok: true,
      documents: [documentDto],
      next_cursor: null,
    });
    expect(parsed.documents[0]?.id).toBe(documentDto.id);
  });

  it("parses GET /v1/credits and only needs the balance", () => {
    const parsed = creditsResponseSchema.parse({
      balance: 42,
      ledger: { rows: [{ opaque: "row shape is not the composer's contract" }] },
    });
    expect(parsed.balance).toBe(42);
  });

  it("parses the POST /v1/runs 201 body (W4-G)", () => {
    const parsed = createRunResponseSchema.parse({
      run_id: "run-1",
      status: "queued",
      credits_reserved: 2,
    });
    expect(parsed.run_id).toBe("run-1");
  });

  it("rejects a run response with unexpected keys (contract drift)", () => {
    expect(() =>
      createRunResponseSchema.parse({
        run_id: "run-1",
        status: "queued",
        credits_reserved: 2,
        internal_id: "nope",
      }),
    ).toThrow();
  });

  it("parses the POST /v1/documents 201 body (W4-F)", () => {
    const parsed = createDocumentResponseSchema.parse({
      ok: true,
      document: documentDto,
      version: {
        id: "v-1",
        revision: 1,
        label: "created",
        created_by: "user-1",
        created_at: "2026-02-01T10:00:00.000Z",
      },
    });
    expect(parsed.document.name).toBe("Friday promo");
  });
});

// ---------------------------------------------------------------------------
// §13.3 error mapping — every gateway failure the composer can meet
// ---------------------------------------------------------------------------

describe("mapRunCreateError", () => {
  const table: readonly {
    readonly name: string;
    readonly error: unknown;
    readonly kind: string;
  }[] = [
    {
      name: "402 insufficient_credits (§14.2 r1) → CTA state",
      error: new ApiError({
        code: "insufficient_credits",
        message: "This run needs 5 credits but the workspace has 2 available.",
        status: 402,
        hint: "Top up credits or upgrade your plan, then retry.",
        retryable: false,
      }),
      kind: "insufficient_credits",
    },
    {
      name: "402 plan_limit → CTA state",
      error: new ApiError({
        code: "plan_limit",
        message: "This plan allows 1 concurrent run.",
        status: 402,
      }),
      kind: "insufficient_credits",
    },
    {
      name: "429 rate_limited with the limiter hint → retry-after seconds",
      error: new ApiError({
        code: "rate_limited",
        message: "Too many requests — slow down and retry shortly.",
        status: 429,
        hint: "Limit is 30 per 60s. Retry after 42s.",
        retryable: true,
      }),
      kind: "rate_limited",
    },
    {
      name: "429 without a parseable hint → retryAfterSec null",
      error: new ApiError({
        code: "rate_limited",
        message: "Too many requests.",
        status: 429,
        retryable: true,
      }),
      kind: "rate_limited",
    },
    {
      name: "401 unauthorized → sign-in state",
      error: new ApiError({ code: "unauthorized", message: "Sign in first.", status: 401 }),
      kind: "auth",
    },
    {
      name: "403 forbidden → sign-in state",
      error: new ApiError({ code: "forbidden", message: "No access.", status: 403 }),
      kind: "auth",
    },
    {
      name: "404 not_found (foreign/missing document, §12.2)",
      error: new ApiError({
        code: "not_found",
        message: "Document not found.",
        status: 404,
        hint: "Check the document id within your workspace.",
      }),
      kind: "not_found",
    },
    {
      name: "409 conflict (archived document, W4-G)",
      error: new ApiError({
        code: "conflict",
        message: "This document is archived; runs start on active documents only.",
        status: 409,
      }),
      kind: "conflict",
    },
    {
      name: "422 validation_failed → fix-the-form state",
      error: new ApiError({
        code: "validation_failed",
        message: "An idempotency key is required to create a run.",
        status: 422,
        retryable: true,
      }),
      kind: "validation",
    },
    {
      name: "503 engine_unavailable → retryable server state",
      error: new ApiError({
        code: "engine_unavailable",
        message: "The engine pool is at capacity.",
        status: 503,
        retryable: true,
      }),
      kind: "server",
    },
    {
      name: "network_error (status 0, client-produced)",
      error: new ApiError({
        code: "network_error",
        message: "Could not reach the server.",
        status: 0,
        retryable: true,
      }),
      kind: "network",
    },
  ];

  it.each(table)("$name", ({ error, kind }: { readonly error: unknown; readonly kind: string }) => {
    const mapped = mapRunCreateError(error);
    expect(mapped.kind).toBe(kind);
    // Never an empty message — the UI always has something to show.
    expect(mapped.message.length).toBeGreaterThan(0);
  });

  it("extracts the retry window from the 429 envelope", () => {
    const mapped = mapRunCreateError(
      new ApiError({
        code: "rate_limited",
        message: "Too many requests.",
        status: 429,
        hint: "Limit is 30 per 60s. Retry after 42s.",
        retryable: true,
      }),
    );
    expect(mapped).toMatchObject({ kind: "rate_limited", retryAfterSec: 42 });
  });

  it("keeps the server's shortfall wording on a 402 (§14.2 r1)", () => {
    const mapped = mapRunCreateError(
      new ApiError({
        code: "insufficient_credits",
        message: "This run needs 5 credits but the workspace has 2 available.",
        status: 402,
        hint: "Top up credits or upgrade your plan, then retry.",
      }),
    );
    expect(mapped).toMatchObject({
      kind: "insufficient_credits",
      message: "This run needs 5 credits but the workspace has 2 available.",
      hint: "Top up credits or upgrade your plan, then retry.",
    });
  });

  it("collapses non-envelope throws to the generic state — no internals leaked", () => {
    const drifted = mapRunCreateError(new z.ZodError([]));
    expect(drifted).toEqual({
      kind: "unknown",
      message: "Could not start the run. Please try again.",
    });
    const coded = mapRunCreateError(new Error("deep internal /var/secrets path"));
    expect(coded.message).not.toContain("/var");
  });
});

// ---------------------------------------------------------------------------
// Retry-after parser — the gateway's hint phrasing is the contract
// ---------------------------------------------------------------------------

describe("parseRetryAfterSeconds", () => {
  it.each([
    ["Limit is 30 per 60s. Retry after 42s.", 42],
    ["…retry after 1s", 1],
    ["Limit is 120 per 60s. Retry after 0s.", 0],
    ["no window here", null],
    [undefined, null],
  ] as const)("%j → %s", (text, expected) => {
    expect(parseRetryAfterSeconds(text)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// §3.4 idempotency keys + navigation seams
// ---------------------------------------------------------------------------

describe("idempotency + routes", () => {
  it("mints distinct UUIDs (one per run-intent, §3.4)", () => {
    const first = createRunIdempotencyKey();
    const second = createRunIdempotencyKey();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(second).not.toBe(first);
  });

  it("points the timeline href at the W8-E route and the CTA at the credits page", () => {
    expect(runTimelineHref("run 42")).toBe("/runs/run%2042");
    expect(runTimelineHref("abc")).toBe("/runs/abc");
    expect(CREDITS_ROUTE).toBe("/credits");
  });
});
