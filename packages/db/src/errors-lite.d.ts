/**
 * Error catalog + typed error for the repository layer.
 *
 * NOTE (W1-e): the old `@studio/config` errors module belongs to the superseded
 * product (lowercase codes, different envelope). The new product's codes are the
 * UPPER_SNAKE strings of PRODUCT_ARCHITECTURE §8.9 + §7.3. This module is the
 * db-package-local ("lite") copy — to be unified into the new @studio/config
 * errors module when it lands; codes are add-only and must stay wire-stable.
 */
export declare const ERROR_CODES: readonly ["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED", "VALIDATION_FAILED", "CONFLICT", "RATE_LIMITED", "PROJECT_VERSION_CONFLICT", "INSUFFICIENT_CREDITS", "QUOTA_EXCEEDED", "RUN_MODEL_UNAVAILABLE", "RUN_INVALID_TOOL", "RUN_INVALID_COMMAND", "RUN_BATCH_ROLLED_BACK", "EDITOR_DISCONNECTED", "RENDER_TIMEOUT"];
export type ErrorCode = (typeof ERROR_CODES)[number];
/** Repo-level typed error. Maps 1:1 onto the §7.3 response envelope. */
export declare class DbError extends Error {
    readonly code: ErrorCode;
    readonly status: number;
    readonly retryable: boolean;
    readonly hint?: string;
    readonly details?: Readonly<Record<string, unknown>>;
    constructor(code: ErrorCode, message: string, options?: {
        status?: number;
        retryable?: boolean;
        hint?: string;
        details?: Record<string, unknown>;
    });
    /** Cross-tenant or unknown id — never confirm existence (§12.1). */
    static notFound(what: string, details?: Record<string, unknown>): DbError;
    static validation(message: string, hint?: string): DbError;
    static conflict(message: string, hint?: string): DbError;
    static forbidden(message: string): DbError;
    /** §9.3: optimistic version mismatch — show compare/restore, never overwrite. */
    static versionConflict(details: {
        expectedVersionId: string | null;
        currentVersionId: string | null;
    }): DbError;
    /** §8.8: fail before the model call, with an upgrade CTA upstream. */
    static insufficientCredits(details: {
        required: number;
        available: number;
    }): DbError;
    static quotaExceeded(message: string, details?: Record<string, unknown>): DbError;
}
export declare function isDbError(error: unknown): error is DbError;
/** Shape for the §7.3 error envelope (gateway fills requestId). */
export interface ErrorPayload {
    readonly code: ErrorCode | string;
    readonly message: string;
    readonly hint?: string;
    readonly retryable: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
}
export declare function toErrorPayload(error: unknown): ErrorPayload;
