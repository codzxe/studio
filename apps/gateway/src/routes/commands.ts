// @studio/gateway — commands routes (§13.1 commands/undo/redo, §13.4). Owner: W4-K.
//
//   POST /v1/documents/:id/commands  manual command execution — the SAME
//                                    allowlist as tools (§13.1/§25-5)
//   POST /v1/documents/:id/undo     ONE step — engine edit.undo via the session
//   POST /v1/documents/:id/redo     ONE step — engine edit.redo via the session
//
// All domain semantics live in src/services/command-exec.ts (ManualCommandExecutor:
// allowlist gate, §12.2 tenant scoping, §3.4 idempotency, §5.6 WAL append, §6.1
// compact replies). This file is HTTP only: Zod at the boundary (§13.1 wire),
// auth (principal resolver seam), the §15.2 Can-guard (documents:write —
// ADR-0003 "Manual commands / undo / redo / restore" is editor+), and typed
// failures mapped to §13.3 statuses.
//
// WIRING (the router is a const, per the wave contract — runs.ts pattern):
//   import { mountCommandRoutes } from "./routes/commands.js";
//   mountCommandRoutes(v1, deps, { path: "/documents" });   // → /v1/documents/:id/{commands,undo,redo}
//   mountCommandRoutes(app, deps);                          // → same, on the root app
// `mountCommandRoutes` injects the CommandRoutesDeps seam through Hono context
// variables. Mount it AFTER documents routes — the subpaths here
// (/:id/commands, /:id/undo, /:id/redo) are disjoint from every documents
// route, so registration order is not load-bearing, but /v1 catch-alls must
// stay LAST (routes/index.ts).
//
// The executor dependency carries the §2.2 allowlist
// (REQUIRED_ENGINE_COMMANDS, @studio/engine-client) — the composition root
// owns that injection; see the SEAMS note in services/command-exec.ts.

import { httpStatusFor } from "@studio/config";
import { Hono, type Context } from "hono";
import { createMiddleware, type MiddlewareHandler } from "hono/factory";
import { z } from "zod";
import { createResourceGuard, type GuardContext } from "../authz/guard.js";
import type { Role } from "../authz/roles.js";
import { AppError } from "../middleware/error-mapper.js";
import {
  MAX_COMMAND_ID_LENGTH,
  MAX_COMMAND_PARAM_KEYS,
  MAX_COMMAND_PARAMS_BYTES,
  type CommandExecErrorCode,
  type CommandExecFailure,
  type CommandExecutionContext,
  type ExecutedCommand,
  type ManualCommandExecutor,
} from "../services/command-exec.js";
import type { AppEnv } from "../types.js";

// ---------------------------------------------------------------------------
// Principal seam (mirrors routes/documents.ts PrincipalResolver — W4-F — and
// services/runs.ts AuthLike — W4-G; the wiring wave composes one adapter over
// the Better Auth session + API-key resolvers).
// ---------------------------------------------------------------------------

/** The authenticated principal for one request (§15.2 role + effective grants). */
export interface CommandPrincipal extends GuardContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: Role;
  /** Member sessions: PERMISSIONS[role]; API keys: the scope intersection. */
  readonly permissions: readonly string[];
}

/** Typed auth-failure arm (§13.3 stable codes; 401/403 at the wire). */
export interface CommandAuthFailure {
  readonly ok: false;
  readonly code: "unauthorized" | "forbidden";
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

/** Resolves the caller from the raw request (session cookie or API key, §13). */
export interface CommandPrincipalResolver {
  authenticate(
    request: Request,
  ): Promise<{ readonly ok: true; readonly value: CommandPrincipal } | CommandAuthFailure>;
}

/** Commands router deps: the principal resolver + the service executor. */
export interface CommandRoutesDeps {
  readonly auth: CommandPrincipalResolver;
  readonly executor: ManualCommandExecutor;
}

/**
 * The commands router env: shared variables plus the injected service seam.
 * `commandsServices` is optional in the type because a missing injection is
 * a wiring bug this module reports as a typed 500 (§13.3), never a crash.
 */
export interface CommandsEnv {
  Variables: AppEnv["Variables"] & { commandsServices?: CommandRoutesDeps };
}

/** The commands router (see the WIRING note in the header). */
export const commandRoutes = new Hono<CommandsEnv>();

/** Reads the injected services; a missing injection is a typed 500 (§13.3). */
function services(c: Context<CommandsEnv>): CommandRoutesDeps {
  const deps = c.get("commandsServices");
  if (deps === undefined) {
    throw new AppError(500, "internal_error", "The commands service is not wired.", {
      hint: "Mount command routes through mountCommandRoutes() so services are injected.",
      retryable: false,
    });
  }
  return deps;
}

// ---------------------------------------------------------------------------
// §13.3 failure → HTTP mapping (local codes get explicit statuses; catalog
// codes ride @studio/config's stable table)
// ---------------------------------------------------------------------------

/**
 * Status for any CommandExecErrorCode. Local surface codes: a refused id or a
 * refused command is a 400 (the engine is the compiler — a bad argument is a
 * compile error, §6.3); a missing session is 503 (§13.3 engine family, with
 * the "open the document first" hint).
 */
export function httpStatusForCommand(code: CommandExecErrorCode): number {
  switch (code) {
    case "command_not_allowlisted":
      return 400;
    case "engine_session_unavailable":
      return 503;
    case "engine_command_failed":
      return 400;
    default:
      return httpStatusFor(code);
  }
}

/** Maps a CommandExecFailure envelope to the AppError the error mapper renders. */
function failureToAppError(failure: CommandExecFailure): AppError {
  return new AppError(
    httpStatusForCommand(failure.code),
    failure.code,
    failure.message,
    { hint: failure.hint, retryable: failure.retryable },
  );
}

// ---------------------------------------------------------------------------
// Request validation (Zod at every boundary, §4/§6.1)
// ---------------------------------------------------------------------------

/** §13 preamble: mutating endpoints carry an Idempotency-Key (≤128 chars). */
export const IDEMPOTENCY_KEY_SCHEMA = z.string().trim().min(1).max(128);

const documentIdSchema = z.string().trim().min(1).max(128);

/**
 * POST /:id/commands body (§13.1). `params` rides the §25-11 compact-command
 * budget: a single surgical operation, never a scene-graph transport.
 */
export const COMMAND_BODY_SCHEMA = z
  .object({
    command: z.string().trim().min(1).max(MAX_COMMAND_ID_LENGTH),
    params: z.record(z.unknown()).default({}),
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body.params).length <= MAX_COMMAND_PARAM_KEYS, {
    message: `params accepts at most ${MAX_COMMAND_PARAM_KEYS} keys.`,
  })
  .refine((body) => JSON.stringify(body.params).length <= MAX_COMMAND_PARAMS_BYTES, {
    message: `params exceed the ${MAX_COMMAND_PARAMS_BYTES}-byte compact-command budget (§25-11).`,
  });

export type CommandRequestBody = z.infer<typeof COMMAND_BODY_SCHEMA>;

/** POST /:id/undo and /:id/redo body — optional; only the key may ride along. */
export const UNDO_REDO_BODY_SCHEMA = z
  .object({
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA.optional(),
  })
  .strict();

export type UndoRedoRequestBody = z.infer<typeof UNDO_REDO_BODY_SCHEMA>;

// ---------------------------------------------------------------------------
// Handler helpers (documents.ts/runs.ts precedent)
// ---------------------------------------------------------------------------

/** Resolves the caller; auth failures are typed envelopes (401/403, §15). */
async function requirePrincipal(
  deps: CommandRoutesDeps,
  request: Request,
): Promise<CommandPrincipal> {
  const result = await deps.auth.authenticate(request);
  if (!result.ok) {
    throw new AppError(result.code === "forbidden" ? 403 : 401, result.code, result.message, {
      hint: result.hint,
      retryable: result.retryable ?? false,
    });
  }
  return result.value;
}

/**
 * §15.2: manual commands / undo / redo need `documents:write` — enforced via
 * the authoritative guard (src/authz/guard.ts assertCan: ADR-0003 matrix +
 * effective session grants), never a local role list.
 */
function requireEditor(c: Context<CommandsEnv>, principal: CommandPrincipal): void {
  const guard = createResourceGuard({
    logger: c.get("logger"),
    requestId: c.get("requestId"),
  });
  guard.assertCan(principal.role, "documents:write", principal);
}

/** Parses a required JSON body; malformed JSON is a 400 validation envelope. */
async function readJsonObject(c: Context<CommandsEnv>): Promise<unknown> {
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
async function readOptionalJsonObject(c: Context<CommandsEnv>): Promise<unknown> {
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

/** SafeParse + throw-ZodError (the error mapper renders 422 + details). */
async function parseBody<S extends z.ZodType<unknown, z.ZodTypeDef, unknown>>(
  c: Context<CommandsEnv>,
  schema: S,
): Promise<z.output<S>> {
  const parsed = schema.safeParse(await readJsonObject(c));
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}

/** Parses an optional-body schema (undo/redo). */
async function parseOptionalBody<S extends z.ZodType<unknown, z.ZodTypeDef, unknown>>(
  c: Context<CommandsEnv>,
  schema: S,
): Promise<z.output<S>> {
  const parsed = schema.safeParse(await readOptionalJsonObject(c));
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}

function parseParam(value: string | undefined): string {
  const parsed = documentIdSchema.safeParse(value);
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}

/**
 * §13 preamble: mutating endpoints require an Idempotency-Key — header or
 * body field; when both are sent they must agree (runs.ts precedent).
 */
function resolveIdempotencyKey(c: Context<CommandsEnv>, bodyKey: string | undefined): string {
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
      "An idempotency key is required to execute a command.",
      {
        hint: "Send an Idempotency-Key header (a client-generated UUID) — retries with the same key replay the original outcome (§3.4).",
        retryable: true,
      },
    );
  }
  return IDEMPOTENCY_KEY_SCHEMA.parse(resolved);
}

/** Builds the §22-correlated service context from the request scope. */
function executionContext(
  c: Context<CommandsEnv>,
  principal: CommandPrincipal,
): CommandExecutionContext {
  return {
    organizationId: principal.organizationId,
    userId: principal.userId,
    requestId: c.get("requestId"),
    logger: c.get("logger"),
  };
}

/** DTO mapper — snake_case wire fields; §6.1 compact shape, never a dump. */
function toCommandReply(executed: ExecutedCommand) {
  return {
    ok: true as const,
    command: executed.command,
    seq: executed.seq,
    summary: executed.summary,
    warnings: executed.warnings,
    document_revision: executed.revisionAfter,
    revision_before: executed.revisionBefore,
    revision_after: executed.revisionAfter,
    replayed: executed.replayed,
  };
}

// ---------------------------------------------------------------------------
// POST /:id/commands — §13.1 manual command execution
// ---------------------------------------------------------------------------

commandRoutes.post("/:id/commands", async (c) => {
  const deps = services(c);
  const principal = await requirePrincipal(deps, c.req.raw);
  requireEditor(c, principal);
  const documentId = parseParam(c.req.param("id"));
  const body = await parseBody(c, COMMAND_BODY_SCHEMA);
  const idempotencyKey = resolveIdempotencyKey(c, body.idempotency_key);

  const result = await deps.executor.executeManualCommand(
    executionContext(c, principal),
    documentId,
    { command: body.command, params: body.params, idempotencyKey },
  );
  if (!result.ok) {
    throw failureToAppError(result);
  }
  return c.json(toCommandReply(result.value), 200);
});

// ---------------------------------------------------------------------------
// POST /:id/undo — §13.1 one step (agent runs undo as one step)
// ---------------------------------------------------------------------------

commandRoutes.post("/:id/undo", async (c) => {
  const deps = services(c);
  const principal = await requirePrincipal(deps, c.req.raw);
  requireEditor(c, principal);
  const documentId = parseParam(c.req.param("id"));
  const body = await parseOptionalBody(c, UNDO_REDO_BODY_SCHEMA);
  const idempotencyKey = resolveIdempotencyKey(c, body.idempotency_key);

  const result = await deps.executor.undoOneStep(
    executionContext(c, principal),
    documentId,
    idempotencyKey,
  );
  if (!result.ok) {
    throw failureToAppError(result);
  }
  return c.json(toCommandReply(result.value), 200);
});

// ---------------------------------------------------------------------------
// POST /:id/redo — §13.1 one step
// ---------------------------------------------------------------------------

commandRoutes.post("/:id/redo", async (c) => {
  const deps = services(c);
  const principal = await requirePrincipal(deps, c.req.raw);
  requireEditor(c, principal);
  const documentId = parseParam(c.req.param("id"));
  const body = await parseOptionalBody(c, UNDO_REDO_BODY_SCHEMA);
  const idempotencyKey = resolveIdempotencyKey(c, body.idempotency_key);

  const result = await deps.executor.redoOneStep(
    executionContext(c, principal),
    documentId,
    idempotencyKey,
  );
  if (!result.ok) {
    throw failureToAppError(result);
  }
  return c.json(toCommandReply(result.value), 200);
});

// ---------------------------------------------------------------------------
// Injection seam — middleware + one-call wiring helper (runs.ts pattern)
// ---------------------------------------------------------------------------

/**
 * Middleware that injects the commands service seam. Typed against the shared
 * AppEnv so it mounts on the standard app; the single context variable it
 * writes is declared by CommandsEnv.
 */
export function commandsServices(deps: CommandRoutesDeps): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    (c as unknown as Context<CommandsEnv>).set("commandsServices", deps);
    await next();
  });
}

/**
 * Wires the commands router in one call — the only supported mount:
 *
 *   mountCommandRoutes(app, deps)                      // → /v1/documents/:id/…
 *   mountCommandRoutes(v1, deps, { path: "/documents" }) // inside the /v1 app
 *
 * Both `use` registrations cover the bare path and every sub-path under any
 * Hono trailing-slash semantics, and must stay BEFORE the route call.
 */
export function mountCommandRoutes(
  app: Hono<AppEnv>,
  deps: CommandRoutesDeps,
  options?: { readonly path?: string },
): void {
  const path = options?.path ?? "/v1/documents";
  app.use(path, commandsServices(deps));
  app.use(`${path}/*`, commandsServices(deps));
  app.route(path, commandRoutes);
}
