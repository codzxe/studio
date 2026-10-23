// @studio/contracts — shared route primitives (PRODUCT_ARCHITECTURE.md §7.2,
// EDITOR_CHAT_UX §5): ids, roles, pagination, context selection.
import { z } from "zod";
// ---------------------------------------------------------------------------
// Ids and shared scalars
// ---------------------------------------------------------------------------
/**
 * Wire ids are opaque non-empty strings (uuid-shaped in practice, §9.1 —
 * "tenant foreign keys are text/uuid consistently"). Contracts stay
 * representation-agnostic.
 */
export const ID_SCHEMA = z.string().min(1);
/** Lowercase SHA-256 hex digest (content-addressed snapshots/assets, §9.2). */
export const SHA256_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest");
/** Wire-stable role names (§7.1: owner | admin | editor | viewer). */
export const ROLES = ["owner", "admin", "editor", "viewer"];
export const ROLE_SCHEMA = z.enum(ROLES);
/** Idempotency keys: mutations require one (§7.2); client-generated, ≥8 chars. */
export const IDEMPOTENCY_KEY_SCHEMA = z.string().min(8).max(128);
/** ISO-8601 timestamps cross the wire as strings. */
export const ISO8601_SCHEMA = z.string().datetime({ offset: true });
// ---------------------------------------------------------------------------
// Pagination (cursor-based, §7.2 list endpoints)
// ---------------------------------------------------------------------------
export const PAGINATION_QUERY_SCHEMA = z.object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const MAX_PAGE_LIMIT = 100;
// ---------------------------------------------------------------------------
// Context selection (EDITOR_CHAT_UX §5.1 auto context)
// ---------------------------------------------------------------------------
//
// Auto-context block toggles. The "Always" blocks of §5.1 (project summary,
// active composition, playhead, focused panel) default to true; conditional
// blocks default to false. The user can remove any block in the Context
// popover (§5.3) — the agent is told what is missing.
export const CONTEXT_BLOCK_KEYS = [
    "projectSummary",
    "activeComp",
    "selection",
    "playhead",
    "focusedPanel",
    "selectedProperties",
    "currentFrame",
    "recentCommands",
    "comments",
];
export const CONTEXT_SELECTION_SCHEMA = z.strictObject({
    projectSummary: z.boolean().default(true), // Always (§5.1)
    activeComp: z.boolean().default(true), // Always
    selection: z.boolean().default(false), // When a selection exists
    playhead: z.boolean().default(true), // Always
    focusedPanel: z.boolean().default(true), // Always
    selectedProperties: z.boolean().default(false), // When a selection exists (≤ 12 props)
    currentFrame: z.boolean().default(false), // When the prompt is visual
    recentCommands: z.boolean().default(false), // When relevant (last 10)
    comments: z.boolean().default(false), // When the prompt mentions feedback
});
// ---------------------------------------------------------------------------
// Manual pinned context (EDITOR_CHAT_UX §5.2)
// ---------------------------------------------------------------------------
export const PINNED_CONTEXT_KINDS = [
    "frame",
    "selection",
    "composition",
    "asset",
    "comment",
];
/**
 * One pinned context chip (§5.2): attach frame/selection/composition/asset/
 * comment. `id` is a Studio id, never a path; `frame` pins usually carry no id.
 */
export const PINNED_CONTEXT_ITEM_SCHEMA = z.strictObject({
    kind: z.enum(PINNED_CONTEXT_KINDS),
    id: ID_SCHEMA.optional(),
    label: z.string().min(1).max(200),
});
//# sourceMappingURL=common.js.map