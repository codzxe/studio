// @studio/gateway — dependency container + Hono bindings.
//
// buildApp({ env, deps… }) is dependency-injected so tests boot the full
// Hono app WITHOUT postgres: they pass fake repos, a fake auth seam, an
// in-memory storage driver and the MockRunner. Production wires the real
// components in src/index.ts.

import type { StudioEnv } from "@studio/config";
import type { Repos, Role } from "@studio/db";
import type { Context } from "hono";
import type { AuthContext, GatewayAuth } from "./auth.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { Logger } from "./logger.js";
import type { RateLimiter } from "./rate-limit.js";
import type { AgentRunner, RunLog, RunRegistry } from "./runner.js";
import type { LocalFSDriver, StorageDriver } from "./storage.js";

/** Connectivity probe for /health (index.ts passes a real SELECT 1). */
export type DbHealth = () => Promise<boolean>;

/** Body-idempotencyKey → run log for chat replays (§7.4 Last-Event-ID). */
export interface ChatReplayEntry {
  readonly runId: string;
  readonly log: RunLog;
}

export interface ChatReplayStore {
  store(key: string, entry: ChatReplayEntry): void;
  lookup(key: string): ChatReplayEntry | null;
  reset(): void;
}

export function createInMemoryChatReplayStore(): ChatReplayStore {
  const map = new Map<string, ChatReplayEntry>();
  return {
    store: (key, entry) => {
      map.set(key, entry);
    },
    lookup: (key) => map.get(key) ?? null,
    reset: () => {
      map.clear();
    },
  };
}

/** Stripe webhook event — minimal structural view of stripe.Event. */
export interface StripeEventLike {
  readonly id: string;
  readonly type: string;
  readonly data: {
    readonly object: {
      readonly id?: string;
      readonly customer?: string | null;
      readonly subscription?: string | null;
      readonly metadata?: Record<string, string> | null;
      readonly status?: string | null;
    };
  };
}

/**
 * Typed failure arm for the extended Stripe seam members (M6-B). Raw SDK
 * errors never cross the seam (law #1): `reason` is a fixed human-safe
 * string — no provider messages, keys, ids or stack fragments.
 */
export type StripeSeamErrorCode =
  | "not_configured"
  | "not_found"
  | "invalid_request"
  | "upstream_error";

/** Result envelope for the extended seam members (same spirit as verifyWebhook). */
export type StripeSeamResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: StripeSeamErrorCode; readonly reason: string };

/**
 * Normalized subscription lifecycle view (BUILD_PLAN §M6 task 2; D-4: trial
 * is a subscription state on the Starter row). Times are unix seconds.
 */
export interface SubscriptionSnapshot {
  readonly status: "trialing" | "active" | "past_due" | "canceled" | "incomplete";
  /** End of the current billing period (unix seconds; on the first item in API 2026-09-30). */
  readonly currentPeriodEnd: number;
  /** Trial end while trialing, else omitted. */
  readonly trialEnd?: number;
  readonly cancelAtPeriodEnd: boolean;
  /** Stripe subscription id (carry in portal/route metadata when needed). */
  readonly subscriptionId: string;
  /** Price id of the first item (null when the subscription has no items). */
  readonly priceId: string | null;
}

/** Test-clock handle (Stripe test mode only; times are unix seconds). */
export interface TestClockView {
  readonly id: string;
  readonly frozenTime: number;
  readonly status: string;
}

/** Structural stripe.TestClock subset (SDK wire names). */
export interface StripeSdkTestClockLike {
  readonly id: string;
  readonly frozen_time: number;
  readonly status: string;
}

/**
 * Structural stripe.Subscription subset the seam reads. Field names mirror
 * the SDK wire (snake_case); expandable unions are kept wide so the real SDK
 * satisfies this structurally.
 */
export interface StripeSdkSubscriptionLike {
  readonly id: string;
  readonly status: string;
  readonly trial_end: number | null;
  readonly cancel_at_period_end: boolean;
  readonly customer: string | { readonly id: string } | null;
  readonly items: {
    readonly data: ReadonlyArray<{
      readonly id: string;
      readonly price: string | { readonly id: string } | null;
      /** Lives on the subscription ITEM since API 2026-09-30. */
      readonly current_period_end: number;
    }>;
  };
}

/**
 * Structural subset of the Stripe SDK the seam drives. The real SDK satisfies
 * this shape structurally (createStripeSeam's assignment proves it at
 * typecheck); the in-process test harness (tests/helpers/fake-stripe.ts)
 * implements the same shape so tests never import Stripe or touch network.
 */
export interface StripeSdkLike {
  readonly checkout: {
    readonly sessions: {
      create(params: {
        mode: "payment" | "subscription";
        line_items: Array<{ price: string; quantity?: number }>;
        customer?: string;
        customer_email?: string;
        success_url: string;
        cancel_url: string;
        metadata?: Record<string, string>;
        subscription_data?: { metadata?: Record<string, string> };
        payment_intent_data?: { metadata?: Record<string, string> };
      }): Promise<{ id: string; url: string | null }>;
    };
  };
  readonly billingPortal: {
    readonly sessions: {
      create(params: {
        customer: string;
        return_url?: string;
      }): Promise<{ id: string; url: string }>;
    };
  };
  readonly customers: {
    create(params: {
      email?: string;
      metadata?: Record<string, string>;
      test_clock?: string;
    }): Promise<{ id: string }>;
  };
  readonly subscriptions: {
    list(params: {
      customer: string;
      limit?: number;
    }): Promise<{ data: readonly StripeSdkSubscriptionLike[] }>;
    update(
      id: string,
      params: {
        items?: Array<{ id: string; price: string }>;
        cancel_at_period_end?: boolean;
      },
    ): Promise<StripeSdkSubscriptionLike>;
  };
  readonly testHelpers: {
    readonly testClocks: {
      create(params: {
        frozen_time: number;
        customer?: string;
        name?: string;
      }): Promise<StripeSdkTestClockLike>;
      advance(id: string, params: { frozen_time: number }): Promise<StripeSdkTestClockLike>;
    };
  };
  readonly webhooks: {
    constructEvent(payload: Buffer, header: string, secret: string): unknown;
  };
}

/**
 * Minimal structural Stripe seam (real SDK in production; null when
 * unconfigured). M6-B extension: the first five members keep their original
 * signatures (billing routes depend on them); the added members return the
 * typed StripeSeamResult envelope instead of throwing.
 */
export interface StripeSeam {
  readonly raw: unknown;
  checkout(params: {
    mode: "subscription" | "payment";
    priceId: string;
    quantity?: number;
    customerEmail?: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    customerId?: string;
  }): Promise<{ id: string; url: string }>;
  portal(params: { customerId: string; returnUrl: string }): Promise<{ id: string; url: string }>;
  verifyWebhook(
    payload: Buffer,
    signature: string | null,
  ): { ok: true; event: StripeEventLike } | { ok: false; reason: string };
  createCustomer(params: { email: string; metadata: Record<string, string> }): Promise<{
    id: string;
  }>;
  /** Idempotency bookkeeping for webhook event ids (true when already handled). */
  seenEvent(id: string): boolean;
  // ── M6-B extension (additive; typed results, never raw SDK errors) ────────
  /**
   * One-time-payment Checkout for a credit pack. `packId` is the Stripe
   * PRICE id for the pack (the caller resolves env.stripe.priceIds — the seam
   * never reads the plan map).
   */
  topUpCheckout(params: {
    packId: string;
    quantity: number;
    customerId?: string;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }): Promise<StripeSeamResult<{ id: string; url: string }>>;
  /**
   * Latest subscription for a customer (Stripe lists newest first).
   * not_found when the customer has no subscription.
   */
  subscription(customerId: string): Promise<StripeSeamResult<SubscriptionSnapshot>>;
  /**
   * Update the customer's latest subscription: swap the first item's price to
   * `planPriceKey` (a Stripe PRICE id, caller-resolved) and/or set
   * cancel-at-period-end. Omitted `cancelAtPeriodEnd` leaves it unchanged.
   */
  updateSubscription(
    customerId: string,
    params: { planPriceKey: string; cancelAtPeriodEnd?: boolean },
  ): Promise<StripeSeamResult<SubscriptionSnapshot>>;
  /**
   * Create a Stripe test clock (test-mode key only; otherwise typed
   * not_configured — no SDK call is made).
   */
  createTestClock(params: {
    frozenTime: number;
    name?: string;
    customerId?: string;
  }): Promise<StripeSeamResult<TestClockView>>;
  /**
   * Decorator: a seam view whose NEW customers ride the given test clock
   * (clocks then propagate to their subscriptions). Shares the base seam's
   * seen-event set and raw SDK handle.
   */
  withTestClock(clockId: string): StripeSeamResult<StripeSeam>;
  /** Records an event id as handled without claiming it (complement of seenEvent). */
  markEventSeen(id: string): void;
}

export interface GatewayDeps {
  readonly env: StudioEnv;
  readonly auth: GatewayAuth;
  readonly repos: Repos;
  readonly storage: StorageDriver;
  readonly local: LocalFSDriver | null;
  readonly runner: AgentRunner;
  readonly runs: RunRegistry;
  readonly limiter: RateLimiter;
  readonly idempotency: IdempotencyStore;
  readonly chatReplay: ChatReplayStore;
  readonly logger: Logger;
  readonly stripe: StripeSeam | null;
  readonly version: string;
  readonly dbHealth: DbHealth;
}

export interface AuthedUser {
  readonly user: AuthContext["user"];
  readonly session: AuthContext["session"];
}

export interface WorkspaceContext {
  readonly id: string;
  readonly slug: string;
  /** Caller's role in this workspace (owner|admin|editor|viewer). */
  readonly role: Role;
  /** Current members (from the org plugin's full view). */
  readonly members: readonly {
    userId: string;
    role: string;
    userName: string | null;
    userEmail: string | null;
  }[];
  /** Organization summary (name/slug/metadata). */
  readonly organization: import("./auth.js").WorkspaceSummary;
}

/** Hono bindings: what middleware puts on the context. */
export interface AppBindings {
  readonly Variables: {
    requestId: string;
    deps: GatewayDeps;
    /** Set by requireAuth. */
    auth: AuthedUser;
    /** Set by requireWorkspace. */
    workspace: WorkspaceContext;
  };
}

export type AppContext = Context<AppBindings>;
export type HandlerEnv = { Bindings: AppBindings["Variables"] };
