import type { EditorSessionClient, UploadVersionResult, VersionRef } from "@/lib/editor-session";
import {
  type ApiClient,
  ApiError,
  createApiClient,
  fromResponse,
  isApiError,
  networkError,
} from "@studio/api-client";
import type { EditorHostPayload, LeasePort } from "./types";

/**
 * The production `EditorSessionClient` (M3-A) built on the props the RSC
 * page already resolved + `@studio/api-client`. Mapping decisions:
 *
 * - `getManifest` serves the SERVER-fetched manifest payload as-is (one fetch
 *   per page load, signed URLs are 10-minute fresh; the engine calls it once
 *   per editor open — a manual retry after expiry fails loudly through the
 *   engine's load path and a page refresh re-runs the RSC fetch).
 * - `downloadProjectFile`/`downloadAsset` use plain `fetch` on the PRE-SIGNED
 *   URLs from the manifest — no auth headers, same-origin cookies untouched
 *   (§9.2: signed URLs carry their own credentials).
 * - `uploadVersion` speaks the gateway's REAL §7.2 wire (multipart: a
 *   `descriptor` JSON part + the `.ecproj` bytes as `file`), sends
 *   `Idempotency-Key` + `x-workspace-id`, and maps a 409
 *   `PROJECT_VERSION_CONFLICT` to `{ ok: false, conflict: true }` — it NEVER
 *   throws for conflicts (the seam pins that; the engine parks on them).
 *   NOTE: `@studio/api-client`'s `versions.upload` implements the older
 *   two-phase descriptor+signed-PUT protocol the gateway does not expose on
 *   this route; the direct multipart call follows the shipped wire (gateway
 *   versions.ts) — see the M3-A worklog for the drift note.
 * - Failure typing reuses the api-client's `ApiError` machinery
 *   (`fromResponse`/`networkError`) so error surfaces stay consistent.
 */

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
const API_BASE_URL = "/v1";

/** Upper bound for the upload call — the engine's single-flight must park, not hang. */
const UPLOAD_TIMEOUT_MS = 60_000;

export interface ApiSessionClientOptions {
  /** Injectable fetch (tests); defaults to the global. */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Injectable idempotency-key factory (tests); defaults to `crypto.randomUUID`. */
  readonly idempotencyKey?: () => string;
}

export interface ApiSessionFactory {
  readonly client: EditorSessionClient;
  readonly leases: LeasePort;
  readonly api: ApiClient;
}

function requirePayload(payload: EditorHostPayload): EditorHostPayload {
  if (payload.manifest.project.id === "") {
    throw new Error("session-client: the payload has no project id");
  }
  return payload;
}

/**
 * Builds the production session client + lease port for one editor page load.
 * ONE `ApiClient` instance serves the lease port (`x-workspace-id` header on
 * every call — the gateway's `requireWorkspace` reads it).
 */
export function createApiSession(options: {
  readonly payload: EditorHostPayload;
  readonly fetch?: ApiSessionClientOptions["fetch"];
  readonly idempotencyKey?: () => string;
}): ApiSessionFactory {
  const payload = requirePayload(options.payload);
  const api = createApiClient({
    baseUrl: API_BASE_URL,
    headers: { "x-workspace-id": payload.workspaceId },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  });

  const client: EditorSessionClient = {
    async getManifest() {
      // Single-fetch principle: the RSC page already resolved this (validated
      // with the engine's own `parseManifest` server-side).
      return {
        project: { ...payload.manifest.project },
        currentVersion: { ...payload.manifest.currentVersion },
        assets: payload.manifest.assets.map((asset) => ({ ...asset })),
        projectFileUrl: payload.manifest.projectFileUrl,
      };
    },

    async downloadProjectFile(url: string): Promise<Blob> {
      return downloadSigned(url, options);
    },

    async downloadAsset(url: string): Promise<Blob> {
      return downloadSigned(url, options);
    },

    async uploadVersion(
      projectId: string,
      input: { bytes: Uint8Array; baseVersionId: string; sha256: string; label?: string },
    ): Promise<UploadVersionResult> {
      try {
        return await uploadVersionCall(payload.workspaceId, projectId, input, options);
      } catch (error) {
        if (isApiError(error)) {
          if (error.status === 409 || error.code === "PROJECT_VERSION_CONFLICT") {
            // §9.3: never a silent overwrite — resolve, don't throw.
            return { ok: false, conflict: true, serverVersion: null };
          }
          return { ok: false, error };
        }
        return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  };

  const leases: LeasePort = {
    async acquire(sessionId) {
      const lease = await api.leases.acquire(payload.manifest.project.id, { sessionId });
      return {
        acquired: lease.acquired,
        holderName: lease.holderName,
        readOnly: lease.readOnly,
      };
    },
    async release() {
      // Best-effort: the lease also expires on its own (§11 TTL).
      await api.leases.release(payload.manifest.project.id).catch(() => undefined);
    },
  };

  return { client, leases, api };
}

// ---------------------------------------------------------------------------
// Downloads (pre-signed URLs — no auth headers)
// ---------------------------------------------------------------------------

async function downloadSigned(
  url: string,
  options: { readonly fetch?: (input: string, init?: RequestInit) => Promise<Response> },
): Promise<Blob> {
  const fetchImpl = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) {
    // Signed URLs: the status is safe to show, nothing else is.
    throw new ApiError({
      code: "NETWORK_ERROR",
      message: `The download failed (HTTP ${response.status}).`,
      hint: "Retry in a moment; if it keeps failing, refresh the page.",
      retryable: true,
      status: 0,
      cause: undefined,
    });
  }
  return response.blob();
}

// ---------------------------------------------------------------------------
// Version upload (the REAL §7.2 multipart wire)
// ---------------------------------------------------------------------------

async function uploadVersionCall(
  workspaceId: string,
  projectId: string,
  input: { bytes: Uint8Array; baseVersionId: string; sha256: string; label?: string },
  options: {
    readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    readonly idempotencyKey?: () => string;
  },
): Promise<UploadVersionResult> {
  const fetchImpl = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const newKey = options.idempotencyKey ?? (() => crypto.randomUUID());

  const descriptor = {
    baseVersionId: input.baseVersionId,
    sha256: input.sha256,
    label: input.label,
    sizeBytes: input.bytes.byteLength,
  };
  const form = new FormData();
  form.set("descriptor", JSON.stringify(descriptor));
  form.set(
    "file",
    new File([input.bytes as BlobPart], "project.ecproj", { type: "application/octet-stream" }),
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(
      `${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/versions`,
      {
        method: "POST",
        headers: {
          "x-workspace-id": workspaceId,
          "Idempotency-Key": newKey(),
        },
        body: form,
        signal: controller.signal,
      },
    );
  } catch (error) {
    // Abort (our 60 s bound) and network failures both surface as the
    // api-client's typed, retryable NETWORK_ERROR.
    throw networkError(error);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const apiError = await fromResponse({
      status: response.status,
      statusText: response.statusText,
      text: () => response.text(),
    });
    throw apiError;
  }

  const text = await response.text();
  const body: unknown = text === "" ? undefined : safeJson(text);
  if (!isOkEnvelope(body)) {
    return {
      ok: false,
      error: new Error("the version upload response was malformed"),
    };
  }
  const version = parseVersionRefLoose(body.data);
  if (version === null) {
    return {
      ok: false,
      error: new Error("the version upload response was malformed"),
    };
  }
  return { ok: true, version };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isOkEnvelope(value: unknown): value is { data: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "data" in value &&
    !("error" in value)
  );
}

/** Narrow `VersionRef` validation (id/sha/size per §9.2) — no zod in apps/web. */
function parseVersionRefLoose(value: unknown): VersionRef | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : null;
  const sha256 =
    typeof record.sha256 === "string" && /^[0-9a-f]{64}$/.test(record.sha256)
      ? record.sha256
      : null;
  const sizeBytes =
    typeof record.sizeBytes === "number" &&
    Number.isSafeInteger(record.sizeBytes) &&
    record.sizeBytes >= 0
      ? record.sizeBytes
      : null;
  const label =
    record.label === undefined || record.label === null
      ? null
      : typeof record.label === "string"
        ? record.label
        : null;
  if (id === null || sha256 === null || sizeBytes === null) return null;
  return { id, label, sha256, sizeBytes };
}
