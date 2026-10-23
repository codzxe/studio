// @studio/contracts — HTTP response envelope (PRODUCT_ARCHITECTURE.md §7.3).
//
// Every /v1 JSON response is wrapped: success → { data, meta? }, failure →
// { error: { code, message, hint?, retryable, requestId } }. Never leak stack
// traces, absolute paths, upstream URLs or raw provider errors (§7.3).
//
// Self-contained by design (task W1-b): do NOT import @studio/config — the
// wire envelope is defined here so every service can depend on it without a
// config coupling.
import { z } from "zod";
// ---------------------------------------------------------------------------
// Error codes (§8.9 failure semantics; stable UPPER_SNAKE_CASE strings)
// ---------------------------------------------------------------------------
/**
 * Stable wire error codes referenced by the architecture (§8.9). Add-only:
 * never rename or reuse an existing code. Services may define additional
 * domain codes — the envelope schema accepts any non-empty string.
 */
export const WIRE_ERROR_CODES = [
    "RUN_MODEL_UNAVAILABLE", // provider down and no fallback; no charge
    "RUN_INVALID_TOOL", // tool args invalid after the single repair turn
    "RUN_INVALID_COMMAND", // batch failed validation; no editor change
    "RUN_BATCH_ROLLED_BACK", // step failed mid-batch; atomic rollback; no commit
    "EDITOR_DISCONNECTED", // run paused, retry exhausted
    "RENDER_TIMEOUT", // preview remains optional
    "PROJECT_VERSION_CONFLICT", // base_version_id mismatch → 409, never overwrite
    "INSUFFICIENT_CREDITS", // fail before the model call; upgrade CTA
    "VALIDATION_FAILED", // request payload failed schema validation → 400
    "UNAUTHORIZED", // 401: missing/invalid session or API key
    "FORBIDDEN", // 403: authenticated but not allowed (RBAC/lease)
    "NOT_FOUND", // unknown id; never confirm existence to strangers
    "RATE_LIMITED", // 429: per-IP/user/workspace limits
    "INTERNAL_ERROR", // 500: unexpected; no details leaked
];
export const WIRE_ERROR_CODE_SCHEMA = z.enum(WIRE_ERROR_CODES);
// ---------------------------------------------------------------------------
// Envelope schemas (§7.3 exact)
// ---------------------------------------------------------------------------
export const ERROR_CODE_SCHEMA = z.string().min(1);
export const REQUEST_ID_SCHEMA = z.string().min(1);
export const META_SCHEMA = z.record(z.string(), z.unknown());
/** Failure body (§7.3 exact: code, message, hint?, retryable, requestId). */
export const ERROR_BODY_SCHEMA = z.object({
    code: ERROR_CODE_SCHEMA,
    message: z.string().min(1), // human, safe to show
    hint: z.string().optional(), // actionable next step
    retryable: z.boolean(),
    requestId: REQUEST_ID_SCHEMA,
});
/** Failure envelope: `{ error: … }` only. */
export const ERR_SCHEMA = z.object({ error: ERROR_BODY_SCHEMA });
/**
 * Builds a success-envelope schema for a given data schema.
 * `{ data: DATA, meta?: Record<string, unknown> }`.
 */
export function okSchema(dataSchema) {
    return z.object({
        data: dataSchema,
        meta: META_SCHEMA.optional(),
    });
}
// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------
/** Wrap a value in a success envelope (§7.3). */
export function ok(data, meta) {
    return meta === undefined ? { data } : { data, meta };
}
/** Build a failure envelope (§7.3). */
export function err(code, message, options) {
    return {
        error: {
            code,
            message,
            requestId: options.requestId,
            ...(options.hint !== undefined ? { hint: options.hint } : {}),
            retryable: options.retryable ?? false,
        },
    };
}
// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Structural guard: exactly one of `data` / `error` must be present, and a
 * present `error` must carry the full §7.3 failure body.
 */
export function isEnvelope(value) {
    if (!isRecord(value))
        return false;
    const hasData = "data" in value;
    const hasError = "error" in value;
    if (hasData === hasError)
        return false; // neither or both
    if (hasError)
        return ERROR_BODY_SCHEMA.safeParse(value.error).success;
    return true;
}
/** Guard for the success arm of the envelope. */
export function isOk(value) {
    return isRecord(value) && "data" in value && !("error" in value);
}
/** Guard for the failure arm of the envelope (fully validated). */
export function isErr(value) {
    return isRecord(value) && !("data" in value) && ERR_SCHEMA.safeParse(value).success;
}
//# sourceMappingURL=envelope.js.map