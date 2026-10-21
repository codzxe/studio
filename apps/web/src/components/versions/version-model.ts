// apps/web/src/components/versions — version-history pure model (W8-G).
//
// Zero imports, no React, no network: everything here is deterministic,
// table-testable logic shared by the versions hooks (./use-versions.ts) and
// the timeline components (version-list / version-row / restore-dialog /
// diff-view). version-model.test.ts pins the tables.
//
// Spec anchors:
//   §10.4  versions are immutable; "restore" creates a NEW version from an
//          old command log — the timeline is linear and never rewritten.
//   §13.1  GET /v1/documents/:id/versions (ascending), POST …/versions/:versionId/restore.
//   §5.6   document.diff {from,to} → {added,removed,changed,moved} per layer,
//          for the UI diff and the validator's "nothing was silently
//          destroyed" check.
//   §6.1   errors are actionable: the UI states below always carry the
//          server's message + hint instead of swallowing them.
//
// The diff row shape mirrors the engine patch
// engine-patches/agent_cmds/document_diff.rs (row: layer_id/name/kind/
// bounds_from/bounds_to/props_changed; moved rows add parent_from/parent_to/
// order_from/order_to). props_changed names the engine's inspect::layer row
// keys that differ — opacity, fill, blend, text, visible, bounds, name, …
// Wire schemas + mapping live in ./use-versions.ts; these are the domain types.

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Engine bounds row: `[x, y, width, height]` (inspect.rs surface bounds). */
export type DiffBounds = readonly [number, number, number, number];

/** One layer row of a document.diff bucket (§5.6, document_diff.rs `row()`). */
export interface DiffRow {
  readonly layerId: number;
  readonly name: string;
  readonly kind: string;
  readonly boundsFrom: DiffBounds | null;
  readonly boundsTo: DiffBounds | null;
  /** Engine layer-row keys that differ, alphabetical (BTree order). */
  readonly propsChanged: readonly string[];
  /** Moved rows only: the enclosing group's layer id, null at top level. */
  readonly parentFrom?: number | null;
  readonly parentTo?: number | null;
  readonly orderFrom?: number;
  readonly orderTo?: number;
}

/** document.diff result — the four §5.6 buckets. */
export interface DocumentDiff {
  readonly from: number;
  readonly to: number;
  readonly added: readonly DiffRow[];
  readonly removed: readonly DiffRow[];
  readonly changed: readonly DiffRow[];
  readonly moved: readonly DiffRow[];
}

/** One version timeline entry (§10.4 VersionDto, camelCase domain form). */
export interface DocumentVersion {
  readonly id: string;
  readonly revision: number;
  readonly label: string;
  readonly createdBy: string;
  readonly createdAt: Date;
}

/**
 * Bucket counts parsed out of the §6.1 compact summary the manual-commands
 * surface returns (`document.diff: added=<2 items>, …`) when full rows are
 * not exposed.
 */
export interface DiffSummaryCounts {
  readonly added?: number;
  readonly removed?: number;
  readonly changed?: number;
  readonly moved?: number;
}

/** Why a revision diff cannot be shown right now (all are graceful states). */
export type DiffUnavailableReason =
  /** The manual allowlist does not carry document.diff yet (§13.4 gate). */
  | "not_allowlisted"
  /** The engine build lacks the agent_cmds patch family (§5.6 W3-G). */
  | "engine_patch_missing"
  /** The engine only holds the current revision + an open run's checkpoint. */
  | "revision_not_held"
  /** The command ran, but the reply carries only the §6.1 compact summary. */
  | "details_not_exposed";

/** Discriminated render state the diff view consumes (never throws). */
export type DiffState =
  | { readonly status: "ok"; readonly diff: DocumentDiff }
  | {
      readonly status: "unavailable";
      readonly reason: DiffUnavailableReason;
      readonly message?: string;
      readonly hint?: string;
      readonly summaryCounts?: DiffSummaryCounts;
    }
  | {
      readonly status: "error";
      readonly message: string;
      readonly hint?: string;
      readonly retryable: boolean;
    };

/** Structural failure description handed to classifyDiffFailure (ApiError fields). */
export interface DiffFailureInput {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
}

// ---------------------------------------------------------------------------
// Timeline helpers (§10.4 ascending)
// ---------------------------------------------------------------------------

/**
 * Timeline in §10.4 order: ascending by revision (the gateway already
 * returns ascending — this defensively enforces the invariant the UI relies
 * on, immutably, stable for equal revisions).
 */
export function sortVersionsAscending(
  versions: readonly DocumentVersion[],
): readonly DocumentVersion[] {
  return [...versions].sort((a, b) => a.revision - b.revision);
}

/** The head revision (highest) or null for an empty timeline. */
export function currentRevisionOf(versions: readonly DocumentVersion[]): number | null {
  if (versions.length === 0) {
    return null;
  }
  let highest = versions[0]?.revision ?? 0;
  for (const version of versions) {
    if (version.revision > highest) {
      highest = version.revision;
    }
  }
  return highest;
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Deterministic UTC stamp ("4 Jul 2026, 14:03 UTC"). Manual formatting — no
 * Intl locale dependence — so the server-rendered markup always matches the
 * client hydration pass (W8-A dashboard-view precedent).
 */
export function formatVersionDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const month = MONTHS_SHORT[date.getUTCMonth()] ?? "?";
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}, ${hours}:${minutes} UTC`;
}

/**
 * The wire carries creator ids, not names (§13.1 has no user-lookup for
 * arbitrary ids — comments wave precedent). Show a short, non-identifying
 * slice; the full id rides in the title attribute.
 */
export function shortenAuthorId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

// ---------------------------------------------------------------------------
// Diff helpers (§5.6)
// ---------------------------------------------------------------------------

/** The r{n} → r{n} diff of one revision against itself: all buckets empty. */
export function emptyDiff(revision: number): DocumentDiff {
  return { from: revision, to: revision, added: [], removed: [], changed: [], moved: [] };
}

/** True when every bucket is empty — the "nothing was silently destroyed" shape. */
export function diffIsEmpty(diff: DocumentDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.moved.length === 0
  );
}

/**
 * One-line bucket summary ("2 added · 1 removed · 3 changed · 1 moved");
 * null when the diff is empty (the caller renders the empty state instead).
 */
export function summarizeDiffCounts(diff: DocumentDiff): string | null {
  const parts: string[] = [];
  for (const entry of [
    ["added", diff.added.length],
    ["removed", diff.removed.length],
    ["changed", diff.changed.length],
    ["moved", diff.moved.length],
  ] as const) {
    if (entry[1] > 0) {
      parts.push(`${entry[1]} ${entry[0]}`);
    }
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** A layer group inside one bucket: rows share a display name (by layer id order). */
export interface DiffLayerGroup {
  readonly key: string;
  readonly name: string;
  readonly rows: readonly DiffRow[];
}

/**
 * Groups one bucket's rows by layer name, preserving the engine's layer-id
 * order (BTree, document_diff.rs) for first appearance. Duplicate names
 * (e.g. two "Background" layers) collapse into one group so the timeline
 * reads as chips per layer name, not per id.
 */
export function groupDiffRowsByLayerName(rows: readonly DiffRow[]): readonly DiffLayerGroup[] {
  const groups: DiffLayerGroup[] = [];
  const indexByName = new Map<string, number>();
  for (const row of rows) {
    const existing = indexByName.get(row.name);
    if (existing === undefined) {
      indexByName.set(row.name, groups.length);
      groups.push({ key: row.name, name: row.name, rows: [row] });
    } else {
      const group = groups[existing];
      if (group === undefined) {
        continue;
      }
      groups[existing] = { ...group, rows: [...group.rows, row] };
    }
  }
  return groups;
}

/** Bounds as a compact readable pair: `12, 40 · 44×60` (or `—` when absent). */
export function formatBounds(bounds: DiffBounds | null): string {
  if (bounds === null) {
    return "—";
  }
  return `${bounds[0]}, ${bounds[1]} · ${bounds[2]}×${bounds[3]}`;
}

function describeParent(parent: number | null | undefined): string {
  return parent === null || parent === undefined ? "top level" : `group ${parent}`;
}

/**
 * Move details for a moved row (tree-position change only — pure geometry is
 * a property change, document_diff.rs): parent move and/or reorder, phrased
 * for chips.
 */
export function movedRowDetails(row: DiffRow): readonly string[] {
  const details: string[] = [];
  if (
    row.parentFrom !== undefined &&
    row.parentTo !== undefined &&
    row.parentFrom !== row.parentTo
  ) {
    details.push(`${describeParent(row.parentFrom)} → ${describeParent(row.parentTo)}`);
  }
  if (row.orderFrom !== undefined && row.orderTo !== undefined && row.orderFrom !== row.orderTo) {
    details.push(`position ${row.orderFrom + 1} → ${row.orderTo + 1}`);
  }
  return details;
}

/** Friendly label for an engine layer-row key (unknown keys pass through). */
const PROP_LABELS: Readonly<Record<string, string>> = {
  blend: "blend mode",
  bounds: "bounds",
  clipped: "clipping",
  expanded: "expansion",
  fill: "fill",
  hasMask: "mask",
  hasVectorMask: "vector mask",
  kind: "layer type",
  labelColor: "label colour",
  linkGroup: "link group",
  name: "name",
  opacity: "opacity",
  text: "text",
  vectorMaskEnabled: "vector mask",
  visible: "visibility",
};

export function propLabel(prop: string): string {
  return PROP_LABELS[prop] ?? prop;
}

// ---------------------------------------------------------------------------
// Failure classification (§6.1 actionable errors → graceful UI states)
// ---------------------------------------------------------------------------

/**
 * Maps one typed transport failure to a DiffState. Feature-gap failures
 * become "unavailable" with reason-specific copy; everything else is an
 * actionable error (message + hint + retryable ride through verbatim — the
 * server already made them user-safe, §13.3).
 */
export function classifyDiffFailure(input: DiffFailureInput): DiffState {
  const base = { message: input.message, hint: input.hint };
  if (input.code === "command_not_allowlisted") {
    // §13.4: manual execution accepts the §2.2 allowlist only; document.diff
    // is an engine-patch command (W3-G) and joins the allowlist in its wave.
    return { status: "unavailable", reason: "not_allowlisted", ...base };
  }
  if (input.code === "engine_command_failed") {
    if (input.message.includes("revision")) {
      // e.g. "revision_out_of_range: revision 41 is unknown; valid revisions are 1..14"
      return { status: "unavailable", reason: "revision_not_held", ...base };
    }
    if (
      input.message.includes("not available right now") ||
      input.message.includes("unknown command")
    ) {
      // Engine's Disabled wire string: the patch family isn't registered.
      return { status: "unavailable", reason: "engine_patch_missing", ...base };
    }
    return { status: "error", retryable: true, ...base };
  }
  if (input.code === "engine_session_unavailable" || input.code === "network_error") {
    return { status: "error", retryable: true, ...base };
  }
  return { status: "error", retryable: input.retryable, ...base };
}

/** Heading for the unavailable panel — the pinned graceful copy (§5.6 hints). */
export function diffUnavailableHeading(reason: DiffUnavailableReason): string {
  if (reason === "engine_patch_missing" || reason === "not_allowlisted") {
    return "Diff unavailable (engine patch required)";
  }
  return "Diff unavailable";
}

/** Reason-specific body; the view appends the server's message + hint below. */
export function diffUnavailableBody(reason: DiffUnavailableReason): string {
  switch (reason) {
    case "not_allowlisted":
      return "Revision diffs aren’t switched on in this build yet — the command that computes them hasn’t been cleared for manual use.";
    case "engine_patch_missing":
      return "The editor engine serving this document doesn’t provide revision diffs yet.";
    case "revision_not_held":
      return "The engine can only compare revisions it still holds: the current one and, while a run is open, that run’s starting checkpoint. Older versions can’t be compared layer-by-layer yet.";
    case "details_not_exposed":
      return "The diff ran, but this build only returns a summary — layer-by-layer details aren’t carried over the wire yet.";
  }
}

/**
 * Parses bucket counts out of a §6.1 compact summary line
 * (`document.diff: from=41, to=46, added=<2 items>, …`). Missing buckets are
 * simply absent from the result; a summary without counts yields `{}`.
 */
export function parseSummaryBucketCounts(summary: string): DiffSummaryCounts {
  const counts: { added?: number; removed?: number; changed?: number; moved?: number } = {};
  const pattern = /\b(added|removed|changed|moved)=<(\d+) items>/g;
  for (const match of summary.matchAll(pattern)) {
    const bucket = match[1] as "added" | "removed" | "changed" | "moved";
    const parsed = Number.parseInt(match[2] ?? "0", 10);
    counts[bucket] = Number.isNaN(parsed) ? 0 : parsed;
  }
  return counts;
}
