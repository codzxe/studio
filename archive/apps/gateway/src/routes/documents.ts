// Document routes (§13.1): create, paged list, read, rename/archive, soft
// delete, version timeline, restore-as-new-version. Owner: W4-F.
//
//   POST   /v1/documents                                create (templateId? → §7 catalog)
//   GET    /v1/documents?cursor=&limit=&include_archived=  paged list (newest first)
//   GET    /v1/documents/:id                            metadata + latest version
//   PATCH  /v1/documents/:id                             rename / archive / unarchive
//   DELETE /v1/documents/:id                            archive semantics (soft delete, §12.2)
//   GET    /v1/documents/:id/versions                   timeline ascending (§10.4)
//   POST   /v1/documents/:id/versions/:versionId/restore  restore AS A NEW VERSION (§10.4)
//
// MOUNTING (composition root / routes/index.ts owner): mount the value of
// `withDocumentDeps(deps)` — it wraps `documentRoutes` with the deps middleware:
//
//   v1.route("/documents", withDocumentDeps(documentRoutesDeps(db, …)));
//
// Alternatively `v1.use("/documents/*", documentDepsMiddleware(deps))` before
// `v1.route("/documents", documentRoutes)` also works (Hono shares one Context
// across mounts, so the variable set by the parent middleware is readable
// here). Handlers fail closed with a typed 500 when deps are missing.
//
// RECONCILIATION (authz, W4-B/W4-C — landed mid-task): src/authz/{roles,
// matrix,guard}.ts + middleware/auth-context.ts are the authoritative RBAC
// layer. Mutations here enforce `documents:write` through the authoritative
// matrix (`can()`, src/authz/roles.ts) — never a local role list. The
// `PrincipalResolver` seam below mirrors services/runs.ts `AuthLike`
// (W4-G) and adds `plan` (canvas MP ceiling needs it, §14.1 — caps.ts takes
// plan the same way); the wiring wave composes one adapter over W4-A's
// session/API-key resolvers + the subscriptions plan lookup. The §12.2 tenant
// enforcement stays in the service's composite org-scoped queries (guard.ts
// rule 1: lookups stay 404), with guard.assertTenant/assertDocAccess available
// for any path that fetches a resource before scoping.
//
// TODO (idempotency owner, §13 preamble): mutating handlers read the
// Idempotency-Key header and record it in the audit trail; replay/dedup over
// the `idempotency_keys` table (§12.1) is the middleware's to wrap here.
//
// Errors: typed flat envelopes `{ ok:false, code, message, hint?, retryable }`
// (docs/AGENTS.md + middleware/error-mapper.ts). Service failures use the
// @studio/config stable code catalog and are mapped here with its
// code → status table; schema failures surface as ZodError → 422
// `validation_failed` with field details (W1-H contract).

import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { httpStatusFor, type Failure, type PlanId, type Result } from "@studio/config";
import { can, type Role } from "../authz/roles.js";
import { AppError } from "../middleware/error-mapper.js";
import type { AppEnv } from "../types.js";
import type { Document, DocumentVersion } from "@studio/db";
import {
  MAX_DOCUMENTS_PAGE_SIZE,
  MAX_DOCUMENT_SIDE_PX,
  MAX_VERSIONS_LIMIT,
  DEFAULT_DOCUMENTS_PAGE_SIZE,
  DEFAULT_VERSIONS_LIMIT,
  createDocument,
  getDocument,
  getLatestDocumentVersion,
  listDocumentVersions,
  listDocuments,
  restoreVersion,
  updateDocument,
  type DocumentsServiceDeps,
  type TemplateCatalogLike,
  type StorageLike,
  type DocumentsStore,
} from "../services/documents.js";

// ---------------------------------------------------------------------------
// Principal seam (mirrors services/runs.ts AuthLike — see RECONCILIATION above)
// ---------------------------------------------------------------------------

/** Workspace RBAC ladder (§15.2) — alias of authz/roles.ts `Role`. */
export type MemberRole = Role;

/** The authenticated principal for one request (§14.1 plan + §15.2 role). */
export interface Principal {
  readonly organizationId: string;
  readonly userId: string;
  /** Plan drives the canvas MP ceiling (§14.1 via @studio/config PLAN_LIMITS). */
  readonly plan: PlanId;
  readonly role: Role;
}

/** Resolves the caller from the raw request (session cookie or API key, §13). */
export interface PrincipalResolver {
  authenticate(request: Request): Promise<Result<Principal>>;
}

/** Documents router deps: the service deps plus the principal resolver. */
export interface DocumentRoutesDeps extends DocumentsServiceDeps {
  readonly auth: PrincipalResolver;
}

/** Env with the injected deps variable (composition-root middleware sets it). */
export type DocumentsEnv = {
  Variables: AppEnv["Variables"] & { documentDeps: DocumentRoutesDeps | undefined };
};

// ---------------------------------------------------------------------------
// The router (§13.1 documents). Handlers pull deps from the shared context —
// see the MOUNTING note in the header.
// ---------------------------------------------------------------------------

export const documentRoutes = new Hono<DocumentsEnv>();

/** Middleware that injects the deps; registered by withDocumentDeps or the root. */
export function documentDepsMiddleware(deps: DocumentRoutesDeps): MiddlewareHandler<DocumentsEnv> {
  return createMiddleware<DocumentsEnv>(async (c, next) => {
    c.set("documentDeps", deps);
    await next();
  });
}

/** The blessed mount: deps middleware + documentRoutes, ready for `.route()`. */
export function withDocumentDeps(deps: DocumentRoutesDeps): Hono<DocumentsEnv> {
  const app = new Hono<DocumentsEnv>();
  app.use(documentDepsMiddleware(deps));
  app.route("/", documentRoutes);
  return app;
}

function requireDeps(c: Context<DocumentsEnv>): DocumentRoutesDeps {
  const deps = c.get("documentDeps");
  if (deps === undefined) {
    // Fail closed — never run a handler against missing dependencies.
    throw new AppError(500, "internal_error", "Documents routes are mounted without dependencies.", {
      hint: "Mount withDocumentDeps(deps) (apps/gateway/src/routes/documents.ts) at the composition root.",
      retryable: false,
    });
  }
  return deps;
}

/** Re-exports of the service seams so the composition root imports one module. */
export type { DocumentsStore, StorageLike, TemplateCatalogLike };

/** Convenience alias matching the injected drizzle store builder. */
export {
  drizzleDocumentsStore,
  DOCUMENT_CREATE_COMMAND_NAME,
  INITIAL_VERSION_LABEL,
} from "../services/documents.js";

// ---------------------------------------------------------------------------
// Request schemas (Zod at every boundary, §4)
// ---------------------------------------------------------------------------

const documentNameSchema = z.string().trim().min(1).max(200);

/** `"id"` or `"id@version"` (§5.5; mirrors the engine template resolver rules). */
const templateRefSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(@[0-9]{1,19})?$/,
    'template_id must be "id" or "id@version" (alphanumerics, ".", "_", "-")',
  );

const createBodySchema = z
  .object({
    name: documentNameSchema,
    width: z.number().int().min(1).max(MAX_DOCUMENT_SIDE_PX),
    height: z.number().int().min(1).max(MAX_DOCUMENT_SIDE_PX),
    templateId: templateRefSchema.optional(),
    // §13.1 spells the body key `template` ("instagram-post@3") — accepted as
    // an alias; template_id wins when both are sent and must then agree.
    template: templateRefSchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.templateId === undefined || body.template === undefined || body.templateId === body.template,
    { message: "Provide template_id or template, not two different values." },
  );

const patchBodySchema = z
  .object({
    name: documentNameSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.archived !== undefined, {
    message: "Provide at least one field to update: name or archived.",
  });

const listQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_DOCUMENTS_PAGE_SIZE)
      .default(DEFAULT_DOCUMENTS_PAGE_SIZE),
    include_archived: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .strict();

const versionsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_VERSIONS_LIMIT)
      .default(DEFAULT_VERSIONS_LIMIT),
  })
  .strict();

const idParamSchema = z.string().min(1).max(128);
const versionIdParamSchema = z.string().min(1).max(128);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maps a service failure envelope onto the HTTP error contract (§13.3). */
function throwAppError(failure: Failure): never {
  throw new AppError(httpStatusFor(failure.code), failure.code, failure.message, {
    hint: failure.hint,
    retryable: failure.retryable,
    docsUrl: failure.docsUrl,
  });
}

async function requirePrincipal(
  deps: DocumentRoutesDeps,
  c: Context<DocumentsEnv>,
): Promise<Principal> {
  const result = await deps.auth.authenticate(c.req.raw);
  if (!result.ok) {
    // 401 unauthorized / 403 forbidden per the resolver's stable code.
    throwAppError(result);
  }
  return result.value;
}

/**
 * §15.2: document mutations need `documents:write` — enforced through the
 * authoritative RBAC matrix (src/authz/roles.ts, W4-C), never a local role
 * list, so this can never drift from ADR-0003.
 */
function requireMutator(principal: Principal): void {
  if (!can(principal.role, "documents:write")) {
    throw new AppError(403, "forbidden", "You do not have permission to modify documents.", {
      hint: 'This action requires the "documents:write" permission (editor or above, §15.2).',
      retryable: false,
    });
  }
}

/**
 * assertDocAccess — composite org-scoped fetch (§12.2: never find-then-check).
 * Unknown and cross-tenant ids both answer not_found (§13.3: never confirm
 * existence to strangers). Used by every /:id… handler.
 */
export async function assertDocAccess(
  deps: DocumentsServiceDeps,
  principal: Principal,
  documentId: string,
): Promise<Result<Document>> {
  return getDocument(deps, {
    documentId,
    organizationId: principal.organizationId,
  });
}

async function parseBody<S extends z.ZodType<unknown, z.ZodTypeDef, unknown>>(
  c: Context<DocumentsEnv>,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError(400, "validation_failed", "The request body is not valid JSON.", {
      retryable: false,
    });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw parsed.error; // → 422 validation_failed + details (error-mapper)
  }
  return parsed.data;
}

function parseQuery<S extends z.ZodType<unknown, z.ZodTypeDef, unknown>>(
  c: Context<DocumentsEnv>,
  schema: S,
): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}

function parseParam(value: string | undefined, schema: z.ZodString): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}

function idempotencyKey(c: Context<DocumentsEnv>): string | undefined {
  return c.req.header("Idempotency-Key") ?? undefined;
}

// ---------------------------------------------------------------------------
// DTO mappers — snake_case wire fields (§13.1); internal ids like storage keys
// and checkpoint refs never leave the box (§13.3).
// ---------------------------------------------------------------------------

function toDocumentDto(document: Document) {
  return {
    id: document.id,
    name: document.name,
    width_px: document.widthPx,
    height_px: document.heightPx,
    current_revision: document.currentRevision,
    template_id: document.templateId,
    created_by: document.createdBy,
    created_at: document.createdAt.toISOString(),
    updated_at: document.updatedAt.toISOString(),
    archived_at: document.archivedAt === null ? null : document.archivedAt.toISOString(),
  };
}

function toVersionDto(version: DocumentVersion) {
  return {
    id: version.id,
    revision: version.revision,
    label: version.label,
    created_by: version.createdBy,
    created_at: version.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

documentRoutes.post("/", async (c) => {
  const deps = requireDeps(c);
  const principal = await requirePrincipal(deps, c);
  requireMutator(principal);
  const body = await parseBody(c, createBodySchema);
  const result = await createDocument(deps, {
    organizationId: principal.organizationId,
    userId: principal.userId,
    plan: principal.plan,
    name: body.name,
    width: body.width,
    height: body.height,
    templateRef: body.templateId ?? body.template,
    idempotencyKey: idempotencyKey(c),
  });
  if (!result.ok) {
    throwAppError(result);
  }
  c.header("Location", `/v1/documents/${result.value.document.id}`);
  return c.json(
    {
      ok: true,
      document: toDocumentDto(result.value.document),
      version: toVersionDto(result.value.version),
    },
    201,
  );
});

documentRoutes.get("/", async (c) => {
  const deps = requireDeps(c);
  const principal = await requirePrincipal(deps, c);
  const query = parseQuery(c, listQuerySchema);
  const result = await listDocuments(deps, {
    organizationId: principal.organizationId,
    cursor: query.cursor,
    limit: query.limit,
    includeArchived: query.include_archived,
  });
  if (!result.ok) {
    throwAppError(result);
  }
  return c.json({
    ok: true,
    documents: result.value.documents.map(toDocumentDto),
    next_cursor: result.value.nextCursor,
  });
});

documentRoutes.get("/:id", async (c) => {
  const deps = requireDeps(c);
  const principal = await requirePrincipal(deps, c);
  const documentId = parseParam(c.req.param("id"), idParamSchema);
  const access = await assertDocAccess(deps, principal, documentId);
  if (!access.ok) {
    throwAppError(access);
  }
  const latest = await getLatestDocumentVersion(deps, {
    documentId,
    organizationId: principal.organizationId,
  });
  if (!latest.ok) {
    throwAppError(latest);
  }
  return c.json({
    ok: true,
    document: {
      ...toDocumentDto(access.value),
      latest_version: latest.value === null ? null : toVersionDto(latest.value),
    },
  });
});

documentRoutes.patch("/:id", async (c) => {
  const deps = requireDeps(c);
  const principal = await requirePrincipal(deps, c);
  requireMutator(principal);
  const documentId = parseParam(c.req.param("id"), idParamSchema);
  const body = await parseBody(c, patchBodySchema);
  const result = await updateDocument(deps, {
    organizationId: principal.organizationId,
    userId: principal.userId,
    documentId,
    name: body.name,
    archived: body.archived,
    idempotencyKey: idempotencyKey(c),
  });
  if (!result.ok) {
    throwAppError(result);
  }
  return c.json({ ok: true, document: toDocumentDto(result.value) });
});

// DELETE has archive semantics (§12.2 soft delete + §22 audit trail); the
// GDPR hard-delete job owns true removal. Idempotent: deleting an already
// archived document returns it unchanged with no extra audit noise.
documentRoutes.delete("/:id", async (c) => {
  const deps = requireDeps(c);
  const principal = await requirePrincipal(deps, c);
  requireMutator(principal);
  const documentId = parseParam(c.req.param("id"), idParamSchema);
  const result = await updateDocument(deps, {
    organizationId: principal.organizationId,
    userId: principal.userId,
    documentId,
    archived: true,
    idempotencyKey: idempotencyKey(c),
  });
  if (!result.ok) {
    throwAppError(result);
  }
  return c.json({ ok: true, document: toDocumentDto(result.value) });
});

documentRoutes.get("/:id/versions", async (c) => {
  const deps = requireDeps(c);
  const principal = await requirePrincipal(deps, c);
  const documentId = parseParam(c.req.param("id"), idParamSchema);
  const query = parseQuery(c, versionsQuerySchema);
  const result = await listDocumentVersions(deps, {
    organizationId: principal.organizationId,
    documentId,
    limit: query.limit,
  });
  if (!result.ok) {
    throwAppError(result);
  }
  return c.json({
    ok: true,
    versions: result.value.versions.map(toVersionDto),
  });
});

// Restore AS A NEW VERSION (§10.4): the source row and its bytes are never
// mutated; a fresh version row (revision = current + 1) is appended and
// becomes the head. Commands/undo-redo routes are W4-K's.
documentRoutes.post("/:id/versions/:versionId/restore", async (c) => {
  const deps = requireDeps(c);
  const principal = await requirePrincipal(deps, c);
  requireMutator(principal);
  const documentId = parseParam(c.req.param("id"), idParamSchema);
  const versionId = parseParam(c.req.param("versionId"), versionIdParamSchema);
  const result = await restoreVersion(deps, {
    organizationId: principal.organizationId,
    userId: principal.userId,
    documentId,
    versionId,
    idempotencyKey: idempotencyKey(c),
  });
  if (!result.ok) {
    throwAppError(result);
  }
  return c.json(
    {
      ok: true,
      document: toDocumentDto(result.value.document),
      version: toVersionDto(result.value.version),
      bytes_stored: result.value.bytesStored,
    },
    201,
  );
});
