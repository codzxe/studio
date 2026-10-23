/**
 * Normalized bridge errors (task W1-d).
 *
 * Every failure surfaced by this package is a `BridgeError` with a stable code, so
 * product code can branch on `err.code` instead of parsing editor error strings.
 */
const CODES = [
    "EDITOR_TIMEOUT",
    "EDITOR_CALL_FAILED",
    "EDITOR_NOT_READY",
    "EDITOR_LOAD_FAILED",
    "EDITOR_DISCONNECTED",
];
export class BridgeError extends Error {
    code;
    retryable;
    constructor(code, message, retryable = false, cause) {
        super(message, { cause });
        this.name = "BridgeError";
        this.code = code;
        this.retryable = retryable;
    }
}
export function isBridgeError(value) {
    return value instanceof BridgeError;
}
export function isBridgeErrorCode(value) {
    return typeof value === "string" && CODES.includes(value);
}
/** Extract a message from upstream rejections, which are plain strings (api.rs rejects with a `JsValue::from_str`). */
export function messageOf(value) {
    if (typeof value === "string")
        return value;
    if (value instanceof Error)
        return value.message;
    if (typeof value === "object" && value !== null && "message" in value) {
        const m = value.message;
        if (typeof m === "string")
            return m;
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
//# sourceMappingURL=errors.js.map