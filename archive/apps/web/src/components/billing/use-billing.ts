"use client";

// components/billing/use-billing — data + mutation hooks for /billing (W8-K,
// spec §14). Everything flows through the typed gateway client (§13: the web
// app talks only to the gateway) with a zod schema at every boundary, so
// contract drift throws ZodError inside the query (rendered as an error
// state, never a crash).
//
// Wire contracts — mirror the implemented gateway routes, snake_case:
//   GET  /v1/credits          { balance, ledger: { rows, next_cursor? } }
//                            (cursor-paged, newest-first, opaque base64url)
//   GET  /v1/credits/summary { window_days, spend_credits, open_holds, trial }
//   GET  /v1/billing/plans   { ok, plans[], credit_pack, credit_price_usd_cents }
//   POST /v1/billing/checkout { planCode, workspaceId } → { ok, url, session_id? }
//   POST /v1/billing/portal   { workspaceId } → { ok, url }
//   GET  /v1/me              { ok, user, memberships, plan? } — contract-only
//   today (openapi pins only "plan: loose Plan summary (§14.1)"), so every
//   plan field is optional and normalized defensively; absent → "—".
//
// The gateway client is built lazily from NEXT_PUBLIC_ env exactly like
// SessionProvider does (never at render/SSR time — prerender needs no env,
// src/lib/env.ts contract). The session module keeps its client context
// private, so this mirror owns one per hook consumer.
//
// Checkout/portal redirect via window.location.assign: Stripe hosts those
// pages (§14.3) — a client-side router push would keep the app mounted
// behind an external URL. Money paths: the client auto-attaches the
// Idempotency-Key header on every POST (§13).

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useSession } from "@/hooks/use-session";
import { createGatewayClientFromEnv, isApiError, type GatewayClient } from "@/lib/api";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Wire schemas (mirror apps/gateway/src/routes/{credits,billing}.ts views)
// ---------------------------------------------------------------------------

/** §14.2 ledger kinds the gateway serves (credit_ledger.kind consts, W1-F). */
export const LEDGER_KINDS = ["grant", "pack", "reserve", "commit", "refund", "adjustment"] as const;
export type KnownLedgerKind = (typeof LEDGER_KINDS)[number];

/** One append-only credit_ledger row as GET /v1/credits serves it (§12.2). */
const ledgerEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  delta: z.number(),
  run_id: z.string().nullable(),
  note: z.string().nullable(),
  balance_after: z.number(),
  created_at: z.coerce.date(),
});

/** GET /v1/credits — balance + one cursor-paged ledger page (§13.1). */
const creditsPageSchema = z.object({
  balance: z.number(),
  ledger: z.object({
    rows: z.array(ledgerEntrySchema),
    next_cursor: z.string().min(1).optional(),
  }),
});

/** GET /v1/credits/summary — 30-day spend, open holds, trial flag (§22). */
const creditsSummarySchema = z.object({
  window_days: z.number().int().positive(),
  spend_credits: z.number(),
  open_holds: z.number(),
  trial: z.boolean(),
});

/** Checkout codes (gateway BILLING_PLAN_CODES: three subscriptions + pack). */
export const BILLING_PLAN_CODES = ["starter", "pro", "max", "pack"] as const;
export type BillingPlanCode = (typeof BILLING_PLAN_CODES)[number];

/** GET /v1/billing/plans card — §14.1 pricing joined with runtime limits. */
const planCardSchema = z.object({
  code: z.enum(["starter", "pro", "max"]),
  monthly_price_usd_cents: z.number().int().nonnegative(),
  monthly_credits: z.number().int().nonnegative(),
  extra_seat_price_usd_cents: z.number().int().nonnegative(),
  seats: z.number().int().positive(),
  concurrent_runs: z.number().int().positive(),
  concurrent_sessions: z.number().int().positive(),
  max_canvas_megapixels: z.number().int().positive(),
  daily_spend_cap_credits: z.number().int().nonnegative(),
});

const plansResponseSchema = z.object({
  ok: z.literal(true).optional(),
  plans: z.array(planCardSchema),
  credit_pack: z.object({
    credits: z.number().int().positive(),
    price_usd_cents: z.number().int().nonnegative(),
  }),
  credit_price_usd_cents: z.number().int().nonnegative(),
});

/** POST /v1/billing/checkout → Stripe Checkout session url (§14.3). */
const checkoutResponseSchema = z.object({
  ok: z.literal(true).optional(),
  url: z.string().min(1),
  session_id: z.string().optional(),
});

/** POST /v1/billing/portal → Stripe customer-portal session url (§14.3). */
const portalResponseSchema = z.object({
  ok: z.literal(true).optional(),
  url: z.string().min(1),
});

/**
 * GET /v1/me `plan` — the §13.1 openapi contract pins only a loose "Plan
 * summary (§14.1)" object. Field names are unpinned until the route wave
 * lands /v1/me, so both spellings are accepted and normalized; the card
 * falls back to the §14.1 catalog for numbers it omits.
 */
const mePlanSummarySchema = z.object({
  code: z.string().optional(),
  plan_code: z.string().optional(),
  name: z.string().optional(),
  monthly_credits: z.number().optional(),
  credits: z.number().optional(),
  seats: z.number().int().optional(),
  seat_limit: z.number().int().optional(),
  renewal_at: z.coerce.date().nullable().optional(),
  renews_at: z.coerce.date().nullable().optional(),
  current_period_end: z.coerce.date().nullable().optional(),
  status: z.string().optional(),
});

const mePlanResponseSchema = z.object({
  ok: z.literal(true).optional(),
  plan: mePlanSummarySchema.nullable().optional(),
});

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type CreditsSummaryResponse = z.infer<typeof creditsSummarySchema>;
export type PlanCard = z.infer<typeof planCardSchema>;
export type CreditPack = z.infer<typeof plansResponseSchema>["credit_pack"];
export type PlansResponse = z.infer<typeof plansResponseSchema>;
export type MePlanSummary = z.infer<typeof mePlanSummarySchema>;

// ---------------------------------------------------------------------------
// §14.1 display fallback (exact mirror)
// ---------------------------------------------------------------------------
//
// GET /v1/billing/plans is the source of truth (the gateway joins
// @studio/config pricing.ts + limits.ts, where the same §14.1 table lives).
// This constant mirrors §14.1 exactly — $30/$60/$120 → 100/250/600 credits,
// seats 1/3/10 with every extra seat +$8, concurrent runs 1/3/6, canvas
// 32/64/128 MP, daily cap = 2× monthly credits (§14.2 rule 7) — so the
// pricing grid still renders while the plans route is unreachable (typed
// 501 until the wiring wave mounts it), clearly labeled in the UI.
// Keep in sync with packages/config/src/constants/{pricing,limits}.ts.

export const PLAN_CATALOG_FALLBACK_14: readonly PlanCard[] = [
  {
    code: "starter",
    monthly_price_usd_cents: 3000,
    monthly_credits: 100,
    extra_seat_price_usd_cents: 800,
    seats: 1,
    concurrent_runs: 1,
    concurrent_sessions: 1,
    max_canvas_megapixels: 32,
    daily_spend_cap_credits: 200,
  },
  {
    code: "pro",
    monthly_price_usd_cents: 6000,
    monthly_credits: 250,
    extra_seat_price_usd_cents: 800,
    seats: 3,
    concurrent_runs: 3,
    concurrent_sessions: 3,
    max_canvas_megapixels: 64,
    daily_spend_cap_credits: 500,
  },
  {
    code: "max",
    monthly_price_usd_cents: 12000,
    monthly_credits: 600,
    extra_seat_price_usd_cents: 800,
    seats: 10,
    concurrent_runs: 6,
    concurrent_sessions: 6,
    max_canvas_megapixels: 128,
    daily_spend_cap_credits: 1200,
  },
];

/** $10 per 100 credits, never expiring while subscribed (§14.1). */
export const CREDIT_PACK_FALLBACK_14: CreditPack = { credits: 100, price_usd_cents: 1000 };

// ---------------------------------------------------------------------------
// Client + shared helpers
// ---------------------------------------------------------------------------

function toMessage(error: unknown): string {
  // ApiError messages are user-safe by contract (§13.3); anything else
  // (network throw, ZodError) collapses to a generic line.
  return isApiError(error) ? error.message : "Something went wrong. Please try again.";
}

function toHint(error: unknown): string | null {
  return isApiError(error) && error.hint !== undefined ? error.hint : null;
}

/** Lazily-built gateway client (SessionProvider keeps its own private one). */
function useBillingClient(): () => GatewayClient {
  const clientRef = useRef<GatewayClient | null>(null);
  return useCallback(() => {
    if (clientRef.current === null) {
      clientRef.current = createGatewayClientFromEnv();
    }
    return clientRef.current;
  }, []);
}

/** 1 decimal at most — credit math is fractional only in half-charge cases. */
export function formatCredits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Signed ledger delta: "+2", "−1.5", "0" (U+2212 minus for readability). */
export function formatDelta(value: number): string {
  if (value > 0) {
    return `+${formatCredits(value)}`;
  }
  if (value < 0) {
    return `−${formatCredits(Math.abs(value))}`;
  }
  return "0";
}

// Fixed locale keeps markup identical across server render and hydration
// (Intl would otherwise resolve different locales per environment).
const USD_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Money is integer cents on the wire (§12); render with a fixed locale. */
export function formatUsdCents(cents: number): string {
  return USD_FORMAT.format(cents / 100);
}

const PLAN_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  starter: "Starter",
  pro: "Pro",
  max: "Max",
};

/** Wire codes are lowercase ids; "max" is the §14.1 top tier's wire name. */
export function planDisplayName(code: string): string {
  return PLAN_DISPLAY_NAMES[code] ?? code.charAt(0).toUpperCase() + code.slice(1);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const ledgerQueryKey = (workspaceId: string | null, limit: number) =>
  ["billing", "credits", "ledger", workspaceId, limit] as const;

function clampLedgerLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 20;
  }
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

export interface CreditsLedgerController {
  readonly status: "loading" | "ready" | "error";
  readonly message: string | null;
  /** Live derived balance from the freshest first page (§12.2: Σ deltas). */
  readonly balance: number | null;
  readonly rows: readonly LedgerEntry[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly retry: () => void;
  readonly loadMore: () => void;
}

/**
 * GET /v1/credits — balance + cursor-paged ledger (§13.1/§14.2). Pages
 * accumulate across loadMore() calls; the newest row's balance_after equals
 * `balance` (§12.2 sum-sanity invariant).
 */
export function useCreditsLedger(limit = 20): CreditsLedgerController {
  const getClient = useBillingClient();
  const { activeWorkspaceId } = useSession();
  const size = clampLedgerLimit(limit);

  const query = useInfiniteQuery({
    queryKey: ledgerQueryKey(activeWorkspaceId, size),
    queryFn: ({ pageParam }) => {
      const cursor = pageParam === undefined ? "" : `&cursor=${encodeURIComponent(pageParam)}`;
      return getClient().get(`/credits?limit=${size}${cursor}`, { schema: creditsPageSchema });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.ledger.next_cursor,
  });

  const pages = query.data?.pages ?? [];
  const rows: readonly LedgerEntry[] = pages.flatMap((page) => page.ledger.rows);
  const firstPage = pages[0];

  return {
    status: query.isPending ? "loading" : query.isError ? "error" : "ready",
    message: query.isError ? toMessage(query.error) : null,
    balance: firstPage !== undefined ? firstPage.balance : null,
    rows,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    retry: () => {
      void query.refetch();
    },
    loadMore: () => {
      void query.fetchNextPage();
    },
  };
}

const summaryQueryKey = (workspaceId: string | null) =>
  ["billing", "credits", "summary", workspaceId] as const;

/** GET /v1/credits/summary — 30-day spend, open holds, trial flag (§22). */
export function useCreditsSummary() {
  const getClient = useBillingClient();
  const { activeWorkspaceId } = useSession();
  return useQuery({
    queryKey: summaryQueryKey(activeWorkspaceId),
    queryFn: () => getClient().get("/credits/summary", { schema: creditsSummarySchema }),
  });
}

const PLANS_QUERY_KEY = ["billing", "plans"] as const;

/** GET /v1/billing/plans — public §14.1 catalog (no workspace scoping). */
export function useBillingPlans() {
  const getClient = useBillingClient();
  return useQuery({
    queryKey: PLANS_QUERY_KEY,
    queryFn: () => getClient().get("/billing/plans", { schema: plansResponseSchema }),
  });
}

const CURRENT_PLAN_QUERY_KEY = ["billing", "me", "plan"] as const;

export interface CurrentPlanSummary {
  readonly code: string | null;
  readonly name: string | null;
  readonly monthlyCredits: number | null;
  readonly seats: number | null;
  readonly renewal: Date | null;
  readonly status: string | null;
}

export interface CurrentPlanController {
  readonly status: "loading" | "ready" | "error";
  readonly message: string | null;
  readonly plan: CurrentPlanSummary | null;
  readonly retry: () => void;
}

function firstDate(...candidates: readonly (Date | null | undefined)[]): Date | null {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) {
      return candidate;
    }
  }
  return null;
}

function normalizePlanSummary(
  raw: MePlanSummary,
  catalog: readonly PlanCard[],
): CurrentPlanSummary {
  const code = raw.code ?? raw.plan_code ?? null;
  const card = code === null ? undefined : catalog.find((plan) => plan.code === code);
  return {
    code,
    name: raw.name ?? (code !== null ? planDisplayName(code) : null),
    monthlyCredits: raw.monthly_credits ?? raw.credits ?? card?.monthly_credits ?? null,
    seats: raw.seats ?? raw.seat_limit ?? card?.seats ?? null,
    renewal: firstDate(raw.renewal_at, raw.renews_at, raw.current_period_end),
    status: raw.status ?? null,
  };
}

/**
 * Current plan via GET /v1/me `plan` (§13.1 contract-only today — /v1/me is
 * a not-implemented route until the auth wave lands it; the typed 501
 * renders as an error state with retry, like the rest of the shell).
 * Numbers absent from the loose plan object fall back to the §14.1 catalog.
 */
export function useCurrentPlan(): CurrentPlanController {
  const getClient = useBillingClient();
  const plansQuery = useBillingPlans();

  const meQuery = useQuery({
    queryKey: CURRENT_PLAN_QUERY_KEY,
    queryFn: () => getClient().get("/me", { schema: mePlanResponseSchema }),
  });

  const catalog = plansQuery.data?.plans ?? [];
  const rawPlan = meQuery.data?.plan;
  const plan =
    rawPlan === undefined || rawPlan === null ? null : normalizePlanSummary(rawPlan, catalog);

  return {
    status: meQuery.isPending ? "loading" : meQuery.isError ? "error" : "ready",
    message: meQuery.isError ? toMessage(meQuery.error) : null,
    plan,
    retry: () => {
      void meQuery.refetch();
    },
  };
}

/**
 * §15.2 RBAC (ADR-0003): billing mutations are admin/owner-only. The
 * gateway enforces this on every route — the UI only decides whether to
 * render the CTAs (UI hiding is not enforcement).
 */
export function useCanManageBilling(): boolean {
  const { activeWorkspace } = useSession();
  const role = activeWorkspace?.role;
  return role === "admin" || role === "owner";
}

// ---------------------------------------------------------------------------
// Mutations — Stripe-hosted redirects (§14.3)
// ---------------------------------------------------------------------------

export type BillingActionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint: string | null;
    };

export type BillingActionError = Extract<BillingActionResult, { ok: false }>;

function noWorkspaceResult(): BillingActionError {
  return {
    ok: false,
    code: "no_active_workspace",
    message: "Pick a workspace first — billing is per workspace.",
    hint: null,
  };
}

export interface CheckoutController {
  readonly pending: boolean;
  readonly checkout: (planCode: BillingPlanCode) => Promise<BillingActionResult>;
}

/**
 * POST /v1/billing/checkout { planCode, workspaceId } (§14.3). Success is a
 * full-page redirect to the Stripe-hosted Checkout session — the webhook
 * (never the return trip) applies subscriptions and pack credits. Upgrades,
 * downgrades and pack purchases all start here; card/plan changes on an
 * existing subscription go through the portal instead.
 */
export function useCheckout(): CheckoutController {
  const getClient = useBillingClient();
  const { activeWorkspaceId } = useSession();
  const [pending, setPending] = useState(false);

  const checkout = useCallback(
    async (planCode: BillingPlanCode): Promise<BillingActionResult> => {
      if (activeWorkspaceId === null) {
        return noWorkspaceResult();
      }
      setPending(true);
      try {
        const session = await getClient().post("/billing/checkout", {
          body: { planCode, workspaceId: activeWorkspaceId },
          schema: checkoutResponseSchema,
        });
        window.location.assign(session.url);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          code: isApiError(error) ? error.code : "unexpected_error",
          message: toMessage(error),
          hint: toHint(error),
        };
      } finally {
        setPending(false);
      }
    },
    [activeWorkspaceId, getClient],
  );

  return { pending, checkout };
}

export interface PortalController {
  readonly pending: boolean;
  readonly openPortal: () => Promise<BillingActionResult>;
}

/**
 * POST /v1/billing/portal { workspaceId } (§14.3) — the Stripe customer
 * portal for card and plan changes. A 404 `no_subscription` ("start a
 * checkout first") arrives as a typed envelope and renders verbatim.
 */
export function usePortal(): PortalController {
  const getClient = useBillingClient();
  const { activeWorkspaceId } = useSession();
  const [pending, setPending] = useState(false);

  const openPortal = useCallback((): Promise<BillingActionResult> => {
    if (activeWorkspaceId === null) {
      return Promise.resolve(noWorkspaceResult());
    }
    setPending(true);
    return (async () => {
      try {
        const portal = await getClient().post("/billing/portal", {
          body: { workspaceId: activeWorkspaceId },
          schema: portalResponseSchema,
        });
        window.location.assign(portal.url);
        return { ok: true } as const;
      } catch (error) {
        const failure: BillingActionError = {
          ok: false,
          code: isApiError(error) ? error.code : "unexpected_error",
          message: toMessage(error),
          hint: toHint(error),
        };
        return failure;
      } finally {
        setPending(false);
      }
    })();
  }, [activeWorkspaceId, getClient]);

  return { pending, openPortal };
}
