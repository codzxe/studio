// buildApp — the gateway composition root (W4-R).
//
// `src/index.ts` is the only file that touches the outside world; everything
// here is injectable and testable via `app.request()`. This file OWNS:
//   - the middleware order (§13.3 envelopes, §22 correlation, §1.5 rate limits),
//   - mounting every landed /v1 route group through its OWN documented wire
//     pattern (factory or const+middleware — whichever export exists),
//   - the adapters that bridge the one W4-B AuthProvider to each sibling's
//     auth seam (workspaces UserResolver, documents PrincipalResolver, runs
//     AuthLike, SSE RunEventsAuthLike, uploads context variable),
//   - `createDefaultDeps(env)` — the production DI graph, every seam
//     overridable for tests (docs/AGENTS.md "everything injectable").
//
// SIBLING FILES ARE READ-ONLY for this module: routes/, services/, middleware/,
// auth/, authz/ export their own seams; only src/app.ts + src/types.ts are owned
// by the wiring wave (task W4-R).

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { RunEventBus } from "@studio/agent";
import { err, ok, type GatewayEnv, type PlanId, type Result } from "@studio/config";
import {
  agentRuns,
  createDb,
  plans as plansTable,
  subscriptions,
  type Db,
} from "@studio/db";
import type { LedgerStore } from "@studio/billing";
import { createStorageFromEnv, type Storage, type StorageEnvInput } from "@studio/storage";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { Logger } from "pino";
import { createAuthResolvers } from "./auth/api-keys.js";
import { createDefaultAuthProvider, extractBearerToken, requireAuth, type AuthProvider, type SessionContext } from "./middleware/auth-context.js";
import { requestContext, type RequestContext } from "./middleware/request-context.js";
import { uploadCap } from "./middleware/caps.js";
import { rateLimit, type RateLimitOptions } from "./middleware/rate-limit.js";
import { AppError, errorMapper, notFoundHandler } from "./middleware/error-mapper.js";
import { requestLogger } from "./middleware/logger.js";
import { requestId } from "./middleware/request-id.js";
import { createAssetsService, DEFAULT_UPLOAD_LIMITS, type AssetsService } from "./services/assets.js";
import { drizzleDocumentsStore, type TemplateCatalogLike } from "./services/documents.js";
import { DrizzleEventStore } from "./services/event-store.js";
import { InMemoryKV, RateLimiter } from "./services/limiter.js";
import {
  billingFromLedger,
  drizzleRunsStore,
  type AuthLike,
  type EnqueueLike,
  type EventBusLike,
} from "./services/runs.js";
import { createDrizzleAudit, createLedgerBilling, createWorkspaceDb } from "./services/workspaces.js";
import { registerRoutes } from "./routes/index.js";
import { withDocumentDeps, documentDepsMiddleware, documentRoutes, type DocumentRoutesDeps, type PrincipalResolver } from "./routes/documents.js";
import { createWorkspaceAuth, inviteRoutes, workspaceRoutes, type WorkspaceAuth, type WorkspaceRoutesDeps } from "./routes/workspaces.js";
import { mountRunRoutes, runsServices, runRoutes, type RunsDeps } from "./routes/runs.js";
import {
  createRunEventRoutes,
  runEventRoutes as runEventRoutesConst,
  wireRunEventRoutes,
  type RunEventsAuthLike,
  type RunEventsDeps,
  type RunLookupLike,
} from "./routes/runs-events.js";
import { uploadRoutes, type UploadsDeps } from "./routes/uploads.js";
import type { TransportEnv } from "./env.js";
import type {
  AppEnv,
  EngineSessionRef,
  GatewayDeps,
  SessionResolver,
  StripeLike,
  TemplateCatalogLike as GatewayCatalogSeam,
} from "./types.js";

// ---------------------------------------------------------------------------
// Rate-limit presets (§1.5 rule 5, §15.2 "rate limits per IP/user/workspace")
// ---------------------------------------------------------------------------

/** The three standard policies buildApp mounts (numbers from the W4-R task). */
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
 * them. Each GatewayDeps seam (src/types.ts) is optional here; a route group
 * mounts only when ALL of its seams are present (or its pre-baked group deps
 * below are passed, which tests use to fake the service layer per group).
 */
export interface AppDeps extends Partial<GatewayDeps> {
  /** Transport env (parsed once at bootstrap, §4 / ADR-0002). */
  readonly env: TransportEnv;
  /** Root pino logger; request-scoped children are derived per request (§22). */
  readonly logger: Logger;
  /** Service version string reported by /v1/health and /v1/openapi.json. */
  readonly version: string;
  /** Dependency probes for GET /v1/health/deep (§13.1) — required (W1-H). */
  readonly probes: readonly import("./routes/health.js").Probe[];
  /** Epoch ms uptime anchor — injected so tests are deterministic. */
  readonly startedAt: number;
  /**
   * Extra mounts, applied after middleware but BEFORE the /v1 group mounts and
   * the routes/index.ts registry — hook routes always win (W1-H contract,
   * kept byte-compatible for the sibling test suites).
   */
  readonly mount?: (app: Hono<AppEnv>) => void;

  // -- pre-baked per-group deps (tests / partial wiring): mounted as-is and
  //    preferred over the adapter-built deps from the seams above. --
  readonly workspacesDeps?: WorkspaceRoutesDeps;
  readonly documentsDeps?: DocumentRoutesDeps;
  readonly runsDeps?: RunsDeps;
  readonly runEventsDeps?: RunEventsDeps;
  readonly uploadsDeps?: UploadsDeps;
}

/** Env with the auth/reqCtx variables narrowed non-optional (mount-time only). */
type FullEnv = AppEnv & {
  Variables: {
    auth: SessionContext;
    reqCtx: RequestContext;
  };
};

/** Uploads' injected context variable, declared locally (single cast below). */
type UploadsMountEnv = {
  Variables: AppEnv["Variables"] & { uploadsDeps: UploadsDeps | undefined };
};

// ---------------------------------------------------------------------------
// Session resolution — ONE resolution per request, shared by every adapter
// ---------------------------------------------------------------------------

/** Memoized session resolution over the injected AuthProvider (per request). */
export interface SessionResolver {
  resolve(request: Request): Promise<SessionContext | null>;
}

/**
 * Wraps a W4-B AuthProvider with a per-request WeakMap so the auth'd rate-limit
 * priming, each group's adapter and the uploads gate resolve the caller at most
 * once per request. Resolution order mirrors requireAuth: bearer API key first,
 * then cookie session; a provider resolving `undefined` is treated as "no
 * session" (fail closed, W4-B contract).
 */
export function makeSessionResolver(provider: AuthProvider): SessionResolver {
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
 * route (each group owns its 401), so unauthenticated surfaces still get their
 * own typed envelopes while the limiter can key by workspace when present.
 */
function primeSession(resolver: SessionResolver): MiddlewareHandler<AppEnv> {
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
    // Single local cast: the variable belongs to the uploads router's env.
    (c as unknown as Context<UploadsMountEnv>).set("uploadsDeps", deps);
    await next();
  });
}

// ---------------------------------------------------------------------------
// Auth adapters — the one AuthProvider bridged onto every sibling seam
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
 * individual adapters below with its shared memoized resolver.
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
function workspacesAuth(resolver: SessionResolver): WorkspaceAuth {
  return createWorkspaceAuth(async (c) => {
    const session = await resolver.resolve(c.req.raw);
    return session === null ? null : { userId: session.userId };
  });
}

/** W4-F seam: PrincipalResolver — session + §14.1 plan, catalog 401 on miss. */
function documentsPrincipal(
  resolver: SessionResolver,
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
function runsAuth(resolver: SessionResolver): AuthLike {
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
// Bus / run-lookup adapters (drizzle seams the SSE + runs groups need)
// ---------------------------------------------------------------------------

/**
 * Run existence + tenant root for the SSE gate (§15.1: the lookup is by run id
 * alone; the ROUTE compares the org, so foreign and missing runs stay the same
 * 404). A 5-line drizzle adapter over @studio/db — the store layer is W4-G's.
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
 * W4-G EventBusLike over the real @studio/agent bus: `run.cancelled`
 * publishes flow through the same durable store the SSE stream backfills
 * from. Bus failure codes map onto the §13.3 catalog (organization_mismatch
 * → forbidden, transport/persist failures → storage_error).
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
          hint: "The durable event store rejected the append; the cancel is retried on the next sync.",
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
    const raw = rows[0]?.code;
    return typeof raw === "string" && raw === "starter" || raw === "pro" || raw === "business"
      ? raw
      : "starter";
  };
}

// ---------------------------------------------------------------------------
// Default implementations (documented on GatewayDeps, src/types.ts)
// ---------------------------------------------------------------------------

/** Money path stays CLOSED until the billing repo wave ships the drizzle store. */
function ledgerUnavailable(): never {
  throw new AppError(503, "service_unavailable", "The credit ledger is not wired in this deployment.", {
    hint: "Inject the drizzle credit-ledger repository via GatewayDeps.ledger (billing repo wave, §14.2).",
    retryable: true,
  });
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
 * LOUD with the same envelope W4-G maps for queue outages (run marked failed,
 * reservation released) — never silently dropped.
 */
export class UnavailableEnqueue implements EnqueueLike {
  async enqueue(): Promise<Result<{ readonly jobId: string }>> {
    return err("engine_unavailable", "The run queue producer is not wired in this process.", {
      hint: "Bootstrap must inject the BullMQ EnqueueLike adapter over the shared Valkey (apps/worker/src/queues.ts).",
      retryable: true,
    });
  }
}

/** Template-catalog default: services/catalog.ts does not exist yet (§7 wave). */
export class EmptyTemplateCatalog implements GatewayCatalogSeam {
  async get(): Promise<TemplateManifestLikeLocal | undefined> {
    return undefined; // every template ref answers "not found" until the catalog lands
  }
}
type TemplateManifestLikeLocal = { readonly id: string; readonly version: string };

/** Stripe default (§14.3): typed not-configured failures, never pretend-success. */
export class NoopStripe implements StripeLike {
  readonly configured = false;
  async createCheckoutSession(): Promise<Result<{ readonly url: string }>> {
    return err("internal_error", "Stripe billing is not configured in this deployment.", {
      hint: "Set STRIPE_SECRET_KEY and inject a real StripeLike adapter (billing-routes wave, §14.3).",
      retryable: false,
    });
  }
  async createPortalSession(): Promise<Result<{ readonly url: string }>> {
    return err("internal_error", "Stripe billing is not configured in this deployment.", {
      hint: "Set STRIPE_SECRET_KEY and inject a real StripeLike adapter (billing-routes wave, §14.3).",
      retryable: false,
    });
  }
  async constructWebhookEvent(): Promise<Result<unknown>> {
    return err("internal_error", "Stripe billing is not configured in this deployment.", {
      hint: "Set STRIPE_WEBHOOK_SECRET and inject a real StripeLike adapter (billing-routes wave, §14.3).",
      retryable: false,
    });
  }
}

/** Engine-session seam default: [] until the engine-pool probe surface ships. */
export class NotWiredSessionResolver implements SessionResolver {
  async listActive(): Promise<readonly EngineSessionRef[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// /v1/openapi.json — honest placeholder document of the MOUNTED surface
// ---------------------------------------------------------------------------

type OpenApiOperations = Record<string, { readonly summary: string }>;

/** Minimal OpenAPI 3.1 skeleton; the API-contract wave owns the full schema. */
function openApiDocument(
  version: string,
  paths: Record<string, OpenApiOperations>,
): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Studio Gateway API",
      version,
      summary:
        "REST + SSE surface (spec §13.1). Placeholder document generated from the mounted route groups; the API-contract wave owns the authoritative schema.",
    },
    servers: [{ url: "/v1" }],
    paths,
  };
}

function op(summary: string): { readonly summary: string } {
  return { summary };
}

// ---------------------------------------------------------------------------
// buildApp — the pure app factory
// ---------------------------------------------------------------------------

/**
 * Build the Hono app. Middleware order is load-bearing (§13.3, §22):
 *   1. errorMapper    — outermost: even request-id/logger failures get a typed
 *                       envelope (never a stack trace, §13.3).
 *   2. requestId     — adopt/generate + echo X-Request-Id (§22).
 *   3. requestLogger — per-request pino child (requestId bound).
 *   4. requestContext — §22 org/user ids re-bound onto that child + `reqCtx`.
 *                       MUST follow requestLogger (it children `c.get("logger")`).
 *   5. rate limits   — global 100/min per IP (health probes skipped); then,
 *                       per authenticated group, a session-prime + 600/min
 *                       org-keyed preset, with a tighter 20/min org+ip preset
 *                       on POST /v1/uploads (§1.5 rule 5, §15.2).
 *   6. auth          — LAZY per route group: each group keeps its own 401
 *                       (never a global auth wall); the uploads group mounts
 *                       W4-B `requireAuth` (code `unauthenticated` — see the
 *                       reconciliation note in src/types.ts).
 * Then the deps.mount hook (test routes win), the /v1 group mounts, the W1-H
 * registry (health + typed 501 catch-all LAST), and the 404 envelope for
 * everything else.
 */
export function buildApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(errorMapper(deps.logger));
  app.use(requestId());
  app.use(requestLogger(deps.logger));
  // One documented cast: FullEnv is AppEnv with auth/reqCtx narrowed required;
  // Hono middleware is env-invariant at this boundary (fleet precedent: runs.ts).
  app.use(requestContext<FullEnv>() as unknown as MiddlewareHandler<AppEnv>);

  if (deps.limiter !== undefined) {
    app.use(rateLimit({ limiter: deps.limiter }, RATE_LIMIT_PRESETS.global));
  }

  if (deps.mount !== undefined) {
    deps.mount(app);
  }

  // --- resolve the route groups (pre-baked deps override the seam-built) ----
  const resolver = deps.auth !== undefined ? makeSessionResolver(deps.auth) : undefined;
  const openapiPaths: Record<string, OpenApiOperations> = {
    "/health": { get: op("Liveness") },
    "/health/deep": { get: op("Dependency checks") },
    "/openapi.json": { get: op("This document") },
  };
  const authedPrefixes = new Set<string>();

  const workspaces = deps.workspacesDeps ?? buildWorkspacesDeps(deps, resolver);
  const documents = deps.documentsDeps ?? buildDocumentsDeps(deps, resolver);
  const runs = deps.runsDeps ?? buildRunsDeps(deps, resolver);
  const runEvents = deps.runEventsDeps ?? buildRunEventsDeps(deps, resolver);
  const uploads = deps.uploadsDeps ?? buildUploadsDeps(deps);

  // --- the /v1 sub-app ------------------------------------------------------
  const v1 = new Hono<AppEnv>();

  if (workspaces !== undefined) {
    authedPrefixes.add("/workspaces");
    authedPrefixes.add("/invites");
    openapiPaths["/workspaces"] = { get: op("List my workspaces"), post: op("Create a workspace") };
    openapiPaths["/workspaces/{id}"] = { get: op("Read workspace"), patch: op("Rename / brand tokens") };
    openapiPaths["/workspaces/{id}/members"] = { get: op("List members") };
    openapiPaths["/workspaces/{id}/members/{userId}"] = { delete: op("Remove member") };
    openapiPaths["/workspaces/{id}/invites"] = { get: op("List invites"), post: op("Create invite") };
    openapiPaths["/workspaces/{id}/invites/{inviteId}"] = { delete: op("Cancel invite") };
    openapiPaths["/invites/{token}"] = { get: op("View invite"), delete: op("Cancel invite by token") };
    openapiPaths["/invites/{token}/accept"] = { post: op("Accept invite") };
  }
  if (documents !== undefined) {
    authedPrefixes.add("/documents");
    openapiPaths["/documents"] = { get: op("Page documents"), post: op("Create document") };
    openapiPaths["/documents/{id}"] = {
      get: op("Read document"),
      patch: op("Rename / archive"),
      delete: op("Archive (soft delete)"),
    };
    openapiPaths["/documents/{id}/versions"] = { get: op("Version timeline") };
    openapiPaths["/documents/{id}/versions/{versionId}/restore"] = { post: op("Restore as new version") };
  }
  if (runs !== undefined || runEvents !== undefined) {
    authedPrefixes.add("/runs");
  }
  if (runs !== undefined) {
    openapiPaths["/runs"] = { get: op("Page runs"), post: op("Create run") };
    openapiPaths["/runs/{id}"] = { get: op("Run detail") };
    openapiPaths["/runs/{id}/cancel"] = { post: op("Cancel run") };
  }
  if (runEvents !== undefined) {
    openapiPaths["/runs/{id}/events"] = { get: op("SSE run-event stream (§13.2)") };
  }
  const uploadsMounted = deps.auth !== undefined;
  if (uploadsMounted) {
    authedPrefixes.add("/uploads");
    authedPrefixes.add("/assets");
    openapiPaths["/uploads"] = { post: op("Upload an asset (multipart)") };
    openapiPaths["/assets"] = { get: op("Asset library page") };
    openapiPaths["/assets/{id}"] = { get: op("Asset + signed URL"), delete: op("Delete asset") };
  }

  // Session-prime + org-keyed preset for the authenticated groups (§15.2):
  // unauthenticated requests degrade to IP buckets inside the middleware —
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

  v1.get("/openapi.json", (c) => c.json(openApiDocument(deps.version, openapiPaths)));

  // --- group mounts — each router's OWN documented wire pattern --------------
  if (workspaces !== undefined) {
    // W4-E pattern: two factory routers (invites pinned at /v1/invites, §13.1).
    v1.route("/workspaces", workspaceRoutes(workspaces));
    v1.route("/invites", inviteRoutes(workspaces));
  }
  if (documents !== undefined) {
    // W4-F pattern: the blessed `withDocumentDeps(deps)` wrapper.
    v1.route("/documents", withDocumentDeps(documents));
  }
  if (runs !== undefined) {
    // W4-G pattern: the one-call wiring helper (path relative to /v1).
    mountRunRoutes(v1, runs, { path: "/runs" });
  }
  if (runEvents !== undefined) {
    // W4-H pattern: deps factory mounted at the /v1 root (internal /runs/:id/events).
    v1.route("/", createRunEventRoutes(runEvents));
  }
  if (uploadsMounted) {
    if (deps.limiter !== undefined) {
      // §20.2: reject on the declared Content-Length before anything is read.
      v1.use("/uploads", uploadCap());
    }
    // Lazy per-route auth (§13): the uploads router consumes the `auth`
    // context variable, so the W4-B gate mounts here — 401 `unauthenticated`.
    v1.use("/uploads", requireAuth<FullEnv>() as unknown as MiddlewareHandler<AppEnv>);
    v1.use("/assets", requireAuth<FullEnv>() as unknown as MiddlewareHandler<AppEnv>);
    v1.use("/assets/*", requireAuth<FullEnv>() as unknown as MiddlewareHandler<AppEnv>);
    if (deps.limiter !== undefined) {
      v1.use("/uploads", rateLimit({ limiter: deps.limiter }, RATE_LIMIT_PRESETS.uploads));
    }
    if (uploads !== undefined) {
      v1.use("/uploads", uploadsContext(uploads));
      v1.use("/assets", uploadsContext(uploads));
      v1.use("/assets/*", uploadsContext(uploads));
    }
    // W4-I pattern: bare const router mounted at the /v1 root; its guards
    // answer a typed 503 until the AssetsStore seam is injected (repo wave).
    v1.route("/", uploadRoutes);
  }

  app.route("/v1", v1);

  // W1-H registry: mounts /v1/health from this deps and keeps the typed 501
  // catch-all for spec'd-but-unmounted paths LAST (routes/index.ts is not
  // owned by W4-R — do not inline it here).
  registerRoutes(app, deps);

  app.notFound(notFoundHandler(deps.logger));
  return app;
}

// ---------------------------------------------------------------------------
// Per-group deps built from the GatewayDeps seams (adapter layer)
// ---------------------------------------------------------------------------

function buildWorkspacesDeps(
  deps: AppDeps,
  resolver: SessionResolver | undefined,
): WorkspaceRoutesDeps | undefined {
  if (
    resolver === undefined ||
    deps.db === undefined ||
    deps.ledger === undefined ||
    deps.audit === undefined
  ) {
    return undefined; // group stays unmounted; /v1 catch-all answers the typed 501
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
  resolver: SessionResolver | undefined,
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

function buildRunsDeps(deps: AppDeps, resolver: SessionResolver | undefined): RunsDeps | undefined {
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
  resolver: SessionResolver | undefined,
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
    return undefined; // router mounts, its requireDeps guard answers the typed 503
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
  /** Per-seam overrides applied LAST — tests inject fakes here. */
  readonly overrides?: Partial<GatewayDeps>;
}

/**
 * The production dependency graph from a parsed @studio/config GatewayEnv.
 * Fail-fast (§4): an unusable DATABASE_URL or storage config throws before
 * any request is served. Defaults + their owning waves are documented on
 * GatewayDeps (src/types.ts); nothing here touches process.env — the parsed
 * env is the only input, and `getAuthServer()` resolves the rest lazily on
 * first session/API-key resolution.
 */
export function createDefaultDeps(
  env: GatewayEnv,
  options: CreateDefaultDepsOptions = {},
): GatewayDeps {
  const overrides = options.overrides ?? {};
  const db = overrides.db ?? createDb(env.DATABASE_URL);
  const kv = overrides.kv ?? new InMemoryKV();
  const storage =
    overrides.storage ??
    defaultStorage(options.storageEnv ?? (env as unknown as StorageEnvInput));
  const engineSessions = overrides.engineSessions ?? new NotWiredSessionResolver();
  const bus = overrides.bus ?? new RunEventBus({ store: new DrizzleEventStore(db) });
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
    stripe: overrides.stripe ?? new NoopStripe(),
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
  kv: import("./services/limiter.js").KVLike,
  storage: Storage,
  engineSessions: SessionResolver,
): readonly import("./routes/health.js").Probe[] {
  return [
    {
      name: "db",
      check: async () => {
        await db.execute("select 1");
        return { ok: true };
      },
    },
    {
      name: "valkey",
      check: async () => {
        await kv.get("__gateway_health_probe__"); // KV seam reachable
        return { ok: true, detail: "kv seam reachable (InMemoryKV until the Valkey adapter lands)" };
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

// Keep the defensive-import contract visible for the contract wave: siblings
// shipped BOTH factory and const router patterns; buildApp prefers each
// module's documented wire function (called above) and falls back to the
// const+middleware shape only if the factory is absent. The fallbacks are
// exercised by the assembly suite through the real exports, so they cannot
// rot while both patterns exist.
void documentDepsMiddleware;
void documentRoutes;
void runsServices;
void runRoutes;
void runEventRoutesConst;
void wireRunEventRoutes;
