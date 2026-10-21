// @studio/gateway — §22 audit export + admin summary routes. Owner: W9-H.
//
//   GET /v1/workspaces/:id/audit   admin+ — cursor-paged §22 export for ONE
//                                  workspace (?from/?to inclusive ISO-8601-Z
//                                  bounds, ?cursor, ?limit 1..500). The §22
//                                  "exportable per workspace" requirement:
//                                  ?format=csv returns the SAME rows as an
//                                  RFC 4180 text/csv download (continuation
//                                  cursor travels in the X-Next-Cursor header).
//   GET /v1/audit/summary/:id       admin+ — counts by action over the last
//                                  30 days; the admin support-tooling landing
//                                  card (§16.3 better-auth admin plugin
//                                  consumers — see routes/audit.README.md).
//
// Thin by contract: this module owns RBAC (admin+), the tenant guard and wire
// encoding ONLY. Filtering, window validation and cursor math live in the W4-Q
// AuditService (../services/audit.ts) — `deps.audit` is satisfied structurally
// by `new AuditService({ store: new DrizzleAuditStore(db) })`.
//
// Spec anchors:
//   §22    audit_log: auth events, role changes, API keys, exports, deletes,
//          credit adjustments — immutable (append-only) and EXPORTABLE PER
//          WORKSPACE; the summary is the support "what happened lately" card.
//   §15.1  tenant scoping: the trail of workspace :id is a tenant-scoped
//          resource; the authz guard's assertTenant refuses foreign
//          organizations with the DISTINCT cross_tenant_denied envelope
//          (never 404-masked, guard.ts seam contract).
//   §15.2  RBAC enforced server-side on every endpoint, via the authz guard —
//          never a local role list. Admin+ below.
//   §16.3  better-auth `admin` plugin = support tooling; its impersonation
//          events are expected to land in audit_log (wiring note in README).
//   §13.3  typed envelopes for every failure (error-mapper renders AppError;
//          service failures keep their own typed codes on the wire).
//
// RBAC DECISION (admin+): the authoritative ADR-0003 matrix (src/authz/
// roles.ts, W4-C) has NO audit permission row yet, and a permission may never
// be invented locally (matrix.ts + tests/authz.test.ts fail CI on drift).
// The gate therefore uses guard.assertCan(role, "members:manage") — the
// admin-tier workspace-security capability the matrix does grant (audit rows
// ARE the member/role/api-key security history, §22). assertCan ALSO enforces
// API-key scope narrowing, so an admin's narrowly-scoped key cannot bulk
// export the security log. If the matrix grows "audit:read", swap
// AUDIT_GATE_PERMISSION — one line, one place.
//
// WIRING (routers are consts, per the wave contract — mirror of credits.ts):
//   mountAuditRoutes(app, deps);                    // /v1/workspaces/:id/audit
//                                                   // + /v1/audit/summary/:id
//   mountAuditRoutes(v1, deps, { workspacesPath: "/workspaces",
//                                auditPath: "/audit" });  // inside the /v1 app
// Mount BEFORE the /v1 catch-all (routes/index.ts). Production adapters for
// the two service seams are sketched in routes/audit.README.md.

import { isFailure, type Result } from "@studio/config";
import { Hono, type Context } from "hono";
import { createMiddleware, type MiddlewareHandler } from "hono/factory";
import { z } from "zod";
import { createResourceGuard, type GuardContext, type TypedResourceGuard } from "../authz/guard.js";
import type { Permission, Role } from "../authz/roles.js";
import { AppError } from "../middleware/error-mapper.js";
import {
  DEFAULT_EXPORT_PAGE_SIZE,
  MAX_EXPORT_PAGE_SIZE,
  type AuditExportErrorCode,
  type AuditExportQuery,
  type AuditExportResult,
  type AuditExportRow,
} from "../services/audit.js";
import type { AppEnv } from "../types.js";

// ---------------------------------------------------------------------------
// Env + deps seam
// ---------------------------------------------------------------------------

/**
 * The audit router env: the app's shared variables plus the injected service
 * seam. `auditServices` is optional in the type because a missing injection
 * is a wiring bug this module reports as a typed 500 (§13.3) — credits.ts
 * precedent.
 */
export interface AuditEnv {
  Variables: AppEnv["Variables"] & { auditServices?: AuditRoutesDeps };
}

/**
 * The authenticated caller. Structurally the authz GuardContext
 * ({ userId, organizationId, role, permissions }) so it flows straight into
 * guard.assertCan / guard.assertTenant — member sessions carry
 * PERMISSIONS[role]; API-key sessions carry the key's scope intersection
 * (never wider than the creating member, ADR-0003).
 */
export interface AuditRouteCaller extends GuardContext {
  /** Convenience alias so `role` reads as the workspace role ladder. */
  readonly role: Role;
}

/**
 * Auth seam (parallel contract with credits.ts CreditsAuthLike): resolves
 * the caller. `unauthorized` failures render 401, `forbidden` renders 403.
 */
export interface AuditAuthLike {
  authenticate(request: Request): Promise<Result<AuditRouteCaller>>;
}

/**
 * §22 export seam — satisfied structurally by the W4-Q AuditService
 * (`export(organizationId, query)`), so the wiring wave passes the same
 * instance the rest of the gateway appends through.
 */
export interface AuditExportLike {
  export(organizationId: string, query?: AuditExportQuery): Promise<AuditExportResult>;
}

/**
 * Counts-by-action read for the 30-day summary card. The W4-Q service owns
 * append + paged export only, so the grouped count is its own tiny seam
 * (production adapter sketch in routes/audit.README.md):
 *
 *   SELECT action, count(*) FROM audit_log
 *   WHERE organization_id = :org AND created_at >= :since
 *   GROUP BY action
 */
export interface AuditActionCountsLike {
  countsByAction(query: {
    readonly organizationId: string;
    readonly since: Date;
  }): Promise<Readonly<Record<string, number>>>;
}

/**
 * The service aggregate injected into the routes (one object, one variable).
 * `now` is a test seam (epoch ms, credits.ts precedent); default Date.now.
 */
export interface AuditRoutesDeps {
  readonly auth: AuditAuthLike;
  readonly audit: AuditExportLike;
  readonly summary: AuditActionCountsLike;
  /** Injectable epoch-ms clock; deterministic tests freeze it. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// RBAC + policy constants
// ---------------------------------------------------------------------------

/**
 * The admin+ gate permission (see the RBAC DECISION header note). Swap to a
 * dedicated matrix permission if/when ADR-0003 grows one — one place only.
 */
export const AUDIT_GATE_PERMISSION: Permission = "members:manage";

/** Summary window: "counts by action 30d" (§22 support landing card). */
export const SUMMARY_WINDOW_DAYS = 30;

/** Header carrying the continuation cursor on CSV responses (bodies are raw). */
export const CSV_NEXT_CURSOR_HEADER = "X-Next-Cursor";

/** Path param bound — mirrors the service's organizationId isRef check (§12.2). */
export const WORKSPACE_ID_SCHEMA = z.string().min(1).max(64);

// ---------------------------------------------------------------------------
// Wire schemas (Zod at every boundary)
// ---------------------------------------------------------------------------

/**
 * GET /v1/workspaces/:id/audit query. Non-strict: extra params are ignored.
 * `from`/`to` are inclusive, UTC ISO-8601 with a `Z` anchor; the service
 * re-validates the window (from ≤ to) and the cursor.
 */
export const AUDIT_EXPORT_QUERY_SCHEMA = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_EXPORT_PAGE_SIZE)
    .default(DEFAULT_EXPORT_PAGE_SIZE),
});

export type AuditExportQueryWire = z.infer<typeof AUDIT_EXPORT_QUERY_SCHEMA>;

// ---------------------------------------------------------------------------
// Service failure mapping (§13.3 — typed codes pass through verbatim)
// ---------------------------------------------------------------------------

type AuditExportFailure = Extract<AuditExportResult, { ok: false }>;

/**
 * Wire status per service failure code. Invalid input shapes (org/window/
 * cursor) are 422s; storage_unavailable is the only retryable one (503 —
 * the table itself is untouched, append-only §22).
 */
const EXPORT_FAILURE_STATUS: Readonly<Record<AuditExportErrorCode, number>> = {
  invalid_org: 422,
  invalid_window: 422,
  invalid_cursor: 422,
  storage_unavailable: 503
};

function exportFailureToAppError(failure: AuditExportFailure): AppError {
  return new AppError(EXPORT_FAILURE_STATUS[failure.code], failure.code, failure.message, {
    hint: failure.hint,
    retryable: failure.retryable
  });
}

// ---------------------------------------------------------------------------
// Shared handler helpers
// ---------------------------------------------------------------------------

/** Reads the injected services; a missing injection is a typed 500 (§13.3). */
function services(c: Context<AuditEnv>): AuditRoutesDeps {
  const deps = c.get("auditServices");
  if (deps === undefined) {
    throw new AppError(500, "internal_error", "The audit service is not wired.", {
      hint: "Mount the audit routes through mountAuditRoutes() so services are injected.",
      retryable: false
    });
  }
  return deps;
}

/** Resolves the caller; auth failures are typed envelopes (401/403, §15). */
async function requireCaller(deps: AuditRoutesDeps, request: Request): Promise<AuditRouteCaller> {
  const result = await deps.auth.authenticate(request);
  if (isFailure(result)) {
    throw new AppError(result.code === "forbidden" ? 403 : 401, result.code, result.message, {
      hint: result.hint,
      retryable: result.retryable
    });
  }
  return result.value;
}

/** Per-request authz guard (§22 correlation: request-scoped logger + request id). */
function guardFor(c: Context<AuditEnv>): TypedResourceGuard {
  return createResourceGuard({ logger: c.get("logger"), requestId: c.get("requestId") });
}

/** Admin+ RBAC gate + §15.1 tenant guard for one workspace-scoped handler. */
function assertAuditAccess(
  guard: TypedResourceGuard,
  caller: AuditRouteCaller,
  workspaceId: string,
): void {
  guard.assertCan(caller.role, AUDIT_GATE_PERMISSION, caller);
  // The audit trail of workspace `workspaceId` IS a tenant-scoped resource:
  // a foreign or empty id fails closed with the DISTINCT cross_tenant_denied
  // envelope (guard.ts seam contract; §20 #11 cross-tenant suite greps it).
  guard.assertTenant({ organizationId: workspaceId }, caller);
}

// ---------------------------------------------------------------------------
// CSV wire codec (RFC 4180) — §22 "exportable per workspace"
// ---------------------------------------------------------------------------

/** Column order of the CSV export (AuditExportRow wire fields). */
export const AUDIT_CSV_COLUMNS = [
  "id",
  "organization_id",
  "actor_id",
  "action",
  "target",
  "metadata",
  "created_at"
] as const;

/**
 * RFC 4180 field escaping: quote a field iff it contains a comma, a double
 * quote, CR or LF; embedded quotes are doubled. Tabs and spaces are safe
 * unquoted.
 */
export function csvEscapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * metadata is exported as ONE JSON cell (compact) — it was redacted at
 * append time by policy (§15.3), so it is exported verbatim; null/undefined
 * metadata exports as an empty cell.
 */
function metadataCell(metadata: unknown): string {
  return metadata === null || metadata === undefined ? "" : JSON.stringify(metadata);
}

/**
 * The SAME rows the JSON page serves, as RFC 4180 text: one header row, one
 * data row per audit event, CRLF line breaks, trailing CRLF. Empty pages
 * still download as a header-only file.
 */
export function auditRowsToCsv(rows: readonly AuditExportRow[]): string {
  const lines: string[] = [AUDIT_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const fields = [
      row.id,
      row.organization_id ?? "",
      row.actor_id ?? "",
      row.action,
      row.target,
      metadataCell(row.metadata),
      row.created_at
    ];
    lines.push(fields.map(csvEscapeField).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Download filename — no internal ids in the name (§15.2 envelope hygiene). */
function csvFilename(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  return `audit-export-${stamp}.csv`;
}

// ---------------------------------------------------------------------------
// Routers (consts, per the wave contract)
// ---------------------------------------------------------------------------

export const workspaceAuditRoutes = new Hono<AuditEnv>();
export const auditSummaryRoutes = new Hono<AuditEnv>();

// ---------------------------------------------------------------------------
// GET /v1/workspaces/:id/audit — §22 export page (JSON or CSV)
// ---------------------------------------------------------------------------

workspaceAuditRoutes.get("/:id/audit", async (c) => {
  const deps = services(c);
  const caller = await requireCaller(deps, c.req.raw);
  const guard = guardFor(c);
  const workspaceId = WORKSPACE_ID_SCHEMA.parse(c.req.param("id"));
  assertAuditAccess(guard, caller, workspaceId);

  const query = AUDIT_EXPORT_QUERY_SCHEMA.parse(c.req.query());
  const result = await deps.audit.export(workspaceId, {
    from: query.from !== undefined ? new Date(query.from) : undefined,
    to: query.to !== undefined ? new Date(query.to) : undefined,
    cursor: query.cursor,
    limit: query.limit
  });
  if (!result.ok) {
    throw exportFailureToAppError(result);
  }

  if (query.format === "csv") {
    // §22 export download: identical rows, identical window/cursor semantics.
    // The body is raw text, so the continuation cursor rides a header.
    const nowMs = deps.now?.() ?? Date.now();
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${csvFilename(nowMs)}"`);
    if (result.nextCursor !== undefined) {
      c.header(CSV_NEXT_CURSOR_HEADER, result.nextCursor);
    }
    return c.body(auditRowsToCsv(result.rows));
  }

  return c.json({
    rows: result.rows,
    ...(result.nextCursor !== undefined ? { next_cursor: result.nextCursor } : {})
  });
});

// ---------------------------------------------------------------------------
// GET /v1/audit/summary/:id — counts by action, last 30 days (admin tooling)
// ---------------------------------------------------------------------------

auditSummaryRoutes.get("/summary/:id", async (c) => {
  const deps = services(c);
  const caller = await requireCaller(deps, c.req.raw);
  const guard = guardFor(c);
  const workspaceId = WORKSPACE_ID_SCHEMA.parse(c.req.param("id"));
  assertAuditAccess(guard, caller, workspaceId);

  const nowMs = deps.now?.() ?? Date.now();
  const since = new Date(nowMs - SUMMARY_WINDOW_DAYS * 86_400_000);
  const counts = await deps.summary.countsByAction({ organizationId: workspaceId, since });

  // Deterministic + fail closed: a malformed summary adapter drops its bad
  // entries instead of 500-ing the support card (§13.3 envelope hygiene).
  const entries = Object.entries(counts)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([action, value]): [string, number] => [action, Math.floor(value as number)]
    );
  const total = entries.reduce((sum, [, count]) => sum + count, 0);

  return c.json({
    window_days: SUMMARY_WINDOW_DAYS,
    since: since.toISOString(),
    total_events: total,
    by_action: Object.fromEntries(entries)
  });
});

// ---------------------------------------------------------------------------
// Injection seam — middleware + one-call wiring helper
// ---------------------------------------------------------------------------

/**
 * Middleware that injects the audit service seam. Typed against the shared
 * AppEnv so it mounts on the standard app (buildApp / the /v1 registry);
 * the single context variable it writes is declared by AuditEnv.
 */
export function auditServices(deps: AuditRoutesDeps): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    (c as unknown as Context<AuditEnv>).set("auditServices", deps);
    await next();
  });
}

/**
 * Wires both audit routers in one call — the only supported mount:
 *
 *   mountAuditRoutes(app, deps)          // /v1/workspaces/:id/audit
 *                                        // + /v1/audit/summary/:id
 *   mountAuditRoutes(v1, deps, { workspacesPath: "/workspaces",
 *                                auditPath: "/audit" })  // inside the /v1 app
 *
 * The `use` registrations cover the bare path and every sub-path; they must
 * stay BEFORE the route call. Mount BEFORE the /v1 catch-all (routes/index.ts).
 */
export function mountAuditRoutes(
  app: Hono<AppEnv>,
  deps: AuditRoutesDeps,
  options?: {
    readonly workspacesPath?: string;
    readonly auditPath?: string;
  }
): void {
  const workspacesPath = options?.workspacesPath ?? "/v1/workspaces";
  const auditPath = options?.auditPath ?? "/v1/audit";
  app.use(workspacesPath, auditServices(deps));
  app.use(`${workspacesPath}/*`, auditServices(deps));
  app.route(workspacesPath, workspaceAuditRoutes);
  app.use(auditPath, auditServices(deps));
  app.use(`${auditPath}/*`, auditServices(deps));
  app.route(auditPath, auditSummaryRoutes);
}
