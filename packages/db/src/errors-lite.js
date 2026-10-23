/**
 * Error catalog + typed error for the repository layer.
 *
 * NOTE (W1-e): the old `@studio/config` errors module belongs to the superseded
 * product (lowercase codes, different envelope). The new product's codes are the
 * UPPER_SNAKE strings of PRODUCT_ARCHITECTURE §8.9 + §7.3. This module is the
 * db-package-local ("lite") copy — to be unified into the new @studio/config
 * errors module when it lands; codes are add-only and must stay wire-stable.
 */
export const ERROR_CODES = [
    // envelope / general (§7.3, §8.9)
    "NOT_FOUND",
    "FORBIDDEN",
    "UNAUTHORIZED",
    "VALIDATION_FAILED",
    "CONFLICT",
    "RATE_LIMITED",
    // product (§8.9)
    "PROJECT_VERSION_CONFLICT",
    "INSUFFICIENT_CREDITS",
    "QUOTA_EXCEEDED",
    "RUN_MODEL_UNAVAILABLE",
    "RUN_INVALID_TOOL",
    "RUN_INVALID_COMMAND",
    "RUN_BATCH_ROLLED_BACK",
    "EDITOR_DISCONNECTED",
    "RENDER_TIMEOUT",
];
const STATUS_BY_CODE = {
    NOT_FOUND: 404,
    FORBIDDEN: 403,
    UNAUTHORIZED: 401,
    VALIDATION_FAILED: 400,
    CONFLICT: 409,
    PROJECT_VERSION_CONFLICT: 409,
    RATE_LIMITED: 429,
    INSUFFICIENT_CREDITS: 402,
    QUOTA_EXCEEDED: 429,
    RUN_MODEL_UNAVAILABLE: 502,
    RUN_INVALID_TOOL: 400,
    RUN_INVALID_COMMAND: 400,
    RUN_BATCH_ROLLED_BACK: 500,
    EDITOR_DISCONNECTED: 503,
    RENDER_TIMEOUT: 504,
};
/** Repo-level typed error. Maps 1:1 onto the §7.3 response envelope. */
export class DbError extends Error {
    code;
    status;
    retryable;
    hint;
    details;
    constructor(code, message, options) {
        super(message);
        this.name = "DbError";
        this.code = code;
        this.status = options?.status ?? STATUS_BY_CODE[code];
        this.retryable = options?.retryable ?? false;
        this.hint = options?.hint;
        this.details = options?.details;
    }
    /** Cross-tenant or unknown id — never confirm existence (§12.1). */
    static notFound(what, details) {
        return new DbError("NOT_FOUND", `${what} not found`, { details });
    }
    static validation(message, hint) {
        return new DbError("VALIDATION_FAILED", message, { hint });
    }
    static conflict(message, hint) {
        return new DbError("CONFLICT", message, { hint });
    }
    static forbidden(message) {
        return new DbError("FORBIDDEN", message);
    }
    /** §9.3: optimistic version mismatch — show compare/restore, never overwrite. */
    static versionConflict(details) {
        return new DbError("PROJECT_VERSION_CONFLICT", "The project changed while you were editing", {
            hint: "Reload the latest version, or restore/compare to resolve the conflict.",
            details,
        });
    }
    /** §8.8: fail before the model call, with an upgrade CTA upstream. */
    static insufficientCredits(details) {
        return new DbError("INSUFFICIENT_CREDITS", "Not enough credits to start this run", {
            hint: "Top up credits or upgrade your plan.",
            details,
        });
    }
    static quotaExceeded(message, details) {
        return new DbError("QUOTA_EXCEEDED", message, { details });
    }
}
export function isDbError(error) {
    return error instanceof DbError;
}
export function toErrorPayload(error) {
    if (isDbError(error)) {
        return {
            code: error.code,
            message: error.message,
            hint: error.hint,
            retryable: error.retryable,
            details: error.details,
        };
    }
    return {
        code: "INTERNAL_ERROR",
        message: "Something went wrong",
        retryable: false,
    };
}
//# sourceMappingURL=errors-lite.js.map