// Shared Hono context types + the assembled dependency graph for the gateway.
//
// Owner: W4-R (the wiring wave). Every sibling owns its own route/service/middleware
// seam; this file is the ONE place they compose, so buildApp (src/app.ts) can wire
// the whole surface without touching any sibling file (docs/AGENTS.md ownership).
//
// Import direction: siblings import `AppEnv` from here; this file imports sibling
// TYPES only (`import type` — erased at runtime, so no module cycles on the wire).

import type { PlanId, Result } from "@studio/config";
import type { Db } from "@studio/db";
import type { LedgerStore } from "@studio/billing";
import type { RunEventBus } from "@studio/agent";
import type { Storage } from "@studio/storage";
import type { Logger } from "pino";
import type { AuthProvider, SessionContext } from "./middleware/auth-context.js";
import type { RequestContext } from "./middleware/request-context.js";
import type { RunEventBusLike } from "./routes/runs-events.js";
import type { Probe } from "./routes/health.js";
import type { EnqueueLike } from "./services/runs.js";
import type { KVLike, RateLimiter } from "./services/limiter.js";
import type { TemplateCatalogLike } from "./services/documents.js";
import type { AssetsStore, UploadLimitsConfig } from "./services/assets.js";
import type { AuditLike } from "./services/workspaces.js";

// ---------------------------------------------------------------------------
// AppEnv — Hono context variables shared by middleware and routes
// ---------------------------------------------------------------------------

/**
 * Hono app env (context variables) for the gateway.
 *
 * `requestId`/`logger` are set by the W1-H middleware on every request.
 * `auth`/`reqCtx` are set ONLY on authenticated/correlated paths (W4-B
 * middleware), so they are declared `| undefined` — a route reading them
 * pre-auth must handle absence (routes/upload.js does; the authz guard and
 * rate-limit middleware read them defensively the same way).
 */
export interface AppEnv {
  Variables: {
    /** §22 request/run correlation — echoed back as `X-Request-Id`. */
    requestId: string;
    /** Request-scoped pino child logger (requestId already bound). */
    logger: Logger;
    /**
     * Authenticated session (W4-B `requireAuth`, §15.2) — set per route group,
     * never globally: unauthenticated surfaces (health, 401 gates) see
     * `undefined`. Shape is the middleware's WIDE mirror (`Permission = string`)
     * so both the W4-A session builder (authz-narrow permissions) and the
     * middleware itself assign into it without casts.
     */
    auth: SessionContext | undefined;
    /** §22 correlation + prompt-log redaction context (request-context.ts). */
    reqCtx: RequestContext | undefined;
  };
}

// 401-CODE RECONCILIATION (W4-R decision, flagged for the contract wave):
// middleware/auth-context.ts answers 401 with the stable code `unauthenticated`;
// @studio/config's add-only §13.3 catalog spells the 401 code `unauthorized`, and
// the sibling routers surface the catalog spelling (uploads.ts, the runs AuthLike
// docs, and the documents PrincipalResolver adapters in src/app.ts). Both spell
// mean 401 on the wire. This assembly keeps every owner's shipped code VERBATIM —
// never rename a stable code at the seam. Resolution belongs to the catalog owner:
// add `unauthenticated` to the add-only catalog, or alias it there.

// ---------------------------------------------------------------------------
// Stripe seam (placeholder surface for the billing-routes wave, §14.3)
// ---------------------------------------------------------------------------

/**
 * The minimal Stripe surface the future billing/webhook routes need (§14.3).
 * `NoopStripe` (src/app.ts) is the fail-loud default until that wave lands;
 * bootstrap injects a real client adapter when STRIPE_SECRET_KEY is configured.
 * The billing wave OWNS the authoritative shape — extend via GatewayDeps.stripe.
 */
export interface StripeLike {
  /** False for the no-op default — routes answer a typed 503, never pretend. */
  readonly configured: boolean;
  /** Checkout session for a plan change / credit pack (idempotency-keyed, §14.2). */
  createCheckoutSession(input: {
    readonly organizationId: string;
    readonly planId: PlanId;
    readonly idempotencyKey: string;
  }): Promise<Result<{ readonly url: string }>>;
  /** Customer-portal session URL (§14.3). */
  createPortalSession(input: {
    readonly organizationId: string;
    readonly idempotencyKey: string;
  }): Promise<Result<{ readonly url: string }>>;
  /** Verify a webhook signature + parse the event (§14.3 idempotent fan-in). */
  constructWebhookEvent(input: {
    readonly payload: string;
    readonly signature: string;
  }): Promise<Result<unknown>>;
}

// ---------------------------------------------------------------------------
// Engine-session seam (engine-pool view for deep health / run detail, §3.1)
// ---------------------------------------------------------------------------

/** One engine session as the gateway needs to see it (apps/engine-pool registry). */
export interface EngineSessionRef {
  readonly id: string;
  /** §15.1 tenant root — the workspace the session renders for. */
  readonly organizationId: string;
  /** Pool lifecycle state (starting|ready|busy|draining|crashed, §3.2). */
  readonly status: string;
  /** Epoch ms of the last activity (watchdog idle sweep input). */
  readonly lastActivityAt: number;
}

/**
 * Read-only engine-session view. The default is a not-wired resolver
 * (src/app.ts) until the engine-pool service exposes an HTTP/RPC surface
 * (ENGINE_POOL_URL probe, §13.1); the bootstrap overrides it.
 */
export interface SessionResolver {
  listActive(): Promise<readonly EngineSessionRef[]>;
}

// ---------------------------------------------------------------------------
// GatewayDeps — every seam of the DI graph, with its default (createDefaultDeps)
// ---------------------------------------------------------------------------

/**
 * The assembled dependency graph (composition root: `createDefaultDeps` in
 * src/app.ts builds the production defaults; every field is overridable so
 * tests inject fakes per seam, docs/AGENTS.md "everything injectable").
 *
 * Defaults (see createDefaultDeps for the authoritative implementation):
 *   auth           → createDefaultAuthProvider(createAuthResolvers()) — W4-A
 *                    Better Auth session + hashed API-key resolvers.
 *   db             → createDb(env.DATABASE_URL) — lazy postgres-js pool (§4).
 *   kv             → InMemoryKV (single-process). PRODUCTION OVERRIDE REQUIRED
 *                    for multi-replica deployments: wire the ioredis/Valkey
 *                    adapter sketch documented on services/limiter.ts KVLike
 *                    (ADR-0004: Valkey, not Redis — §16.5) over env.VALKEY_URL.
 *   storage        → createStorageFromEnv(env) — local|s3 driver (§3.1); fails
 *                    fast on missing config (no silent default).
 *   limiter        → new RateLimiter({ kv }) — token bucket over the KV seam.
 *   bus            → new RunEventBus({ store: new DrizzleEventStore(db) }) —
 *                    durable run_events sink (§13.2), real @studio/agent bus.
 *   enqueue        → UnavailableEnqueue — BullMQ producer lives in the worker
 *                    (apps/worker/src/queues.ts); bootstrap injects the
 *                    EnqueueLike adapter over the shared Valkey.
 *   ledger         → UnavailableLedgerStore — the money-path repo layer (§14.2)
 *                    has no production implementation yet; fail-closed typed
 *                    503s until the billing repo wave ships it. NEVER a no-op.
 *   audit          → createDrizzleAudit(db) — append-only audit_log rows (§22).
 *   catalog        → EmptyTemplateCatalog — services/catalog.ts does not exist
 *                    yet; template refs resolve "not found" until it lands.
 *   stripe         → NoopStripe (§14.3) — typed not-configured failures.
 *   engineSessions → NotWiredSessionResolver — [] until the engine-pool probe
 *                    surface (ENGINE_POOL_URL) ships.
 *   resolvePlan     → drizzle lookup on subscriptions ⋈ plans, falling back to
 *                    "starter" (§14.1 ladder) — fail-closed to the LOWEST plan
 *                    caps when the row is missing.
 *   assets         → NO default: no production AssetsStore exists yet (W4-I
 *                    shipped the route + service seam only). When undefined the
 *                    uploads/assets routes mount and answer a typed 503 — the
 *                    repo wave injects the drizzle store.
 *   probes         → db `select 1`, KV seam, storage reachability, engine
 *                    sessions, model-provider note (§13.1 deep health).
 */
export interface GatewayDeps {
  /** Session/API-key resolution (W4-B AuthProvider; W4-A default resolvers). */
  readonly auth: AuthProvider;
  /** Drizzle handle over the studio Postgres (@studio/db, lazy pool). */
  readonly db: Db;
  /** Rate-limit/cache KV (InMemoryKV default; Valkey adapter in production). */
  readonly kv: KVLike;
  /** Object storage (§3.1) — @studio/storage driver from createStorageFromEnv. */
  readonly storage: Storage;
  /** Token-bucket/fixed-window limiter over `kv` (services/limiter.ts). */
  readonly limiter: RateLimiter;
  /**
   * Durable run-event bus (§13.2). Typed as @studio/agent's RunEventBus — it
   * satisfies W4-H's structural mirror (routes/runs-events.ts RunEventBusLike)
   * shape-for-shape, and the runs cancel-event adapter needs `publish`.
   */
  readonly bus: RunEventBus;
  /** BullMQ producer seam (worker queues; typed-unavailable default). */
  readonly enqueue: EnqueueLike;
  /** Append-only credit ledger (§14.2; fail-closed default until the repo wave). */
  readonly ledger: LedgerStore;
  /** §22 audit append (createDrizzleAudit default). */
  readonly audit: AuditLike;
  /** Template catalog (§7) — EmptyTemplateCatalog default until services/catalog. */
  readonly catalog: TemplateCatalogLike;
  /** Stripe client seam (§14.3) — NoopStripe default. */
  readonly stripe: StripeLike;
  /** Engine-session view for deep health (§13.1) — not-wired default. */
  readonly engineSessions: SessionResolver;
  /** Plan code for a workspace (§14.1) — drives canvas/concurrency caps. */
  resolvePlan(organizationId: string): Promise<PlanId>;
  /**
   * Asset persistence (§12.1 composite-scoped) — NO default; the uploads
   * router answers its typed 503 until the drizzle AssetsStore ships.
   */
  readonly assets?: AssetsStore;
  /** Upload caps (§20.2) — defaults to services/assets.ts DEFAULT_UPLOAD_LIMITS. */
  readonly uploadLimits?: UploadLimitsConfig;
  /** SSE heartbeat override (§13.2 keepalive); default SSE_HEARTBEAT_MS (15 s). */
  readonly sseHeartbeatMs?: number;
  /** Injectable clock — deterministic tests. Default: real time. */
  readonly clock?: () => Date;
  /** Injectable id factory (uuid in production, counters in tests). */
  readonly newId?: () => string;
  /** Dependency probes for GET /v1/health/deep (§13.1). */
  readonly probes: readonly Probe[];
}

/**
 * Convenience alias: the SSE bus seam the runs-events router consumes. The real
 * RunEventBus (GatewayDeps.bus) satisfies it structurally — verified against
 * packages/agent/src/eventbus.ts (subscribe/EventDelivery/CorrelatedRunEvent).
 */
export type { RunEventBusLike };
