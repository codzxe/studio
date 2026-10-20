// @studio/storage — the object key space (pure, unit-tested; no I/O imports).
//
// Design (task W2-M; §3.1 objects: uploaded originals, generated images,
// previews, exports, .pcraft backups; §15.1 per-workspace prefixes):
//
//   assets/organizations/<orgId>/assets/<assetId>[/<filename>]
//     — uploaded originals (§13.1 POST /v1/uploads), optional original filename
//   renders/organizations/<orgId>/documents/<docId>/preview-<width>-<revision>.png
//     — cached previews (§13.1 GET /v1/documents/:id/preview?w=…; §3.3 step 4)
//   exports/organizations/<orgId>/documents/<docId>/<format>-<versionId>.<ext>
//     — exports (§13.1 POST /v1/documents/:id/exports; format pcraft|png|jpg|psd)
//   documents/organizations/<orgId>/documents/<docId>/<versionId>.pcraft
//     — committed document versions (§3.3 step 6, §10.4 document_versions)
//   checkpoints/organizations/<orgId>/documents/<docId>/sessions/<sessionId>/checkpoint-<revision>.pcraft
//     — engine session checkpoints, the WAL replay bases (§3.2, §3.4)
//
// Every key embeds `…/organizations/<orgId>/…` so tenant extraction and the
// cross-tenant guard (§15.1) are pure string operations. Validation is
// REJECTION, never normalization (mirrors engine-client capabilities.ts):
// traversal, alternate separators, absolute paths, control characters,
// reserved Windows device names, unsafe charsets and length caps all fail.

import { storageFailure, type StorageResult } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The five object namespaces, in spec §3.1 order. */
export const KEY_NAMESPACES = [
  "assets",
  "renders",
  "exports",
  "documents",
  "checkpoints",
] as const satisfies readonly string[];

export type KeyNamespace = (typeof KEY_NAMESPACES)[number];

/** Fixed second path segment of every key (§15.1 per-workspace prefixes). */
export const ORGANIZATIONS_SEGMENT = "organizations";

/** Fixed third-to-last… layout constants for builder/parse parity. */
export const DOCUMENTS_SEGMENT = "documents";
export const SESSIONS_SEGMENT = "sessions";

/** S3 keys are capped at 1024 bytes UTF-8; we enforce it for every driver. */
export const MAX_KEY_BYTES = 1024;

/** Id components (orgId, assetId, docId, versionId, sessionId): 1..64 chars. */
export const MAX_ID_LENGTH = 64;

/** Filename components: 1..128 chars. */
export const MAX_FILENAME_LENGTH = 128;

/** Export formats (§13.1 POST /v1/documents/:id/exports). Extension equals format. */
export const EXPORT_FORMATS = ["pcraft", "png", "jpg", "psd"] as const satisfies readonly string[];

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Preview width bounds for previewKey (engine renders ≤ 2048 px; 2× for retina). */
export const MAX_PREVIEW_WIDTH = 4096;

/** Largest checkpoint revision the key builder accepts (int32-ish). */
export const MAX_REVISION = 2_147_483_647;

// ---------------------------------------------------------------------------
// Component predicates (charset allowlists — reject, never normalize)
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const WINDOWS_DEVICE_STEMS = new Set(["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"]);

/** Reserved Windows device stems (CON, PRN, COM1-9, LPT1-9, …). */
export function isWindowsDeviceName(component: string): boolean {
  const stem = (component.split(".")[0] ?? component).toUpperCase();
  if (WINDOWS_DEVICE_STEMS.has(stem)) {
    return true;
  }
  return /^COM[1-9]$/.test(stem) || /^LPT[1-9]$/.test(stem);
}

/** True when any code unit is a C0 control character or DEL. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * One tenant/record id component: 1..64 chars, starts alnum, then alnum/`_`/`-`.
 * No dots — ids are opaque database identifiers and never resemble path tricks.
 */
export function isSafeId(component: string): boolean {
  return component.length >= 1 && component.length <= MAX_ID_LENGTH && ID_PATTERN.test(component);
}

/**
 * One filename-ish segment: 1..128 chars, starts alnum, alnum/`.`/`_`/`-` after,
 * not a Windows device name, no trailing dot. `.` and `..` cannot match (they do
 * not start with an alnum character), so traversal is impossible by construction.
 */
export function isSafeFilename(component: string): boolean {
  if (component.length === 0 || component.length > MAX_FILENAME_LENGTH) {
    return false;
  }
  if (!SEGMENT_PATTERN.test(component)) {
    return false;
  }
  if (component.endsWith(".")) {
    return false;
  }
  return !isWindowsDeviceName(component);
}

function byteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return bytes;
}

function reasonForSegment(segment: string): string {
  if (segment.length === 0) {
    return "empty path segments are not allowed";
  }
  if (segment === "." || segment === "..") {
    return "traversal segments are not allowed";
  }
  if (!SEGMENT_PATTERN.test(segment)) {
    return "segment characters are outside the allowed set (alphanumerics, `.`, `_`, `-`; must start alphanumeric)";
  }
  if (segment.endsWith(".")) {
    return "segments ending in a dot are not allowed";
  }
  if (hasControlCharacter(segment)) {
    return "control characters are not allowed";
  }
  if (isWindowsDeviceName(segment)) {
    return "reserved device names are not allowed";
  }
  return "segment is not a safe path component";
}

// ---------------------------------------------------------------------------
// Key validation + tenant extraction
// ---------------------------------------------------------------------------

/**
 * Validate a storage key: relative forward-slash path, known namespace,
 * `organizations/<orgId>` present, every segment charset-safe, ≤ 1024 bytes.
 * Structural layout beyond the tenant segment is checked by parseStorageKey.
 */
export function validateStorageKey(key: string): StorageResult<string> {
  if (typeof key !== "string" || key.length === 0) {
    return storageFailure("storage_invalid_key", "storage key must be a non-empty string");
  }
  if (byteLength(key) > MAX_KEY_BYTES) {
    return storageFailure("storage_invalid_key", "storage key exceeds the 1024-byte cap");
  }
  if (key.startsWith("/") || key.startsWith("\\\\")) {
    return storageFailure("storage_invalid_key", "storage keys are relative; absolute paths are not allowed");
  }
  if (key.endsWith("/")) {
    return storageFailure("storage_invalid_key", "storage keys must not end with a slash");
  }
  if (key.includes("\\") || key.includes(":")) {
    return storageFailure(
      "storage_invalid_key",
      "alternate separators and drive/device prefixes are not allowed; keys use `/` only",
    );
  }
  if (hasControlCharacter(key)) {
    return storageFailure("storage_invalid_key", "control characters are not allowed in storage keys");
  }
  const segments = key.split("/");
  const namespace = segments[0] ?? "";
  if (!(KEY_NAMESPACES as readonly string[]).includes(namespace)) {
    return storageFailure(
      "storage_invalid_key",
      `storage key namespace is not recognized; expected one of ${KEY_NAMESPACES.join("|")}`,
    );
  }
  if (segments.length < 4) {
    return storageFailure(
      "storage_invalid_key",
      "storage keys must include the organizations/<organizationId> tenant segment",
    );
  }
  if (segments[1] !== ORGANIZATIONS_SEGMENT) {
    return storageFailure(
      "storage_invalid_key",
      `storage keys must scope objects under ${ORGANIZATIONS_SEGMENT}/<organizationId> (§15.1 per-workspace prefixes)`,
    );
  }
  const organizationId = segments[2] ?? "";
  if (!isSafeId(organizationId)) {
    return storageFailure("storage_invalid_key", "storage key tenant segment is not a safe organization id");
  }
  for (const segment of segments) {
    if (!isSafeFilename(segment)) {
      return storageFailure("storage_invalid_key", `storage key rejected: ${reasonForSegment(segment)}`);
    }
  }
  return { ok: true, value: key };
}

/** Tenant (organization id) extracted from a validated key. */
export function extractTenant(key: string): StorageResult<string> {
  const validated = validateStorageKey(key);
  if (!validated.ok) {
    return validated;
  }
  return { ok: true, value: key.split("/")[2] ?? "" };
}

/**
 * Cross-tenant guard (§15.1): the key must be valid AND belong to `organizationId`.
 * The typed failure never echoes the key or the ids — messages name the fields.
 */
export function assertTenant(key: string, organizationId: string): StorageResult<string> {
  if (!isSafeId(organizationId)) {
    return storageFailure(
      "storage_invalid_key",
      "tenant guard failed: the organization id argument is not a safe path component",
      { hint: "organization ids are 1..64 alphanumeric ids (no separators, no dots)" },
    );
  }
  const validated = validateStorageKey(key);
  if (!validated.ok) {
    return validated;
  }
  const tenant = key.split("/")[2] ?? "";
  if (tenant !== organizationId) {
    return storageFailure(
      "cross_tenant_key",
      "storage key belongs to a different organization; access denied",
      { hint: "every storage key embeds organizations/<organizationId>; callers must pass the caller's own organization id" },
    );
  }
  return { ok: true, value: key };
}

/**
 * Validate a list() prefix: `""` (whole space) or a relative charset-safe
 * partial path — the last segment may be a partial component, and a trailing
 * `/` marks a component boundary. Traversal rules match validateStorageKey.
 */
export function validateStoragePrefix(prefix: string): StorageResult<string> {
  if (typeof prefix !== "string") {
    return storageFailure("storage_invalid_key", "storage prefix must be a string");
  }
  if (prefix.length === 0) {
    return { ok: true, value: prefix };
  }
  if (byteLength(prefix) > MAX_KEY_BYTES) {
    return storageFailure("storage_invalid_key", "storage prefix exceeds the 1024-byte cap");
  }
  if (prefix.startsWith("/") || prefix.startsWith("\\\\")) {
    return storageFailure("storage_invalid_key", "storage prefixes are relative; absolute paths are not allowed");
  }
  if (prefix.includes("\\") || prefix.includes(":")) {
    return storageFailure(
      "storage_invalid_key",
      "alternate separators and drive/device prefixes are not allowed; prefixes use `/` only",
    );
  }
  if (hasControlCharacter(prefix)) {
    return storageFailure("storage_invalid_key", "control characters are not allowed in storage prefixes");
  }
  const boundary = prefix.endsWith("/");
  const segments = (boundary ? prefix.slice(0, -1) : prefix).split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return storageFailure("storage_invalid_key", "empty path segments are not allowed in storage prefixes");
  }
  const fullSegments = boundary ? segments : segments.slice(0, -1);
  const lastSegment = boundary ? "" : segments[segments.length - 1] ?? "";
  for (const segment of fullSegments) {
    if (!isSafeFilename(segment)) {
      return storageFailure("storage_invalid_key", `storage prefix rejected: ${reasonForSegment(segment)}`);
    }
  }
  if (lastSegment.length > 0 && !isSafeFilename(lastSegment)) {
    return storageFailure("storage_invalid_key", `storage prefix rejected: ${reasonForSegment(lastSegment)}`);
  }
  return { ok: true, value: prefix };
}

// ---------------------------------------------------------------------------
// Typed layout parse (beyond safety: which object is this key?)
// ---------------------------------------------------------------------------

export type ParsedStorageKey =
  | {
      readonly kind: "asset";
      readonly organizationId: string;
      readonly assetId: string;
      readonly filename?: string;
    }
  | {
      readonly kind: "preview";
      readonly organizationId: string;
      readonly documentId: string;
      readonly width: number;
      readonly revision: number;
    }
  | {
      readonly kind: "export";
      readonly organizationId: string;
      readonly documentId: string;
      readonly format: ExportFormat;
      readonly versionId: string;
    }
  | {
      readonly kind: "document";
      readonly organizationId: string;
      readonly documentId: string;
      readonly versionId: string;
    }
  | {
      readonly kind: "checkpoint";
      readonly organizationId: string;
      readonly documentId: string;
      readonly sessionId: string;
      readonly revision: number;
    };

function previewFilename(width: number, revision: number): string {
  return `preview-${width}-${revision}.png`;
}

function exportFilename(format: ExportFormat, versionId: string): string {
  return `${format}-${versionId}.${format}`;
}

function parsePreviewFilename(segment: string): { width: number; revision: number } | null {
  const match = /^preview-([0-9]{1,4})-([0-9]{1,10})\.png$/.exec(segment);
  if (match === null) {
    return null;
  }
  return { width: Number(match[1] ?? "0"), revision: Number(match[2] ?? "0") };
}

function parseCheckpointFilename(segment: string): number | null {
  const match = /^checkpoint-([0-9]{1,10})\.pcraft$/.exec(segment);
  if (match === null) {
    return null;
  }
  return Number(match[1] ?? "-1");
}

/**
 * Parse a validated key into its typed object record. Unknown-but-safe
 * layouts fail with `storage_invalid_key` — the key space is closed by design.
 */
export function parseStorageKey(key: string): StorageResult<ParsedStorageKey> {
  const validated = validateStorageKey(key);
  if (!validated.ok) {
    return validated;
  }
  const segments = key.split("/");
  const namespace = segments[0] as KeyNamespace;
  const organizationId = segments[2] ?? "";
  if (namespace === "assets") {
    if (segments[1] !== ORGANIZATIONS_SEGMENT || segments[3] !== "assets" || segments.length < 5 || segments.length > 6) {
      return layoutFailure();
    }
    const assetId = segments[4] ?? "";
    if (!isSafeId(assetId)) {
      return storageFailure("storage_invalid_key", "asset id segment is not a safe id");
    }
    const filename = segments[5];
    if (filename !== undefined && !isSafeFilename(filename)) {
      return storageFailure("storage_invalid_key", "asset filename segment is not a safe filename");
    }
    return {
      ok: true,
      value: filename === undefined
        ? { kind: "asset", organizationId, assetId }
        : { kind: "asset", organizationId, assetId, filename },
    };
  }
  if (segments[3] !== DOCUMENTS_SEGMENT) {
    return layoutFailure();
  }
  const documentId = segments[4] ?? "";
  if (!isSafeId(documentId)) {
    return storageFailure("storage_invalid_key", "document id segment is not a safe id");
  }
  if (namespace === "renders" && segments.length === 6) {
    const preview = parsePreviewFilename(segments[5] ?? "");
    if (
      preview === null ||
      preview.width < 1 ||
      preview.width > MAX_PREVIEW_WIDTH ||
      preview.revision > MAX_REVISION
    ) {
      return storageFailure("storage_invalid_key", "render segment is not a preview-<width>-<revision>.png layout");
    }
    return { ok: true, value: { kind: "preview", organizationId, documentId, ...preview } };
  }
  if (namespace === "exports" && segments.length === 6) {
    const segment = segments[5] ?? "";
    const format = EXPORT_FORMATS.find((candidate) => segment.startsWith(`${candidate}-`));
    if (format === undefined || !segment.endsWith(`.${format}`)) {
      return storageFailure(
        "storage_invalid_key",
        `export segment must be <format>-<versionId>.<format> with format in {${EXPORT_FORMATS.join("|")}}`,
      );
    }
    const versionId = segment.slice(format.length + 1, segment.length - format.length - 1);
    if (!isSafeId(versionId)) {
      return storageFailure("storage_invalid_key", "export version id segment is not a safe id");
    }
    return { ok: true, value: { kind: "export", organizationId, documentId, format, versionId } };
  }
  if (namespace === "documents" && segments.length === 6) {
    const segment = segments[5] ?? "";
    if (!segment.endsWith(".pcraft")) {
      return storageFailure("storage_invalid_key", "document segment must be <versionId>.pcraft");
    }
    const versionId = segment.slice(0, -".pcraft".length);
    if (!isSafeId(versionId)) {
      return storageFailure("storage_invalid_key", "document version id segment is not a safe id");
    }
    return { ok: true, value: { kind: "document", organizationId, documentId, versionId } };
  }
  if (
    namespace === "checkpoints" &&
    segments.length === 8 &&
    segments[5] === SESSIONS_SEGMENT
  ) {
    const sessionId = segments[6] ?? "";
    if (!isSafeId(sessionId)) {
      return storageFailure("storage_invalid_key", "checkpoint session id segment is not a safe id");
    }
    const revision = parseCheckpointFilename(segments[7] ?? "");
    if (revision === null || revision < 0 || revision > MAX_REVISION) {
      return storageFailure(
        "storage_invalid_key",
        "checkpoint segment must be checkpoint-<revision>.pcraft with a revision in 0..2147483647",
      );
    }
    return { ok: true, value: { kind: "checkpoint", organizationId, documentId, sessionId, revision } };
  }
  return layoutFailure();
}

function layoutFailure() {
  return storageFailure(
    "storage_invalid_key",
    "storage key does not match any known object layout for its namespace",
  );
}

// ---------------------------------------------------------------------------
// Builders (validate every input; messages never echo values)
// ---------------------------------------------------------------------------

function requireId(field: string, value: string): StorageResult<string> {
  if (!isSafeId(value)) {
    return storageFailure("storage_invalid_key", `the ${field} argument is not a safe id component`);
  }
  return { ok: true, value };
}

export function assetKey(input: {
  readonly organizationId: string;
  readonly assetId: string;
  readonly filename?: string;
}): StorageResult<string> {
  for (const [field, value] of [
    ["organizationId", input.organizationId],
    ["assetId", input.assetId],
  ] as const) {
    const id = requireId(field, value);
    if (!id.ok) {
      return id;
    }
  }
  const base = `assets/${ORGANIZATIONS_SEGMENT}/${input.organizationId}/assets/${input.assetId}`;
  if (input.filename === undefined) {
    return validateStorageKey(base);
  }
  if (!isSafeFilename(input.filename)) {
    return storageFailure("storage_invalid_key", "the filename argument is not a safe filename component");
  }
  return validateStorageKey(`${base}/${input.filename}`);
}

export function previewKey(input: {
  readonly organizationId: string;
  readonly documentId: string;
  readonly width: number;
  readonly revision: number;
}): StorageResult<string> {
  for (const [field, value] of [
    ["organizationId", input.organizationId],
    ["documentId", input.documentId],
  ] as const) {
    const id = requireId(field, value);
    if (!id.ok) {
      return id;
    }
  }
  if (!Number.isInteger(input.width) || input.width < 1 || input.width > MAX_PREVIEW_WIDTH) {
    return storageFailure("storage_invalid_key", "the width argument must be an integer between 1 and 4096");
  }
  if (!Number.isInteger(input.revision) || input.revision < 0 || input.revision > MAX_REVISION) {
    return storageFailure("storage_invalid_key", "the revision argument must be a non-negative integer");
  }
  return validateStorageKey(
    `renders/${ORGANIZATIONS_SEGMENT}/${input.organizationId}/${DOCUMENTS_SEGMENT}/${input.documentId}/${previewFilename(input.width, input.revision)}`,
  );
}

export function exportKey(input: {
  readonly organizationId: string;
  readonly documentId: string;
  readonly format: ExportFormat;
  readonly versionId: string;
}): StorageResult<string> {
  for (const [field, value] of [
    ["organizationId", input.organizationId],
    ["documentId", input.documentId],
    ["versionId", input.versionId],
  ] as const) {
    const id = requireId(field, value);
    if (!id.ok) {
      return id;
    }
  }
  if (!(EXPORT_FORMATS as readonly string[]).includes(input.format)) {
    return storageFailure(
      "storage_invalid_key",
      `the format argument must be one of {${EXPORT_FORMATS.join("|")}}`,
    );
  }
  return validateStorageKey(
    `exports/${ORGANIZATIONS_SEGMENT}/${input.organizationId}/${DOCUMENTS_SEGMENT}/${input.documentId}/${exportFilename(input.format, input.versionId)}`,
  );
}

export function documentKey(input: {
  readonly organizationId: string;
  readonly documentId: string;
  readonly versionId: string;
}): StorageResult<string> {
  for (const [field, value] of [
    ["organizationId", input.organizationId],
    ["documentId", input.documentId],
    ["versionId", input.versionId],
  ] as const) {
    const id = requireId(field, value);
    if (!id.ok) {
      return id;
    }
  }
  return validateStorageKey(
    `documents/${ORGANIZATIONS_SEGMENT}/${input.organizationId}/${DOCUMENTS_SEGMENT}/${input.documentId}/${input.versionId}.pcraft`,
  );
}

export function checkpointKey(input: {
  readonly organizationId: string;
  readonly documentId: string;
  readonly sessionId: string;
  readonly revision: number;
}): StorageResult<string> {
  for (const [field, value] of [
    ["organizationId", input.organizationId],
    ["documentId", input.documentId],
    ["sessionId", input.sessionId],
  ] as const) {
    const id = requireId(field, value);
    if (!id.ok) {
      return id;
    }
  }
  if (!Number.isInteger(input.revision) || input.revision < 0 || input.revision > MAX_REVISION) {
    return storageFailure("storage_invalid_key", "the revision argument must be a non-negative integer");
  }
  return validateStorageKey(
    `checkpoints/${ORGANIZATIONS_SEGMENT}/${input.organizationId}/${DOCUMENTS_SEGMENT}/${input.documentId}/${SESSIONS_SEGMENT}/${input.sessionId}/checkpoint-${input.revision}.pcraft`,
  );
}
