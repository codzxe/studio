// @studio/config — error catalog and the Err half of the §7.3 response envelope.
//
// PRODUCT_ARCHITECTURE §7.3: Err = { error: { code, message, hint?, retryable,
// requestId } }. Codes are stable strings — add-only, never rename or reuse.
// §8.9 failure semantics drive the per-code defaults. Never leak stack traces,
// absolute paths, upstream URLs or raw provider errors: `fromUnknown` maps any
// unknown failure to INTERNAL and keeps the original only on `cause` (for
// server-side logs), never in the envelope.
import { z } from "zod";
import { newRequestId } from "./ids.js";
/**
 * Stable error-code catalog (§7.3 codes, §8.9 failure semantics).
 * Add-only: never rename or reuse an existing key.
 */
export const ERROR_CATALOG = {
    /** Version conflict on save/upload — never overwrite; offer compare/restore (§9.3). */
    PROJECT_VERSION_CONFLICT: {
        message: "This project changed while you were working.",
        hint: "Open the latest version, or restore yours from version history. Nothing was overwritten.",
        retryable: false,
    },
    /** Zero/negative balance — run never starts (§8.8); upgrade CTA. */
    INSUFFICIENT_CREDITS: {
        message: "This workspace is out of credits.",
        hint: "Top up credits or upgrade your plan to continue.",
        retryable: false,
    },
    /** Single-writer lease owned by another editor (§11). */
    LEASE_HELD: {
        message: "Someone else is editing this project right now.",
        hint: "You can open it read-only, or take over once the lease is released.",
        retryable: true,
    },
    /** Own lease expired mid-session — re-acquire to continue (§11). */
    LEASE_EXPIRED: {
        message: "Your editing lease on this project expired.",
        hint: "Reacquire the lease to continue editing.",
        retryable: true,
    },
    /** Model provider down and no fallback available (§8.9); no charge. */
    RUN_MODEL_UNAVAILABLE: {
        message: "The model service is unavailable right now.",
        hint: "Try again in a moment. You were not charged for this run.",
        retryable: true,
    },
    /** Tool args failed validation twice (repair turn exhausted, §8.9). */
    RUN_INVALID_TOOL: {
        message: "The agent requested a tool call we can't validate.",
        hint: "Nothing was applied. Rephrase the request and try again.",
        retryable: false,
    },
    /** Batch validation failed before execution; no editor change (§8.9). */
    RUN_INVALID_COMMAND: {
        message: "The planned edit didn't pass validation.",
        hint: "Nothing was applied. Ask for a smaller, more specific edit.",
        retryable: false,
    },
    /** Step failed mid-batch → atomic rollback, no commit (§8.9). */
    RUN_BATCH_ROLLED_BACK: {
        message: "Part of the edit failed, so the whole edit was rolled back.",
        hint: "Nothing was applied. Ask the agent to split the edit into smaller steps.",
        retryable: false,
    },
    /** User cancelled the run; reserve released (§8.9). */
    RUN_CANCELLED: {
        message: "The run was cancelled.",
        hint: "Nothing was applied. Reserved credits were refunded.",
        retryable: false,
    },
    /** Editor iframe/connection dropped; retried once (§8.9). */
    EDITOR_DISCONNECTED: {
        message: "The editor connection dropped.",
        hint: "Reconnect the editor, then retry the step.",
        retryable: true,
    },
    /** Render exceeded its timeout; preview remains optional (§8.9). */
    RENDER_TIMEOUT: {
        message: "Rendering took too long and was stopped.",
        hint: "Retry, or render a shorter range at a lower resolution.",
        retryable: true,
    },
    /** Render pipeline failed. */
    RENDER_FAILED: {
        message: "Rendering failed.",
        hint: "Check the composition for unsupported features, then retry.",
        retryable: true,
    },
    /**
     * 415 — declared-but-disabled render format refused at queue time (D-2
     * gate; client-shaped like ASSET_REJECTED). ProRes/GIF/WAV stay reserved.
     */
    RENDER_UNSUPPORTED_FORMAT: {
        message: "This render format isn't available yet.",
        hint: "Choose MP4 or PNG sequence for now.",
        retryable: false,
    },
    /** 429 — workspace out of render minutes this cycle (mirrors QUOTA_EXCEEDED). */
    RENDER_QUOTA_EXCEEDED: {
        message: "This workspace used all its render minutes.",
        hint: "The quota resets with your billing cycle, or you can upgrade now.",
        retryable: false,
    },
    /** 500 — worker cannot find the effectcraft-cli binary (operator action needed). */
    RENDER_CLI_MISSING: {
        message: "The rendering tool isn't available right now.",
        hint: "We're on it. You were not charged for this render.",
        retryable: false,
    },
    /** 500 — effectcraft-cli ran but exited non-zero; safe to retry (mirrors RENDER_FAILED). */
    RENDER_CLI_FAILED: {
        message: "The render worker couldn't finish this job.",
        hint: "Retry the render, or contact support if it keeps failing. You were not charged.",
        retryable: true,
    },
    /** 409 — user cancelled the render; the credit reserve is released (mirrors RUN_CANCELLED). */
    RENDER_CANCELLED: {
        message: "The render was cancelled.",
        hint: "Nothing was rendered. Reserved credits were refunded.",
        retryable: false,
    },
    /** 400 — project snapshot failed render validation; client-shaped (mirrors RUN_INVALID_COMMAND). */
    RENDER_PROJECT_INVALID: {
        message: "This project can't be rendered as-is.",
        hint: "The composition didn't pass render validation. Fix the reported problem and try again.",
        retryable: false,
    },
    /** 400 — the render input references an asset that is no longer available. */
    RENDER_ASSET_MISSING: {
        message: "A media asset this render needs is missing.",
        hint: "Re-upload or relink the missing asset, then render again.",
        retryable: false,
    },
    /** 429 — workspace already runs its maxConcurrentRenders (mirrors RATE_LIMITED). */
    RENDER_CONCURRENCY_LIMIT: {
        message: "Too many renders are already running.",
        hint: "Wait for one to finish, then try again.",
        retryable: true,
    },
    /** 500 — unexpected render-pipeline failure; details never leak (mirrors INTERNAL). */
    RENDER_INTERNAL: {
        message: "Something went wrong during rendering.",
        hint: "We're on it. Try again in a moment.",
        retryable: true,
    },
    /** Upload above the plan/size cap (ASSET_MAX_BYTES). */
    ASSET_TOO_LARGE: {
        message: "This file is larger than your plan allows.",
        hint: "Compress the file, or upgrade for bigger uploads.",
        retryable: false,
    },
    /** MIME/extension rejected by the upload allowlist (§12.3). */
    ASSET_REJECTED: {
        message: "This file type isn't supported.",
        hint: "Use a supported media format: video, image, audio, font, LUT, SVG or PDF.",
        retryable: false,
    },
    /** Workspace hit a plan quota (storage, runs/day, seats…). */
    QUOTA_EXCEEDED: {
        message: "This workspace hit a usage quota.",
        hint: "The quota resets with your billing cycle, or you can upgrade now.",
        retryable: false,
    },
    /** Unknown workspace — never confirms existence to strangers (§12.1). */
    WORKSPACE_NOT_FOUND: {
        message: "Workspace not found.",
        hint: "Check the link, or ask the workspace owner to invite you.",
        retryable: false,
    },
    PROJECT_NOT_FOUND: {
        message: "Project not found.",
        hint: "It may have been deleted, or you may not have access.",
        retryable: false,
    },
    VERSION_NOT_FOUND: {
        message: "Version not found.",
        hint: "Refresh the version list and try again.",
        retryable: false,
    },
    THREAD_NOT_FOUND: {
        message: "Thread not found.",
        hint: "Start a new thread in this project.",
        retryable: false,
    },
    RUN_NOT_FOUND: {
        message: "Run not found.",
        hint: "Refresh the page, or open the project's run history.",
        retryable: false,
    },
    /** Per-IP/user/workspace rate limit (§7.1). */
    RATE_LIMITED: {
        message: "Too many requests.",
        hint: "Slow down for a moment, then retry.",
        retryable: true,
    },
    /** 401 — missing/invalid session or API key. */
    AUTH_REQUIRED: {
        message: "Sign in to continue.",
        hint: "Your session may have expired.",
        retryable: false,
    },
    /** 403 — authenticated but not allowed (RBAC role, read-only lease). */
    FORBIDDEN: {
        message: "You don't have permission to do that.",
        hint: "Ask a workspace admin for access.",
        retryable: false,
    },
    /** Payload failed schema validation at the boundary. */
    VALIDATION_FAILED: {
        message: "That request didn't look right.",
        hint: "Check the input and try again.",
        retryable: false,
    },
    /** Unexpected failure — details never leak to clients. */
    INTERNAL: {
        message: "Something went wrong on our side.",
        hint: "We're on it. Try again in a moment.",
        retryable: true,
    },
};
export const ERROR_CODES = Object.freeze(Object.keys(ERROR_CATALOG));
/** Zod schema for error codes at API boundaries. */
export const ERROR_CODE_SCHEMA = z.enum(
// The catalog is a frozen const object; its keys are the exhaustive enum.
Object.keys(ERROR_CATALOG));
/** Builds an Ok envelope: `okEnvelope(value, meta?)`. */
export function okEnvelope(data, meta) {
    return meta === undefined ? { data } : { data, meta };
}
/**
 * Typed application error carrying the §7.3 envelope. Message/hint/retryable
 * default from the catalog and may be overridden per throw; `requestId`
 * defaults to a fresh `req_…` id. `toEnvelope()` is the wire shape — `toJSON()`
 * aliases it so accidental `JSON.stringify(error)` still cannot leak internals
 * (stack, cause, upstream URLs, absolute paths).
 */
export class StudioError extends Error {
    code;
    hint;
    retryable;
    requestId;
    constructor(code, options = {}) {
        const entry = ERROR_CATALOG[code];
        super(options.message ?? entry.message, { cause: options.cause });
        this.name = "StudioError";
        this.code = code;
        this.hint = options.hint ?? entry.hint;
        this.retryable = options.retryable ?? entry.retryable;
        this.requestId = options.requestId ?? newRequestId();
    }
    /** §7.3 Err envelope for this error. */
    toEnvelope() {
        const body = {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            requestId: this.requestId,
        };
        const hint = this.hint;
        if (hint !== undefined) {
            body.hint = hint;
        }
        return { error: body };
    }
    /** JSON.stringify hook — same wire shape as {@link toEnvelope}. */
    toJSON() {
        return this.toEnvelope();
    }
}
/** Type guard for StudioError at boundaries/handlers. */
export function isStudioError(value) {
    return value instanceof StudioError;
}
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
export function fromUnknown(err, requestId) {
    if (err instanceof StudioError) {
        if (requestId === undefined || err.requestId === requestId) {
            return err;
        }
        return new StudioError(err.code, {
            message: err.message,
            hint: err.hint,
            retryable: err.retryable,
            requestId,
            cause: err.cause,
        });
    }
    if (err instanceof z.ZodError) {
        return new StudioError("VALIDATION_FAILED", { requestId, cause: err });
    }
    return new StudioError("INTERNAL", {
        requestId,
        cause: err instanceof Error ? err : undefined,
    });
}
/** Type guard for the Err envelope half. */
export function isErrEnvelope(value) {
    return "error" in value;
}
//# sourceMappingURL=errors.js.map