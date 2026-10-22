// The share-page API seam (BUILD_PLAN §M7 task 5): a narrow port the real
// `@studio/api-client` `share` region satisfies structurally, so every
// interactive surface of /s/:token is testable against a fake and the
// production build never hand-rolls a call.
//
// Only the PUBLIC memberless calls live here (manifest / comments list /
// guest comment / request access) — the token (or token + password, sent by
// the api-client as the `x-share-password` header) IS the capability. The
// member issue/list/revoke surface belongs to the workspace UI, not to an
// anonymous review page.
//
// Boundary law (apps/web): `@studio/contracts` is `import type` ONLY.

import {
  type ApiClient,
  type ShareCallOptions,
  createApiClient,
  isApiError,
} from "@studio/api-client";
import type {
  CreateShareCommentRequest,
  Page,
  RequestAccessRequest,
  RequestAccessResponse,
  ShareComment,
  ShareManifest,
} from "@studio/contracts";

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
export const SHARE_API_BASE_URL = "/v1";

/** The public share surface the review page consumes. */
export interface SharePort {
  /** GET /v1/share/:token/manifest — the player's read surface (gated). */
  readonly getManifest: (token: string, options?: ShareCallOptions) => Promise<ShareManifest>;
  /** GET /v1/share/:token/comments — id-stripped, guest-readable rows. */
  readonly listComments: (token: string, options?: ShareCallOptions) => Promise<Page<ShareComment>>;
  /** POST /v1/share/:token/comments — guest comment (gated, rate-limited). */
  readonly createComment: (
    token: string,
    body: CreateShareCommentRequest,
    options?: ShareCallOptions,
  ) => Promise<ShareComment>;
  /** POST /v1/share/:token/request-access — typed ok (rate-limited). */
  readonly requestAccess: (
    token: string,
    body: RequestAccessRequest,
    options?: ShareCallOptions,
  ) => Promise<RequestAccessResponse>;
}

/**
 * Compile-time pin + adapter: the production `ApiClient["share"]` satisfies
 * {@link SharePort} — the page never hand-rolls a call or a fetch.
 */
export function asSharePort(client: ApiClient): SharePort {
  return {
    getManifest: client.share.getManifest,
    listComments: (token, options) => client.share.listComments(token, {}, options),
    createComment: client.share.createComment,
    requestAccess: client.share.requestAccess,
  };
}

/** The production port for the anonymous review page (same-origin `/v1`). */
export function createDefaultSharePort(): SharePort {
  return asSharePort(createApiClient({ baseUrl: SHARE_API_BASE_URL }));
}

// ---------------------------------------------------------------------------
// Typed failure mapping (§7.3 → §14 microcopy)
// ---------------------------------------------------------------------------

/** The share-page failure states an anonymous reviewer can land in. */
export type ShareFailureKind =
  /** 401 AUTH_REQUIRED — missing and wrong password are the same answer. */
  | "wrong-password"
  /** 429 RATE_LIMITED — the per-IP windows (password 10/min, posts 5/min). */
  | "rate-limited"
  /** 404 NOT_FOUND — the token expired or was revoked mid-review. */
  | "gone"
  /** 400 VALIDATION_FAILED — the body didn't pass the schemas. */
  | "invalid"
  /** Anything else — network down, 5xx, malformed envelope. */
  | "unavailable";

export interface ShareFailure {
  readonly kind: ShareFailureKind;
  /** Safe, actionable microcopy (§14) — never a raw body or stack. */
  readonly message: string;
}

const RATE_LIMITED_MESSAGE = "Too many attempts — wait a minute and try again.";

/**
 * Map any thrown failure from a {@link SharePort} call to the share page's
 * typed failure states. Non-ApiError failures (network, bugs) read as
 * `unavailable` with sanitized copy — §7.3 safety holds at the UI too.
 */
export function describeShareFailure(error: unknown): ShareFailure {
  if (isApiError(error)) {
    const { code, status } = error;
    if (status === 401 || code === "AUTH_REQUIRED") {
      return {
        kind: "wrong-password",
        message: "That password didn't unlock this link. Check with whoever shared it.",
      };
    }
    if (status === 429 || code === "RATE_LIMITED") {
      return { kind: "rate-limited", message: RATE_LIMITED_MESSAGE };
    }
    if (status === 404 || code === "NOT_FOUND" || code === "WORKSPACE_NOT_FOUND") {
      return {
        kind: "gone",
        message: "This share link isn't available anymore.",
      };
    }
    if (status === 400 || code === "VALIDATION_FAILED") {
      return {
        kind: "invalid",
        message:
          error.message.length > 0 ? error.message : "That didn't look right — check the fields.",
      };
    }
    if (code === "NETWORK_ERROR") {
      return {
        kind: "unavailable",
        message: "Could not reach the server. Check your connection and try again.",
      };
    }
  }
  return {
    kind: "unavailable",
    message: "Something went wrong on our side. Try again in a moment.",
  };
}
