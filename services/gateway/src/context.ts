// @studio/gateway — dependency container + Hono bindings.
//
// buildApp({ env, deps… }) is dependency-injected so tests boot the full
// Hono app WITHOUT postgres: they pass fake repos, a fake auth seam, an
// in-memory storage driver and the MockRunner. Production wires the real
// components in src/index.ts.

import type { Context } from "hono";
import type { StudioEnv } from "@studio/config";
import type { Repos, Role } from "@studio/db";
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

/** Minimal structural Stripe seam (real SDK in production; null when unconfigured). */
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
  createCustomer(params: { email: string; metadata: Record<string, string> }): Promise<{ id: string }>;
  /** Idempotency bookkeeping for webhook event ids (true when already handled). */
  seenEvent(id: string): boolean;
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
  readonly members: readonly { userId: string; role: string; userName: string | null; userEmail: string | null }[];
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
