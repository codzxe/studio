// @studio/gateway — OpenAPI 3.1 document for the §13 REST + SSE surface.
// Owner: W4-O (contract wave). Zero-dep on purpose: a hand-authored, typed
// const + `buildOpenApiSpec()` + `mountOpenApi()`. §13 of docs/BUILD_PROMPT.md
// is the contract; this file + docs/api/openapi-contract.md are its audit.
//
// RECONCILED DECISIONS (this wave owns them; cited where the reason matters):
// 1. Error envelope is FLAT: `{ ok:false, code, message, hint, retryable,
//    docs_url?, details? }`. §13.3 sketches a nested `{ error:{…} }` shape —
//    REJECTED. Authority: docs/AGENTS.md code-style law ("Errors: typed result
//    envelopes { ok:false, code, message, hint, retryable? }"), the shipped
//    gateway mapper (src/middleware/error-mapper.ts, W1-H) and the reconcile
//    note in docs/api/README.md ("Error envelope"), which queued the Wave-4
//    decision to this wave. The nested shape never appears on /v1.
// 2. Schema-validation failures answer 422 `validation_failed` (W1-H mapper);
//    §13.3's literal 400 stays for malformed JSON/multipart/query frames.
//    Both are documented below; the audit doc carries the divergence note (D5).
// 3. Every operation carries `x-studio-status` mirroring the W4-O audit table
//    (implemented | wired-in-W4-R | partial | not-implemented) so the spec
//    and the audit cannot drift silently. W4-R mounts this document at
//    GET /v1/openapi.json via `mountOpenApi(app)` and wires the audit's routes.
//
// TS style: strict, ESM (.js specifiers), no `any` in exported APIs. The spec
// types below are a minimal structural subset of OpenAPI 3.1 — typed const,
// JSON-serializable (no `undefined` values in emitted fields).

import { Hono } from "hono";
import type { AppEnv } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal structural types (OpenAPI 3.1 subset). Deliberately explicit: no
// index signatures, no `any` — extensions are named fields (`x-studio-status`).
// ---------------------------------------------------------------------------

/** JSON value tree — every const in this module serializes cleanly. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Primitive JSON type names; 3.1 also allows arrays (nullable unions). */
export type JsonTypeName =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

/** JSON Schema (subset used here; zod-compatible shapes mirror the route zod). */
export interface SchemaObject {
  readonly type?: JsonTypeName | readonly JsonTypeName[];
  readonly title?: string;
  readonly description?: string;
  readonly format?: string;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, SchemaObject>>;
  readonly additionalProperties?: boolean | SchemaObject;
  readonly items?: SchemaObject;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly const?: string | number | boolean | null;
  readonly default?: JsonValue;
  readonly example?: JsonValue;
  readonly allOf?: readonly SchemaObject[];
  readonly anyOf?: readonly SchemaObject[];
  readonly $ref?: string;
}

export interface MediaTypeObject {
  readonly schema?: SchemaObject;
  readonly example?: JsonValue;
}

export interface ParameterObject {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly description?: string;
  readonly required?: boolean;
  readonly schema: SchemaObject;
  readonly example?: JsonValue;
}

export interface RequestBodyObject {
  readonly description?: string;
  readonly required?: boolean;
  readonly content: Readonly<Record<string, MediaTypeObject>>;
}

export interface HeaderObject {
  readonly description: string;
  readonly schema: SchemaObject;
}

export interface ResponseObject {
  readonly description: string;
  readonly content?: Readonly<Record<string, MediaTypeObject>>;
  readonly headers?: Readonly<Record<string, HeaderObject>>;
  readonly example?: JsonValue;
}

/** Response / parameter indirection via `#/components/...`. */
export interface ReferenceObject {
  readonly $ref: string;
}

export type ResponseOrRef = ResponseObject | ReferenceObject;
export type ParameterOrRef = ParameterObject | ReferenceObject;

/** Audit vocabulary from docs/api/openapi-contract.md (§ audit table). */
export type ImplementationStatus =
  | "implemented"
  | "wired-in-W4-R"
  | "partial"
  | "not-implemented";

export interface OperationObject {
  readonly summary: string;
  readonly description?: string;
  readonly operationId: string;
  readonly tags: readonly string[];
  readonly security?: readonly SecurityRequirement[];
  readonly parameters?: readonly ParameterOrRef[];
  readonly requestBody?: RequestBodyObject;
  readonly responses: Readonly<Record<string, ResponseOrRef>>;
  readonly "x-studio-status"?: ImplementationStatus;
}

export interface PathItemObject {
  readonly summary?: string;
  readonly description?: string;
  readonly get?: OperationObject;
  readonly post?: OperationObject;
  readonly patch?: OperationObject;
  readonly put?: OperationObject;
  readonly delete?: OperationObject;
}

export interface SecurityRequirement {
  readonly [scheme: string]: readonly string[];
}

export type SecuritySchemeObject =
  | {
      readonly type: "http";
      readonly scheme: "bearer";
      readonly description: string;
    }
  | {
      readonly type: "apiKey";
      readonly in: "cookie" | "header";
      readonly name: string;
      readonly description: string;
    };

export interface ServerObject {
  readonly url: string;
  readonly description: string;
}

export interface TagObject {
  readonly name: string;
  readonly description: string;
}

export interface ComponentsObject {
  readonly schemas: Readonly<Record<string, SchemaObject>>;
  readonly securitySchemes: Readonly<Record<string, SecuritySchemeObject>>;
  readonly parameters: Readonly<Record<string, ParameterObject>>;
  readonly responses: Readonly<Record<string, ResponseObject>>;
}

export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly summary?: string;
    readonly description: string;
  };
  readonly servers: readonly ServerObject[];
  readonly tags: readonly TagObject[];
  readonly paths: Readonly<Record<string, PathItemObject>>;
  readonly components: ComponentsObject;
}

// ---------------------------------------------------------------------------
// Small builders — keep the spec const declarative and ≤100 columns.
// ---------------------------------------------------------------------------

const schemaRef = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });
const responseRef = (name: string): ResponseOrRef => ({ $ref: `#/components/responses/${name}` });
const paramRef = (name: string): ParameterOrRef => ({ $ref: `#/components/parameters/${name}` });

const media = (schema: SchemaObject): MediaTypeObject => ({ schema });

const jsonBody = (
  schema: SchemaObject,
  description: string,
  required = true
): RequestBodyObject => ({
  description,
  required,
  content: { "application/json": media(schema) },
});

const jsonResponse = (schema: SchemaObject, description: string): ResponseObject => ({
  description,
  content: { "application/json": media(schema) },
});

const looseObject = (description: string): SchemaObject => ({
  type: "object",
  additionalProperties: true,
  description,
});

/** Both credential mechanisms satisfy auth (session cookie OR API key, §13). */
const AUTH_BOTH: readonly SecurityRequirement[] = [{ sessionCookie: [] }, { apiKey: [] }];

const ROLE_ENUM: SchemaObject = {
  type: "string",
  enum: ["owner", "admin", "editor", "viewer"],
};

const INVITE_ROLE_ENUM: SchemaObject = {
  type: "string",
  enum: ["admin", "editor", "viewer"],
};

const OK_TRUE: SchemaObject = { const: true };

const createdAt = (): SchemaObject => ({ type: "string", format: "date-time" });

const pathParam = (name: string, description: string, maxLength: number): ParameterObject => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", minLength: 1, maxLength },
});

const pathIdParam = (): ParameterObject => pathParam("id", "Resource id (opaque).", 128);
const pathRunIdParam = (): ParameterObject => pathParam("id", "Run id.", 200);

// ---------------------------------------------------------------------------
// Shared schemas (zod-mirrored where a route zod exists — see per-schema
// comments; the audit doc pins file + schema name for every mirror).
// ---------------------------------------------------------------------------

/**
 * The RECONCILED error envelope (flat — see the header note). Mirrors
 * src/middleware/error-mapper.ts `ErrorEnvelope` (W1-H) exactly:
 * ok:false | code | message | hint? | retryable | docs_url? | details?.
 * `code` is a stable string; the stable core is the @studio/config catalog
 * (packages/config/src/errors.ts ERROR_CODES) plus gateway transport codes.
 * NOT nested under `error:{}` — §13.3's sketch was REJECTED (decision W4-O;
 * docs/api/README.md "Error envelope" reconcile note).
 */
const ERROR_ENVELOPE_SCHEMA: SchemaObject = {
  title: "ErrorEnvelope",
  type: "object",
  description:
    "Flat error envelope. §13.3 sketched { error: { code, message, … } }; that " +
    "nested shape was REJECTED in the reconcile notes (docs/AGENTS.md code " +
    "style, src/middleware/error-mapper.ts, docs/api/README.md) — the flat " +
    "shape is the public contract and the only error shape served on /v1.",
  required: ["ok", "code", "message", "retryable"],
  properties: {
    ok: { const: false },
    code: {
      type: "string",
      description:
        "Stable string code. Core catalog (@studio/config ERROR_CODES): " +
        "text_overflow, unknown_slots, invalid_slots, validation_failed, " +
        "budget_exceeded, insufficient_credits, plan_limit, unauthorized, " +
        "forbidden, cross_tenant_denied, not_found, conflict, rate_limited, " +
        "quota_exceeded, engine_unavailable, engine_timeout, engine_crashed, " +
        "image_provider_error, provider_unhealthy, storage_error, " +
        "internal_error; plus gateway transport codes (bad_request, " +
        "not_implemented, not_configured, service_unavailable, payment_required, " +
        "upload_too_large, run_not_found, run_events_unavailable, " +
        "client_disconnected).",
    },
    message: {
      type: "string",
      description: "Human-safe; never a stack trace, path or internal id.",
    },
    hint: { type: "string", description: "Optional actionable hint." },
    retryable: { type: "boolean", description: "Clients must respect this for backoff." },
    docs_url: { type: "string", description: "Optional link to documentation." },
    details: {
      type: "array",
      description: "Optional field-level validation problems (ZodError issues, 422).",
      items: { $ref: "#/components/schemas/ValidationDetail" },
    },
  },
  additionalProperties: false,
};

const RUN_STATUS_ENUM: SchemaObject = {
  type: "string",
  enum: [
    "queued",
    "planning",
    "executing",
    "observing",
    "rendering",
    "validating",
    "critiquing",
    "repairing",
    "finalizing",
    "succeeded",
    "succeeded_with_warnings",
    "failed",
    "cancelled",
  ],
};

const RUN_COST_SCHEMA: SchemaObject = {
  type: "object",
  description: "services/runs.ts RunCostApiView.",
  required: [
    "credits_reserved",
    "credits_charged",
    "tokens_in",
    "tokens_out",
    "cache_hits",
    "cost_micro_usd",
  ],
  properties: {
    credits_reserved: { type: "number" },
    credits_charged: { type: "number" },
    tokens_in: { type: "integer" },
    tokens_out: { type: "integer" },
    cache_hits: { type: "integer" },
    cost_micro_usd: { type: "number" },
  },
};

const RUN_STEP_SCHEMA: SchemaObject = {
  type: "object",
  required: ["seq", "phase", "tool", "duration_ms", "ok", "error_code", "deviation_from_plan"],
  properties: {
    seq: { type: "integer" },
    phase: { type: "string" },
    tool: { type: ["string", "null"] },
    duration_ms: { type: "integer" },
    ok: { type: "boolean" },
    error_code: { type: ["string", "null"] },
    deviation_from_plan: { type: "boolean" },
  },
};

const RUN_ERROR_SCHEMA: SchemaObject = {
  type: "object",
  description: "@studio/db RunError (flat envelope shape, §13.3 codes).",
  required: ["code", "message"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    hint: { type: "string" },
    retryable: { type: "boolean" },
  },
};

const components: ComponentsObject = {
  schemas: {
    ErrorEnvelope: ERROR_ENVELOPE_SCHEMA,
    ValidationDetail: {
      type: "object",
      description:
        "One field-level problem from a ZodError (path is a field path — " +
        "never user data).",
      required: ["path", "message"],
      properties: { path: { type: "string" }, message: { type: "string" } },
      additionalProperties: false,
    },
    // --- workspaces (W4-E) -------------------------------------------------
    WorkspaceSummary: {
      type: "object",
      description: "services/workspaces.ts WorkspaceSummary.",
      required: ["id", "name", "slug", "role", "created_at"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        slug: { type: "string" },
        role: ROLE_ENUM,
        created_at: createdAt(),
      },
    },
    WorkspaceDetail: {
      type: "object",
      description: "services/workspaces.ts WorkspaceDetail.",
      required: ["id", "name", "slug", "logo", "brand_tokens", "created_at"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        slug: { type: "string" },
        logo: { type: ["string", "null"] },
        brand_tokens: { type: "object", additionalProperties: true },
        created_at: createdAt(),
      },
    },
    MemberView: {
      type: "object",
      description: "services/workspaces.ts MemberView.",
      required: ["id", "user_id", "role", "created_at"],
      properties: {
        id: { type: "string" },
        user_id: { type: "string" },
        role: ROLE_ENUM,
        created_at: createdAt(),
      },
    },
    InviteView: {
      type: "object",
      description:
        "services/workspaces.ts InviteView. TODO(email): the token is " +
        "returned in-band until the email wave lands (routes/workspaces.ts).",
      required: [
        "token",
        "organization_id",
        "organization_name",
        "email",
        "role",
        "status",
        "expires_at",
      ],
      properties: {
        token: { type: "string" },
        organization_id: { type: "string" },
        organization_name: { type: "string" },
        email: { type: "string", format: "email" },
        role: INVITE_ROLE_ENUM,
        status: {
          type: "string",
          description: "Better Auth invitation status (pending|accepted|canceled|rejected).",
        },
        expires_at: createdAt(),
      },
    },
    CreateWorkspaceRequest: {
      type: "object",
      description: "routes/workspaces.ts createWorkspaceSchema (strict).",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120, description: "Trimmed." },
        slug: {
          type: "string",
          pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
          description: "Optional 1–63 chars: a–z, 0–9, interior dashes; derived when absent.",
        },
      },
      additionalProperties: false,
    },
    InviteRequest: {
      type: "object",
      description: "routes/workspaces.ts inviteSchema (strict).",
      required: ["email", "role"],
      properties: {
        email: { type: "string", format: "email", maxLength: 320 },
        role: {
          type: "string",
          enum: ["admin", "editor", "viewer"],
          description: "Never owner.",
        },
        expires_in_days: { type: "integer", minimum: 1, maximum: 90 },
      },
      additionalProperties: false,
    },
    WorkspacePatchRequest: {
      type: "object",
      description: "routes/workspaces.ts patchWorkspaceSchema (strict; ≥1 field).",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        brand_tokens: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    // --- documents (W4-F) --------------------------------------------------
    DocumentDto: {
      type: "object",
      description: "routes/documents.ts toDocumentDto (snake_case wire fields).",
      required: [
        "id",
        "name",
        "width_px",
        "height_px",
        "current_revision",
        "template_id",
        "created_by",
        "created_at",
        "updated_at",
        "archived_at",
      ],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        width_px: { type: "integer" },
        height_px: { type: "integer" },
        current_revision: { type: "integer" },
        template_id: { type: ["string", "null"] },
        created_by: { type: "string" },
        created_at: createdAt(),
        updated_at: createdAt(),
        archived_at: { type: ["string", "null"], format: "date-time" },
      },
    },
    VersionDto: {
      type: "object",
      description: "routes/documents.ts toVersionDto.",
      required: ["id", "revision", "label", "created_by", "created_at"],
      properties: {
        id: { type: "string" },
        revision: { type: "integer" },
        label: { type: "string" },
        created_by: { type: "string" },
        created_at: createdAt(),
      },
    },
    CreateDocumentRequest: {
      type: "object",
      description:
        "routes/documents.ts createBodySchema (strict). DIVERGES from §13.1's " +
        "{ project_id, name, template } — audit D3: no project column (W1-D) " +
        "and width/height are required; `template` is the §13.1 key accepted as " +
        "an alias of template_id (both present ⇒ must agree).",
      required: ["name", "width", "height"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        width: { type: "integer", minimum: 1, maximum: 65535 },
        height: { type: "integer", minimum: 1, maximum: 65535 },
        templateId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(@[0-9]{1,19})?$",
          description: '"id" or "id@version".',
        },
        template: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(@[0-9]{1,19})?$",
          description: '§13.1 key, e.g. "instagram-post@3"; alias of templateId.',
        },
      },
      additionalProperties: false,
    },
    DocumentPatchRequest: {
      type: "object",
      description: "routes/documents.ts patchBodySchema (strict; ≥1 field).",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        archived: { type: "boolean" },
      },
      additionalProperties: false,
    },
    // --- runs (W4-G) --------------------------------------------------------
    CreateRunRequest: {
      type: "object",
      description:
        "services/runs.ts CREATE_RUN_BODY_SCHEMA (strict, camelCase per the " +
        "W4-G task contract — §13.1 spells POST /v1/documents/:id/runs with " +
        "snake_case fields; reconciliation is assigned to W4-R, audit D4).",
      required: ["documentId", "prompt", "tier"],
      properties: {
        documentId: { type: "string", minLength: 1, maxLength: 200 },
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 8000,
          description: "Capped, never trusted (§5.7).",
        },
        tier: {
          type: "string",
          enum: ["quick", "standard", "complex", "premium", "max"],
        },
        templateId: { type: "string", minLength: 1, maxLength: 200 },
        assetIds: {
          type: "array",
          maxItems: 16,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
        idempotencyKey: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Alternative to the Idempotency-Key header; must agree when both are sent.",
        },
      },
      additionalProperties: false,
    },
    RunError: RUN_ERROR_SCHEMA,
    RunDetail: {
      type: "object",
      description: "services/runs.ts RunDetailApiView — §13.1 status + plan + steps + cost.",
      required: [
        "run_id",
        "document_id",
        "status",
        "tier",
        "revision_before",
        "revision_after",
        "created_at",
        "started_at",
        "finished_at",
        "error",
        "plan",
        "cost",
        "steps",
      ],
      properties: {
        run_id: { type: "string" },
        document_id: { type: "string" },
        status: RUN_STATUS_ENUM,
        tier: { type: "string" },
        revision_before: { type: "integer" },
        revision_after: { type: ["integer", "null"] },
        created_at: createdAt(),
        started_at: { type: ["string", "null"], format: "date-time" },
        finished_at: { type: ["string", "null"], format: "date-time" },
        error: { anyOf: [RUN_ERROR_SCHEMA, { type: "null" }] },
        plan: { type: ["object", "null"], description: "Run plan (§6.2) or null until planned." },
        cost: RUN_COST_SCHEMA,
        steps: { type: "array", items: RUN_STEP_SCHEMA },
      },
    },
    RunListItem: {
      type: "object",
      description: "services/runs.ts RunListItemApiView (GET /v1/runs page item).",
      required: [
        "run_id",
        "document_id",
        "status",
        "tier",
        "revision_before",
        "revision_after",
        "created_at",
        "started_at",
        "finished_at",
        "error",
        "credits",
      ],
      properties: {
        run_id: { type: "string" },
        document_id: { type: "string" },
        status: RUN_STATUS_ENUM,
        tier: { type: "string" },
        revision_before: { type: "integer" },
        revision_after: { type: ["integer", "null"] },
        created_at: createdAt(),
        started_at: { type: ["string", "null"], format: "date-time" },
        finished_at: { type: ["string", "null"], format: "date-time" },
        error: { anyOf: [RUN_ERROR_SCHEMA, { type: "null" }] },
        credits: {
          type: "object",
          required: ["reserved", "charged"],
          properties: { reserved: { type: "number" }, charged: { type: "number" } },
        },
      },
    },
    // --- assets / uploads (W4-I) --------------------------------------------
    AssetSummary: {
      type: "object",
      description: "services/assets.ts AssetSummary (§13.3: no storage keys, no uploader ids).",
      required: [
        "id",
        "kind",
        "bytes",
        "width",
        "height",
        "mime",
        "checksum",
        "name",
        "created_at",
      ],
      properties: {
        id: { type: "string" },
        kind: { type: "string" },
        bytes: { type: "integer" },
        width: { type: ["integer", "null"] },
        height: { type: ["integer", "null"] },
        mime: { type: "string" },
        checksum: { type: "string", description: "sha256 (dedupe key, §12.1)." },
        name: { type: "string" },
        created_at: createdAt(),
      },
    },
    // --- SSE (§13.2 / W4-H) -------------------------------------------------
    SseEventEnvelope: {
      type: "object",
      description:
        "§13.2 wire envelope, sent as the SSE `data:` payload. Clients dedupe " +
        "by `seq` and resume with Last-Event-ID; the stream closes after one " +
        "terminal event.",
      required: ["seq", "run_id", "at", "type", "payload"],
      properties: {
        seq: { type: "integer", minimum: 0 },
        run_id: { type: "string" },
        at: createdAt(),
        type: {
          type: "string",
          enum: [
            "run.queued",
            "run.started",
            "run.plan",
            "step.started",
            "step.finished",
            "preview.updated",
            "validate.report",
            "critique.report",
            "credits.reserved",
            "credits.charged",
            "run.succeeded",
            "run.failed",
            "run.cancelled",
            "run.resync",
          ],
          description:
            "The 13 §13.2 event types plus the `run.resync` gap sentinel emitted " +
            "by routes/runs-events.ts (extra wire event — audit D8): reconnect " +
            "with Last-Event-ID = the sentinel `id` to re-heal the gap.",
        },
        payload: { description: "Per-type payload; opaque to the transport." },
      },
    },
  },
  securitySchemes: {
    sessionCookie: {
      type: "apiKey",
      in: "cookie",
      name: "better-auth.session_token",
      description:
        "Better Auth httpOnly session cookie for the web app (§13 preamble; " +
        "ADR-0003). The name is the Better Auth default — src/auth/" +
        "client-config.ts pins the basePath; verify at W4-R wiring.",
    },
    apiKey: {
      type: "http",
      scheme: "bearer",
      description:
        "Personal API key for the public API (§13/§15.2): hashed, scoped " +
        "(documents:read, documents:write, runs:create, exports:create; " +
        "org:<id> scope string), revocable. Send `Authorization: Bearer <key>` " +
        "(src/middleware/auth-context.ts, RFC 9110) — the key verifier also " +
        "accepts `x-api-key` (src/auth/api-keys.ts extractApiKey).",
    },
  },
  parameters: {
    IdempotencyKey: {
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description:
        "§13 preamble: every mutating endpoint requires an Idempotency-Key " +
        "(a client-generated UUID is fine; ≤128 chars). Enforced on run " +
        "creation today; other mutations validate + correlate it into the " +
        "audit trail until the idempotency store lands (audit D7).",
      schema: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        example: "0f8a2f7e-9b1d-4c6a-a2b3-5e8d7c9f1a2b",
      },
    },
    IdempotencyKeyOrBody: {
      name: "Idempotency-Key",
      in: "header",
      required: false,
      description:
        "Required unless the `idempotencyKey` body field is sent (routes/" +
        "runs.ts: header and body must agree when both are present).",
      schema: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  responses: {
    // Shared error responses — all render the FLAT ErrorEnvelope (decision W4-O).
    BadRequest: {
      description:
        "400 — malformed request frame (bad JSON, bad multipart, malformed " +
        "Last-Event-ID).",
      content: { "application/json": media(schemaRef("ErrorEnvelope")) },
    },
    ValidationFailed: {
      description:
        "422 — body/query schema validation failed (ZodError → " +
        "validation_failed + details; W1-H mapper). §13.3 lists 400 for " +
        "validation — reconciled split (audit D5): 400 = frame errors, " +
        "422 = schema errors.",
      content: { "application/json": media(schemaRef("ErrorEnvelope")) },
    },
    Unauthorized: {
      description:
        "401 — no valid session cookie or API key. Codes observed: " +
        "`unauthorized` (W1-H/§13.3 catalog) and `unauthenticated` (W4-B " +
        "middleware) — drift flagged, audit D6.",
      content: { "application/json": media(schemaRef("ErrorEnvelope")) },
    },
    Forbidden: {
      description:
        "403 — authenticated but the role/permission/scope denies the action " +
        "(RBAC, ADR-0003).",
      content: { "application/json": media(schemaRef("ErrorEnvelope")) },
    },
    NotFound: {
      description:
        "404 — unknown id. Cross-tenant ids answer the same 404 (§15.1: " +
        "existence is never revealed to strangers).",
      content: { "application/json": media(schemaRef("ErrorEnvelope")) },
    },
    PaymentRequired: {
      description:
        "402 — payment/credits required (§14.2 rule 1: insufficient_credits " +
        "with a top-up hint; plan_limit for plan gates).",
      content: { "application/json": media(schemaRef("ErrorEnvelope")) },
      example: {
        ok: false,
        code: "insufficient_credits",
        message: "Not enough credits to reserve this run.",
        hint: "Top up via POST /v1/billing/checkout.",
        retryable: false,
      },
    },
    Conflict: {
      description:
        "409 — idempotency/version conflict (e.g. replay of another org's " +
        "key; cancel of a terminal run).",
      content: { "application/json": media(schemaRef("ErrorEnvelope")) },
    },
    PayloadTooLarge: {
      description:
        "413 — upload exceeds the per-file cap (upload_too_large; §20.2: " +
        "25 MB + multipart slack).",
      content: { "application/json": media(schemaRef("ErrorEnvelope")) },
    },
    RateLimited: {
      description:
        "429 — rate limit or run cap hit (rate_limited / quota_exceeded / " +
        "run_cap_reached). Honor Retry-After; X-RateLimit-* carry the bucket " +
        "state (W4-D middleware).",
      content: { "application/json": media(schemaRef("ErrorEnvelope")) },
      headers: {
        "Retry-After": {
          description: "Seconds until the next request may be attempted.",
          schema: { type: "integer" },
        },
        "X-RateLimit-Limit": { description: "Bucket capacity.", schema: { type: "integer" } },
        "X-RateLimit-Remaining": {
          description: "Tokens remaining in the window.",
          schema: { type: "integer" },
        },
        "X-RateLimit-Reset": {
          description: "Epoch seconds when the bucket refills.",
          schema: { type: "integer" },
        },
      },
    },
    InternalError: {
      description: "500 — unexpected. Generic message only; details go to logs (§13.3).",
      content: { "application/json": media(schemaRef("ErrorEnvelope")) },
    },
    ServiceUnavailable: {
      description:
        "503 — dependency down: engine_unavailable (§13.3), service_unavailable " +
        "(unwired seams), run_events_unavailable (SSE router unwired).",
      content: { "application/json": media(schemaRef("ErrorEnvelope")) },
    },
  },
};

// ---------------------------------------------------------------------------
// The document.
// ---------------------------------------------------------------------------

export const OPENAPI_SPEC: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Agentic Design SaaS — Gateway API",
    version: "0.1.0",
    summary: "Versioned /v1 REST + SSE surface (spec §13).",
    description: [
      "Machine-readable contract for the gateway's /v1 surface. Spec §13 of",
      "docs/BUILD_PROMPT.md (endpoints §13.1, SSE §13.2, errors §13.3, §13.4",
      '"the public API is the agent API") is authoritative; the endpoint audit',
      "(route file → status → discrepancies) lives in",
      "apps/gateway/docs/api/openapi-contract.md (W4-O).",
      "",
      "ERROR ENVELOPE — RECONCILED CONTRACT (decision W4-O, the contract wave):",
      "every error response uses the FLAT envelope",
      "{ ok:false, code, message, hint, retryable, docs_url?, details? }.",
      "§13.3's sketch of a nested { error: { code, message, hint?, retryable,",
      "docs_url? } } shape was REJECTED — docs/AGENTS.md code style mandates the",
      "flat shape repo-wide, the shipped gateway error mapper",
      "(apps/gateway/src/middleware/error-mapper.ts, W1-H) emits flat, and the",
      "reconcile note in docs/api/README.md ('Error envelope') queued the Wave-4",
      "amendment to this wave. The nested shape never appears on /v1.",
      "Reconciled with it: schema-validation failures answer 422",
      "`validation_failed` (plus field-level `details`); §13.3's literal 400",
      "remains for malformed request frames (bad JSON, bad multipart, malformed",
      "Last-Event-ID).",
      "",
      "AUTH (§13 preamble): Better Auth session cookie for the web app;",
      "hashed, scoped, revocable personal API keys for the public API.",
      "Bearer API-key resolution runs before the cookie path, and the 401",
      "never reveals which mechanism failed (§15.2).",
      "",
      "IDEMPOTENCY (§13 preamble): every mutating endpoint takes an",
      "Idempotency-Key header (or a client-generated UUID). Run creation",
      "enforces it today; other mutations validate + correlate it until the",
      "idempotency store wave lands (audit D7).",
      "",
      "IMPLEMENTATION STATUS: each operation carries x-studio-status mirroring",
      "the W4-O audit table — `implemented` (served today), `wired-in-W4-R`",
      "(route module landed; W4-R mounts it), `partial` (lands with a flagged",
      "divergence), `not-implemented` (contract-only; see the audit's gap",
      "list). Until W4-R wiring lands, unmounted §13 paths answer 501",
      "`not_implemented` from the /v1 catch-all placeholder (routes/index.ts).",
      "",
      "SSE (§13.2): GET /v1/runs/{id}/events streams text/event-stream frames",
      "id: <seq>, event: <type>, data: { seq, run_id, at, type, payload }.",
      "Backfill from run_events first, then live; clients dedupe by seq and",
      "resume with the Last-Event-ID header; the stream closes after a",
      "terminal event (run.succeeded/failed/cancelled); a comment heartbeat",
      "is sent every 15 s.",
    ].join("\n"),
  },
  servers: [
    {
      url: "http://localhost:8787",
      description:
        "Local dev (GATEWAY_PORT default; behind Caddy in staging/prod, §17.2).",
    },
  ],
  tags: [
    { name: "Auth", description: "Better Auth handlers + current user (§13.1)." },
    { name: "Workspaces", description: "Workspace CRUD, members, brand tokens (§13.1, §15.2)." },
    { name: "Invites", description: "Workspace invite flow (§13.1)." },
    { name: "Documents", description: "Document CRUD + versions (§13.1, §12.2, §10.4)." },
    { name: "Commands", description: "Manual command execution + undo/redo (§13.1, §13.4)." },
    { name: "Runs", description: "Agent runs: create, status, list, cancel (§13.1, §3.3)." },
    { name: "RunEvents", description: "SSE run event stream (§13.1, §13.2)." },
    { name: "Uploads", description: "Asset upload + library (§13.1, §20.2, §15.1)." },
    { name: "Catalog", description: "Templates + components with manifests (§13.1, §7)." },
    { name: "Billing", description: "Credits, Stripe checkout/portal, webhooks (§13.1, §14)." },
    { name: "Usage", description: "Daily usage rollups (§13.1)." },
    { name: "Meta", description: "Health + this document (§13.1)." },
  ],
  paths: {
    // --- Auth (§13.1: POST /v1/auth/*; W4-A modules landed — audit D1) ------
    "/v1/auth/{handler}": {
      summary: "Better Auth handlers (sign-up/in/out, magic link, OAuth, sessions, orgs, keys).",
      description:
        "§13.1 `POST /v1/auth/*`. The auth server (src/auth/server.ts, W4-A) is " +
        "Better Auth mounted at its default basePath /api/auth (src/auth/" +
        "client-config.ts) — DIVERGENCE: §13.1 pins /v1/auth/*; W4-R must remount " +
        "(basePath) or proxy. Some handlers are public (session bootstrap); " +
        "org/invite/key handlers require an existing session.",
      post: {
        summary: "Better Auth action handlers (mount divergence flagged, audit D1).",
        operationId: "authHandlerPost",
        tags: ["Auth"],
        security: [],
        "x-studio-status": "partial",
        parameters: [pathParam("handler", "Better Auth handler name.", 128)],
        responses: {
          "200": {
            description: "Handler-specific JSON body.",
            content: { "application/json": media(looseObject("Better Auth handler response.")) },
          },
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
        },
      },
      get: {
        summary: "Better Auth read handlers (e.g. get-session).",
        operationId: "authHandlerGet",
        tags: ["Auth"],
        security: [],
        "x-studio-status": "partial",
        parameters: [pathParam("handler", "Better Auth handler name.", 128)],
        responses: {
          "200": {
            description: "Handler-specific JSON body.",
            content: { "application/json": media(looseObject("Better Auth handler response.")) },
          },
          "401": responseRef("Unauthorized"),
        },
      },
    },
    "/v1/me": {
      summary: "User + memberships + plan summary (§13.1).",
      get: {
        summary: "Current user, memberships and plan summary.",
        operationId: "getMe",
        tags: ["Auth"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description:
          "Contract-only (audit D2 gap): no route module yet. Response shape " +
          "provisional — pinned by the route wave that lands it.",
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "user", "memberships", "plan"],
              properties: {
                ok: OK_TRUE,
                user: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    email: { type: "string" },
                    name: { type: "string" },
                  },
                },
                memberships: { type: "array", items: schemaRef("WorkspaceSummary") },
                plan: looseObject("Plan summary (§14.1)."),
              },
            },
            "Provisional shape (§13.1)."
          ),
          "401": responseRef("Unauthorized"),
        },
      },
    },
    // --- Workspaces (W4-E) --------------------------------------------------
    "/v1/workspaces": {
      summary: "List mine / create a workspace (§13.1).",
      get: {
        summary: "List my workspaces (memberships).",
        operationId: "listWorkspaces",
        tags: ["Workspaces"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "workspaces"],
              properties: {
                ok: OK_TRUE,
                workspaces: { type: "array", items: schemaRef("WorkspaceSummary") },
              },
            },
            "Workspaces the caller belongs to."
          ),
          "401": responseRef("Unauthorized"),
          "429": responseRef("RateLimited"),
        },
      },
      post: {
        summary: "Create a workspace (org + owner member + trial grant, §1.4/§14.1).",
        operationId: "createWorkspace",
        tags: ["Workspaces"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [paramRef("IdempotencyKey")],
        requestBody: jsonBody(
          schemaRef("CreateWorkspaceRequest"),
          "createWorkspaceSchema (strict)."
        ),
        responses: {
          "201": jsonResponse(
            {
              type: "object",
              required: ["ok", "workspace", "role", "trial"],
              properties: {
                ok: OK_TRUE,
                workspace: schemaRef("WorkspaceDetail"),
                role: ROLE_ENUM,
                trial: {
                  type: "object",
                  required: ["granted", "credits", "duplicate"],
                  properties: {
                    granted: { type: "boolean" },
                    credits: { type: "number" },
                    duplicate: { type: "boolean" },
                  },
                },
              },
            },
            "Created; role is owner. Trial grant is idempotent per workspace (§14.2 r6)."
          ),
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "409": responseRef("Conflict"),
          "422": responseRef("ValidationFailed"),
          "429": responseRef("RateLimited"),
        },
      },
    },
    "/v1/workspaces/{id}": {
      summary: "Read / rename + brand-tokens (§13.1).",
      get: {
        summary: "Read a workspace (any member).",
        operationId: "getWorkspace",
        tags: ["Workspaces"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [pathIdParam()],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "workspace", "role"],
              properties: {
                ok: OK_TRUE,
                workspace: schemaRef("WorkspaceDetail"),
                role: ROLE_ENUM,
              },
            },
            "Workspace + the caller's role."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
        },
      },
      patch: {
        summary: "Rename / set brand tokens (admin+, §15.2).",
        operationId: "patchWorkspace",
        tags: ["Workspaces"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [pathIdParam(), paramRef("IdempotencyKey")],
        requestBody: jsonBody(
          schemaRef("WorkspacePatchRequest"),
          "patchWorkspaceSchema (strict; at least one field)."
        ),
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "workspace"],
              properties: { ok: OK_TRUE, workspace: schemaRef("WorkspaceDetail") },
            },
            "Updated."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
          "422": responseRef("ValidationFailed"),
        },
      },
    },
    "/v1/workspaces/{id}/members": {
      summary: "List members (admin+; extra endpoint, audit E2).",
      get: {
        summary: "List workspace members.",
        operationId: "listMembers",
        tags: ["Workspaces"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [pathIdParam()],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "members"],
              properties: {
                ok: OK_TRUE,
                members: { type: "array", items: schemaRef("MemberView") },
              },
            },
            "Members."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
        },
      },
    },
    "/v1/workspaces/{id}/members/{userId}": {
      summary: "Remove a member (admin+; last-owner protected; extra endpoint, audit E2).",
      delete: {
        summary: "Remove a member from the workspace.",
        operationId: "removeMember",
        tags: ["Workspaces"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [
          pathIdParam(),
          pathParam("userId", "Member user id.", 200),
          paramRef("IdempotencyKey"),
        ],
        responses: {
          "200": jsonResponse(
            { type: "object", required: ["ok"], properties: { ok: OK_TRUE } },
            "Removed."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
        },
      },
    },
    "/v1/workspaces/{id}/invites": {
      summary: "List / create invites (admin+, §13.1).",
      get: {
        summary: "List invites.",
        operationId: "listInvites",
        tags: ["Invites"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [pathIdParam()],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "invites"],
              properties: {
                ok: OK_TRUE,
                invites: { type: "array", items: schemaRef("InviteView") },
              },
            },
            "Invites."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
        },
      },
      post: {
        summary: "Create an invite (role ∈ editor|viewer|admin — never owner).",
        operationId: "createInvite",
        tags: ["Invites"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        description:
          "TODO(email): the token is returned in-band until the email wave " +
          "lands.",
        parameters: [pathIdParam(), paramRef("IdempotencyKey")],
        requestBody: jsonBody(schemaRef("InviteRequest"), "inviteSchema (strict)."),
        responses: {
          "201": jsonResponse(
            {
              type: "object",
              required: ["ok", "invite"],
              properties: { ok: OK_TRUE, invite: schemaRef("InviteView") },
            },
            "Created."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
          "422": responseRef("ValidationFailed"),
          "429": responseRef("RateLimited"),
        },
      },
    },
    "/v1/workspaces/{id}/invites/{inviteId}": {
      summary: "Cancel an invite (admin+; extra endpoint, audit E2).",
      delete: {
        summary: "Cancel an invite by id.",
        operationId: "cancelInviteById",
        tags: ["Invites"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [
          pathIdParam(),
          pathParam("inviteId", "Invite id.", 200),
          paramRef("IdempotencyKey"),
        ],
        responses: {
          "200": jsonResponse(
            { type: "object", required: ["ok"], properties: { ok: OK_TRUE } },
            "Cancelled."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
        },
      },
    },
    "/v1/invites/{token}": {
      summary: "View / cancel an invite by email token (extra endpoints, audit E3).",
      get: {
        summary: "Pre-accept view (token is the capability).",
        operationId: "viewInvite",
        tags: ["Invites"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [pathParam("token", "Invite token (the capability).", 200)],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "invite"],
              properties: { ok: OK_TRUE, invite: schemaRef("InviteView") },
            },
            "Invite."
          ),
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
        },
      },
      delete: {
        summary: "Cancel by token (admin+ of the inviting workspace).",
        operationId: "cancelInviteByToken",
        tags: ["Invites"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [pathParam("token", "Invite token.", 200), paramRef("IdempotencyKey")],
        responses: {
          "200": jsonResponse(
            { type: "object", required: ["ok"], properties: { ok: OK_TRUE } },
            "Cancelled."
          ),
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
        },
      },
    },
    "/v1/invites/{token}/accept": {
      summary: "Accept an invite (§13.1).",
      post: {
        summary: "Accept an invitation.",
        operationId: "acceptInvite",
        tags: ["Invites"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        description:
          "TODO(email): verifying the accepter's address against invitation.email " +
          "lands with the email wave.",
        parameters: [pathParam("token", "Invite token.", 200), paramRef("IdempotencyKey")],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "workspace_id", "role"],
              properties: {
                ok: OK_TRUE,
                workspace_id: { type: "string" },
                role: INVITE_ROLE_ENUM,
              },
            },
            "Accepted."
          ),
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
        },
      },
    },
    // --- Projects (§13.1) — audit D3: no project table ---------------------
    "/v1/projects": {
      summary: "List/create projects (§13.1).",
      get: {
        summary: "List projects.",
        operationId: "listProjects",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description:
          "GAP (audit D3): the landed schema has no project table — documents " +
          "hang off the organization directly (W1-D, noted in routes/uploads.ts). " +
          "Either projects land as a concept or §13.1 is amended; request/response " +
          "bodies are pinned then.",
        responses: {
          "401": responseRef("Unauthorized"),
          "429": responseRef("RateLimited"),
        },
      },
      post: {
        summary: "Create a project.",
        operationId: "createProject",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description: "GAP (audit D3) — see GET /v1/projects.",
        parameters: [paramRef("IdempotencyKey")],
        responses: {
          "401": responseRef("Unauthorized"),
          "422": responseRef("ValidationFailed"),
        },
      },
    },
    // --- Documents (W4-F) ---------------------------------------------------
    "/v1/documents": {
      summary: "List/create documents (§13.1).",
      get: {
        summary: "Paged document list (newest first).",
        operationId: "listDocuments",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [
          {
            name: "cursor",
            in: "query",
            required: false,
            description: "Opaque keyset cursor from next_cursor.",
            schema: { type: "string", minLength: 1, maxLength: 1024 },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          {
            name: "include_archived",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["true", "false"], default: "false" },
          },
        ],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "documents"],
              properties: {
                ok: OK_TRUE,
                documents: { type: "array", items: schemaRef("DocumentDto") },
                next_cursor: { type: "string" },
              },
            },
            "One page; next_cursor absent on the last page."
          ),
          "401": responseRef("Unauthorized"),
          "422": responseRef("ValidationFailed"),
        },
      },
      post: {
        summary: "Create a document (optionally from a template, §7).",
        operationId: "createDocument",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        description:
          "Canvas ceiling enforced per plan (§14.1): 402 plan_limit; 422 on " +
          "shape errors.",
        parameters: [paramRef("IdempotencyKey")],
        requestBody: jsonBody(schemaRef("CreateDocumentRequest"), "createBodySchema (strict)."),
        responses: {
          "201": jsonResponse(
            {
              type: "object",
              required: ["ok", "document", "version"],
              properties: {
                ok: OK_TRUE,
                document: schemaRef("DocumentDto"),
                version: schemaRef("VersionDto"),
              },
            },
            "Created; the Location header points at the new document."
          ),
          "401": responseRef("Unauthorized"),
          "402": responseRef("PaymentRequired"),
          "403": responseRef("Forbidden"),
          "422": responseRef("ValidationFailed"),
          "429": responseRef("RateLimited"),
        },
      },
    },
    "/v1/documents/{id}": {
      summary: "Read / rename-archive / soft-delete (§13.1, §12.2).",
      get: {
        summary: "Metadata + latest version.",
        operationId: "getDocument",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        description:
          "§13.1 also promises preview URL + layer summary in this body — not " +
          "yet in the DTO (audit D9); GET /v1/documents/{id}/preview and " +
          "/layers cover them.",
        parameters: [pathIdParam()],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "document"],
              properties: {
                ok: OK_TRUE,
                document: {
                  allOf: [schemaRef("DocumentDto")],
                  properties: {
                    latest_version: { anyOf: [schemaRef("VersionDto"), { type: "null" }] },
                  },
                },
              },
            },
            "Document + latest_version."
          ),
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
        },
      },
      patch: {
        summary: "Rename / archive / unarchive.",
        operationId: "patchDocument",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [pathIdParam(), paramRef("IdempotencyKey")],
        requestBody: jsonBody(
          schemaRef("DocumentPatchRequest"),
          "patchBodySchema (strict; at least one field)."
        ),
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "document"],
              properties: { ok: OK_TRUE, document: schemaRef("DocumentDto") },
            },
            "Updated."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
          "422": responseRef("ValidationFailed"),
        },
      },
      delete: {
        summary: "Archive semantics (soft delete, §12.2); idempotent.",
        operationId: "deleteDocument",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        description: "The GDPR hard-delete job owns true removal.",
        parameters: [pathIdParam(), paramRef("IdempotencyKey")],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "document"],
              properties: { ok: OK_TRUE, document: schemaRef("DocumentDto") },
            },
            "Archived."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
        },
      },
    },
    "/v1/documents/{id}/versions": {
      summary: "Version timeline (§13.1, §10.4).",
      get: {
        summary: "Version timeline ascending.",
        operationId: "listDocumentVersions",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [
          pathIdParam(),
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 200, default: 100 },
          },
        ],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "versions"],
              properties: {
                ok: OK_TRUE,
                versions: { type: "array", items: schemaRef("VersionDto") },
              },
            },
            "Timeline."
          ),
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
          "422": responseRef("ValidationFailed"),
        },
      },
    },
    "/v1/documents/{id}/versions/{versionId}/restore": {
      summary: "Restore as a NEW version (§13.1, §10.4).",
      post: {
        summary: "Restore a version — source bytes are never mutated.",
        operationId: "restoreDocumentVersion",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [
          pathIdParam(),
          pathParam("versionId", "Version id.", 128),
          paramRef("IdempotencyKey"),
        ],
        responses: {
          "201": jsonResponse(
            {
              type: "object",
              required: ["ok", "document", "version", "bytes_stored"],
              properties: {
                ok: OK_TRUE,
                document: schemaRef("DocumentDto"),
                version: schemaRef("VersionDto"),
                bytes_stored: { type: "integer" },
              },
            },
            "A fresh version row (revision = current + 1) is appended and becomes the head."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
          "429": responseRef("RateLimited"),
        },
      },
    },
    "/v1/documents/{id}/layers": {
      summary: "Compact layer tree via layer.list (§13.1).",
      get: {
        summary: "Compact layer tree.",
        operationId: "listDocumentLayers",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description: "GAP (audit D2): no route module yet.",
        parameters: [pathIdParam()],
        responses: {
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
        },
      },
    },
    "/v1/documents/{id}/inspect": {
      summary: "Filtered scene graph (§13.1).",
      get: {
        summary: "Filtered scene graph.",
        operationId: "inspectDocument",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description: "GAP (audit D2): no route module yet.",
        parameters: [pathIdParam()],
        responses: {
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
        },
      },
    },
    // --- Runs (W4-G; §13.1 alias partial — audit D4) -------------------------
    "/v1/documents/{id}/runs": {
      summary: "Create a run on a document (§13.1 alias — partial, audit D4).",
      post: {
        summary: "Create an agent run for this document.",
        operationId: "createRunForDocument",
        tags: ["Runs"],
        security: AUTH_BOTH,
        "x-studio-status": "partial",
        description:
          "NOT the implemented path: W4-G ships POST /v1/runs with a camelCase " +
          "body (documentId inside the body). This §13.1 alias — snake_case " +
          "{ prompt, tier?, template?, attachment_asset_ids?, model? } — is " +
          "contract-only until W4-R reconciles alias + field names (audit D4).",
        parameters: [pathIdParam(), paramRef("IdempotencyKey")],
        requestBody: jsonBody(
          {
            type: "object",
            description: "§13.1 body (snake_case; provisional until the alias lands).",
            required: ["prompt"],
            properties: {
              prompt: { type: "string", minLength: 1, maxLength: 8000 },
              tier: {
                type: "string",
                enum: ["quick", "standard", "complex", "premium", "max"],
              },
              template: { type: "string", description: 'Template ref, e.g. "instagram-post@3".' },
              attachment_asset_ids: { type: "array", maxItems: 16, items: { type: "string" } },
              model: { type: "string", description: "Model preference (multipliers §14.1)." },
            },
          },
          "§13.1 spelling."
        ),
        responses: {
          "201": jsonResponse(
            {
              type: "object",
              required: ["run_id", "credits_reserved"],
              properties: { run_id: { type: "string" }, credits_reserved: { type: "number" } },
            },
            "{ run_id, credits_reserved } (§13.1)."
          ),
          "401": responseRef("Unauthorized"),
          "402": responseRef("PaymentRequired"),
          "404": responseRef("NotFound"),
          "422": responseRef("ValidationFailed"),
          "429": responseRef("RateLimited"),
          "503": responseRef("ServiceUnavailable"),
        },
      },
    },
    "/v1/runs": {
      summary: "Create / list agent runs (§13.1 + list extra, audit E5).",
      post: {
        summary: "Create a run: auth → tenant → caps → reserve → insert → enqueue.",
        operationId: "createRun",
        tags: ["Runs"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        description:
          "Implemented contract (W4-G). §14.2 rule 1: credits are reserved " +
          "up-front; insufficient balance → 402 and the run never starts. " +
          "jobId = runId so a duplicate enqueue cannot double-apply (§3.4).",
        parameters: [paramRef("IdempotencyKeyOrBody")],
        requestBody: jsonBody(schemaRef("CreateRunRequest"), "CREATE_RUN_BODY_SCHEMA (strict)."),
        responses: {
          "201": jsonResponse(
            {
              type: "object",
              required: ["run_id", "status", "credits_reserved"],
              properties: {
                run_id: { type: "string" },
                status: { type: "string", enum: ["queued"] },
                credits_reserved: { type: "number" },
              },
            },
            "{ run_id, status, credits_reserved } (§13.1)."
          ),
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "402": responseRef("PaymentRequired"),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
          "422": responseRef("ValidationFailed"),
          "429": responseRef("RateLimited"),
          "503": responseRef("ServiceUnavailable"),
        },
      },
      get: {
        summary: "One org-scoped page of runs, optional document filter.",
        operationId: "listRuns",
        tags: ["Runs"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [
          {
            name: "document_id",
            in: "query",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 200 },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 1024 },
          },
        ],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["runs"],
              properties: {
                runs: { type: "array", items: schemaRef("RunListItem") },
                next_cursor: { type: "string" },
              },
            },
            "One page."
          ),
          "401": responseRef("Unauthorized"),
          "422": responseRef("ValidationFailed"),
        },
      },
    },
    "/v1/runs/{id}": {
      summary: "Run status + plan + steps summary + cost (§13.1).",
      get: {
        summary: "Run detail.",
        operationId: "getRun",
        tags: ["Runs"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [pathRunIdParam()],
        responses: {
          "200": jsonResponse(schemaRef("RunDetail"), "RunDetailApiView."),
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
        },
      },
    },
    "/v1/runs/{id}/cancel": {
      summary: "Cancel + rollback + refund (§13.1, §3.4, §14.2 rule 3).",
      post: {
        summary: "Cancel an active run (full reservation release for user_cancel).",
        operationId: "cancelRun",
        tags: ["Runs"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        description:
          "Terminal runs answer 409; the worker enforces rollback/refund " +
          "idempotently.",
        parameters: [pathRunIdParam(), paramRef("IdempotencyKey")],
        requestBody: jsonBody(
          {
            type: "object",
            properties: {
              reason: {
                type: "string",
                minLength: 1,
                maxLength: 200,
                description: "Defaults to user_cancel (§14.2 rule 3).",
              },
            },
            additionalProperties: false,
          },
          "Optional.",
          false
        ),
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["run_id", "status", "credits_refunded"],
              properties: {
                run_id: { type: "string" },
                status: { type: "string", enum: ["cancelled"] },
                credits_refunded: { type: "number" },
              },
            },
            "Cancelled."
          ),
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
          "422": responseRef("ValidationFailed"),
        },
      },
    },
    "/v1/runs/{id}/events": {
      summary: "SSE run event stream (§13.1, §13.2).",
      get: {
        summary: "Backfill from run_events, then live (text/event-stream).",
        operationId: "streamRunEvents",
        tags: ["RunEvents"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        description:
          "§13.2. Frames: `id: <seq>`, `event: <type>`, `data: { seq, run_id, " +
          "at, type, payload }`. Resume with the Last-Event-ID header (the seq " +
          "of the last contiguous event); ?lastEventId= is the non-EventSource " +
          "fallback and the header wins when both are present. Backfill replays " +
          "run_events rows with seq > Last-Event-ID, then live delivery, " +
          "deduped by seq on both sides. A seq gap emits the `run.resync` " +
          "sentinel (id = last contiguous seq) and closes the response — " +
          "reconnect with that Last-Event-ID to re-heal from the durable store. " +
          "The stream closes after a terminal event (run.succeeded | run.failed " +
          "| run.cancelled). A comment heartbeat (\": hb\") is sent every 15 s. " +
          "Cross-tenant and unknown run ids answer the same 404 (§15.1).",
        parameters: [
          pathRunIdParam(),
          {
            name: "Last-Event-ID",
            in: "header",
            required: false,
            description:
              "§13.2 resume anchor: the seq of the last event received. " +
              "Malformed values answer 400.",
            schema: { type: "string", pattern: "^[0-9]{1,15}$", example: "42" },
          },
          {
            name: "lastEventId",
            in: "query",
            required: false,
            description: "Fallback for non-EventSource clients; the header wins.",
            schema: { type: "string", pattern: "^[0-9]{1,15}$" },
          },
        ],
        responses: {
          "200": {
            description: "SSE stream (§13.2). Media type text/event-stream.",
            content: {
              "text/event-stream": {
                schema: {
                  type: "string",
                  description:
                    "Raw SSE text: id/event/data frames per §13.2 + comment heartbeats.",
                },
                example:
                  ": sse open\n\n" +
                  "id: 1\nevent: run.queued\ndata: {\"seq\":1,\"run_id\":\"run_…\"," +
                  "\"at\":\"2026-01-15T10:00:00.000Z\",\"type\":\"run.queued\"," +
                  "\"payload\":{}}\n\n" +
                  "id: 7\nevent: run.succeeded\ndata: {\"seq\":7,\"run_id\":\"run_…\"," +
                  "\"at\":\"2026-01-15T10:00:09.000Z\",\"type\":\"run.succeeded\"," +
                  "\"payload\":{}}\n\n",
              },
            },
            headers: {
              "Cache-Control": {
                description: "no-cache while the stream is open.",
                schema: { type: "string", const: "no-cache" },
              },
            },
          },
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
          "503": responseRef("ServiceUnavailable"),
        },
      },
    },
    // --- Commands + undo/redo (§13.1, §13.4; W4-K per code comments) --------
    "/v1/documents/{id}/commands": {
      summary: "Manual command execution (§13.1, §13.4).",
      post: {
        summary: "Execute one allowed engine command (the same allowlist as agent tools).",
        operationId: "executeDocumentCommand",
        tags: ["Commands"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description:
          "GAP (audit D2): the route module lands with W4-K (routes/documents.ts " +
          "note). §13.4: the public API is the agent API — raw engine ids are NOT " +
          "exposed. Body pinned when the route lands; Idempotency-Key per the " +
          "§13 preamble.",
        parameters: [pathIdParam(), paramRef("IdempotencyKey")],
        responses: {
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
          "422": responseRef("ValidationFailed"),
          "429": responseRef("RateLimited"),
        },
      },
    },
    "/v1/documents/{id}/undo": {
      summary: "Undo one step (§13.1).",
      post: {
        summary: "Undo one step (an agent run undoes as one step).",
        operationId: "undoDocument",
        tags: ["Commands"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description: "GAP (audit D2): W4-K.",
        parameters: [pathIdParam(), paramRef("IdempotencyKey")],
        responses: {
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
        },
      },
    },
    "/v1/documents/{id}/redo": {
      summary: "Redo one step (§13.1).",
      post: {
        summary: "Redo one step.",
        operationId: "redoDocument",
        tags: ["Commands"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description: "GAP (audit D2): W4-K.",
        parameters: [pathIdParam(), paramRef("IdempotencyKey")],
        responses: {
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
        },
      },
    },
    // --- Exports / preview (§13.1) ------------------------------------------
    "/v1/documents/{id}/exports": {
      summary: "Create an export job (§13.1).",
      post: {
        summary: "{ format, width?, height?, quality? } → job → URL.",
        operationId: "createExport",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description:
          "GAP (audit D2): no route module yet. Plan gates apply to export " +
          "fidelity (§14.1) → 402.",
        parameters: [pathIdParam(), paramRef("IdempotencyKey")],
        requestBody: jsonBody(
          {
            type: "object",
            description: "§13.1 body.",
            required: ["format"],
            properties: {
              format: { type: "string", enum: ["pcraft", "png", "jpg", "psd"] },
              width: { type: "integer", minimum: 1 },
              height: { type: "integer", minimum: 1 },
              quality: { type: "integer", minimum: 1, maximum: 100 },
            },
            additionalProperties: false,
          },
          "§13.1 spelling."
        ),
        responses: {
          "202": jsonResponse(
            {
              type: "object",
              description: "Provisional: job handle + final URL once the job completes.",
              properties: {
                ok: OK_TRUE,
                job_id: { type: "string" },
                url: { type: "string" },
              },
            },
            "Export job accepted (§13.1: job → URL)."
          ),
          "401": responseRef("Unauthorized"),
          "402": responseRef("PaymentRequired"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
          "422": responseRef("ValidationFailed"),
          "429": responseRef("RateLimited"),
        },
      },
    },
    "/v1/documents/{id}/preview": {
      summary: "Cached preview PNG (§13.1).",
      get: {
        summary: "Cached preview at the requested width (signed URL).",
        operationId: "getDocumentPreview",
        tags: ["Documents"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description:
          "GAP (audit D2): no route module yet. §13.1: cached preview PNG " +
          "served via a short-lived signed URL (§15.1 ≤15 min); response shape " +
          "pinned then.",
        parameters: [
          pathIdParam(),
          {
            name: "w",
            in: "query",
            required: false,
            description: "Preview width.",
            schema: { type: "integer", minimum: 1, default: 1024 },
          },
        ],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              description: "Provisional shape.",
              properties: {
                ok: OK_TRUE,
                url: { type: "string", description: "Signed URL (≤15 min, §15.1)." },
                revision: { type: "integer" },
                width: { type: "integer" },
              },
            },
            "Preview pointer."
          ),
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
          "429": responseRef("RateLimited"),
        },
      },
    },
    // --- Uploads / assets (W4-I) ---------------------------------------------
    "/v1/uploads": {
      summary: "Upload an asset (§13.1, §20.2, §15.2).",
      post: {
        summary: "Multipart upload (one 'file' part) + register asset; byte-idempotent.",
        operationId: "uploadAsset",
        tags: ["Uploads"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        description:
          "§13.1 offers pre-signed OR multipart; the multipart branch is " +
          "implemented (audit D10). §20.2: magic-byte sniffing (never the " +
          "Content-Type header), 25 MB cap (Content-Length pre-screen → 413), " +
          "60 MP bomb ceiling; EXIF stripped by the worker. Dedupe on " +
          "(organization, sha256) → duplicate: true.",
        parameters: [paramRef("IdempotencyKey")],
        requestBody: {
          description:
            "multipart/form-data: one 'file' part (JPEG or PNG), optional " +
            "'kind' (only \"image\") and 'name' (≤200 chars).",
          required: true,
          content: {
            "multipart/form-data": media({
              type: "object",
              required: ["file"],
              properties: {
                file: { type: "string", format: "binary", description: "JPEG or PNG bytes." },
                kind: {
                  type: "string",
                  enum: ["image"],
                  description: "Fonts are managed server-side, never uploaded.",
                },
                name: { type: "string", maxLength: 200 },
              },
            }),
          },
        },
        responses: {
          "201": jsonResponse(
            {
              type: "object",
              required: ["ok", "asset", "duplicate"],
              properties: {
                ok: OK_TRUE,
                asset: {
                  type: "object",
                  required: ["id", "kind", "bytes", "width", "height", "mime", "checksum"],
                  properties: {
                    id: { type: "string" },
                    kind: { type: "string" },
                    bytes: { type: "integer" },
                    width: { type: ["integer", "null"] },
                    height: { type: ["integer", "null"] },
                    mime: { type: "string" },
                    checksum: { type: "string" },
                  },
                },
                duplicate: { type: "boolean" },
              },
            },
            "Registered."
          ),
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "413": responseRef("PayloadTooLarge"),
          "422": responseRef("ValidationFailed"),
          "429": responseRef("RateLimited"),
        },
      },
    },
    "/v1/assets": {
      summary: "Asset library (§13.1).",
      get: {
        summary: "Newest-first asset page, keyset-paged by (created_at, id).",
        operationId: "listAssets",
        tags: ["Uploads"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,512}$" },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          {
            name: "project_id",
            in: "query",
            required: false,
            description:
              "§13.1 lists ?project_id= — accepted + validated today, but there " +
              "is no project column, so it does not filter yet (audit D3).",
            schema: { type: "string", minLength: 1, maxLength: 200 },
          },
        ],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "assets"],
              properties: {
                ok: OK_TRUE,
                assets: { type: "array", items: schemaRef("AssetSummary") },
                next_cursor: { type: "string" },
              },
            },
            "One page."
          ),
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "422": responseRef("ValidationFailed"),
        },
      },
    },
    "/v1/assets/{id}": {
      summary: "Asset metadata + signed URL / delete (extra endpoints, audit E4).",
      get: {
        summary: "Metadata + short-lived signed URL (ttl 900 s, §15.1).",
        operationId: "getAsset",
        tags: ["Uploads"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [pathIdParam()],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "asset", "url"],
              properties: {
                ok: OK_TRUE,
                asset: schemaRef("AssetSummary"),
                url: {
                  type: "object",
                  required: ["url", "expires_at", "expires_in_seconds"],
                  properties: {
                    url: { type: "string" },
                    expires_at: createdAt(),
                    expires_in_seconds: { type: "integer", maximum: 900 },
                  },
                },
              },
            },
            "Signed URL ≤ 15 min."
          ),
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "404": responseRef("NotFound"),
        },
      },
      delete: {
        summary: "Delete an asset (editor+; audited §22; re-delete is 404).",
        operationId: "deleteAsset",
        tags: ["Uploads"],
        security: AUTH_BOTH,
        "x-studio-status": "wired-in-W4-R",
        parameters: [pathIdParam(), paramRef("IdempotencyKey")],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "deleted", "id"],
              properties: { ok: OK_TRUE, deleted: { const: true }, id: { type: "string" } },
            },
            "Deleted."
          ),
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "404": responseRef("NotFound"),
        },
      },
    },
    // --- Catalog (§13.1) ----------------------------------------------------
    "/v1/templates": {
      summary: "Template catalog with manifests (§13.1, §7).",
      get: {
        summary: "Templates + manifests.",
        operationId: "listTemplates",
        tags: ["Catalog"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description: "GAP (audit D2): no catalog route module yet.",
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "templates"],
              properties: {
                ok: OK_TRUE,
                templates: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      version: { type: "integer" },
                      name: { type: "string" },
                      manifest: looseObject("Template manifest (§7)."),
                    },
                  },
                },
              },
            },
            "Catalog."
          ),
          "401": responseRef("Unauthorized"),
        },
      },
    },
    "/v1/components": {
      summary: "Component catalog with manifests (§13.1, §7).",
      get: {
        summary: "Components + manifests.",
        operationId: "listComponents",
        tags: ["Catalog"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description: "GAP (audit D2): no catalog route module yet.",
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "components"],
              properties: {
                ok: OK_TRUE,
                components: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      version: { type: "integer" },
                      name: { type: "string" },
                      manifest: looseObject("Component manifest (§7)."),
                    },
                  },
                },
              },
            },
            "Catalog."
          ),
          "401": responseRef("Unauthorized"),
        },
      },
    },
    // --- Credits / billing / webhooks (§13.1, §14) --------------------------
    "/v1/credits": {
      summary: "Balance + ledger page (§13.1).",
      get: {
        summary: "Credit balance + one ledger page (append-only ledger, §14.2).",
        operationId: "getCredits",
        tags: ["Billing"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description: "GAP (audit D2): no route module yet.",
        parameters: [
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              description: "Provisional.",
              properties: {
                ok: OK_TRUE,
                balance: { type: "number" },
                ledger: { type: "array", items: looseObject("Ledger entry (§14.2).") },
                next_cursor: { type: "string" },
              },
            },
            "Balance + page."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
        },
      },
    },
    "/v1/billing/checkout": {
      summary: "Stripe Checkout session (§13.1, §14.3).",
      post: {
        summary: "Create a Stripe Checkout session (plans, credit packs).",
        operationId: "createCheckout",
        tags: ["Billing"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description:
          "GAP (audit D2): no route module yet. Stripe Tax enabled; PCI scope " +
          "is Stripe's (§14.3).",
        parameters: [paramRef("IdempotencyKey")],
        requestBody: jsonBody(
          {
            type: "object",
            description: "Provisional (§14.1 plans + credit packs).",
            properties: {
              plan_id: { type: "string" },
              credit_pack: { type: "string", enum: ["pack_100"] },
            },
            additionalProperties: false,
          },
          "Pinned when the billing route lands.",
          false
        ),
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "url"],
              properties: {
                ok: OK_TRUE,
                url: { type: "string", description: "Stripe Checkout URL." },
              },
            },
            "Redirect target."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "409": responseRef("Conflict"),
          "422": responseRef("ValidationFailed"),
        },
      },
    },
    "/v1/billing/portal": {
      summary: "Stripe customer portal (§13.1, §14.3).",
      post: {
        summary: "Create a customer-portal session (card/plan changes).",
        operationId: "createPortal",
        tags: ["Billing"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description: "GAP (audit D2): no route module yet.",
        parameters: [paramRef("IdempotencyKey")],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "url"],
              properties: { ok: OK_TRUE, url: { type: "string" } },
            },
            "Portal URL."
          ),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
        },
      },
    },
    "/v1/webhooks/stripe": {
      summary: "Signed Stripe webhook (§13.1, §14.3).",
      post: {
        summary: "Signature-verified, idempotent by event id.",
        operationId: "stripeWebhook",
        tags: ["Billing"],
        security: [],
        "x-studio-status": "not-implemented",
        description:
          "GAP (audit D2): no route module yet. Unauthenticated (signature-" +
          "verified instead); idempotent by Stripe event id. Webhooks are the " +
          "only source of truth for subscription state (§14.3).",
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              properties: { ok: OK_TRUE, received: { type: "boolean" } },
            },
            "Ack (idempotent)."
          ),
          "400": responseRef("BadRequest"),
          "409": responseRef("Conflict"),
        },
      },
    },
    "/v1/usage": {
      summary: "Daily usage rollups (§13.1).",
      get: {
        summary: "Daily rollups for the workspace dashboard.",
        operationId: "getUsage",
        tags: ["Usage"],
        security: AUTH_BOTH,
        "x-studio-status": "not-implemented",
        description: "GAP (audit D2): no route module yet.",
        parameters: [
          {
            name: "from",
            in: "query",
            required: false,
            description: "Inclusive start.",
            schema: { type: "string", format: "date" },
          },
          {
            name: "to",
            in: "query",
            required: false,
            description: "Inclusive end.",
            schema: { type: "string", format: "date" },
          },
        ],
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              description: "Provisional.",
              properties: {
                ok: OK_TRUE,
                days: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      date: { type: "string", format: "date" },
                      runs: { type: "integer" },
                      credits: { type: "number" },
                    },
                  },
                },
              },
            },
            "Rollups."
          ),
          "401": responseRef("Unauthorized"),
          "422": responseRef("ValidationFailed"),
        },
      },
    },
    // --- Health + meta (implemented today) -----------------------------------
    "/v1/health": {
      summary: "Liveness (§13.1).",
      get: {
        summary: "Process is up; O(1), no dependencies touched.",
        operationId: "getHealth",
        tags: ["Meta"],
        security: [],
        "x-studio-status": "implemented",
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "service", "version", "uptime_seconds"],
              properties: {
                ok: OK_TRUE,
                service: { const: "gateway" },
                version: { type: "string" },
                uptime_seconds: { type: "integer" },
              },
            },
            "Liveness."
          ),
        },
      },
    },
    "/v1/health/deep": {
      summary: "Dependency checks (§13.1).",
      get: {
        summary: "db / valkey / storage / engine pool / model providers.",
        operationId: "getHealthDeep",
        tags: ["Meta"],
        security: [],
        "x-studio-status": "implemented",
        description: "503 with the same body when any probe reports down.",
        responses: {
          "200": jsonResponse(
            {
              type: "object",
              required: ["ok", "service", "version", "uptime_seconds", "checks"],
              properties: {
                ok: { type: "boolean" },
                service: { const: "gateway" },
                version: { type: "string" },
                uptime_seconds: { type: "integer" },
                checks: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["name", "ok"],
                    properties: {
                      name: {
                        type: "string",
                        enum: ["db", "valkey", "storage", "engine_pool", "model_providers"],
                      },
                      ok: { type: "boolean" },
                      latency_ms: { type: "integer" },
                      detail: { type: "string" },
                      stub: { type: "boolean" },
                    },
                  },
                },
              },
            },
            "All probes green."
          ),
          "503": {
            description:
              "At least one dependency is down (§13.3: engine_unavailable / " +
              "service_unavailable).",
            content: { "application/json": media(schemaRef("ErrorEnvelope")) },
          },
        },
      },
    },
    "/v1/openapi.json": {
      summary: "This document (W4-O; served by mountOpenApi, W4-R mounts).",
      get: {
        summary: "The OpenAPI 3.1 document itself.",
        operationId: "getOpenapi",
        tags: ["Meta"],
        security: [],
        "x-studio-status": "implemented",
        responses: {
          "200": {
            description: "The OpenAPI 3.1 JSON document (this object).",
            content: { "application/json": media(looseObject("The OpenAPI 3.1 document.")) },
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// buildOpenApiSpec — the typed const, optionally stamped with the running
// service version / server origin (bootstrap + tests).
// ---------------------------------------------------------------------------

export interface BuildOpenApiSpecOptions {
  /** Override info.version (e.g. the version reported by GET /v1/health). */
  readonly version?: string;
  /** Override the server list (e.g. the deployed origin). */
  readonly servers?: readonly ServerObject[];
}

/**
 * Build the spec for serving. Returns a deep copy of the authored const with
 * optional version/server overrides — callers may mutate their copy freely
 * without touching the module-level document.
 */
export function buildOpenApiSpec(options: BuildOpenApiSpecOptions = {}): OpenApiDocument {
  const base = structuredClone(OPENAPI_SPEC);
  return {
    ...base,
    info: { ...base.info, ...(options.version !== undefined ? { version: options.version } : {}) },
    servers: options.servers ?? base.servers,
  };
}

// ---------------------------------------------------------------------------
// mountOpenApi — W4-R calls this once on the built app. Serving a JSON string
// directly (c.body) keeps the const's readonly types out of Hono's JSONValue
// machinery and makes the emitted bytes deterministic.
// ---------------------------------------------------------------------------

/** Serve GET /v1/openapi.json — the authored spec const (W4-R mounts it). */
export function mountOpenApi(app: Hono<AppEnv>): void {
  app.get("/v1/openapi.json", (c) =>
    c.body(JSON.stringify(OPENAPI_SPEC), 200, {
      "content-type": "application/json",
    })
  );
}
