// @studio/config — id helpers.
//
// cuid2-style ids built on `crypto.randomUUID` (Node 22+, browsers, workers):
// short lowercase prefix + underscore + 32 hex chars (`prj_0f9a…`). Prefixes keep
// ids readable in URLs, logs and support conversations without leaking anything.
import { randomUUID } from "node:crypto";
import { z } from "zod";

/** Entity kinds with a stable prefix (`prj_`, `ver_`, `ast_`, `thr_`, `run_`, `rnd_`, `req_`). */
export const ID_PREFIXES = {
  /** Project (`prj_`). */
  project: "prj",
  /** Immutable project version snapshot (`ver_`). */
  version: "ver",
  /** Uploaded asset (`ast_`). */
  asset: "ast",
  /** Chat thread (`thr_`). */
  thread: "thr",
  /** Agent run (`run_`). */
  run: "run",
  /** Render job (`rnd_`). */
  render: "rnd",
  /** API request id (`req_`) — also the default `requestId` of a StudioError. */
  request: "req",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

/** The random part of an id: 32 lowercase hex chars (a stripped UUID v4). */
const ID_BODY_PATTERN = /^[0-9a-f]{32}$/;

/** Default id generator — deterministic seam for tests. */
export function defaultIdGenerator(): string {
  return randomUUID().replace(/-/g, "");
}

/**
 * New prefixed id, e.g. `newId("project")` → `prj_<32 hex>`.
 * Pass `generate` for deterministic tests or alternate schemes (e.g. real cuid2).
 */
export function newId(kind: IdKind, generate: () => string = defaultIdGenerator): string {
  return `${ID_PREFIXES[kind]}_${generate()}`;
}

/** Type guard: is `value` a well-formed prefixed id of the given kind? */
export function isNewId(value: string, kind: IdKind): boolean {
  const prefix = ID_PREFIXES[kind];
  if (!value.startsWith(`${prefix}_`)) {
    return false;
  }
  return ID_BODY_PATTERN.test(value.slice(prefix.length + 1));
}

/** Zod schema for prefixed ids at API boundaries: `idSchema("project")` → `/^prj_[0-9a-f]{32}$/`. */
export function idSchema(kind: IdKind) {
  const prefix = ID_PREFIXES[kind];
  const pattern = new RegExp(`^${prefix}_[0-9a-f]{32}$`);
  return z.string().regex(pattern, `must be a ${prefix}_ id (32 hex chars after the prefix)`);
}

/** New project id (`prj_…`). */
export function newProjectId(): string {
  return newId("project");
}

/** New version id (`ver_…`). */
export function newVersionId(): string {
  return newId("version");
}

/** New asset id (`ast_…`). */
export function newAssetId(): string {
  return newId("asset");
}

/** New thread id (`thr_…`). */
export function newThreadId(): string {
  return newId("thread");
}

/** New run id (`run_…`). */
export function newRunId(): string {
  return newId("run");
}

/** New render id (`rnd_…`). */
export function newRenderId(): string {
  return newId("render");
}

/** New request id (`req_…`) — used for error envelopes and log correlation. */
export function newRequestId(): string {
  return newId("request");
}
