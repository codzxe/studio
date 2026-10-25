/**
 * The editor-session seam types (M3.3 load sequence + M3.4 autosave/versioning).
 *
 * This module is the pinned contract between the editor host page (M3-A) and
 * the session engine (M3-B); BUILD_PLAN §M3 tasks 3/4 and DECISIONS.md D-6.
 * The page implements `EditorSessionClient` on top of `@studio/api-client`
 * (gateway: projects manifest, signed URLs, immutable versions — §7.2/§9.2/§9.3);
 * the engine orchestrates the real EffectCraft editor through `EditorBridge`.
 *
 * Boundary notes:
 * - `@studio/contracts` is imported as `import type` only from apps/web
 *   (Turbopack constraint); the seam therefore restates the (subset of) wire
 *   fields it consumes instead of importing the runtime schemas.
 * - `zod` is not a dependency of apps/web, so client results are validated
 *   with the narrow hand-rolled validators below (bridge results are already
 *   Zod-validated inside `@studio/editor-bridge`).
 * - Editor results the bridge returns raw (`query()`) are parsed with the
 *   bridge package's own `ProjectSummarySchema` (see internal.ts).
 */

import type { EditorBridge } from "@studio/editor-bridge";

// ---------------------------------------------------------------------------
// Pinned seam (do not rename — M3-A codes against these names)
// ---------------------------------------------------------------------------

export interface VersionRef {
  id: string;
  label: string | null;
  sha256: string;
  sizeBytes: number;
}

export interface ManifestAssetInfo {
  id: string;
  name: string;
  /** Stable virtual path the project file references (§6.3 `assets/<assetId>/<name>`). */
  virtualPath: string;
  /** Signed, short-lived download URL. */
  downloadUrl: string;
  sizeBytes?: number;
}

export interface MissingAsset {
  asset: ManifestAssetInfo;
  reason: string;
}

export interface LoadOutcome {
  /** The path the editor assigned to the open `.ecproj` (authoritative — upstream keeps the last path segment).
   * `null` for a fresh start-from-scratch open (no snapshot to load — the editor keeps its own default project). */
  openedPath: string | null;
  activeComp: number | null;
  /** Assets that failed to register; a missing asset NEVER blocks the project from opening. */
  missingAssets: MissingAsset[];
  /** assetId → the path the editor actually assigned (upstream may shorten the requested virtual path). */
  assetPaths: Readonly<Record<string, string>>;
}

/**
 * Narrow seam over the gateway (implemented by M3-A with @studio/api-client).
 */
export interface EditorSessionClient {
  getManifest(projectId: string): Promise<{
    project: { id: string; slug: string; name: string };
    /** `null` for a project with no versions yet (start-from-scratch). */
    currentVersion: VersionRef | null;
    assets: ManifestAssetInfo[];
    /** Signed URL of the current `.ecproj` snapshot; `null` when currentVersion is. */
    projectFileUrl: string | null;
  }>;
  downloadProjectFile(url: string): Promise<Blob>;
  downloadAsset(url: string): Promise<Blob>;
  /**
   * Upload an immutable version snapshot; on base-version mismatch the
   * implementation resolves with a `conflict: true` outcome (gateway 409
   * PROJECT_VERSION_CONFLICT) — it must NOT throw for conflicts.
   *
   * Deviation from the original pin (recorded in worklog M3-B): the conflict
   * variant may carry `serverVersion` so `AutosaveHooks.onConflict` can show
   * what the server holds. The field is optional — a client returning the
   * exact pinned `{ ok: false; conflict: true }` still satisfies this type.
   */
  uploadVersion(
    projectId: string,
    input: { bytes: Uint8Array; baseVersionId: string | null; sha256: string; label?: string },
  ): Promise<UploadVersionResult>;
}

export type UploadVersionResult =
  | { ok: true; version: VersionRef }
  | { ok: false; conflict: true; serverVersion?: VersionRef | null }
  | { ok: false; error: unknown };

export interface AutosaveHooks {
  onSaved?(version: VersionRef): void;
  onConflict?(serverVersion: VersionRef | null): void;
  onError?(error: unknown): void;
}

export interface SaveOutcome {
  saved: boolean;
  version?: VersionRef;
  conflict?: boolean;
  error?: unknown;
}

export interface AutosaveController {
  readonly dirty: boolean;
  markDirty(reason?: string): void;
  saveNow(reason: string): Promise<SaveOutcome>;
  /** The session's current version (the advancing autosave chain head) — the
   * M5 apply/reapply gate's honest source. `null` pre-boot/disposed, or for a
   * fresh project until its first save lands. */
  currentVersion(): VersionRef | null;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Options (pinned fields + additive, optional extras)
// ---------------------------------------------------------------------------

export interface LoadProjectSessionOptions {
  bridge: EditorBridge;
  client: EditorSessionClient;
  projectId: string;
  /** Parallel asset downloads (default 3, clamp 1..8). */
  assetConcurrency?: number;
  /** Per-asset download+register timeout in ms (default 30 000). */
  assetTimeoutMs?: number;
  /** Project-file download timeout in ms (default 60 000). */
  projectFileTimeoutMs?: number;
  /**
   * `file.open` execute budget in ms (default 60 000). The open is the FIRST
   * heavy command after boot (parse + replace project + restore view) and on
   * a cold, software-rendered engine can outrun the bridge's generic 15 s
   * call timeout while the engine is perfectly healthy.
   */
  openTimeoutMs?: number;
}

export interface CreateAutosaveControllerOptions {
  bridge: EditorBridge;
  client: EditorSessionClient;
  projectId: string;
  /** The version the session started from (`manifest.currentVersion`);
   * `null` for a fresh project — the first save uploads with `baseVersionId: null`
   * (the gateway's root-upload path, W3-G3) and the chain head advances from there. */
  baseVersion: VersionRef | null;
  /** File-table name for the FIRST save of a fresh project (no session path yet);
   * defaults to `project.ecproj`. Ignored once a version exists. */
  defaultSaveName?: string;
  hooks?: AutosaveHooks;
  /** Tick cadence while dirty in ms (default 30 000 — DECISIONS.md D-6). */
  intervalMs?: number;
  /** Consecutive failed save attempts after which autosave parks (default 5). */
  maxConsecutiveErrors?: number;
  /** Extra immediate retries per save attempt before waiting for the next tick (default 2). */
  immediateRetries?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type EditorSessionErrorCode =
  | "bad-args"
  | "manifest-invalid"
  | "upload-result-invalid"
  | "summary-invalid"
  | "project-file-failed"
  | "open-failed"
  | "no-project-open"
  | "timeout"
  | "autosave-parked"
  | "disposed";

/** The single error type the session engine throws (bridge errors keep their `BridgeError` shape via `cause`). */
export class EditorSessionError extends Error {
  readonly code: EditorSessionErrorCode;

  constructor(code: EditorSessionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EditorSessionError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Hand-rolled validators (no zod in apps/web — see module doc)
// ---------------------------------------------------------------------------

const SHA256_RE = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function err(code: EditorSessionErrorCode, detail: string): EditorSessionError {
  return new EditorSessionError(code, detail);
}

/** Validate a `VersionRef`-shaped value (id/sha/size per §9.2, lowercase sha256 hex like the gateway). */
export function parseVersionRef(value: unknown, where: string): VersionRef {
  if (!isRecord(value)) throw err("manifest-invalid", `${where}: expected an object`);
  const id = str(value.id);
  if (id === undefined) throw err("manifest-invalid", `${where}: missing or empty \`id\``);
  const sha256 = str(value.sha256);
  if (sha256 === undefined || !SHA256_RE.test(sha256)) {
    throw err("manifest-invalid", `${where}: \`sha256\` must be a lowercase 64-char hex digest`);
  }
  const sizeBytes = value.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw err("manifest-invalid", `${where}: \`sizeBytes\` must be a non-negative integer`);
  }
  const label = value.label;
  if (label !== undefined && label !== null && typeof label !== "string") {
    throw err("manifest-invalid", `${where}: \`label\` must be a string or null`);
  }
  return { id, label: typeof label === "string" ? label : null, sha256, sizeBytes };
}

/** Validate the `getManifest` result (the subset of the §7.2 manifest this engine consumes). */
export function parseManifest(value: unknown): {
  project: { id: string; slug: string; name: string };
  currentVersion: VersionRef | null;
  assets: ManifestAssetInfo[];
  projectFileUrl: string | null;
} {
  if (!isRecord(value)) throw err("manifest-invalid", "getManifest: expected an object");
  const rawProject = value.project;
  if (!isRecord(rawProject))
    throw err("manifest-invalid", "getManifest: `project` must be an object");
  const projectId = str(rawProject.id);
  if (projectId === undefined)
    throw err("manifest-invalid", "getManifest.project: missing or empty `id`");
  if (typeof rawProject.slug !== "string") {
    throw err("manifest-invalid", "getManifest.project: `slug` must be a string");
  }
  if (typeof rawProject.name !== "string") {
    throw err("manifest-invalid", "getManifest.project: `name` must be a string");
  }
  // Start-from-scratch: a project with no versions carries `currentVersion: null`
  // and `projectFileUrl: null` (or omits it) — the editor keeps its own default
  // empty project and the first save creates v1 (root upload, W3-G3).
  const currentVersion =
    value.currentVersion === null || value.currentVersion === undefined
      ? null
      : parseVersionRef(value.currentVersion, "getManifest.currentVersion");
  const rawAssets = value.assets;
  if (!Array.isArray(rawAssets))
    throw err("manifest-invalid", "getManifest: `assets` must be an array");
  const assets: ManifestAssetInfo[] = rawAssets.map((raw, index) => {
    const where = `getManifest.assets[${index}]`;
    if (!isRecord(raw)) throw err("manifest-invalid", `${where}: expected an object`);
    const id = str(raw.id);
    if (id === undefined) throw err("manifest-invalid", `${where}: missing or empty \`id\``);
    if (typeof raw.name !== "string")
      throw err("manifest-invalid", `${where}: \`name\` must be a string`);
    if (typeof raw.virtualPath !== "string") {
      throw err("manifest-invalid", `${where}: \`virtualPath\` must be a string`);
    }
    const downloadUrl = str(raw.downloadUrl);
    if (downloadUrl === undefined) {
      throw err("manifest-invalid", `${where}: missing or empty \`downloadUrl\``);
    }
    const sizeBytes = raw.sizeBytes;
    const asset: ManifestAssetInfo = {
      id,
      name: raw.name,
      virtualPath: raw.virtualPath,
      downloadUrl,
    };
    if (sizeBytes !== undefined) {
      if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw err("manifest-invalid", `${where}: \`sizeBytes\` must be a non-negative integer`);
      }
      asset.sizeBytes = sizeBytes;
    }
    return asset;
  });
  const projectFileUrl = str(value.projectFileUrl) ?? null;
  if (currentVersion === null && projectFileUrl !== null) {
    throw err("manifest-invalid", "getManifest: `projectFileUrl` set without `currentVersion`");
  }
  if (currentVersion !== null && projectFileUrl === null) {
    throw err("manifest-invalid", "getManifest: missing or empty `projectFileUrl`");
  }
  return {
    project: { id: projectId, slug: rawProject.slug, name: rawProject.name },
    currentVersion,
    assets,
    projectFileUrl,
  };
}

/** Validate an `uploadVersion` result; conflicts and errors resolve (never throw) — malformed results do. */
export function parseUploadResult(value: unknown): UploadVersionResult {
  if (!isRecord(value)) {
    throw err("upload-result-invalid", "uploadVersion: expected an object result");
  }
  if (value.ok === true) {
    return { ok: true, version: parseVersionRef(value.version, "uploadVersion.version") };
  }
  if (value.conflict === true) {
    const serverVersionRaw = value.serverVersion;
    if (serverVersionRaw === undefined || serverVersionRaw === null) {
      return { ok: false, conflict: true, serverVersion: null };
    }
    return {
      ok: false,
      conflict: true,
      serverVersion: parseVersionRef(serverVersionRaw, "uploadVersion.serverVersion"),
    };
  }
  if (value.ok === false) {
    const error =
      value.error !== undefined && value.error !== null
        ? value.error
        : err("upload-result-invalid", "uploadVersion returned { ok: false } without an error");
    return { ok: false, error };
  }
  throw err("upload-result-invalid", "uploadVersion: result must have `ok: true` or `ok: false`");
}
