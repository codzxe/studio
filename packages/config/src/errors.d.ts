import { z } from "zod";
/** Catalog entry defaults: shown to users as-is, safe for any tenant. */
export interface StudioErrorCatalogEntry {
    /** Human message, safe to show. */
    readonly message: string;
    /** Actionable next step (always present in the catalog; overridable per throw). */
    readonly hint: string;
    /** Safe to retry the same request (after a pause) without human intervention? */
    readonly retryable: boolean;
}
/**
 * Stable error-code catalog (§7.3 codes, §8.9 failure semantics).
 * Add-only: never rename or reuse an existing key.
 */
export declare const ERROR_CATALOG: {
    /** Version conflict on save/upload — never overwrite; offer compare/restore (§9.3). */
    readonly PROJECT_VERSION_CONFLICT: {
        readonly message: "This project changed while you were working.";
        readonly hint: "Open the latest version, or restore yours from version history. Nothing was overwritten.";
        readonly retryable: false;
    };
    /** Zero/negative balance — run never starts (§8.8); upgrade CTA. */
    readonly INSUFFICIENT_CREDITS: {
        readonly message: "This workspace is out of credits.";
        readonly hint: "Top up credits or upgrade your plan to continue.";
        readonly retryable: false;
    };
    /** Single-writer lease owned by another editor (§11). */
    readonly LEASE_HELD: {
        readonly message: "Someone else is editing this project right now.";
        readonly hint: "You can open it read-only, or take over once the lease is released.";
        readonly retryable: true;
    };
    /** Own lease expired mid-session — re-acquire to continue (§11). */
    readonly LEASE_EXPIRED: {
        readonly message: "Your editing lease on this project expired.";
        readonly hint: "Reacquire the lease to continue editing.";
        readonly retryable: true;
    };
    /** Model provider down and no fallback available (§8.9); no charge. */
    readonly RUN_MODEL_UNAVAILABLE: {
        readonly message: "The model service is unavailable right now.";
        readonly hint: "Try again in a moment. You were not charged for this run.";
        readonly retryable: true;
    };
    /** Tool args failed validation twice (repair turn exhausted, §8.9). */
    readonly RUN_INVALID_TOOL: {
        readonly message: "The agent requested a tool call we can't validate.";
        readonly hint: "Nothing was applied. Rephrase the request and try again.";
        readonly retryable: false;
    };
    /** Batch validation failed before execution; no editor change (§8.9). */
    readonly RUN_INVALID_COMMAND: {
        readonly message: "The planned edit didn't pass validation.";
        readonly hint: "Nothing was applied. Ask for a smaller, more specific edit.";
        readonly retryable: false;
    };
    /** Step failed mid-batch → atomic rollback, no commit (§8.9). */
    readonly RUN_BATCH_ROLLED_BACK: {
        readonly message: "Part of the edit failed, so the whole edit was rolled back.";
        readonly hint: "Nothing was applied. Ask the agent to split the edit into smaller steps.";
        readonly retryable: false;
    };
    /** User cancelled the run; reserve released (§8.9). */
    readonly RUN_CANCELLED: {
        readonly message: "The run was cancelled.";
        readonly hint: "Nothing was applied. Reserved credits were refunded.";
        readonly retryable: false;
    };
    /** Editor iframe/connection dropped; retried once (§8.9). */
    readonly EDITOR_DISCONNECTED: {
        readonly message: "The editor connection dropped.";
        readonly hint: "Reconnect the editor, then retry the step.";
        readonly retryable: true;
    };
    /** Render exceeded its timeout; preview remains optional (§8.9). */
    readonly RENDER_TIMEOUT: {
        readonly message: "Rendering took too long and was stopped.";
        readonly hint: "Retry, or render a shorter range at a lower resolution.";
        readonly retryable: true;
    };
    /** Render pipeline failed. */
    readonly RENDER_FAILED: {
        readonly message: "Rendering failed.";
        readonly hint: "Check the composition for unsupported features, then retry.";
        readonly retryable: true;
    };
    /**
     * 415 — declared-but-disabled render format refused at queue time (D-2
     * gate; client-shaped like ASSET_REJECTED). ProRes/GIF/WAV stay reserved.
     */
    readonly RENDER_UNSUPPORTED_FORMAT: {
        readonly message: "This render format isn't available yet.";
        readonly hint: "Choose MP4 or PNG sequence for now.";
        readonly retryable: false;
    };
    /** 429 — workspace out of render minutes this cycle (mirrors QUOTA_EXCEEDED). */
    readonly RENDER_QUOTA_EXCEEDED: {
        readonly message: "This workspace used all its render minutes.";
        readonly hint: "The quota resets with your billing cycle, or you can upgrade now.";
        readonly retryable: false;
    };
    /** 500 — worker cannot find the effectcraft-cli binary (operator action needed). */
    readonly RENDER_CLI_MISSING: {
        readonly message: "The rendering tool isn't available right now.";
        readonly hint: "We're on it. You were not charged for this render.";
        readonly retryable: false;
    };
    /** 500 — effectcraft-cli ran but exited non-zero; safe to retry (mirrors RENDER_FAILED). */
    readonly RENDER_CLI_FAILED: {
        readonly message: "The render worker couldn't finish this job.";
        readonly hint: "Retry the render, or contact support if it keeps failing. You were not charged.";
        readonly retryable: true;
    };
    /** 409 — user cancelled the render; the credit reserve is released (mirrors RUN_CANCELLED). */
    readonly RENDER_CANCELLED: {
        readonly message: "The render was cancelled.";
        readonly hint: "Nothing was rendered. Reserved credits were refunded.";
        readonly retryable: false;
    };
    /** 400 — project snapshot failed render validation; client-shaped (mirrors RUN_INVALID_COMMAND). */
    readonly RENDER_PROJECT_INVALID: {
        readonly message: "This project can't be rendered as-is.";
        readonly hint: "The composition didn't pass render validation. Fix the reported problem and try again.";
        readonly retryable: false;
    };
    /** 400 — the render input references an asset that is no longer available. */
    readonly RENDER_ASSET_MISSING: {
        readonly message: "A media asset this render needs is missing.";
        readonly hint: "Re-upload or relink the missing asset, then render again.";
        readonly retryable: false;
    };
    /** 429 — workspace already runs its maxConcurrentRenders (mirrors RATE_LIMITED). */
    readonly RENDER_CONCURRENCY_LIMIT: {
        readonly message: "Too many renders are already running.";
        readonly hint: "Wait for one to finish, then try again.";
        readonly retryable: true;
    };
    /** 500 — unexpected render-pipeline failure; details never leak (mirrors INTERNAL). */
    readonly RENDER_INTERNAL: {
        readonly message: "Something went wrong during rendering.";
        readonly hint: "We're on it. Try again in a moment.";
        readonly retryable: true;
    };
    /** Upload above the plan/size cap (ASSET_MAX_BYTES). */
    readonly ASSET_TOO_LARGE: {
        readonly message: "This file is larger than your plan allows.";
        readonly hint: "Compress the file, or upgrade for bigger uploads.";
        readonly retryable: false;
    };
    /** MIME/extension rejected by the upload allowlist (§12.3). */
    readonly ASSET_REJECTED: {
        readonly message: "This file type isn't supported.";
        readonly hint: "Use a supported media format: video, image, audio, font, LUT, SVG or PDF.";
        readonly retryable: false;
    };
    /** Workspace hit a plan quota (storage, runs/day, seats…). */
    readonly QUOTA_EXCEEDED: {
        readonly message: "This workspace hit a usage quota.";
        readonly hint: "The quota resets with your billing cycle, or you can upgrade now.";
        readonly retryable: false;
    };
    /** Unknown workspace — never confirms existence to strangers (§12.1). */
    readonly WORKSPACE_NOT_FOUND: {
        readonly message: "Workspace not found.";
        readonly hint: "Check the link, or ask the workspace owner to invite you.";
        readonly retryable: false;
    };
    readonly PROJECT_NOT_FOUND: {
        readonly message: "Project not found.";
        readonly hint: "It may have been deleted, or you may not have access.";
        readonly retryable: false;
    };
    readonly VERSION_NOT_FOUND: {
        readonly message: "Version not found.";
        readonly hint: "Refresh the version list and try again.";
        readonly retryable: false;
    };
    readonly THREAD_NOT_FOUND: {
        readonly message: "Thread not found.";
        readonly hint: "Start a new thread in this project.";
        readonly retryable: false;
    };
    readonly RUN_NOT_FOUND: {
        readonly message: "Run not found.";
        readonly hint: "Refresh the page, or open the project's run history.";
        readonly retryable: false;
    };
    /** Per-IP/user/workspace rate limit (§7.1). */
    readonly RATE_LIMITED: {
        readonly message: "Too many requests.";
        readonly hint: "Slow down for a moment, then retry.";
        readonly retryable: true;
    };
    /** 401 — missing/invalid session or API key. */
    readonly AUTH_REQUIRED: {
        readonly message: "Sign in to continue.";
        readonly hint: "Your session may have expired.";
        readonly retryable: false;
    };
    /** 403 — authenticated but not allowed (RBAC role, read-only lease). */
    readonly FORBIDDEN: {
        readonly message: "You don't have permission to do that.";
        readonly hint: "Ask a workspace admin for access.";
        readonly retryable: false;
    };
    /** Payload failed schema validation at the boundary. */
    readonly VALIDATION_FAILED: {
        readonly message: "That request didn't look right.";
        readonly hint: "Check the input and try again.";
        readonly retryable: false;
    };
    /** Unexpected failure — details never leak to clients. */
    readonly INTERNAL: {
        readonly message: "Something went wrong on our side.";
        readonly hint: "We're on it. Try again in a moment.";
        readonly retryable: true;
    };
};
/** Stable error codes, in catalog order. */
export type StudioErrorCode = keyof typeof ERROR_CATALOG;
export declare const ERROR_CODES: readonly StudioErrorCode[];
/** Zod schema for error codes at API boundaries. */
export declare const ERROR_CODE_SCHEMA: z.ZodEnum<{
    PROJECT_VERSION_CONFLICT: "PROJECT_VERSION_CONFLICT";
    INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS";
    LEASE_HELD: "LEASE_HELD";
    LEASE_EXPIRED: "LEASE_EXPIRED";
    RUN_MODEL_UNAVAILABLE: "RUN_MODEL_UNAVAILABLE";
    RUN_INVALID_TOOL: "RUN_INVALID_TOOL";
    RUN_INVALID_COMMAND: "RUN_INVALID_COMMAND";
    RUN_BATCH_ROLLED_BACK: "RUN_BATCH_ROLLED_BACK";
    RUN_CANCELLED: "RUN_CANCELLED";
    EDITOR_DISCONNECTED: "EDITOR_DISCONNECTED";
    RENDER_TIMEOUT: "RENDER_TIMEOUT";
    RENDER_FAILED: "RENDER_FAILED";
    RENDER_UNSUPPORTED_FORMAT: "RENDER_UNSUPPORTED_FORMAT";
    RENDER_QUOTA_EXCEEDED: "RENDER_QUOTA_EXCEEDED";
    RENDER_CLI_MISSING: "RENDER_CLI_MISSING";
    RENDER_CLI_FAILED: "RENDER_CLI_FAILED";
    RENDER_CANCELLED: "RENDER_CANCELLED";
    RENDER_PROJECT_INVALID: "RENDER_PROJECT_INVALID";
    RENDER_ASSET_MISSING: "RENDER_ASSET_MISSING";
    RENDER_CONCURRENCY_LIMIT: "RENDER_CONCURRENCY_LIMIT";
    RENDER_INTERNAL: "RENDER_INTERNAL";
    ASSET_TOO_LARGE: "ASSET_TOO_LARGE";
    ASSET_REJECTED: "ASSET_REJECTED";
    QUOTA_EXCEEDED: "QUOTA_EXCEEDED";
    WORKSPACE_NOT_FOUND: "WORKSPACE_NOT_FOUND";
    PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND";
    VERSION_NOT_FOUND: "VERSION_NOT_FOUND";
    THREAD_NOT_FOUND: "THREAD_NOT_FOUND";
    RUN_NOT_FOUND: "RUN_NOT_FOUND";
    RATE_LIMITED: "RATE_LIMITED";
    AUTH_REQUIRED: "AUTH_REQUIRED";
    FORBIDDEN: "FORBIDDEN";
    VALIDATION_FAILED: "VALIDATION_FAILED";
    INTERNAL: "INTERNAL";
}>;
/** §7.3 Err envelope error body. `hint` is omitted when undefined. */
export interface ErrBody {
    /** Stable code, e.g. `PROJECT_VERSION_CONFLICT`. */
    readonly code: StudioErrorCode;
    /** Human message, safe to show. */
    readonly message: string;
    /** Actionable next step. */
    readonly hint?: string;
    /** Safe to retry the same request? */
    readonly retryable: boolean;
    /** Correlates with server logs for support. */
    readonly requestId: string;
}
/** §7.3 Err envelope. */
export interface ErrEnvelope {
    readonly error: ErrBody;
}
/** §7.3 Ok envelope. */
export interface OkEnvelope<T> {
    readonly data: T;
    readonly meta?: Record<string, unknown>;
}
/** §7.3 response envelope union. */
export type Envelope<T> = OkEnvelope<T> | ErrEnvelope;
/** Builds an Ok envelope: `okEnvelope(value, meta?)`. */
export declare function okEnvelope<T>(data: T, meta?: Record<string, unknown>): OkEnvelope<T>;
/** Constructor overrides; every field optional, catalog defaults apply. */
export interface StudioErrorOptions {
    readonly message?: string;
    readonly hint?: string;
    readonly retryable?: boolean;
    readonly requestId?: string;
    /** Original failure — kept for server-side logs only, never serialized. */
    readonly cause?: unknown;
}
/**
 * Typed application error carrying the §7.3 envelope. Message/hint/retryable
 * default from the catalog and may be overridden per throw; `requestId`
 * defaults to a fresh `req_…` id. `toEnvelope()` is the wire shape — `toJSON()`
 * aliases it so accidental `JSON.stringify(error)` still cannot leak internals
 * (stack, cause, upstream URLs, absolute paths).
 */
export declare class StudioError extends Error {
    readonly code: StudioErrorCode;
    readonly hint: string | undefined;
    readonly retryable: boolean;
    readonly requestId: string;
    constructor(code: StudioErrorCode, options?: StudioErrorOptions);
    /** §7.3 Err envelope for this error. */
    toEnvelope(): ErrEnvelope;
    /** JSON.stringify hook — same wire shape as {@link toEnvelope}. */
    toJSON(): ErrEnvelope;
}
/** Type guard for StudioError at boundaries/handlers. */
export declare function isStudioError(value: unknown): value is StudioError;
/**
 * Maps an unknown thrown value to a safe StudioError.
 *
 * - `StudioError` passes through unchanged.
 * - `ZodError` → `VALIDATION_FAILED` (generic message; the invalid input is
 *   never echoed into the envelope).
 * - Anything else → `INTERNAL` with the catalog message. The original failure
 *   is preserved on `cause` for server-side logging only — stack traces,
 *   absolute paths and upstream URLs never reach the client.
 */
export declare function fromUnknown(err: unknown, requestId?: string): StudioError;
/** Type guard for the Err envelope half. */
export declare function isErrEnvelope<T>(value: Envelope<T>): value is ErrEnvelope;
