import { z } from "zod";
/** Entity kinds with a stable prefix (`prj_`, `ver_`, `ast_`, `thr_`, `run_`, `rnd_`, `req_`). */
export declare const ID_PREFIXES: {
    /** Project (`prj_`). */
    readonly project: "prj";
    /** Immutable project version snapshot (`ver_`). */
    readonly version: "ver";
    /** Uploaded asset (`ast_`). */
    readonly asset: "ast";
    /** Chat thread (`thr_`). */
    readonly thread: "thr";
    /** Agent run (`run_`). */
    readonly run: "run";
    /** Render job (`rnd_`). */
    readonly render: "rnd";
    /** API request id (`req_`) — also the default `requestId` of a StudioError. */
    readonly request: "req";
};
export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];
/** Default id generator — deterministic seam for tests. */
export declare function defaultIdGenerator(): string;
/**
 * New prefixed id, e.g. `newId("project")` → `prj_<32 hex>`.
 * Pass `generate` for deterministic tests or alternate schemes (e.g. real cuid2).
 */
export declare function newId(kind: IdKind, generate?: () => string): string;
/** Type guard: is `value` a well-formed prefixed id of the given kind? */
export declare function isNewId(value: string, kind: IdKind): boolean;
/** Zod schema for prefixed ids at API boundaries: `idSchema("project")` → `/^prj_[0-9a-f]{32}$/`. */
export declare function idSchema(kind: IdKind): z.ZodString;
/** New project id (`prj_…`). */
export declare function newProjectId(): string;
/** New version id (`ver_…`). */
export declare function newVersionId(): string;
/** New asset id (`ast_…`). */
export declare function newAssetId(): string;
/** New thread id (`thr_…`). */
export declare function newThreadId(): string;
/** New run id (`run_…`). */
export declare function newRunId(): string;
/** New render id (`rnd_…`). */
export declare function newRenderId(): string;
/** New request id (`req_…`) — used for error envelopes and log correlation. */
export declare function newRequestId(): string;
