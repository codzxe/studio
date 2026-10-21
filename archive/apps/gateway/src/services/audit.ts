// @studio/gateway — §22 audit trail service (append-only, org-exportable).
// Owner: W4-Q (docs/AGENTS.md).
//
// Spec anchors:
//   §22    `audit_log` records auth events, role changes, API keys, exports,
//          deletes and credit adjustments; immutable (append-only) and
//          exportable per workspace. This service implements the two §22
//          operations over the @studio/db `audit_log` table (W1-F schema):
//            append(action, {…}) — plain append, deliberately NOT idempotent:
//                                 every event is a fact; replaying a request
//                                 must not double-write (money paths stay
//                                 idempotent via the ledger, not here).
//                                 Rate-limited INTERNALLY per (organization,
//                                 action) so a runaway loop cannot storm the
//                                 table; denials return a typed envelope.
//            export(orgId, {…})  — cursor-paged, newest-first rows for ONE
//                                 organization, the §22 "exportable per
//                                 workspace" query. RBAC (admin+) is enforced
//                                 at the ROUTE layer — this method trusts its
//                                 caller. Call sites (W5+): the billing /
//                                 credits routes after the authz guard.
//   §15.3  never store raw prompts (or any user-content blob) in metadata:
//          redactMetadata() strips them BY POLICY BEFORE the insert, so the
//          durable row only ever holds export-safe context.
//   §15.2  error envelopes never leak internals: DB failures surface as
//          typed result envelopes (code/message/hint/retryable), not thrown
//          stack traces. Audit failure must never fail the primary action —
//          callers log/alert on `ok:false`.
//   §12.2  tenant scoping: `page()` always filters by organizationId; the
//          platform never exports one workspace's trail to another.
//
// Suggested action names (§22 taxonomy — free-form, lowercase dotted, kept
// stable so exports stay greppable):
//   auth.login, auth.logout, role.changed, member.invited, api_key.created,
//   api_key.revoked, export.created, document.deleted, asset.deleted,
//   credit.adjustment, credit.grant
//
// TODO(W5+, wiring): workspaces.ts already consumes a narrow `AuditLike`
// seam (`append({ organizationId, actorId, action, target, metadata })`).
// An adapter is one line: `append: async (e) => { const r = await
// audit.append(e.action, e); if (!r.ok) logger.warn(r.code); }` — do not
// change that file in place; land the adapter in the route wiring wave.

import { auditLog, type NewAuditLog } from "@studio/db";
import { and, desc, eq, gte, lt, lte, or, type SQL } from "drizzle-orm";
// Shared Drizzle client face (W4-H `DbLike` in event-store.ts — one
// definition per services/ family; this store needs exactly insert+select).
import type { DbLike } from "./event-store.js";
import { InMemoryKV, RateLimiter, type RateLimitPolicy } from "./limiter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default append storm guard: 60 events / 10 s per (organization, action). */
export const DEFAULT_APPEND_RATE: RateLimitPolicy = { limit: 60, windowSec: 10 };

/** Default export page size (rows per page). */
export const DEFAULT_EXPORT_PAGE_SIZE = 100;

/** Hard cap on export page size — one page must stay a bounded artifact. */
export const MAX_EXPORT_PAGE_SIZE = 500;

/** Sentinel target for actions that affect no specific record (logins…). */
export const PLATFORM_TARGET = "platform:none";

const ACTION_MAX_LENGTH = 128;
// Lowercase dotted/underscored/hyphenated segments: "auth.login",
// "api_key.created", "credit.adjustment". Uppercase/space is a caller bug.
const ACTION_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

// "<type>:<id>" per the W1-F column doc — printable, no whitespace, one colon
// at least ("document:<uuid>", "workspace:<uuid>").
const TARGET_MAX_LENGTH = 256;
const TARGET_PATTERN = /^[\x21-\x7E]+$/;

// uuid-shaped reference columns (organizations/users ids).
const REF_MAX_LENGTH = 64;

// ---------------------------------------------------------------------------
// Metadata redaction (§15.3 — never store raw prompts)
// ---------------------------------------------------------------------------

/** Value substituted for denied keys (and for failed decodes) in metadata. */
export const AUDIT_REDACTED = "[redacted]";
/** Value substituted when a string/array/object exceeds its size cap. */
export const AUDIT_TRUNCATED = "[truncated]";
/** Value substituted for values that are not JSON-safe or nest too deep. */
export const AUDIT_DROPPED = "[dropped]";

/**
 * Key deny list policy: normalized key substrings that must never survive
 * into audit metadata. Normalization is `lowercase + drop non-alphanumerics`,
 * so `user_prompt`, `systemPrompt`, `api_key`, `sessionToken` and
 * `Authorization` all match. Errs toward over-redaction: audit metadata is
 * context, never content (§15.3, §22).
 */
export interface RedactionPolicy {
  /** Max object depth; deeper values become `[dropped]`. */
  readonly maxDepth: number;
  /** Max keys per object / items per array; extras collapse to a marker. */
  readonly maxKeys: number;
  /** Max string length before truncation. */
  readonly maxStringLength: number;
  /** Normalized key substrings whose values are always replaced. */
  readonly denyKeySubstrings: readonly string[];
}

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  maxDepth: 4,
  maxKeys: 64,
  maxStringLength: 512,
  denyKeySubstrings: [
    "prompt",
    "message",
    "content",
    "body",
    "payload",
    "text",
    "blob",
    "image",
    "png",
    "jpg",
    "jpeg",
    "base64",
    "password",
    "secret",
    "token",
    "apikey",
    "authorization",
    "cookie",
    "credential"
  ]
};

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deniedKey(key: string, policy: RedactionPolicy): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return policy.denyKeySubstrings.some((needle) => normalized.includes(needle));
}

function walk(value: unknown, policy: RedactionPolicy, depth: number): unknown {
  if (depth > policy.maxDepth) {
    return AUDIT_DROPPED;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(CONTROL_CHARS, "");
    return cleaned.length > policy.maxStringLength
      ? cleaned.slice(0, policy.maxStringLength) + AUDIT_TRUNCATED
      : cleaned;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : AUDIT_DROPPED;
  }
  if (typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, policy.maxKeys).map((item) => walk(item, policy, depth + 1));
    if (value.length > policy.maxKeys) {
      items.push(AUDIT_TRUNCATED);
    }
    return items;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [rawKey, rawValue] of Object.entries(value)) {
      if (count >= policy.maxKeys) {
        out["[truncated]"] = true;
        break;
      }
      const key = rawKey.slice(0, 128);
      out[key] = deniedKey(rawKey, policy) ? AUDIT_REDACTED : walk(rawValue, policy, depth + 1);
      count += 1;
    }
    return out;
  }
  // undefined, bigint, symbol, function, Date, Map… — not JSON-safe audit context.
  return AUDIT_DROPPED;
}

/**
 * Redact audit metadata BEFORE it is stored (§15.3). Fail-closed: a
 * non-plain-object (raw string, array, number…) is dropped entirely — a bare
 * string could be a prompt. Output is JSON-round-tripped so the jsonb column
 * only ever receives safe JSON.
 */
export function redactMetadata(
  metadata: unknown,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): Record<string, unknown> {
  if (!isPlainObject(metadata)) {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(walk(metadata, policy, 0))) as Record<string, unknown>;
  } catch {
    // Should be unreachable post-walk; keep the append safe (§15.3) anyway.
    return {};
  }
}

// ---------------------------------------------------------------------------
// Cursor codec (opaque, server-produced; keyset anchor on (createdAt, id))
// ---------------------------------------------------------------------------

/** Keyset anchor: newest-first pages resume strictly BEFORE this row. */
export interface AuditCursorAnchor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeCursor(anchor: AuditCursorAnchor): string {
  const payload = JSON.stringify({ v: 1, at: anchor.createdAt.toISOString(), id: anchor.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): AuditCursorAnchor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || typeof record.at !== "string" || typeof record.id !== "string") {
      return null;
    }
    const createdAt = new Date(record.at);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }
    if (record.id.length === 0 || record.id.length > REF_MAX_LENGTH) {
      return null;
    }
    return { createdAt, id: record.id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Store seam (narrow + fakeable; W4-H `EventStoreLike` precedent)
// ---------------------------------------------------------------------------

/** One stored `audit_log` row as `page()` returns it. */
export interface AuditRow {
  readonly id: string;
  readonly organizationId: string | null;
  readonly actorId: string | null;
  readonly action: string;
  readonly target: string;
  readonly metadata: unknown;
  readonly createdAt: Date;
}

/** Filters for one org-scoped page. `before` is the exclusive keyset anchor. */
export interface AuditPageOptions {
  /** Inclusive lower bound on created_at. */
  readonly from?: Date;
  /** Inclusive upper bound on created_at. */
  readonly to?: Date;
  /** Return only rows strictly older (later in DESC order) than this anchor. */
  readonly before?: AuditCursorAnchor;
  /** Max rows returned (the service asks for limit+1 to detect a next page). */
  readonly limit: number;
}

/**
 * Narrow, in-memory-fakeable face of the audit store. `insert` is append-only
 * (§22); `page` serves the export query: org-scoped, window-filtered,
 * newest-first `(created_at DESC, id DESC)`, keyset-cursored.
 */
export interface AuditStoreLike {
  insert(row: NewAuditLog): Promise<void>;
  page(organizationId: string, options: AuditPageOptions): Promise<readonly AuditRow[]>;
}

/**
 * Drizzle-backed `AuditStoreLike` over `audit_log` (§12.1 shape, W1-F schema).
 * A real `Db` (packages/db createDb) satisfies `DbLike` structurally — the
 * bootstrap passes it straight in, same as the W4-H event store.
 */
export class DrizzleAuditStore implements AuditStoreLike {
  readonly #db: DbLike;

  constructor(db: DbLike) {
    this.#db = db;
  }

  async insert(row: NewAuditLog): Promise<void> {
    // §22 append-only: no conflict target, no update, ever.
    await this.#db.insert(auditLog).values(row);
  }

  async page(organizationId: string, options: AuditPageOptions): Promise<readonly AuditRow[]> {
    const conditions: SQL[] = [eq(auditLog.organizationId, organizationId)];
    if (options.from !== undefined) {
      conditions.push(gte(auditLog.createdAt, options.from));
    }
    if (options.to !== undefined) {
      conditions.push(lte(auditLog.createdAt, options.to));
    }
    if (options.before !== undefined) {
      // Keyset continuation (DESC): strictly "smaller" than the anchor —
      // (created_at, id) < (anchor.createdAt, anchor.id) lexicographically.
      const beforeCond = or(
        lt(auditLog.createdAt, options.before.createdAt),
        and(eq(auditLog.createdAt, options.before.createdAt), lt(auditLog.id, options.before.id))
      );
      if (beforeCond !== undefined) {
        conditions.push(beforeCond);
      }
    }
    return this.#db
      .select({
        id: auditLog.id,
        organizationId: auditLog.organizationId,
        actorId: auditLog.actorId,
        action: auditLog.action,
        target: auditLog.target,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt
      })
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(options.limit);
  }
}

// ---------------------------------------------------------------------------
// Result envelopes (§13.3-style typed results; no thrown strings)
// ---------------------------------------------------------------------------

export type AuditAppendErrorCode =
  | "invalid_action"
  | "invalid_target"
  | "invalid_org"
  | "invalid_actor"
  | "rate_limited"
  | "storage_unavailable";

export type AuditAppendResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: AuditAppendErrorCode;
      readonly message: string;
      readonly hint: string;
      readonly retryable: boolean;
    };

export type AuditExportErrorCode =
  | "invalid_org"
  | "invalid_window"
  | "invalid_cursor"
  | "storage_unavailable";

/** One exported §22 row (snake_case wire fields, §13 conventions). */
export interface AuditExportRow {
  readonly id: string;
  readonly organization_id: string | null;
  readonly actor_id: string | null;
  readonly action: string;
  readonly target: string;
  /** Already redacted at append time (§15.3) — exported verbatim. */
  readonly metadata: unknown;
  readonly created_at: string;
}

export type AuditExportResult =
  | { readonly ok: true; readonly rows: readonly AuditExportRow[]; readonly nextCursor?: string }
  | {
      readonly ok: false;
      readonly code: AuditExportErrorCode;
      readonly message: string;
      readonly hint: string;
      readonly retryable: boolean;
    };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Caller-supplied context for one audit event. All fields optional. */
export interface AuditAppendInput {
  /** §12.2 tenant root; null/undefined = platform-level event (§22). */
  readonly organizationId?: string | null;
  /** Acting user; null for system/webhook actors. */
  readonly actorId?: string | null;
  /** "<type>:<id>" of the affected record; default `platform:none`. */
  readonly target?: string;
  /** Redacted by policy before the insert (§15.3). */
  readonly metadata?: unknown;
}

/** §22 export query. `from`/`to` are inclusive bounds on created_at. */
export interface AuditExportQuery {
  readonly from?: Date;
  readonly to?: Date;
  /** Opaque cursor from a previous page's `nextCursor`. */
  readonly cursor?: string;
  /** Page size; default 100, clamped to 1..500. */
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// AuditService
// ---------------------------------------------------------------------------

export interface AuditServiceDeps {
  readonly store: AuditStoreLike;
  /** Injectable clock for deterministic tests. Default `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Per (organization, action) append storm guard. Default 60 events / 10 s.
   * The limiter state is process-local: it bounds a runaway loop, it is not
   * a cross-instance quota.
   */
  readonly appendRate?: RateLimitPolicy;
}

function isRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= REF_MAX_LENGTH;
}

function isDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validTarget(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= TARGET_MAX_LENGTH &&
    value.includes(":") &&
    TARGET_PATTERN.test(value)
  );
}

/**
 * §22 audit trail over an injected store. Construct once at bootstrap:
 * `new AuditService({ store: new DrizzleAuditStore(db) })`.
 */
export class AuditService {
  readonly #store: AuditStoreLike;
  readonly #now: () => Date;
  readonly #appendPolicy: RateLimitPolicy;
  readonly #limiter: RateLimiter;

  constructor(deps: AuditServiceDeps) {
    this.#store = deps.store;
    this.#now = deps.now ?? (() => new Date());
    const rate = deps.appendRate ?? DEFAULT_APPEND_RATE;
    if (
      !Number.isInteger(rate.limit) ||
      rate.limit < 1 ||
      !Number.isFinite(rate.windowSec) ||
      rate.windowSec <= 0
    ) {
      // Fail fast at boot (§4): a bad policy is a wiring bug, not a runtime one.
      throw new Error(
        "[AuditService] appendRate must be { limit: integer >= 1, windowSec: number > 0 }"
      );
    }
    this.#appendPolicy = rate;
    const epochNow = (): number => this.#now().getTime();
    // casAttempts 0: a single-process storm guard does not need CAS retries;
    // last-write-wins keeps the hot append path short.
    this.#limiter = new RateLimiter({
      kv: new InMemoryKV(epochNow),
      now: epochNow,
      casAttempts: 0
    });
  }

  /**
   * Append one §22 event. Plain insert — NO idempotency (every event is a
   * fact). Returns a typed envelope; never throws. Rate-limited internally
   * per (organization, action) so log storms cannot flood the table: a denial
   * means the event was NOT stored — callers alert on `code: "rate_limited"`
   * (the storm itself is the incident).
   */
  async append(action: string, entry: AuditAppendInput = {}): Promise<AuditAppendResult> {
    if (
      typeof action !== "string" ||
      action.length === 0 ||
      action.length > ACTION_MAX_LENGTH ||
      !ACTION_PATTERN.test(action)
    ) {
      return {
        ok: false,
        code: "invalid_action",
        message: "Audit action must be lowercase dotted segments (e.g. 'auth.login').",
        hint: "Use the §22 action taxonomy documented in services/audit.ts.",
        retryable: false
      };
    }

    const organizationId = entry.organizationId ?? null;
    if (organizationId !== null && !isRef(organizationId)) {
      return {
        ok: false,
        code: "invalid_org",
        message: "organizationId must be a non-empty id (<= 64 chars) or null.",
        hint: "Pass null for platform-level events.",
        retryable: false
      };
    }
    const actorId = entry.actorId ?? null;
    if (actorId !== null && !isRef(actorId)) {
      return {
        ok: false,
        code: "invalid_actor",
        message: "actorId must be a non-empty id (<= 64 chars) or null.",
        hint: "Pass null for system/webhook-actor events.",
        retryable: false
      };
    }

    const target = entry.target ?? PLATFORM_TARGET;
    if (!validTarget(target)) {
      return {
        ok: false,
        code: "invalid_target",
        message: "Audit target must be '<type>:<id>' (printable, no whitespace, <= 256 chars).",
        hint: "Example: 'document:<uuid>'. Omit for platform-level events.",
        retryable: false
      };
    }

    // §15.3: redact BEFORE the durable write — raw prompts never land.
    const metadata = redactMetadata(entry.metadata);

    // Internal storm guard (per organization+action bucket).
    const subject = organizationId ?? "platform";
    const decision = await this.#limiter.tokenBucket(
      "audit.append",
      `${subject}|${action}`,
      this.#appendPolicy
    );
    if (!decision.allowed) {
      return {
        ok: false,
        code: "rate_limited",
        message: `Audit append dropped: over ${this.#appendPolicy.limit} '${action}' events per ${this.#appendPolicy.windowSec}s for this subject.`,
        hint: "Log-storm guard (§22). The event was NOT stored — investigate the source loop.",
        retryable: true
      };
    }

    const row: NewAuditLog = {
      organizationId,
      actorId,
      action,
      target,
      metadata,
      createdAt: this.#now()
    };
    try {
      await this.#store.insert(row);
    } catch {
      return {
        ok: false,
        code: "storage_unavailable",
        message: "Audit log append failed.",
        hint: "Primary action continued; log/alert this envelope (missing trail = compliance gap).",
        retryable: true
      };
    }
    return { ok: true };
  }

  /**
   * §22 export for ONE organization, cursor-paged newest-first. This is the
   * helper the billing/credits routes (W5+) call after enforcing admin+ RBAC
   * at the route layer — the service performs NO permission check on purpose
   * (route-level enforcement, same rule as every other workspace query).
   *
   * Cursors are opaque, server-produced keyset anchors on (created_at, id);
   * pass the previous page's `nextCursor` verbatim. `from`/`to` are inclusive.
   */
  async export(organizationId: string, query: AuditExportQuery = {}): Promise<AuditExportResult> {
    const org = organizationId.trim();
    if (!isRef(org)) {
      return {
        ok: false,
        code: "invalid_org",
        message: "organizationId must be a non-empty id (<= 64 chars).",
        hint: "The §22 export is always per workspace.",
        retryable: false
      };
    }

    const from = query.from;
    const to = query.to;
    if ((from !== undefined && !isDate(from)) || (to !== undefined && !isDate(to))) {
      return {
        ok: false,
        code: "invalid_window",
        message: "from/to must be valid dates.",
        hint: "Use ISO 8601 strings parsed at the route layer.",
        retryable: false
      };
    }
    if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
      return {
        ok: false,
        code: "invalid_window",
        message: "from must not be after to (both bounds are inclusive).",
        hint: "Swap the bounds or drop one.",
        retryable: false
      };
    }

    let before: AuditCursorAnchor | undefined;
    if (query.cursor !== undefined) {
      const anchor = decodeCursor(query.cursor);
      if (anchor === null) {
        return {
          ok: false,
          code: "invalid_cursor",
          message: "Cursor is malformed or not issued by this service.",
          hint: "Pass the nextCursor value from the previous page unmodified.",
          retryable: false
        };
      }
      before = anchor;
    }

    const requested = query.limit;
    const limit =
      requested !== undefined && Number.isFinite(requested)
        ? Math.min(MAX_EXPORT_PAGE_SIZE, Math.max(1, Math.floor(requested)))
        : DEFAULT_EXPORT_PAGE_SIZE;

    let rows: readonly AuditRow[];
    try {
      // limit+1: one lookahead row decides whether a nextCursor exists.
      rows = await this.#store.page(org, {
        from,
        to,
        before,
        limit: limit + 1
      });
    } catch {
      return {
        ok: false,
        code: "storage_unavailable",
        message: "Audit export query failed.",
        hint: "Retry later; the table itself is untouched (append-only).",
        retryable: true
      };
    }

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const mapped: AuditExportRow[] = pageRows.map((row) => ({
      id: row.id,
      organization_id: row.organizationId,
      actor_id: row.actorId,
      action: row.action,
      target: row.target,
      metadata: row.metadata,
      created_at: row.createdAt.toISOString()
    }));

    if (hasMore) {
      const last = pageRows.at(-1);
      if (last !== undefined) {
        return { ok: true, rows: mapped, nextCursor: encodeCursor(last) };
      }
    }
    return { ok: true, rows: mapped };
  }
}
