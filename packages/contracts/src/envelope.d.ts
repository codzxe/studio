import { z } from "zod";
/**
 * Stable wire error codes referenced by the architecture (§8.9). Add-only:
 * never rename or reuse an existing code. Services may define additional
 * domain codes — the envelope schema accepts any non-empty string.
 */
export declare const WIRE_ERROR_CODES: readonly ["RUN_MODEL_UNAVAILABLE", "RUN_INVALID_TOOL", "RUN_INVALID_COMMAND", "RUN_BATCH_ROLLED_BACK", "EDITOR_DISCONNECTED", "RENDER_TIMEOUT", "PROJECT_VERSION_CONFLICT", "INSUFFICIENT_CREDITS", "VALIDATION_FAILED", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"];
export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];
export declare const WIRE_ERROR_CODE_SCHEMA: z.ZodEnum<{
    PROJECT_VERSION_CONFLICT: "PROJECT_VERSION_CONFLICT";
    INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS";
    RUN_MODEL_UNAVAILABLE: "RUN_MODEL_UNAVAILABLE";
    RUN_INVALID_TOOL: "RUN_INVALID_TOOL";
    RUN_INVALID_COMMAND: "RUN_INVALID_COMMAND";
    RUN_BATCH_ROLLED_BACK: "RUN_BATCH_ROLLED_BACK";
    EDITOR_DISCONNECTED: "EDITOR_DISCONNECTED";
    RENDER_TIMEOUT: "RENDER_TIMEOUT";
    RATE_LIMITED: "RATE_LIMITED";
    FORBIDDEN: "FORBIDDEN";
    VALIDATION_FAILED: "VALIDATION_FAILED";
    NOT_FOUND: "NOT_FOUND";
    UNAUTHORIZED: "UNAUTHORIZED";
    INTERNAL_ERROR: "INTERNAL_ERROR";
}>;
export declare const ERROR_CODE_SCHEMA: z.ZodString;
export declare const REQUEST_ID_SCHEMA: z.ZodString;
export declare const META_SCHEMA: z.ZodRecord<z.ZodString, z.ZodUnknown>;
/** Failure body (§7.3 exact: code, message, hint?, retryable, requestId). */
export declare const ERROR_BODY_SCHEMA: z.ZodObject<{
    code: z.ZodString;
    message: z.ZodString;
    hint: z.ZodOptional<z.ZodString>;
    retryable: z.ZodBoolean;
    requestId: z.ZodString;
}, z.core.$strip>;
/** Failure envelope: `{ error: … }` only. */
export declare const ERR_SCHEMA: z.ZodObject<{
    error: z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
        hint: z.ZodOptional<z.ZodString>;
        retryable: z.ZodBoolean;
        requestId: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export type Err = z.infer<typeof ERR_SCHEMA>;
/** Success envelope: `{ data: T, meta? }` only (§7.3). */
export interface Ok<T> {
    data: T;
    meta?: Record<string, unknown>;
}
export type Envelope<T> = Ok<T> | Err;
/**
 * Builds a success-envelope schema for a given data schema.
 * `{ data: DATA, meta?: Record<string, unknown> }`.
 */
export declare function okSchema<T>(dataSchema: z.ZodType<T>): z.ZodObject<{
    data: z.ZodType<T, unknown, z.core.$ZodTypeInternals<T, unknown>>;
    meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
/** Wrap a value in a success envelope (§7.3). */
export declare function ok<T>(data: T, meta?: Record<string, unknown>): Ok<T>;
export interface ErrOptions {
    /** Correlation id — always present on the wire (§7.3). */
    readonly requestId: string;
    /** Actionable next step, safe to show (§7.3). */
    readonly hint?: string;
    /** Safe default is `false`: never tell a client to retry what we cannot redo. */
    readonly retryable?: boolean;
}
/** Build a failure envelope (§7.3). */
export declare function err(code: string, message: string, options: ErrOptions): Err;
/**
 * Structural guard: exactly one of `data` / `error` must be present, and a
 * present `error` must carry the full §7.3 failure body.
 */
export declare function isEnvelope(value: unknown): value is Ok<unknown> | Err;
/** Guard for the success arm of the envelope. */
export declare function isOk(value: unknown): value is Ok<unknown>;
/** Guard for the failure arm of the envelope (fully validated). */
export declare function isErr(value: unknown): value is Err;
