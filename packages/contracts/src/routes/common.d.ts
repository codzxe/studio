import { z } from "zod";
/**
 * Wire ids are opaque non-empty strings (uuid-shaped in practice, §9.1 —
 * "tenant foreign keys are text/uuid consistently"). Contracts stay
 * representation-agnostic.
 */
export declare const ID_SCHEMA: z.ZodString;
export type Id = z.infer<typeof ID_SCHEMA>;
/** Lowercase SHA-256 hex digest (content-addressed snapshots/assets, §9.2). */
export declare const SHA256_SCHEMA: z.ZodString;
/** Wire-stable role names (§7.1: owner | admin | editor | viewer). */
export declare const ROLES: readonly ["owner", "admin", "editor", "viewer"];
export declare const ROLE_SCHEMA: z.ZodEnum<{
    editor: "editor";
    owner: "owner";
    admin: "admin";
    viewer: "viewer";
}>;
export type Role = z.infer<typeof ROLE_SCHEMA>;
/** Idempotency keys: mutations require one (§7.2); client-generated, ≥8 chars. */
export declare const IDEMPOTENCY_KEY_SCHEMA: z.ZodString;
export type IdempotencyKey = z.infer<typeof IDEMPOTENCY_KEY_SCHEMA>;
/** ISO-8601 timestamps cross the wire as strings. */
export declare const ISO8601_SCHEMA: z.ZodString;
export declare const PAGINATION_QUERY_SCHEMA: z.ZodObject<{
    cursor: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
}, z.core.$strip>;
export type PaginationQuery = z.infer<typeof PAGINATION_QUERY_SCHEMA>;
export declare const MAX_PAGE_LIMIT = 100;
export interface Page<T> {
    readonly items: readonly T[];
    readonly nextCursor: string | null;
}
export declare const CONTEXT_BLOCK_KEYS: readonly ["projectSummary", "activeComp", "selection", "playhead", "focusedPanel", "selectedProperties", "currentFrame", "recentCommands", "comments"];
export type ContextBlockKey = (typeof CONTEXT_BLOCK_KEYS)[number];
export declare const CONTEXT_SELECTION_SCHEMA: z.ZodObject<{
    projectSummary: z.ZodDefault<z.ZodBoolean>;
    activeComp: z.ZodDefault<z.ZodBoolean>;
    selection: z.ZodDefault<z.ZodBoolean>;
    playhead: z.ZodDefault<z.ZodBoolean>;
    focusedPanel: z.ZodDefault<z.ZodBoolean>;
    selectedProperties: z.ZodDefault<z.ZodBoolean>;
    currentFrame: z.ZodDefault<z.ZodBoolean>;
    recentCommands: z.ZodDefault<z.ZodBoolean>;
    comments: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export type ContextSelection = z.infer<typeof CONTEXT_SELECTION_SCHEMA>;
export declare const PINNED_CONTEXT_KINDS: readonly ["frame", "selection", "composition", "asset", "comment"];
export type PinnedContextKind = (typeof PINNED_CONTEXT_KINDS)[number];
/**
 * One pinned context chip (§5.2): attach frame/selection/composition/asset/
 * comment. `id` is a Studio id, never a path; `frame` pins usually carry no id.
 */
export declare const PINNED_CONTEXT_ITEM_SCHEMA: z.ZodObject<{
    kind: z.ZodEnum<{
        asset: "asset";
        comment: "comment";
        selection: "selection";
        frame: "frame";
        composition: "composition";
    }>;
    id: z.ZodOptional<z.ZodString>;
    label: z.ZodString;
}, z.core.$strict>;
export type PinnedContextItem = z.infer<typeof PINNED_CONTEXT_ITEM_SCHEMA>;
