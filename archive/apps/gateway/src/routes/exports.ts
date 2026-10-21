// @studio/gateway — exports + preview routes (§13.1). Owner: W4-L.
//
//   POST /v1/documents/:id/exports   { format: pcraft|png|jpg|psd, width?,
//                                      height?, quality? } → 202
//                                      { export_id, status: "queued" }
//                                      auth → tenant (404==missing, §15.1) →
//                                      exports:create (editor+, ADR-0003) →
//                                      §14.1 MP ceiling → enqueue (jobId =
//                                      Idempotency-Key, §3.4)
//   GET  /v1/documents/:id/exports    past exports for the document
//   GET  /v1/documents/:id/preview?w=1024
//                                    cached preview PNG → signed URL (ttl 900)
//
// All domain semantics live in src/services/exports.ts (MP gate, §2.3 PSD
// warning, idempotent enqueue memo). This file is HTTP only: Zod at the
// boundary, typed failures mapped to §13.3 statuses via httpStatusFor.
//
// WIRING (the routers are consts, per the wave contract):
//   import { mountExportRoutes } from "./routes/exports.js";
//   mountExportRoutes(v1, deps);                        // → /v1/documents/:id/…
//   mountExportRoutes(app, deps, { documentsPath: "/v1/documents" });
// Mount BEFORE the /v1 catch-all in routes/index.ts so concrete routes win,
// and before any /v1/documents/:id wildcard so the deeper paths match first.
//
// SEAM NOTES for the wiring wave:
//   - deps.enqueue: wrap the BullMQ `exports` queue adapter in
//     withIdempotentEnqueue() (services/exports.ts) — same-key replays then
//     return the same job in-process; the broker jobId dedupe is the backstop.
//   - deps.status: NO exports table exists in @studio/db yet (W1-D/F own the
//     schema; tables are not invented by route owners) — the production
//     ExportStatusLike is worker-side TODO wiring; an empty implementation
//     answers GET /exports with 200 [] until then.
//   - deps.previewCache: cache WRITES happen in the worker (W2-N
//     PreviewPipeline renders `renders/…/preview-<w>-<rev>.png` after open/run);
//     the gateway only reads. Until the worker wiring lands, GET /preview
//     answers 404 preview_not_rendered (the documented miss).

import { httpStatusFor, isFailure, type Failure, type PlanId, type Result } from "@studio/config";
import { can, type Role } from "../authz/roles.js";
import { Hono, type Context } from "hono";
import { createMiddleware, type MiddlewareHandler } from "hono/factory";
import { AppError } from "../middleware/error-mapper.js";
import {
  DOCUMENT_ID_SCHEMA,
  EXPORT_CREATE_BODY_SCHEMA,
  EXPORT_LIST_QUERY_SCHEMA,
  IDEMPOTENCY_KEY_SCHEMA,
  PREVIEW_QUERY_SCHEMA,
  createExportJob,
  listExports,
  resolvePreview,
  type ExportCreateBody,
  type ExportsDeps,
} from "../services/exports.js";
import type { AppEnv } from "../types.js";

// ---------------------------------------------------------------------------
// Principal seam (mirrors routes/documents.ts Principal / runs.ts AuthLike —
// the auth wave owns the real resolver; see the RECONCILIATION note there)
// ---------------------------------------------------------------------------

/** The authenticated principal for one request (§14.1 plan + §15.2 role). */
export interface ExportPrincipal {
  readonly organizationId: string;
  readonly userId: string;
  /** Plan drives the §14.1 MP ceiling and is pinned into the export job. */
  readonly plan: PlanId;
  readonly role: Role;
}

/** Resolves the caller from a raw request (session cookie or API key, §13). */
export interface ExportAuthLike {
  authenticate(request: Request): Promise<Result<ExportPrincipal>>;
}

/** The exports router deps: the service aggregate plus the principal resolver. */
export interface ExportRoutesDeps extends ExportsDeps {
  readonly auth: ExportAuthLike;
}

/**
 * The exports/preview router env: the app's shared variables plus the injected
 * deps seam. Optional in the type — a missing injection is a wiring bug
 * reported as a typed 500 (§13.3), never a crash.
 */
export interface ExportsEnv {
  Variables: AppEnv["Variables"] & { exportsServices?: ExportRoutesDeps };
}

/** POST/GET /v1/documents/:id/exports router (mounted via mountExportRoutes). */
export const exportRoutes = new Hono<ExportsEnv>();

/** GET /v1/documents/:id/preview router (mounted via mountExportRoutes). */
export const previewRoutes = new Hono<ExportsEnv>();

/** Reads the injected deps; a missing injection is a typed 500 (§13.3). */
function services(c: Context<ExportsEnv>): ExportRoutesDeps {
  const deps = c.get("exportsServices");
  if (deps === undefined) {
    throw new AppError(500, "internal_error", "The exports service is not wired.", {
      hint: "Mount export routes through mountExportRoutes() so services are injected.",
      retryable: false,
    });
  }
  return deps;
}

/** Maps a §13.3 failure envelope to the AppError the error mapper renders. */
function failureToAppError(failure: Failure): AppError {
  return new AppError(httpStatusFor(failure.code), failure.code, failure.message, {
    hint: failure.hint,
    retryable: failure.retryable,
    docsUrl: failure.docsUrl,
  });
}

/** Resolves the principal; auth failures are typed envelopes (401/403, §15). */
async function requirePrincipal(
  deps: ExportRoutesDeps,
  c: Context<ExportsEnv>,
): Promise<ExportPrincipal> {
  const result = await deps.auth.authenticate(c.req.raw);
  if (isFailure(result)) {
    throw new AppError(result.code === "forbidden" ? 403 : 401, result.code, result.message, {
      hint: result.hint,
      retryable: result.retryable,
    });
  }
  return result.value;
}

/**
 * §15.2 RBAC through the authoritative matrix (src/authz/roles.ts, W4-C) —
 * never a local role list. POST needs `exports:create` (editor+, ADR-0003);
 * the two GETs ride `documents:read` (viewer+).
 */
function requirePermission(
  principal: ExportPrincipal,
  permission: "exports:create" | "documents:read",
): void {
  if (!can(principal.role, permission)) {
    throw new AppError(
      403,
      "forbidden",
      `You do not have permission to perform this action (${permission}).`,
      {
        hint: "This action requires a higher workspace role (§15.2, ADR-0003).",
        retryable: false,
      },
    );
  }
}

/** Parses a required JSON body; malformed JSON is a 400 validation envelope. */
async function readJsonObject(c: Context<ExportsEnv>): Promise<unknown> {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    throw new AppError(400, "validation_failed", "The request body must be valid JSON.", {
      hint: "Send Content-Type: application/json with a JSON object body.",
      retryable: true,
    });
  }
}

/**
 * §13: mutating endpoints require an Idempotency-Key header (or body field —
 * `idempotency_key`, the snake_case wire twin). Both may be sent; they must
 * agree. The key becomes the BullMQ jobId (§3.4: retries cannot double-render).
 */
function resolveIdempotencyKey(c: Context<ExportsEnv>, bodyKey: string | undefined): string {
  const headerKey = c.req.header("Idempotency-Key")?.trim();
  if (headerKey !== undefined && bodyKey !== undefined && headerKey !== bodyKey) {
    throw new AppError(
      422,
      "validation_failed",
      "The Idempotency-Key header and the idempotency_key body field disagree.",
      {
        hint: "Send the key in exactly one place, or make both values equal.",
        retryable: true,
      },
    );
  }
  const resolved = headerKey ?? bodyKey;
  if (resolved === undefined) {
    throw new AppError(
      422,
      "validation_failed",
      "An idempotency key is required to create an export.",
      {
        hint:
          "Send an Idempotency-Key header (a client-generated UUID) — retries with " +
          "the same key return the same export job (§3.4).",
        retryable: true,
      },
    );
  }
  return IDEMPOTENCY_KEY_SCHEMA.parse(resolved);
}

// ---------------------------------------------------------------------------
// POST /v1/documents/:id/exports — §13.1 job → URL
// ---------------------------------------------------------------------------

exportRoutes.post("/", async (c) => {
  const deps = services(c);
  const principal = await requirePrincipal(deps, c);
  requirePermission(principal, "exports:create");

  const body: ExportCreateBody = EXPORT_CREATE_BODY_SCHEMA.parse(await readJsonObject(c));
  const idempotencyKey = resolveIdempotencyKey(c, body.idempotency_key);

  const result = await createExportJob(deps, {
    organizationId: principal.organizationId,
    documentId: DOCUMENT_ID_SCHEMA.parse(c.req.param("id")),
    body,
    idempotencyKey,
    requestId: c.get("requestId"),
    plan: principal.plan,
  });
  if (isFailure(result)) {
    throw failureToAppError(result);
  }
  const queued = result.value;
  return c.json(
    {
      export_id: queued.exportId,
      status: queued.status,
      revision: queued.revision,
      // §2.3: psd answers with the experimental warning text; [] otherwise.
      warnings: queued.warnings,
    },
    202,
  );
});

// ---------------------------------------------------------------------------
// GET /v1/documents/:id/exports — past export jobs (worker-side TODO store)
// ---------------------------------------------------------------------------

exportRoutes.get("/", async (c) => {
  const deps = services(c);
  const principal = await requirePrincipal(deps, c);
  requirePermission(principal, "documents:read");

  const query = EXPORT_LIST_QUERY_SCHEMA.parse(c.req.query());
  const result = await listExports(deps, {
    organizationId: principal.organizationId,
    documentId: DOCUMENT_ID_SCHEMA.parse(c.req.param("id")),
    limit: query.limit,
  });
  if (isFailure(result)) {
    throw failureToAppError(result);
  }
  return c.json(result.value);
});

// ---------------------------------------------------------------------------
// GET /v1/documents/:id/preview?w=1024 — cached preview behind a signed URL
// ---------------------------------------------------------------------------

previewRoutes.get("/", async (c) => {
  const deps = services(c);
  const principal = await requirePrincipal(deps, c);
  requirePermission(principal, "documents:read");

  const query = PREVIEW_QUERY_SCHEMA.parse(c.req.query());
  const result = await resolvePreview(deps, {
    organizationId: principal.organizationId,
    documentId: DOCUMENT_ID_SCHEMA.parse(c.req.param("id")),
    width: query.w,
  });
  if (isFailure(result)) {
    throw failureToAppError(result);
  }
  const resolved = result.value;
  if (!resolved.found) {
    // Route-local add-only stable code (§13.3 discipline) — flagged for the
    // @studio/config catalog owner to adopt; the shared catalog is add-only.
    throw new AppError(
      404,
      "preview_not_rendered",
      "No preview has been rendered for this document at the requested size yet.",
      {
        hint:
          "Open the document in the editor or run an edit first — the worker renders " +
          "and caches previews after the first open or run (§13.1), then this " +
          "endpoint serves a signed URL.",
        retryable: true,
      },
    );
  }
  // 200 + Location: API clients read the JSON; browsers may follow the header.
  c.header("Location", resolved.url);
  return c.json(
    {
      url: resolved.url,
      revision: resolved.revision,
      expires_at: new Date(resolved.expiresAt).toISOString(),
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// Injection seam — middleware + one-call wiring helper
// ---------------------------------------------------------------------------

/**
 * Middleware that injects the exports route deps (services + auth resolver).
 * Typed against the shared AppEnv so it mounts on the standard app (buildApp /
 * the /v1 registry); the single context variable it writes is declared by
 * ExportsEnv. (AppEnv cannot know this router's variable, hence the one local
 * cast — same pattern as routes/runs.ts, W4-G.)
 */
export function exportsServices(deps: ExportRoutesDeps): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    (c as unknown as Context<ExportsEnv>).set("exportsServices", deps);
    await next();
  });
}

/**
 * Wires both routers in one call — the only supported mount:
 *
 *   mountExportRoutes(app, deps)                          // → /v1/documents/:id/…
 *   mountExportRoutes(v1, deps, { documentsPath: "/v1/documents" })
 *
 * The `use` registrations cover the bare path and every sub-path, and stay
 * BEFORE the route calls (Hono matches middleware in registration order).
 */
export function mountExportRoutes(
  app: Hono<AppEnv>,
  deps: ExportRoutesDeps,
  options?: { readonly documentsPath?: string },
): void {
  const documentsPath = options?.documentsPath ?? "/v1/documents";
  const exportsPath = `${documentsPath}/:id/exports`;
  const previewPath = `${documentsPath}/:id/preview`;
  for (const path of [exportsPath, previewPath]) {
    app.use(path, exportsServices(deps));
    app.use(`${path}/*`, exportsServices(deps));
  }
  app.route(exportsPath, exportRoutes);
  app.route(previewPath, previewRoutes);
}
