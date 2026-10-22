import type { ApiClient } from "@studio/api-client";
import type { EditorSessionClient, ManifestAssetInfo, VersionRef } from "@/lib/editor-session";

/**
 * Shared types for the editor host (M3.5/M3.6/M3.7) — the pinned seam between
 * the RSC route (`app/(app)/w/[slug]/editor/page.tsx`) and the client-side
 * host components. BUILD_PLAN §M3 tasks 3–7; DECISIONS.md D-6.
 */

/**
 * The server-rendered manifest slice the host needs — already mapped to the
 * `EditorSessionClient.getManifest` seam shape (the RSC fetch is the single
 * source; the client does NOT re-fetch it on mount).
 */
export interface EditorInitialManifest {
  readonly project: { readonly id: string; readonly slug: string; readonly name: string };
  /** The version this session starts from; the autosave chain anchors on it. */
  readonly currentVersion: VersionRef;
  readonly assets: readonly ManifestAssetInfo[];
  /** Signed, short-lived download URL of the current `.ecproj` snapshot. */
  readonly projectFileUrl: string;
}

/** Serializable props from the RSC page to the client `EditorHost`. */
export interface EditorHostPayload {
  readonly manifest: EditorInitialManifest;
  /**
   * The workspace the project lives in (id). Browser-side `/v1` calls need it
   * as the `x-workspace-id` header (the gateway's requireWorkspace reads it).
   */
  readonly workspaceId: string;
}

/**
 * The single-writer lease port (§9.3/§11) the host checks on mount, on
 * window focus and on a 2-minute heartbeat (acquire = renew with the same
 * `sessionId`). Production wires `@studio/api-client`'s `leases.acquire`;
 * tests inject fakes.
 */
export interface LeasePort {
  /** Acquire or renew; resolves with the gateway's §7.2 outcome. */
  acquire(sessionId: string): Promise<{
    acquired: boolean;
    holderName: string;
    readOnly: boolean;
  }>;
  /** Best-effort release on unmount. */
  release(): Promise<void>;
}

/**
 * Test seam: production builds the api-client-backed `EditorSessionClient`
 * and lease port; tests inject the editor-session fake client + fake leases.
 * (Values, not factories — one session per page load; the payload never
 * changes once the RSC page resolved it.)
 */
export interface EditorSessionFactory {
  /** The `EditorSessionClient` the session engine drives. */
  readonly client: EditorSessionClient;
  /** The lease check/save-suspension port. */
  readonly leases: LeasePort;
  /**
   * The workspace-scoped `ApiClient` the M4 chat overlay rides (M4-J). The
   * production factory (`createApiSession`) always provides it; injected test
   * sessions may omit it, in which case the host mounts no chat layer.
   */
  readonly api?: ApiClient;
}
