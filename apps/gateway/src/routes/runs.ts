// @studio/gateway — runs routes (§13.1 / §13.3 / §3.3). Owner: W4-G.
//
//   POST /v1/runs            create: auth → tenant → canRunTier → reserve →
//                            insert (queued) → enqueue (jobId=runId) → 201
//   GET  /v1/runs/:id        status + plan + steps summary + cost
//   GET  /v1/runs             org-scoped page (optional document_id filter)
//   POST /v1/runs/:id/cancel  §3.4: flip active → cancelled, release, emit
//
// All money/tenant semantics live in src/services/runs.ts (idempotency core,
// §3.4). This file is HTTP only: Zod at the boundary, typed failures mapped to
// §13.3 statuses via httpStatusFor, and no domain logic.
//
// WIRING (the router is a const, per the wave contract):
//   import { mountRunRoutes } from "./routes/runs.js";
//   mountRunRoutes(v1, deps, { path: "/runs" });   // or root: mountRunRoutes(app, deps)
// `mountRunRoutes` injects the RunsDeps seam through Hono context variables
// and mounts `runRoutes` at the given path. Mount it BEFORE the /v1 catch-all
// in routes/index.ts so concrete routes win. (SSE GET /v1/runs/:id/events is
// §13.2 and belongs to the event-stream wave — it is not claimed here.)

import { httpStatusFor, isFailure, type Failure } from "@studio/config";
import { Hono, type Context } from "hono";
import { createMiddleware, type MiddlewareHandler } from "hono/factory";
import { AppError } from "../middleware/error-mapper.js";
import {
  CANCEL_RUN_BODY_SCHEMA,
  CREATE_RUN_BODY_SCHEMA,
  DEFAULT_CANCEL_REASON,
  IDEMPOTENCY_KEY_SCHEMA,
  LIST_RUNS_QUERY_SCHEMA,
  RUN_ID_SCHEMA,
  cancelRun,
  createRun,
  decodeRunCursor,
  getRun,
  listRuns,
  runDetailToApi,
  type RunCaller,
  type RunsDeps,
} from "../services/runs.js";
import type { AppEnv } from "../types.js";

/**
 * The runs router env: the app's shared variables plus the injected service
 * seam. `runsServices` is optional in the type because a missing injection is
 * a wiring bug this module reports as a typed 500 (§13.3), never a crash.
 */
export interface RunsEnv {
  Variables: AppEnv["Variables"] & { runsServices?: RunsDeps };
}

/**
 * The runs router, mounted at /v1/runs via `mountRunRoutes` (see WIRING above).
 * Registered bottom-up in this file; handlers resolve their services from the
 * Hono context (`runsServices`), set by the injected middleware.
 */
export const runRoutes = new Hono<RunsEnv>();

/** Reads the injected services; a missing injection is a typed 500 (§13.3). */
function services(c: Context<RunsEnv>): RunsDeps {
  const deps = c.get("runsServices");
  if (deps === undefined) {
    throw new AppError(500, "internal_error", "The runs service is not wired.", {
      hint: "Mount run routes through mountRunRoutes() so services are injected.",
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
  });
}

/** Resolves the caller; auth failures are typed envelopes (401/403, §15). */
async function requireCaller(deps: RunsDeps, request: Request): Promise<RunCaller> {
  const result = await deps.auth.authenticate(request);
  if (isFailure(result)) {
    throw new AppError(result.code === "forbidden" ? 403 : 401, result.code, result.message, {
      hint: result.hint,
      retryable: result.retryable,
    });
  }
  return result.value;
}

/** Parses a required JSON body; malformed JSON is a 400 validation envelope. */
async function readJsonObject(c: Context<RunsEnv>): Promise<unknown> {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    throw new AppError(400, "validation_failed", "The request body must be valid JSON.", {
      hint: "Send Content-Type: application/json with a JSON object body.",
      retryable: true,
    });
  }
}

/** Parses an optional JSON body — absent/blank means an empty object. */
async function readOptionalJsonObject(c: Context<RunsEnv>): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError(400, "validation_failed", "The request body must be valid JSON.", {
      hint: "Send an empty body or a JSON object.",
      retryable: true,
    });
  }
}

/**
 * §13: mutating endpoints require an Idempotency-Key header (or body field).
 * Both may be sent; they must agree. The key is validated against the same
 * schema the body field uses (≤128 chars, trimmed).
 */
function resolveIdempotencyKey(c: Context<RunsEnv>, bodyKey: string | undefined): string {
  const headerKey = c.req.header("Idempotency-Key")?.trim();
  if (headerKey !== undefined && bodyKey !== undefined && headerKey !== bodyKey) {
    throw new AppError(
      422,
      "validation_failed",
      "The Idempotency-Key header and the idempotencyKey body field disagree.",
      {
        hint: "Send the key in exactly one place, or make both values equal.",
        retryable: true,
      },
    );
  }
  const resolved = headerKey ?? bodyKey;
  if (resolved === undefined) {
    throw new AppError(422, "validation_failed", "An idempotency key is required to create a run.", {
      hint: "Send an Idempotency-Key header (a client-generated UUID). Retries with the same key return the same run and never double-charge (§3.4).",
      retryable: true,
    });
  }
  return IDEMPOTENCY_KEY_SCHEMA.parse(resolved);
}

// ---------------------------------------------------------------------------
// POST /v1/runs — §3.3 step 2
// ---------------------------------------------------------------------------

runRoutes.post("/", async (c) => {
  const deps = services(c);
  const caller = await requireCaller(deps, c.req.raw);
  const body = CREATE_RUN_BODY_SCHEMA.parse(await readJsonObject(c));
  const idempotencyKey = resolveIdempotencyKey(c, body.idempotencyKey);

  const result = await createRun(deps, { caller, body, idempotencyKey });
  if (isFailure(result)) {
    throw failureToAppError(result);
  }
  const { run } = result.value;
  return c.json(
    { run_id: run.id, status: run.status, credits_reserved: run.creditsReserved },
    201,
  );
});

// ---------------------------------------------------------------------------
// GET /v1/runs/:id — status + plan + steps summary + cost (§13.1)
// ---------------------------------------------------------------------------

runRoutes.get("/:id", async (c) => {
  const deps = services(c);
  const caller = await requireCaller(deps, c.req.raw);
  const runId = RUN_ID_SCHEMA.parse(c.req.param("id"));

  const result = await getRun(deps, { organizationId: caller.organizationId, runId });
  if (isFailure(result)) {
    throw failureToAppError(result);
  }
  return c.json(runDetailToApi(result.value.run, result.value.steps));
});

// ---------------------------------------------------------------------------
// GET /v1/runs — one page of runs, org-scoped (§12.2), optional document filter
// ---------------------------------------------------------------------------

runRoutes.get("/", async (c) => {
  const deps = services(c);
  const caller = await requireCaller(deps, c.req.raw);
  const query = LIST_RUNS_QUERY_SCHEMA.parse(c.req.query());

  const cursor = query.cursor !== undefined ? decodeRunCursor(query.cursor) : undefined;
  if (query.cursor !== undefined && cursor === null) {
    throw new AppError(422, "validation_failed", "The pagination cursor is malformed.", {
      hint: "Pass the next_cursor value from the previous page unmodified.",
      retryable: true,
    });
  }

  const result = await listRuns(deps, {
    organizationId: caller.organizationId,
    ...(query.document_id !== undefined ? { documentId: query.document_id } : {}),
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });
  if (isFailure(result)) {
    throw failureToAppError(result);
  }
  return c.json(result.value);
});

// ---------------------------------------------------------------------------
// POST /v1/runs/:id/cancel — §3.4: flip active → cancelled, release, emit
// ---------------------------------------------------------------------------

runRoutes.post("/:id/cancel", async (c) => {
  const deps = services(c);
  const caller = await requireCaller(deps, c.req.raw);
  const runId = RUN_ID_SCHEMA.parse(c.req.param("id"));
  const body = CANCEL_RUN_BODY_SCHEMA.parse(await readOptionalJsonObject(c));

  const result = await cancelRun(deps, {
    organizationId: caller.organizationId,
    runId,
    reason: body.reason ?? DEFAULT_CANCEL_REASON,
  });
  if (isFailure(result)) {
    throw failureToAppError(result);
  }
  const outcome = result.value;
  return c.json({
    run_id: outcome.run.id,
    status: outcome.run.status,
    credits_refunded: outcome.release?.amountRefunded ?? 0,
  });
});

// ---------------------------------------------------------------------------
// Injection seam — middleware + one-call wiring helper
// ---------------------------------------------------------------------------

/**
 * Middleware that injects the runs service seam. Typed against the shared
 * AppEnv so it mounts on the standard app (buildApp / the /v1 registry); the
 * single context variable it writes is declared by RunsEnv.
 */
export function runsServices(deps: RunsDeps): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    (c as unknown as Context<RunsEnv>).set("runsServices", deps);
    await next();
  });
}

/**
 * Wires the runs router in one call — the only supported mount:
 *
 *   mountRunRoutes(app, deps)                    // → /v1/runs
 *   mountRunRoutes(v1, deps, { path: "/runs" })   // → /v1/runs inside the /v1 app
 *
 * Both `use` registrations cover the bare path and every sub-path under any
 * Hono trailing-slash semantics, and must stay BEFORE the route call.
 */
export function mountRunRoutes(
  app: Hono<AppEnv>,
  deps: RunsDeps,
  options?: { readonly path?: string },
): void {
  const path = options?.path ?? "/v1/runs";
  app.use(path, runsServices(deps));
  app.use(`${path}/*`, runsServices(deps));
  app.route(path, runRoutes);
}
