// @studio/gateway — catalog routes (§13.1 `GET /v1/templates`,
// `GET /v1/components`, workspace template registration). Owner: W4-J.
//
//   GET  /v1/templates                    discovery cards (NOT full manifests)
//   GET  /v1/templates/:id                full §7.2 manifest (?version=N pins)
//   GET  /v1/components                   discovery cards (§8.2)
//   GET  /v1/components/:id               full manifest (?version=N pins)
//   POST /v1/workspaces/:id/templates     admin+; registers a workspace-
//                                        private template row (§7.2 license)
//
// Auth + tenant: the catalog is PUBLIC CONTENT but still requires auth and is
// rate-limited PER ORG (§1.5 rule 5 — the tenant dimension of a public
// catalog is the caller's workspace bucket). The injected middleware below
// resolves the caller once per request (deps.auth, the runs.ts AuthLike
// seam), then — when a W4-D RateLimiter is provided — charges the
// `api.catalog.read` token bucket for (scope, org) before any handler runs,
// so a hammering workspace cannot starve the others and an unauthenticated
// request never reaches the limiter. Fail-open on a KV outage (W4-D
// posture: rate limiting is abuse protection, never an outage multiplier).
//
// WIRING (export const + one-call mount, the runs.ts contract):
//   import { mountCatalogRoutes } from "./routes/catalog.js";
//   mountCatalogRoutes(v1, deps, { path: "" });   // or mountCatalogRoutes(app, deps)
// `deps` = CatalogDeps (services/catalog.ts): auth + the loaded TemplateCatalog
// + the workspace_templates store + optional limiter/logger. The router is
// mounted at the /v1 root and owns its full sub-paths; mount it BEFORE the
// /v1 catch-all in routes/index.ts so concrete routes win.
//
// Errors: typed envelopes (§13.3). Lookup misses are the gateway-local stable
// codes `unknown_template` / `unknown_component` with the known id@version
// pins in the hint; registration failures use the @studio/config catalog and
// httpStatusFor. Zod failures surface as 422 `validation_failed` via the
// error mapper (W1-H contract).

import { httpStatusFor, isFailure, type Failure } from "@studio/config";
import { Hono, type Context } from "hono";
import { createMiddleware, type MiddlewareHandler } from "hono/factory";
import { z } from "zod";
import { AppError } from "../middleware/error-mapper.js";
import { RATE_LIMIT_HEADERS } from "../middleware/rate-limit.js";
import { subjectBucketKey, type RateLimitDecision } from "../services/limiter.js";
import {
  CATALOG_ID_SCHEMA,
  REGISTER_TEMPLATE_BODY_SCHEMA,
  registerWorkspaceTemplate,
  MAX_QUERY_TAGS,
  type CatalogCaller,
  type CatalogDeps,
  type CatalogFailure,
} from "../services/catalog.js";
import { IDEMPOTENCY_KEY_SCHEMA } from "../services/runs.js";
import type { AppEnv } from "../types.js";

// ---------------------------------------------------------------------------
// Route env + the exported router (runs.ts mount contract)
// ---------------------------------------------------------------------------

/**
 * The catalog router env: the app's shared variables plus the injected
 * service seam. Both variables are optional because a missing injection is
 * a wiring bug this module reports as a typed 500 (§13.3), never a crash.
 */
export interface CatalogEnv {
  Variables: AppEnv["Variables"] & {
    catalogServices?: CatalogDeps;
    catalogCaller?: CatalogCaller;
  };
}

/** The catalog router — mounted at the /v1 root via `mountCatalogRoutes`. */
export const catalogRoutes = new Hono<CatalogEnv>();

/** Reads the injected deps; a missing injection is a typed 500 (§13.3). */
function services(c: Context<CatalogEnv>): CatalogDeps {
  const deps = c.get("catalogServices");
  if (deps === undefined) {
    throw new AppError(500, "internal_error", "The catalog service is not wired.", {
      hint: "Mount catalog routes through mountCatalogRoutes() so services are injected.",
      retryable: false,
    });
  }
  return deps;
}

/** Reads the caller the injected middleware resolved (401 before handlers). */
function requireCaller(c: Context<CatalogEnv>): CatalogCaller {
  const caller = c.get("catalogCaller");
  if (caller === undefined) {
    throw new AppError(500, "internal_error", "The catalog auth pipeline did not run.", {
      hint: "Mount catalog routes through mountCatalogRoutes() so auth middleware runs first.",
      retryable: false,
    });
  }
  return caller;
}

/** Maps a §13.3 failure envelope to the AppError the error mapper renders. */
function failureToAppError(failure: Failure): AppError {
  return new AppError(httpStatusFor(failure.code), failure.code, failure.message, {
    hint: failure.hint,
    retryable: failure.retryable,
  });
}

/** A catalog lookup miss → the 404 unknown_template/unknown_component envelope. */
function throwCatalogFailure(failure: CatalogFailure): never {
  throw new AppError(404, failure.code, failure.message, {
    hint: failure.hint,
    retryable: failure.retryable,
  });
}

/** Parses a JSON body; malformed JSON is a 400 validation envelope. */
async function readJsonObject(c: Context<CatalogEnv>): Promise<unknown> {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    throw new AppError(400, "validation_failed", "The request body must be valid JSON.", {
      hint: "Send Content-Type: application/json with a template manifest object.",
      retryable: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Wire schemas — Zod at the boundary (docs/AGENTS.md)
// ---------------------------------------------------------------------------

/**
 * `?tags=a,b,c` — comma-separated, case-insensitive, AND semantics (a
 * template matches when it carries EVERY tag; engine `template.list`).
 * A parameter that splits down to zero tags is a 422, not "list everything".
 */
export const TAGS_LIST_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .transform((raw) => raw.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0))
  .refine((tags) => tags.length >= 1, {
    message: "pass at least one tag in `tags`, or leave the parameter out to list everything",
  })
  .refine((tags) => tags.length <= MAX_QUERY_TAGS, {
    message: `at most ${MAX_QUERY_TAGS} tags can be filtered on`,
  });

export type TagsList = z.infer<typeof TAGS_LIST_SCHEMA>;

/** `?query=` — a non-empty substring filter over id / name / description. */
const QUERY_PARAM_SCHEMA = z.string().trim().min(1).max(512);

/** `?version=N` — a positive integer pin (§7.2); absent means "the newest". */
const VERSION_QUERY_SCHEMA = z.coerce.number().int().min(1).max(1_000_000_000);

/** The `?tags=&query=` shape the list endpoints accept. */
export const LIST_CATALOG_QUERY_SCHEMA = z.object({
  tags: TAGS_LIST_SCHEMA.optional(),
  query: QUERY_PARAM_SCHEMA.optional(),
});

export type ListCatalogQuery = z.infer<typeof LIST_CATALOG_QUERY_SCHEMA>;

// ---------------------------------------------------------------------------
// Middleware — auth once per request + the per-org rate-limit gate
// ---------------------------------------------------------------------------

/** The per-org catalog policy (§1.5 rule 5). Scope keys rate_limit_buckets. */
export interface CatalogRateLimitPolicy {
  readonly scope: "api.catalog.read";
  readonly limit: number;
  readonly windowSec: number;
}

/** Default: a workspace may burst 120 catalog reads per minute. */
export const DEFAULT_CATALOG_RATE_LIMIT: CatalogRateLimitPolicy = {
  scope: "api.catalog.read",
  limit: 120,
  windowSec: 60,
};

async function chargeOrgBucket(
  c: Context<AppEnv>,
  deps: CatalogDeps,
  caller: CatalogCaller,
  policy: CatalogRateLimitPolicy,
): Promise<void> {
  if (deps.limiter === undefined) {
    return; // no limiter wired (bootstrap without Valkey) — unlimited
  }
  let decision: RateLimitDecision | undefined;
  try {
    decision = await deps.limiter.tokenBucket(
      policy.scope,
      subjectBucketKey({ kind: "org", organizationId: caller.organizationId }),
      { limit: policy.limit, windowSec: policy.windowSec },
    );
  } catch (error) {
    // Fail open (W4-D): the limiter is abuse protection, not a money surface.
    c.get("logger").warn({ err: error }, "catalog rate limiter unavailable — failing open");
  }
  if (decision === undefined) {
    return;
  }
  c.header(RATE_LIMIT_HEADERS.limit, String(policy.limit));
  if (decision.allowed) {
    c.header(RATE_LIMIT_HEADERS.remaining, String(decision.remaining));
    return;
  }
  c.header(RATE_LIMIT_HEADERS.remaining, "0");
  c.header(
    RATE_LIMIT_HEADERS.reset,
    String(Math.floor(Date.now() / 1000) + decision.retryAfterSec),
  );
  c.header("Retry-After", String(decision.retryAfterSec));
  throw new AppError(429, "rate_limited", "Too many catalog requests from this workspace.", {
    hint: "Wait for the cool-down window, then retry (§1.5 rule 5: per-workspace limits).",
    retryable: true,
  });
}

/**
 * Injects deps + caller and enforces the per-org catalog rate limit.
 *
 * Resolution order: authenticate (typed 401/403, runs.ts requireCaller
 * semantics) → charge the org token bucket (when a limiter is wired) →
 * handler. The rate limiter FAILS OPEN on a KV outage (W4-D posture).
 *
 * IDEMPOTENT: the mount registers this middleware on both the exact prefix
 * and its `/*` sub-path (Hono's wildcard may match the bare path too), so the
 * first run's caller/deps variables short-circuit any duplicate registration.
 * Without the guard, auth and the org bucket would be charged twice per GET.
 */
export function catalogMiddleware(
  deps: CatalogDeps,
  policy: CatalogRateLimitPolicy,
): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const env = c as unknown as Context<CatalogEnv>;
    if (env.get("catalogCaller") !== undefined) {
      await next(); // already ran for this request (exact + /* both matched)
      return;
    }
    const result = await deps.auth.authenticate(c.req.raw);
    if (isFailure(result)) {
      throw new AppError(result.code === "forbidden" ? 403 : 401, result.code, result.message, {
        hint: result.hint,
        retryable: result.retryable,
      });
    }
    const caller = result.value;
    env.set("catalogServices", deps);
    env.set("catalogCaller", caller);
    await chargeOrgBucket(c, deps, caller, policy);
    await next();
  });
}

// ---------------------------------------------------------------------------
// GET /v1/templates + /v1/components — discovery cards (§7.4 / §8.3)
// ---------------------------------------------------------------------------

catalogRoutes.get("/templates", async (c) => {
  const deps = services(c);
  requireCaller(c); // auth happened in the middleware; assert the pipeline ran
  const query = LIST_CATALOG_QUERY_SCHEMA.parse(c.req.query());
  return c.json({
    templates: deps.catalog.list({
      ...(query.tags !== undefined ? { tags: query.tags } : {}),
      ...(query.query !== undefined ? { query: query.query } : {}),
    }),
  });
});

catalogRoutes.get("/components", async (c) => {
  const deps = services(c);
  requireCaller(c);
  const query = LIST_CATALOG_QUERY_SCHEMA.parse(c.req.query());
  return c.json({
    components: deps.catalog.listComponents({
      ...(query.tags !== undefined ? { tags: query.tags } : {}),
      ...(query.query !== undefined ? { query: query.query } : {}),
    }),
  });
});

// ---------------------------------------------------------------------------
// GET /v1/templates/:id + /v1/components/:id — full manifests (§13.1)
// ---------------------------------------------------------------------------

catalogRoutes.get("/templates/:id", async (c) => {
  const deps = services(c);
  requireCaller(c);
  const id = CATALOG_ID_SCHEMA.parse(c.req.param("id"));
  const version = VERSION_QUERY_SCHEMA.optional().parse(c.req.query("version"));
  const result = deps.catalog.inspect(id, version);
  if (!result.ok) {
    throwCatalogFailure(result);
  }
  return c.json({ template: result.value });
});

catalogRoutes.get("/components/:id", async (c) => {
  const deps = services(c);
  requireCaller(c);
  const id = CATALOG_ID_SCHEMA.parse(c.req.param("id"));
  const version = VERSION_QUERY_SCHEMA.optional().parse(c.req.query("version"));
  const result = deps.catalog.inspectComponent(id, version);
  if (!result.ok) {
    throwCatalogFailure(result);
  }
  return c.json({ component: result.value });
});

// ---------------------------------------------------------------------------
// POST /v1/workspaces/:id/templates — admin+ workspace registration (§7.2)
// ---------------------------------------------------------------------------

catalogRoutes.post("/workspaces/:id/templates", async (c) => {
  const deps = services(c);
  const caller = requireCaller(c);
  const workspaceId = CATALOG_ID_SCHEMA.parse(c.req.param("id"));

  // §13 preamble: every mutating endpoint requires an Idempotency-Key. The
  // registration body is a manifest — the key travels in the header only, so
  // it can never leak into the stored jsonb document.
  const headerKey = c.req.header("Idempotency-Key")?.trim();
  if (headerKey === undefined || headerKey.length === 0) {
    throw new AppError(
      422,
      "validation_failed",
      "An idempotency key is required to register a template.",
      {
        hint: "Send an Idempotency-Key header (a client-generated UUID) — retries with the " +
          "same key return the same registration.",
        retryable: true,
      },
    );
  }
  IDEMPOTENCY_KEY_SCHEMA.parse(headerKey);

  const manifest = REGISTER_TEMPLATE_BODY_SCHEMA.parse(await readJsonObject(c));
  const result = await registerWorkspaceTemplate(deps, { caller, workspaceId, manifest });
  if (isFailure(result)) {
    throw failureToAppError(result);
  }
  const { row, duplicate } = result.value;
  return c.json(
    {
      id: row.id,
      workspace_id: row.organizationId ?? workspaceId,
      template_id: manifest.id,
      version: row.version,
      license: row.source,
      created_at: row.createdAt.toISOString(),
      duplicate,
    },
    duplicate ? 200 : 201,
  );
});

// ---------------------------------------------------------------------------
// One-call wiring — mount the router + its middleware (runs.ts contract)
// ---------------------------------------------------------------------------

export interface CatalogMountOptions {
  /** Mount root for the catalog paths; defaults to "/v1". */
  readonly path?: string;
  /** Per-org rate-limit policy override (defaults to 120 reads / 60 s). */
  readonly rateLimit?: { readonly limit: number; readonly windowSec: number };
}

/**
 * Wires the catalog surface in one call:
 *
 *   mountCatalogRoutes(app, deps)                  // → /v1/templates, …
 *   mountCatalogRoutes(v1, deps, { path: "" })    // mounted inside /v1
 *
 * The `use` registrations must stay BEFORE the `route` call so the auth +
 * rate-limit middleware runs for every catalog path (exact + sub-paths).
 */
export function mountCatalogRoutes(
  app: Hono<AppEnv>,
  deps: CatalogDeps,
  options: CatalogMountOptions = {},
): void {
  const root = options.path ?? "/v1";
  const policy: CatalogRateLimitPolicy = {
    scope: DEFAULT_CATALOG_RATE_LIMIT.scope,
    limit: options.rateLimit?.limit ?? DEFAULT_CATALOG_RATE_LIMIT.limit,
    windowSec: options.rateLimit?.windowSec ?? DEFAULT_CATALOG_RATE_LIMIT.windowSec,
  };
  const middleware = catalogMiddleware(deps, policy);
  for (const prefix of [`${root}/templates`, `${root}/components`]) {
    app.use(prefix, middleware);
    app.use(`${prefix}/*`, middleware);
  }
  app.use(`${root}/workspaces/:id/templates`, middleware);
  app.route(root, catalogRoutes);
}
