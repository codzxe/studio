// buildApp — the gateway composition root (W4-R).
//
// `src/index.ts` is the only file that touches the outside world; everything
// here is injectable and testable via `app.request()`. This file OWNS:
//   - the middleware order (§13.3 envelopes, §22 correlation, §1.5 rate limits),
//   - mounting every landed /v1 route group through its OWN documented wire
//     pattern — defensive import shape: each sibling shipped either a deps
//     factory or a const router (+middleware/setter); buildApp calls whichever
//     export exists so a renamed factory never silently unmounts a group,
//   - the adapters that bridge the ONE W4-B AuthProvider onto each sibling's
//     auth seam (workspaces UserResolver, documents PrincipalResolver, runs
//     AuthLike, SSE RunEventsAuthLike, uploads context variable),
//   - `createDefaultDeps(env)` — the production DI graph; every seam is
//     overridable for tests (docs/AGENTS.md "everything injectable").
//
// Sibling files are READ-ONLY for this module: routes/, services/, middleware/,
// auth/, authz/ export their own seams; the wiring wave owns only src/app.ts +
// src/types.ts (task W4-R; final composition pass W10-R).
//
// W10-R (final integration) note: this file is the MOUNT AUTHORITY for every
// /v1 group (the W10-G final audit's checklist) — buildApp now wires ALL
// landed route modules through their documented one-call mount helpers:
//   - seam-built deps for credits/billing/audit (drizzle adapters below),
//   - pre-baked deps for catalog/commands/exports (their service seams are
//     env/worker-driven — the §7 catalog boots from a manifests dir, the
//     command executor needs the engine bus, the export pipeline needs the
//     BullMQ producer + signer — so tests/bootstrap inject the built deps),
//   - GET /v1/openapi.json serves the AUDITED spec (mountOpenApi, D11),
//   - Better Auth handlers mount at /api/auth/* AND the §13.1 /v1/auth/*
//     alias (D1: same handler, URL-rewritten by the proxy below),
//   - absent deps ⇒ the group stays behind routes/index.ts's typed 501
//     catch-all (the W8-K degrade contract — never a silent 404).

import { and, count, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { RunEventBus } from "@studio/agent";
import { err, ok, type GatewayEnv, type PlanId, type Result } from "@studio/config";
import {
  agentRuns,
  auditLog,
  createDb,
  creditReservations,
  creditsLedger,
  plans as plansTable,
  subscriptions,
  type Db,
} from "@studio/db";
import type { LedgerStore } from "@studio/billing";
import { createStorageFromEnv, type Storage, type StorageEnvInput } from "@studio/storage";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { Logger } from "pino";
import { getAuthServer } from "./auth/server.js";
import { createAuthResolvers } from "./auth/api-keys.js";
import {
  createDefaultAuthProvider,
  extractBearerToken,
  requireAuth,
  type AuthProvider,
  type SessionContext,
} from "./middleware/auth-context.js";
import { requestContext, type RequestContext } from "./middleware/request-context.js";
import { uploadCap } from "./middleware/caps.js";
import { rateLimit, type RateLimitOptions } from "./middleware/rate-limit.js";
import { AppError, errorMapper, notFoundHandler } from "./middleware/error-mapper.js";
import { requestLogger } from "./middleware/logger.js";
import { requestId } from "./middleware/request-id.js";
import {
  createAssetsService,
  DEFAULT_UPLOAD_LIMITS,
  type AssetsService,
} from "./services/assets.js";
import { drizzleDocumentsStore, type TemplateManifestLike } from "./services/documents.js";
import { DrizzleEventStore } from "./services/event-store.js";
import { InMemoryKV, RateLimiter, type KVLike } from "./services/limiter.js";
import {
  billingFromLedger,
  drizzleRunsStore,
  type AuthLike,
  type EnqueueLike,
  type EventBusLike,
} from "./services/runs.js";
import {
  createDrizzleAudit,
  createLedgerBilling,
  createWorkspaceDb,
} from "./services/workspaces.js";
import { registerRoutes } from "./routes/index.js";
import type { Probe } from "./routes/health.js";
import type {
  AuditActionCountsLike,
  AuditAuthLike,
  AuditRoutesDeps,
} from "./routes/audit.js";
import type { BillingRoutesDeps } from "./routes/billing.js";
import type {
  BillingSummaryLike,
  CreditsAuthLike,
  CreditsDeps,
  LedgerLike,
  LedgerPage,
  LedgerPageCursor,
  WorkspaceBillingSummary,
} from "./routes/credits.js";
import type { CommandRoutesDeps } from "./routes/commands.js";
import type { ExportRoutesDeps } from "./routes/exports.js";
import type { CatalogDeps } from "./services/catalog.js";
import { AuditService, DrizzleAuditStore } from "./services/audit.js";
import { drizzleUsageQueries } from "./services/usage.js";
import {
  NoopStripe,
  createDrizzleBillingDb,
  createStripeBillingService,
  drizzleWithTransaction,
  ledgerFromStore,
  priceMapFromEnv,
} from "./services/stripe.js";
import { createGatewayMetrics, httpMetricsMiddleware, metricsRoutes } from "./routes/metrics.js";
import { mountOpenApi } from "./openapi.js";
import { createWorkspaceAuth } from "./routes/workspaces.js";
import type { DocumentRoutesDeps, PrincipalResolver } from "./routes/documents.js";
import type { RunsDeps } from "./routes/runs.js";
import type { RunEventsAuthLike, RunEventsDeps, RunLookupLike } from "./routes/runs-events.js";
import type { UploadsDeps } from "./routes/uploads.js";
import type { WorkspaceAuth, WorkspaceRoutesDeps } from "./routes/workspaces.js";
import type { TransportEnv } from "./env.js";
import type {
  AppEnv,
  EngineSessionRef,
  GatewayDeps,
  SessionResolver,
} from "./types.js";

// Route modules as namespaces — the defensive-import seam: every mount below
// resolves its router through these at runtime (factory OR const), so mounting
// survives either wire pattern the sibling waves shipped.
import * as workspacesRoutesModule from "./routes/workspaces.js";
import * as documentsRoutesModule from "./routes/documents.js";
import * as runsRoutesModule from "./routes/runs.js";
import * as runEventsRoutesModule from "./routes/runs-events.js";
import * as uploadsRoutesModule from "./routes/uploads.js";
import * as catalogRoutesModule from "./routes/catalog.js";
import * as commandsRoutesModule from "./routes/commands.js";
import * as exportsRoutesModule from "./routes/exports.js";

// ---------------------------------------------------------------------------
// Rate-limit presets (§1.5 rule 5, §15.2 "rate limits per IP/user/workspace")
// ---------------------------------------------------------------------------

/** The three standard policies buildApp mounts (numbers per the W4-R task). */
export const RATE_LIMIT_PRESETS = {
  /** Global: 100 events/min per client IP — the unauthenticated floor. */
  global: { scope: "api.v1.global", limit: 100, windowSec: 60, keyBy: "ip" },
  /** Authenticated: 600 events/min per workspace (org-keyed, §15.2). */
  authenticated: { scope: "api.v1.authenticated", limit: 600, windowSec: 60, keyBy: "org" },
  /** Uploads: 20/min per user inside a workspace (expensive bodies, §20.2). */
  uploads: { scope: "api.v1.uploads", limit: 20, windowSec: 60, keyBy: "org+ip" },
} as const satisfies Record<string, RateLimitOptions>;

// ---------------------------------------------------------------------------
// AppDeps — buildApp's input (W1-H base + the optional GatewayDeps seams)
// ---------------------------------------------------------------------------

/**
 * Everything buildApp accepts. The W1-H fields (env/logger/version/probes/
 * startedAt/mount) are REQUIRED and unchanged — every sibling test boots on
 * exactly them. Each GatewayDeps seam (src/types.ts) is optional here: a route
 * group mounts only when all of ITS seams are present, or when its pre-baked
 * group deps below are passed (tests fake the service layer per group).
 */
export interface AppDeps extends Partial<GatewayDeps> {
  /** Transport env (parsed once at bootstrap, §4 / ADR-0002). */
  readonly env: TransportEnv;
  /** Root pino logger; request-scoped children are derived per request (§22). */
  readonly logger: Logger;
  /** Service version string reported by /v1/health and /v1/openapi.json. */
  readonly version: string;
  /** Dependency probes for GET /v1/health/deep (§13.1) — required (W1-H). */
  readonly probes: readonly Probe[];
  /** Epoch ms uptime anchor — injected so tests are deterministic. */
  readonly startedAt: number;
  /**
   * Extra mounts, applied after middleware but BEFORE the /v1 group mounts and
   * the routes/index.ts registry — hook routes always win (W1-H contract,
   * kept byte-compatible for the sibling test suites).
   */
  readonly mount?: (app: Hono<AppEnv>) => void;

  // Pre-baked per-group deps (tests / partial wiring): mounted as-is, and
  // preferred over the adapter-built deps from the GatewayDeps seams.
  readonly workspacesDeps?: WorkspaceRoutesDeps;
  readonly documentsDeps?: DocumentRoutesDeps;
  readonly runsDeps?: RunsDeps;
  readonly runEventsDeps?: RunEventsDeps;
  readonly uploadsDeps?: UploadsDeps;
  // W8-K/W9-H fleet flags → W10-F/W10-R: the credits/billing/audit groups mount
  // through the routes/index.ts registry when these are present OR when their
  // seams resolve (buildCreditsDeps/buildBillingDeps/buildAuditDeps below — the
  // pre-baked deps win over the seam-built ones). /metrics needs no field:
  // app.ts (W10-E) builds its MetricsRouteDeps from env + the shared counters.
  readonly creditsDeps?: CreditsDeps;
  readonly billingDeps?: BillingRoutesDeps;
  readonly auditDeps?: AuditRoutesDeps;
  // W4-J/W4-K/W4-L groups (W10-R): PRE-BAKED ONLY — their service seams are
  // env/worker-driven, not GatewayDeps (the §7 TemplateCatalog boots from a
  // manifests dir, the command executor needs the engine session/command
  // seams, the export pipeline needs the BullMQ producer + URL signer + the
  // worker-owned preview cache). Tests inject fakes; the bootstrap composes
  // the real services per each route file's WIRING header. Absent deps leave
  // the group behind the typed 501 catch-all (same W8-K degrade contract).
  readonly catalogDeps?: CatalogDeps;
  readonly commandDeps?: CommandRoutesDeps;
  readonly exportDeps?: ExportRoutesDeps;
}

/** Env with the auth/reqCtx variables narrowed non-optional (mount-time only). */
type FullEnv = AppEnv & {
  Variables: {
    auth: SessionContext;
    reqCtx: RequestContext;
  };
};

/** The uploads router's injected context variable (single cast below). */
type UploadsMountEnv = {
  Variables: AppEnv["Variables"] & { uploadsDeps: UploadsDeps | undefined };
};

// ---------------------------------------------------------------------------
// Defensive import shape — resolve routers from whichever export exists
// ---------------------------------------------------------------------------

/** Runtime view of a route module: factories and/or const routers. */
type RouteModuleShape = Record<string, unknown>;

function shape(module: object): RouteModuleShape {
  return module as unknown as RouteModuleShape;
}

/** The `<name>(deps)` factory if the module exports one. */
function factoryOf(
  module: RouteModuleShape,
  name: string,
): ((deps: unknown) => Hono<AppEnv>) | undefined {
  const candidate = module[name];
  return typeof candidate === "function"
    ? (candidate as (deps: unknown) => Hono<AppEnv>)
    : undefined;
}

/** The exported const router, if the module ships one. */
function routerOf(module: RouteModuleShape, name: string): Hono<AppEnv> | undefined {
  const candidate = module[name];
  return candidate instanceof Hono ? (candidate as Hono<AppEnv>) : undefined;
}

/** A named export of any other callable shape (middleware/setter helpers). */
function helperOf(module: RouteModuleShape, name: string): unknown {
  const candidate = module[name];
  return typeof candidate === "function" ? candidate : undefined;
}

// ---------------------------------------------------------------------------
// Session resolution — ONE resolution per request, shared by every adapter
// ---------------------------------------------------------------------------

/**
 * Memoized per-request session resolution over the injected AuthProvider.
 * (Named `RequestSessionResolver` to stay distinct from the engine-session
 * SessionResolver seam in src/types.ts.)
 */
export interface RequestSessionResolver {
  resolve(request: Request): Promise<SessionContext | null>;
}

/**
 * Wraps a W4-B AuthProvider with a per-request WeakMap so the rate-limit
 * priming, each group's auth adapter and the uploads gate resolve the caller
 * at most once per request. Resolution order mirrors requireAuth: bearer API
 * key first, then cookie session; a provider resolving `undefined` is treated
 * as "no session" (fail closed, W4-B contract).
 */
export function makeSessionResolver(provider: AuthProvider): RequestSessionResolver {
  const memo = new WeakMap<Request, SessionContext | null>();
  const resolveOnce = async (request: Request): Promise<SessionContext | null> => {
    let session: SessionContext | null = null;
    if (extractBearerToken(request) !== null && provider.verifyApiKey !== undefined) {
      session = await provider.verifyApiKey(request);
    }
    if (!session) {
      session = await provider.getSession(request);
    }
    return session ?? null;
  };
  return {
    async resolve(request) {
      const cached = memo.get(request);
      if (cached !== undefined) {
        return cached;
      }
      const session = await resolveOnce(request);
      memo.set(request, session);
      return session;
    },
  };
}

/**
 * Session-priming middleware for org-keyed rate-limit buckets (§15.2): resolves
 * the caller and annotates `c.auth` WITHOUT rejecting — auth stays lazy per
 * route (each group owns its 401), and unauthenticated requests simply degrade
 * to IP buckets inside the limiter.
 */
function primeSession(resolver: RequestSessionResolver): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const session = await resolver.resolve(c.req.raw);
    if (session !== null) {
      c.set("auth", session);
    }
    await next();
  });
}

/** Injects the uploads service + limits context variable (routes/uploads.ts). */
function uploadsContext(deps: UploadsDeps): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    // Single local cast: the variable belongs to the uploads router's env
    // (fleet precedent: routes/runs.ts runsServices).
    (c as unknown as Context<UploadsMountEnv>).set("uploadsDeps", deps);
    await next();
  });
}

// ---------------------------------------------------------------------------
// Auth adapters — the ONE AuthProvider bridged onto every sibling seam
// ---------------------------------------------------------------------------

/** All four per-group auth adapters built from one provider (+ plan lookup). */
export interface SessionAuthAdapters {
  /** W4-E: requireAuth middleware + authed() wrapper (WeakMap store). */
  readonly workspaces: WorkspaceAuth;
  /** W4-F: PrincipalResolver — adds the §14.1 plan for canvas caps. */
  readonly documents: PrincipalResolver;
  /** W4-G: AuthLike — Result<RunCaller> with catalog 401 codes. */
  readonly runs: AuthLike;
  /** W4-H: SSE auth — caller or null. */
  readonly runEvents: RunEventsAuthLike;
}

/**
 * Bridge the single W4-B AuthProvider onto each sibling's auth seam. Tests use
 * this to wire fake providers through the REAL mount paths; buildApp calls the
 * individual adapters with its shared memoized resolver.
 */
export function sessionAuthAdapters(
  provider: AuthProvider,
  resolvePlan: (organizationId: string) => Promise<PlanId>,
): SessionAuthAdapters {
  const resolver = makeSessionResolver(provider);
  return {
    workspaces: workspacesAuth(resolver),
    documents: documentsPrincipal(resolver, resolvePlan),
    runs: runsAuth(resolver),
    runEvents: { authenticate: (request) => resolver.resolve(request) },
  };
}

/** W4-E seam: createWorkspaceAuth over the provider (userId-only context). */
function workspacesAuth(resolver: RequestSessionResolver): WorkspaceAuth {
  return createWorkspaceAuth(async (c) => {
    const session = await resolver.resolve(c.req.raw);
    return session === null ? null : { userId: session.userId };
  });
}

/** W4-F seam: PrincipalResolver — session + §14.1 plan, catalog 401 on miss. */
function documentsPrincipal(
  resolver: RequestSessionResolver,
  resolvePlan: (organizationId: string) => Promise<PlanId>,
): PrincipalResolver {
  return {
    async authenticate(request) {
      const session = await resolver.resolve(request);
      if (session === null) {
        return err("unauthorized", "Authentication is required.", { retryable: false });
      }
      return ok({
        organizationId: session.organizationId,
        userId: session.userId,
        role: session.role,
        plan: await resolvePlan(session.organizationId),
      });
    },
  };
}

/** W4-G seam: AuthLike — Result<RunCaller>, catalog `unauthorized` on miss. */
function runsAuth(resolver: RequestSessionResolver): AuthLike {
  return {
    async authenticate(request) {
      const session = await resolver.resolve(request);
      if (session === null) {
        return err("unauthorized", "Authentication is required.", { retryable: false });
      }
      return ok({ userId: session.userId, organizationId: session.organizationId });
    },
  };
}

// ---------------------------------------------------------------------------
// Bus / run-lookup / plan adapters (drizzle seams the groups need)
// ---------------------------------------------------------------------------

/**
 * Run existence + tenant root for the SSE gate (§15.1: lookup by run id alone;
 * the ROUTE compares the org, so foreign and missing runs stay the same 404).
 * A five-line drizzle adapter over @studio/db — the store layer is W4-G's.
 */
export function drizzleRunLookup(db: Db): RunLookupLike {
  return {
    async findRun(runId) {
      const rows = await db
        .select({ organizationId: agentRuns.organizationId })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : { organizationId: row.organizationId };
    },
  };
}

/**
 * W4-G EventBusLike over the real @studio/agent bus: `run.cancelled` publishes
 * flow through the same durable store the SSE stream backfills from. Bus
 * failure codes map onto the §13.3 catalog (organization_mismatch → forbidden,
 * persist/transport failures → storage_error).
 */
export function runCancelEvents(bus: RunEventBus): EventBusLike {
  return {
    async runCancelled(input) {
      const published = await bus.publish(
        input.runId,
        "run.cancelled",
        { reason: input.reason },
        { organizationId: input.organizationId },
      );
      if (!published.ok) {
        const code = published.code === "organization_mismatch" ? "forbidden" : "storage_error";
        return err(code, "The run cancellation event could not be published.", {
          hint: "The durable event store rejected the append; it is retried on the next sync.",
          retryable: published.retryable ?? true,
        });
      }
      return ok({ seq: published.event.seq });
    },
  };
}

/**
 * §14.1 plan lookup: subscriptions ⋈ plans by organization; falls back to
 * "starter" (the LOWEST caps) when the row is missing or the code is unknown —
 * a fail-closed default for every plan-gated surface (canvas MP, concurrency).
 */
export function drizzlePlanResolver(db: Db): (organizationId: string) => Promise<PlanId> {
  return async (organizationId) => {
    const rows = await db
      .select({ code: plansTable.code })
      .from(subscriptions)
      .innerJoin(plansTable, eq(subscriptions.planId, plansTable.id))
      .where(eq(subscriptions.organizationId, organizationId))
      .limit(1);
    const code: unknown = rows[0]?.code;
    return code === "pro" || code === "business" ? code : "starter";
  };
}

// ---------------------------------------------------------------------------
// Default implementations (each default is documented on GatewayDeps)
// ---------------------------------------------------------------------------

/** Money path stays CLOSED until the billing repo wave ships the drizzle store. */
function ledgerUnavailable(): never {
  throw new AppError(
    503,
    "service_unavailable",
    "The credit ledger is not wired in this deployment.",
    {
      hint: "Inject the drizzle credit-ledger repository via GatewayDeps.ledger " +
        "(billing repo wave, §14.2).",
      retryable: true,
    },
  );
}

/** Fail-closed LedgerStore default (§14.2): every method answers a typed 503. */
export class UnavailableLedgerStore implements LedgerStore {
  append(): Promise<void> {
    ledgerUnavailable();
  }
  balanceAfter(): Promise<number> {
    ledgerUnavailable();
  }
  findByIdempotency(): Promise<boolean> {
    ledgerUnavailable();
  }
}

/**
 * BullMQ producer seam default: the queue producer lives in the worker
 * (apps/worker/src/queues.ts). Until bootstrap injects it, run creates fail
 * LOUD with the envelope W4-G maps for queue outages (run marked failed,
 * reservation released) — never a silent drop.
 */
export class UnavailableEnqueue implements EnqueueLike {
  async enqueue(): Promise<Result<{ readonly jobId: string }>> {
    return err("engine_unavailable", "The run queue producer is not wired in this process.", {
      hint: "Bootstrap must inject the BullMQ EnqueueLike adapter over the shared " +
        "Valkey (apps/worker/src/queues.ts).",
      retryable: true,
    });
  }
}

/**
 * Template-catalog default: services/catalog.ts does not exist yet (§7 wave),
 * so every template ref resolves "not found" — document creation works without
 * templateId and the §5.5 ref validation fails closed.
 */
export class EmptyTemplateCatalog {
  async get(): Promise<TemplateManifestLike | undefined> {
    return undefined;
  }
}

/**
 * Stripe default — W10-R reconcile: RETIRED the W4-R placeholder class here and
 * adopted services/stripe.ts's own NoopStripe (the W4-N authoritative shape —
 * deterministic ids, no network, REAL HMAC webhook verification) as the
 * GatewayDeps.stripe default in createDefaultDeps. Production must inject
 * createStripeSdk (the wiring-check wave fails fast on NoopStripe there).
 */
/** Engine-session seam default: [] until the engine-pool probe surface ships. */
export class NotWiredSessionResolver implements SessionResolver {
  async listActive(): Promise<readonly EngineSessionRef[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// GET /v1/openapi.json — the AUDITED spec (D11, W10-R)
// ---------------------------------------------------------------------------
// The W4-R minimal runtime document (openApiDocument + the mounted-paths
// accumulator) was RETIRED per the W10-G final audit's D11 resolution: the
// endpoint now serves the audited OpenAPI 3.1 document from src/openapi.ts
// via mountOpenApi(app, { version }) — same bytes as OPENAPI_SPEC with the
// running service version stamped into info.version (test-enforced ⇔ the
// audit table in docs/api/openapi-contract.md).

// ---------------------------------------------------------------------------
// buildApp — the pure app factory
// ---------------------------------------------------------------------------

/**
 * Build the Hono app. Middleware order is load-bearing (§13.3, §22):
 *   1. errorMapper     — outermost: even request-id/logger failures get a typed
 *                        envelope (never a stack trace, §13.3).
 *   2. requestId       — adopt/generate + echo X-Request-Id (§22).
 *   3. requestLogger   — per-request pino child (requestId bound).
 *   4. requestContext  — §22 org/user ids re-bound onto that child + `reqCtx`.
 *                        MUST follow requestLogger (it children c.get("logger")).
 *   5. rate limits     — global 100/min per IP (health probes skipped); then,
 *                        per authenticated group, session-priming + the
 *                        600/min org-keyed preset, plus a tighter 20/min
 *                        org+ip preset on POST /v1/uploads (§1.5 rule 5, §15.2).
 *   6. auth            — LAZY per route group: each group keeps its own 401
 *                        (never a global auth wall). The uploads group mounts
 *                        W4-B `requireAuth` (401 code `unauthenticated` — see
 *                        the reconciliation note in src/types.ts).
 * Then the deps.mount hook (test routes win), the D11 audited-spec + D1 auth
 * mounts (W10-R), the /v1 group mounts (ALL landed groups — W4-R's five plus
 * catalog/commands/exports via their one-call helpers), the W1-H registry
 * (health + the seam-built credits/billing/audit mounts + typed 501 catch-all
 * LAST), the INTERNAL-ONLY /metrics exposition (W10-E, §22 — token-gated,
 * never under /v1), and the typed 404 for everything else. Bootstrap/shutdown
 * (src/index.ts, graceful drain) is unchanged by this wave.
 */
export function buildApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(errorMapper(deps.logger));
  app.use(requestId());
  app.use(requestLogger(deps.logger));
  // One documented cast: FullEnv is AppEnv with auth/reqCtx narrowed required;
  // Hono middleware is env-invariant at this boundary (fleet precedent: runs.ts).
  app.use(requestContext<FullEnv>() as unknown as MiddlewareHandler<AppEnv>);

  // §22 HTTP request counters (W10-E): one GatewayMetrics instance per app,
  // shared by this middleware (counts EVERY request with its final status —
  // SSE and rate-limited 429s included) and the /metrics exposition mounted
  // below (the W9-G wiring note in routes/metrics.ts).
  const httpMetrics = createGatewayMetrics();
  app.use(httpMetricsMiddleware(httpMetrics));

  if (deps.limiter !== undefined) {
    app.use(rateLimit({ limiter: deps.limiter }, RATE_LIMIT_PRESETS.global));
  }

  if (deps.mount !== undefined) {
    deps.mount(app);
  }

  // --- D11 (W10-G final audit): serve the AUDITED OpenAPI spec -------------
  // mountOpenApi registers GET /v1/openapi.json on the ROOT app (before the
  // /v1 sub-apps + the registry catch-all, so it always wins) and stamps the
  // running version — the W4-R minimal runtime document was retired.
  mountOpenApi(app, { version: deps.version });

  // --- D1 (W10-G final audit): the Better Auth handlers --------------------
  // §13.1 pins /v1/auth/*; W4-A landed the handlers at the /api/auth basePath
  // (client-config.ts pin). The recipe lives in auth/server.ts's header — the
  // composition root executes it verbatim, plus the versioned alias: the /v1
  // mount URL-rewrites the basePath portion (method/headers/body verbatim) so
  // ONE handler serves both prefixes. getAuthServer() resolves env LAZILY on
  // the first auth request (the createAuthResolvers precedent — §4 fail-fast
  // happens then, surfaced as a typed 500 envelope by the error mapper when a
  // deployment forgets BETTER_AUTH_URL). Registered before the /v1 sub-apps so
  // concrete handlers beat the registry's 501 catch-all.
  app.all("/api/auth/*{path}", (c) => getAuthServer().handler(c.req.raw));
  app.all("/v1/auth/*{path}", (c) => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/v1\/auth/, "/api/auth");
    return getAuthServer().handler(new Request(url, c.req.raw));
  });

  // --- resolve the group deps (pre-baked overrides win over seam-built) -----
  const resolver = deps.auth !== undefined ? makeSessionResolver(deps.auth) : undefined;
  const workspaces = deps.workspacesDeps ?? buildWorkspacesDeps(deps, resolver);
  const documents = deps.documentsDeps ?? buildDocumentsDeps(deps, resolver);
  const runs = deps.runsDeps ?? buildRunsDeps(deps, resolver);
  const runEvents = deps.runEventsDeps ?? buildRunEventsDeps(deps, resolver);
  const uploads = deps.uploadsDeps ?? buildUploadsDeps(deps);
  const uploadsMounted = deps.auth !== undefined; // router gates itself; store may 503
  // W10-R: the registry groups — pre-baked deps win, else seam-built adapters.
  const credits = deps.creditsDeps ?? buildCreditsDeps(deps, resolver);
  const billing = deps.billingDeps ?? buildBillingDeps(deps, resolver);
  const audit = deps.auditDeps ?? buildAuditDeps(deps, resolver);
  // W10-R: pre-baked-only groups (see the AppDeps field docs — their service
  // seams are env/worker-driven, so buildApp never synthesizes them).
  const catalog = deps.catalogDeps;
  const commands = deps.commandDeps;
  const exportRoutesDeps = deps.exportDeps;

  // --- W10-R: catalog / commands / exports (the awaiting-mount checklist) --
  // One documented one-call helper per module (W4-J/W4-K/W4-L), mounted on the
  // app ROOT with each helper's DEFAULT paths — the exact call shape the
  // sibling suites exercise (catalog.test.ts / command-exec.test.ts /
  // exports.test.ts mount through the deps.mount hook at this same position).
  // Registered BEFORE the /v1 sub-app + the registry, so their concrete routes
  // always beat the typed 501 catch-all; each helper injects its own
  // auth/deps middleware before its routers (their own module contracts).
  if (catalog !== undefined) {
    const catalogMod = shape(catalogRoutesModule);
    const mount = helperOf(catalogMod, "mountCatalogRoutes");
    if (mount !== undefined) {
      (mount as (app: Hono<AppEnv>, deps: CatalogDeps) => void)(app, catalog);
    }
  }

  if (commands !== undefined) {
    const commandsMod = shape(commandsRoutesModule);
    const mount = helperOf(commandsMod, "mountCommandRoutes");
    if (mount !== undefined) {
      (mount as (
        app: Hono<AppEnv>,
        deps: CommandRoutesDeps,
        options?: { readonly path?: string },
      ) => void)(app, commands);
    }
  }

  if (exportRoutesDeps !== undefined) {
    const exportsMod = shape(exportsRoutesModule);
    const mount = helperOf(exportsMod, "mountExportRoutes");
    if (mount !== undefined) {
      (mount as (
        app: Hono<AppEnv>,
        deps: ExportRoutesDeps,
        options?: { readonly documentsPath?: string },
      ) => void)(app, exportRoutesDeps);
    }
  }

  // --- the /v1 sub-app ------------------------------------------------------
  const v1 = new Hono<AppEnv>();
  // Authenticated-group prefixes (§15.2 org-keyed preset below) — the groups
  // mounted INSIDE the v1 sub-app (W4-R's five). The W4-J/K/L groups mount on
  // the app root (below, before this sub-app) with their default /v1 paths —
  // the exact call shape their suites exercise — so the org preset for their
  // prefixes lives in their own modules: catalog charges api.catalog.read per
  // org in its middleware; commands/exports keep the global IP floor (their
  // modules ship no limiter seam — §13 amendment candidate). credits/billing/
  // audit mount through the routes/index.ts registry sub-app (their modules own
  // their per-org buckets; audit documents "intentionally none").
  const authedPrefixes = new Set<string>();

  if (workspaces !== undefined) {
    authedPrefixes.add("/workspaces");
    authedPrefixes.add("/invites");
  }
  if (documents !== undefined) {
    authedPrefixes.add("/documents");
  }
  if (runs !== undefined || runEvents !== undefined) {
    authedPrefixes.add("/runs");
  }
  if (uploadsMounted) {
    authedPrefixes.add("/uploads");
    authedPrefixes.add("/assets");
  }

  // Session-prime + the org-keyed preset for authenticated groups (§15.2).
  // Unauthenticated requests degrade to IP buckets inside the middleware —
  // never a single global bucket one tenant could exhaust for everyone.
  if (resolver !== undefined && deps.limiter !== undefined) {
    const prime = primeSession(resolver);
    const orgLimit = rateLimit({ limiter: deps.limiter }, RATE_LIMIT_PRESETS.authenticated);
    for (const prefix of authedPrefixes) {
      v1.use(prefix, prime);
      v1.use(`${prefix}/*`, prime);
      v1.use(prefix, orgLimit);
      v1.use(`${prefix}/*`, orgLimit);
    }
  }

  // --- group mounts: defensive import shape (factory OR const, per module) --
  const wsMod = shape(workspacesRoutesModule);
  if (workspaces !== undefined) {
    const workspacesFactory = factoryOf(wsMod, "workspaceRoutes");
    if (workspacesFactory !== undefined) {
      v1.route("/workspaces", workspacesFactory(workspaces));
      const inviteFactory = factoryOf(wsMod, "inviteRoutes");
      if (inviteFactory !== undefined) {
        v1.route("/invites", inviteFactory(workspaces));
      }
    }
  }

  if (documents !== undefined) {
    const docsMod = shape(documentsRoutesModule);
    const withDeps = factoryOf(docsMod, "withDocumentDeps");
    const router =
      withDeps !== undefined
        ? withDeps(documents)
        : documentsFallbackRouter(docsMod, documents);
    if (router !== undefined) {
      v1.route("/documents", router);
    }
  }

  if (runs !== undefined) {
    const runsMod = shape(runsRoutesModule);
    const mount = helperOf(runsMod, "mountRunRoutes");
    if (mount !== undefined) {
      (mount as (app: Hono<AppEnv>, deps: RunsDeps, options?: { readonly path?: string }) => void)(
        v1,
        runs,
        { path: "/runs" },
      );
    } else {
      const router = routerOf(runsMod, "runRoutes");
      const inject = helperOf(runsMod, "runsServices");
      if (router !== undefined && inject !== undefined) {
        const middleware = (inject as (deps: RunsDeps) => MiddlewareHandler<AppEnv>)(runs);
        v1.use("/runs", middleware);
        v1.use("/runs/*", middleware);
        v1.route("/runs", router);
      }
    }
  }

  if (runEvents !== undefined) {
    const eventsMod = shape(runEventsRoutesModule);
    const factory = factoryOf(eventsMod, "createRunEventRoutes");
    if (factory !== undefined) {
      v1.route("/", factory(runEvents));
    } else {
      const router = routerOf(eventsMod, "runEventRoutes");
      const wire = helperOf(eventsMod, "wireRunEventRoutes");
      if (router !== undefined && wire !== undefined) {
        (wire as (deps: RunEventsDeps | null) => void)(runEvents);
        v1.route("/", router);
      }
    }
  }

  if (uploadsMounted) {
    const uploadsMod = shape(uploadsRoutesModule);
    const uploadsRouter = routerOf(uploadsMod, "uploadRoutes");
    if (uploadsRouter !== undefined) {
      if (deps.limiter !== undefined) {
        // §20.2: reject on the declared Content-Length before anything is read.
        v1.use("/uploads", uploadCap());
      }
      // Lazy per-route auth (§13): the uploads router consumes the `auth`
      // context variable, so the W4-B gate mounts here — 401 `unauthenticated`.
      const authGate =
        requireAuth<FullEnv>(deps.auth as AuthProvider) as unknown as MiddlewareHandler<AppEnv>;
      v1.use("/uploads", authGate);
      v1.use("/assets", authGate);
      v1.use("/assets/*", authGate);
      if (deps.limiter !== undefined) {
        v1.use("/uploads", rateLimit({ limiter: deps.limiter }, RATE_LIMIT_PRESETS.uploads));
      }
      if (uploads !== undefined) {
        const inject = uploadsContext(uploads);
        v1.use("/uploads", inject);
        v1.use("/assets", inject);
        v1.use("/assets/*", inject);
      }
      v1.route("/", uploadsRouter);
    }
  }

  app.route("/v1", v1);

  // W1-H registry: mounts /v1/health from this deps and keeps the typed 501
  // catch-all for spec'd-but-unmounted paths LAST (routes/index.ts is not
  // owned by W4-R — do not inline it here). W10-R: the seam-built credits/
  // billing/audit deps ride along (pre-baked deps on AppDeps keep winning), so
  // the registry's one-call mounts light up without duplicating its wiring.
  registerRoutes(app, {
    ...deps,
    ...(credits !== undefined ? { creditsDeps: credits } : {}),
    ...(billing !== undefined ? { billingDeps: billing } : {}),
    ...(audit !== undefined ? { auditDeps: audit } : {}),
  });

  // --- /metrics (§22): INTERNAL-ONLY Prometheus exposition (W10-E) ---------
  // Mounted on the app root — NEVER under the public /v1 group (§13.1) —
  // behind the METRICS_TOKEN Basic-auth seam (W9-G: the Basic PASSWORD must
  // equal the token, username ignored, timing-safe; UNSET ⇒ fail-closed
  // 401 — an unconfigured auth seam never exposes operational data).
  // INTERNAL-ONLY: compose exposes the metrics port on the bridge network
  // only (gateway "3001", never `ports:` — §17.2) and the Caddyfile answers
  // public /metrics with 404, so this mount is unreachable from the internet.
  // TODO(wiring wave, src/index.ts): give /metrics its own 3001 listener and
  // inject the shared W9-D registry (studio_* series) + queue/enginePool
  // gauges through MetricsRouteDeps. METRICS_TOKEN is read STRUCTURALLY —
  // packages/config does not declare it yet (flagged to the config owner;
  // ADR-0002 wants it in the gateway env schema).
  app.route(
    "/metrics",
    metricsRoutes({
      version: deps.version,
      startedAt: deps.startedAt,
      token: (deps.env as unknown as { readonly METRICS_TOKEN?: string }).METRICS_TOKEN,
      http: httpMetrics,
    }),
  );

  app.notFound(notFoundHandler(deps.logger));
  return app;
}

/** W4-F fallback mount: documentDepsMiddleware + the exported const router. */
function documentsFallbackRouter(
  mod: RouteModuleShape,
  deps: DocumentRoutesDeps,
): Hono<AppEnv> | undefined {
  const router = routerOf(mod, "documentRoutes");
  const middlewareFactory = helperOf(mod, "documentDepsMiddleware");
  if (router === undefined || middlewareFactory === undefined) {
    return undefined;
  }
  const middleware = (middlewareFactory as (deps: unknown) => MiddlewareHandler<AppEnv>)(deps);
  const sub = new Hono<AppEnv>();
  sub.use(middleware);
  sub.route("/", router);
  return sub;
}

// ---------------------------------------------------------------------------
// Per-group deps built from the GatewayDeps seams (the adapter layer)
// ---------------------------------------------------------------------------

function buildWorkspacesDeps(
  deps: AppDeps,
  resolver: RequestSessionResolver | undefined,
): WorkspaceRoutesDeps | undefined {
  if (
    resolver === undefined ||
    deps.db === undefined ||
    deps.ledger === undefined ||
    deps.audit === undefined
  ) {
    return undefined; // group stays unmounted; the /v1 catch-all answers 501
  }
  return {
    db: createWorkspaceDb(deps.db),
    billing: createLedgerBilling(deps.ledger),
    audit: deps.audit,
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    ...(deps.newId !== undefined ? { newId: deps.newId } : {}),
    auth: workspacesAuth(resolver),
  };
}

function buildDocumentsDeps(
  deps: AppDeps,
  resolver: RequestSessionResolver | undefined,
): DocumentRoutesDeps | undefined {
  if (
    resolver === undefined ||
    deps.db === undefined ||
    deps.storage === undefined ||
    deps.catalog === undefined ||
    deps.resolvePlan === undefined
  ) {
    return undefined;
  }
  return {
    store: drizzleDocumentsStore(deps.db),
    storage: deps.storage, // @studio/storage Storage satisfies the get/put seam
    templates: deps.catalog,
    now: deps.clock ?? (() => new Date()),
    newId: deps.newId ?? randomUUID,
    auth: documentsPrincipal(resolver, deps.resolvePlan),
  };
}

function buildRunsDeps(
  deps: AppDeps,
  resolver: RequestSessionResolver | undefined,
): RunsDeps | undefined {
  if (
    resolver === undefined ||
    deps.db === undefined ||
    deps.ledger === undefined ||
    deps.enqueue === undefined ||
    deps.bus === undefined
  ) {
    return undefined;
  }
  return {
    auth: runsAuth(resolver),
    billing: billingFromLedger(deps.ledger),
    store: drizzleRunsStore(deps.db),
    enqueue: deps.enqueue,
    events: runCancelEvents(deps.bus),
  };
}

function buildRunEventsDeps(
  deps: AppDeps,
  resolver: RequestSessionResolver | undefined,
): RunEventsDeps | undefined {
  if (resolver === undefined || deps.db === undefined || deps.bus === undefined) {
    return undefined;
  }
  return {
    auth: { authenticate: (request) => resolver.resolve(request) },
    runLookup: drizzleRunLookup(deps.db),
    bus: deps.bus, // RunEventBus satisfies W4-H's structural mirror shape-for-shape
    ...(deps.sseHeartbeatMs !== undefined ? { heartbeatMs: deps.sseHeartbeatMs } : {}),
  };
}

function buildUploadsDeps(deps: AppDeps): UploadsDeps | undefined {
  if (deps.storage === undefined || deps.assets === undefined) {
    return undefined; // router mounts; its requireDeps guard answers the typed 503
  }
  const service: AssetsService = createAssetsService({
    store: deps.assets,
    storage: deps.storage,
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    ...(deps.newId !== undefined ? { newId: deps.newId } : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
  return { service, limits: deps.uploadLimits ?? DEFAULT_UPLOAD_LIMITS };
}

// ---------------------------------------------------------------------------
// W10-R adapters — the seam-built deps for the registry groups (credits /
// billing / audit). Each mirrors the production adapter its route file's WIRING
// header sketched (credits.ts “~15-line LedgerLike”, audit.README.md “~10-line
// countsByAction”, billing.ts “createStripeBillingService + drizzle seams”).
// ---------------------------------------------------------------------------

/** W4-M seam: CreditsAuthLike — Result<CreditsCaller>, catalog `unauthorized`. */
function creditsAuth(resolver: RequestSessionResolver): CreditsAuthLike {
  return {
    async authenticate(request) {
      const session = await resolver.resolve(request);
      if (session === null) {
        return err("unauthorized", "Authentication is required.", { retryable: false });
      }
      return ok({
        userId: session.userId,
        organizationId: session.organizationId,
        role: session.role,
      });
    },
  };
}

/**
 * W4-M seam: the credits LedgerLike — balanceAfter rides the injected
 * @studio/billing LedgerStore shape-for-shape (the route header's note); only
 * `page` is gateway-local: the keyset walk over credit_ledger newest-first,
 * served by credit_ledger_org_created_idx (§12.2).
 */
function ledgerPageFromStore(store: LedgerStore, db: Db): LedgerLike {
  return {
    async balanceAfter(organizationId: string): Promise<number> {
      return store.balanceAfter(organizationId);
    },
    async page(query: {
      readonly organizationId: string;
      readonly limit: number;
      readonly before?: LedgerPageCursor;
    }): Promise<LedgerPage> {
      const newer: SQL | undefined =
        query.before === undefined
          ? undefined
          : or(
              lt(creditsLedger.createdAt, query.before.createdAt),
              and(
                eq(creditsLedger.createdAt, query.before.createdAt),
                lt(creditsLedger.id, query.before.id),
              ),
            );
      const rows = await db
        .select()
        .from(creditsLedger)
        .where(and(eq(creditsLedger.organizationId, query.organizationId), newer))
        .orderBy(desc(creditsLedger.createdAt), desc(creditsLedger.id))
        .limit(query.limit + 1);
      const pageRows = rows.slice(0, query.limit);
      const last = pageRows.length > 0 ? pageRows[pageRows.length - 1] : undefined;
      const next =
        rows.length > query.limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : undefined;
      return { rows: pageRows, ...(next !== undefined ? { next } : {}) };
    },
  };
}

/**
 * W4-M seam: the credits summary — ONE composite read per the route header:
 * spend = −Σ delta over kinds reserve/commit/refund since `since` (§14.2
 * one-append-per-phase ⇒ that net IS the charged spend + still-open holds);
 * openHolds = held credit_reservations (§14.2 rule 1); trial = no ACTIVE
 * subscription row (§14.1/§14.3 — the internal 'holding' grace state and a
 * canceled row both read as trial for the summary card).
 */
function drizzleBillingSummary(db: Db): BillingSummaryLike {
  return {
    async summary(query: {
      readonly organizationId: string;
      readonly since: Date;
    }): Promise<WorkspaceBillingSummary> {
      const spendRows = await db
        .select({ total: sql<string | null>`coalesce(sum(${creditsLedger.delta}), 0)` })
        .from(creditsLedger)
        .where(
          and(
            eq(creditsLedger.organizationId, query.organizationId),
            gte(creditsLedger.createdAt, query.since),
            inArray(creditsLedger.kind, ["reserve", "commit", "refund"]),
          ),
        );
      const holdRows = await db
        .select({ held: count() })
        .from(creditReservations)
        .where(
          and(
            eq(creditReservations.organizationId, query.organizationId),
            eq(creditReservations.status, "held"),
          ),
        );
      const subRows = await db
        .select({ status: subscriptions.status })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.organizationId, query.organizationId),
            eq(subscriptions.status, "active"),
          ),
        )
        .limit(1);
      return {
        spendCredits: -Number(spendRows[0]?.total ?? 0),
        openHolds: Number(holdRows[0]?.held ?? 0),
        trial: subRows.length === 0,
      };
    },
  };
}

/** Registry group deps: credits/usage (W4-M) from the shared seams. */
function buildCreditsDeps(
  deps: AppDeps,
  resolver: RequestSessionResolver | undefined,
): CreditsDeps | undefined {
  if (
    resolver === undefined ||
    deps.db === undefined ||
    deps.ledger === undefined ||
    deps.limiter === undefined
  ) {
    return undefined; // group stays behind the typed 501 catch-all (W8-K)
  }
  return {
    auth: creditsAuth(resolver),
    ledger: ledgerPageFromStore(deps.ledger, deps.db),
    summary: drizzleBillingSummary(deps.db),
    usage: drizzleUsageQueries(deps.db),
    limiter: deps.limiter,
  };
}

/** Registry group deps: billing + Stripe webhook (W4-N) from the seams. */
function buildBillingDeps(
  deps: AppDeps,
  resolver: RequestSessionResolver | undefined,
): BillingRoutesDeps | undefined {
  if (
    resolver === undefined ||
    deps.db === undefined ||
    deps.ledger === undefined ||
    deps.audit === undefined ||
    deps.stripe === undefined ||
    deps.billingWiring === undefined
  ) {
    // billingWiring is the ONLY seam with no default (§4: prices are env-only,
    // see GatewayDeps.billingWiring) — an unconfigured deployment keeps the
    // billing group behind the typed 501 catch-all, never a pretend-success.
    return undefined;
  }
  return {
    billing: createStripeBillingService({
      stripe: deps.stripe,
      db: createDrizzleBillingDb(deps.db),
      ledger: ledgerFromStore(deps.ledger), // @studio/billing LedgerStore → §14.2 grants
      audit: deps.audit, // workspaces.ts AuditLike ≡ stripe.ts AuditLike, structural
      prices: deps.billingWiring.prices,
      webhookSecret: deps.billingWiring.webhookSecret,
      appUrl: deps.billingWiring.appUrl,
      withTransaction: drizzleWithTransaction(deps.db),
      logger: deps.logger,
    }),
    auth: workspacesAuth(resolver), // the SAME W4-E seam the workspaces group uses
  };
}

/** W9-H seam: AuditAuthLike — Result<AuditRouteCaller> (the authz mirror). */
function auditAuth(resolver: RequestSessionResolver): AuditAuthLike {
  return {
    async authenticate(request) {
      const session = await resolver.resolve(request);
      if (session === null) {
        return err("unauthorized", "Authentication is required.", { retryable: false });
      }
      // SessionContext ≡ GuardContext field-for-field (W4-B mirror): the route
      // feeds it straight into guard.assertCan / assertTenant (§15.1/§15.2).
      return ok(session);
    },
  };
}

/**
 * W9-H seam: the 30-day counts-by-action card — the ~10-line Drizzle adapter
 * sketched in routes/audit.README.md (grouped read over audit_log, §22).
 */
function drizzleAuditCounts(db: Db): AuditActionCountsLike {
  return {
    async countsByAction(query: {
      readonly organizationId: string;
      readonly since: Date;
    }): Promise<Readonly<Record<string, number>>> {
      const rows = await db
        .select({ action: auditLog.action, n: count() })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.organizationId, query.organizationId),
            gte(auditLog.createdAt, query.since),
          ),
        )
        .groupBy(auditLog.action);
      return Object.fromEntries(rows.map((row) => [row.action, Number(row.n)]));
    },
  };
}

/** Registry group deps: §22 audit export + summary (W9-H) from the seams. */
function buildAuditDeps(
  deps: AppDeps,
  resolver: RequestSessionResolver | undefined,
): AuditRoutesDeps | undefined {
  if (resolver === undefined || deps.db === undefined) {
    return undefined;
  }
  return {
    auth: auditAuth(resolver),
    // The SAME W4-Q service instance shape the rest of the gateway appends
    // through (routes/audit.ts header contract) over the drizzle store.
    audit: new AuditService({ store: new DrizzleAuditStore(deps.db) }),
    summary: drizzleAuditCounts(deps.db),
  };
}

// ---------------------------------------------------------------------------
// createDefaultDeps — the production DI graph (every seam overridable)
// ---------------------------------------------------------------------------

/** Options for createDefaultDeps. */
export interface CreateDefaultDepsOptions {
  /**
   * STORAGE_* variables for createStorageFromEnv. GatewayEnv does not carry
   * them yet (W2-Q flagged the config-schema addition), so bootstrap passes
   * the raw env source; when omitted the parsed GatewayEnv is used as-is.
   */
  readonly storageEnv?: StorageEnvInput;
  /**
   * W10-R: raw env source for the Stripe price map — GatewayEnv CANNOT carry
   * STRIPE_PRICE_* (the schema is .strict(); priceMapFromEnv parses the alias
   * names too), so the bootstrap hands the raw source over exactly like
   * storageEnv. A source that fails to yield starter/pro/max prices throws
   * (§4 fail-fast); omitted ⇒ no billingWiring ⇒ the billing group stays
   * behind the typed 501 catch-all.
   */
  readonly stripePriceEnv?: Readonly<Record<string, string | undefined>>;
  /** Per-seam overrides applied LAST — tests inject their fakes here. */
  readonly overrides?: Partial<GatewayDeps>;
}

/**
 * The production dependency graph from a parsed @studio/config GatewayEnv.
 * Fail-fast (§4): an unusable DATABASE_URL or storage config throws before any
 * request is served. Defaults + their owning waves are documented on
 * GatewayDeps (src/types.ts). Nothing here reads process.env — the parsed env
 * is the only input; the auth resolvers reach Better Auth lazily on first
 * session/API-key resolution (auth/server.ts singletons).
 */
export function createDefaultDeps(
  env: GatewayEnv,
  options: CreateDefaultDepsOptions = {},
): GatewayDeps {
  const overrides = options.overrides ?? {};
  const db = overrides.db ?? createDb(env.DATABASE_URL);
  const kv = overrides.kv ?? new InMemoryKV();
  const storage =
    overrides.storage ?? defaultStorage(options.storageEnv ?? (env as unknown as StorageEnvInput));
  const engineSessions = overrides.engineSessions ?? new NotWiredSessionResolver();
  const bus = overrides.bus ?? new RunEventBus({ store: new DrizzleEventStore(db) });
  // W10-R: §14.3 wiring inputs. The parsed GatewayEnv carries the webhook
  // secret + app URL (both required); the price ids come from the RAW env
  // source (strict schema — see CreateDefaultDepsOptions.stripePriceEnv).
  // A provided-but-bad price source refuses to boot (§4), a missing one just
  // leaves billingWiring unset (billing group → typed 501, never pretend).
  const prices =
    options.stripePriceEnv !== undefined ? priceMapFromEnv(options.stripePriceEnv) : undefined;
  if (prices !== undefined && !prices.ok) {
    throw new AppError(500, "validation_failed", prices.message, {
      hint: prices.hint,
      retryable: false,
    });
  }
  const billingWiring =
    overrides.billingWiring ??
    (prices !== undefined && prices.ok
      ? { webhookSecret: env.STRIPE_WEBHOOK_SECRET, appUrl: env.APP_URL, prices: prices.value }
      : undefined);
  return {
    auth: overrides.auth ?? createDefaultAuthProvider(createAuthResolvers()),
    db,
    kv,
    storage,
    limiter: overrides.limiter ?? new RateLimiter({ kv }),
    bus,
    enqueue: overrides.enqueue ?? new UnavailableEnqueue(),
    ledger: overrides.ledger ?? new UnavailableLedgerStore(),
    audit: overrides.audit ?? createDrizzleAudit(db),
    catalog: overrides.catalog ?? new EmptyTemplateCatalog(),
    // W10-R: services/stripe.ts's NoopStripe (W4-N authoritative shape) —
    // deterministic ids, no network, REAL HMAC webhook verification. Production
    // must inject createStripeSdk (wiring-check wave fails fast on Noop there).
    stripe: overrides.stripe ?? new NoopStripe(),
    ...(billingWiring !== undefined ? { billingWiring } : {}),
    engineSessions,
    resolvePlan: overrides.resolvePlan ?? drizzlePlanResolver(db),
    ...(overrides.assets !== undefined ? { assets: overrides.assets } : {}),
    ...(overrides.uploadLimits !== undefined ? { uploadLimits: overrides.uploadLimits } : {}),
    sseHeartbeatMs: overrides.sseHeartbeatMs ?? env.SSE_HEARTBEAT_MS,
    ...(overrides.clock !== undefined ? { clock: overrides.clock } : {}),
    ...(overrides.newId !== undefined ? { newId: overrides.newId } : {}),
    probes: overrides.probes ?? defaultProbes(db, kv, storage, engineSessions),
  };
}

/** §4 fail fast: a misconfigured storage driver refuses to boot (no default). */
function defaultStorage(env: StorageEnvInput): Storage {
  const result = createStorageFromEnv(env);
  if (!result.ok) {
    throw new AppError(500, "storage_error", result.message, {
      hint: result.hint,
      retryable: false,
    });
  }
  return result.value;
}

/** Real dependency probes for /v1/health/deep (§13.1) over the default seams. */
function defaultProbes(
  db: Db,
  kv: KVLike,
  storage: Storage,
  engineSessions: SessionResolver,
): readonly Probe[] {
  return [
    {
      name: "db",
      check: async () => {
        await db.execute(sql`select 1`);
        return { ok: true };
      },
    },
    {
      name: "valkey",
      check: async () => {
        await kv.get("__gateway_health_probe__"); // KV seam reachable
        return {
          ok: true,
          detail: "kv seam reachable (InMemoryKV until the Valkey adapter lands)",
        };
      },
    },
    {
      name: "storage",
      check: async () => {
        await storage.get("__gateway/health_probe__"); // read-only reachability
        return { ok: true };
      },
    },
    {
      name: "engine_pool",
      check: async () => {
        const active = await engineSessions.listActive();
        return { ok: true, detail: `${active.length} active engine session(s)` };
      },
    },
    {
      name: "model_providers",
      check: async () =>
        ({ ok: true, stub: true, detail: "model providers serve from the worker (§5.3)" }),
    },
  ];
}
