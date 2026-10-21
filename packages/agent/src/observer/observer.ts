// @studio/agent/observer/observer — §5.1 "observe after act". Owner: W6-C.
// Tests: tests/observer.test.ts.
//
// Spec anchors:
//   §5.1  "Observe after act": after each execution phase the loop renders a
//         ≤1024 px PNG and feeds ONLY that downscaled render (+ the layer
//         summary) to the models. This service produces that Observation for
//         the next model turn.
//   §5.4  The document summary is the FILTERED compact read — never a full
//         dump — and lives AFTER the cached prefix (items 1-3), so per-turn
//         changes (revisions, deltas) can never shift the cache prefix.
//   §5.2/§5.3  The worker wires the seams; retry/clock policy is the tool
//         wiring's job (§6.3), not this service's.
//
// SEAMS (injected; @studio/tools is NEVER imported here — tools run inside a
// ToolContext, which only the worker can construct):
//   - `SnapshotLike.compact(documentId)` — the workspace_snapshot tool's §5.4
//     compaction (§6 row 1), run by the worker inside a real ToolContext. The
//     pinned minimal wiring returns the tool's `summary` string; a richer
//     adapter may return the envelope `{ summary, revision?, warnings? }`
//     (the tool's ok envelope carries `documentRevision`) — read defensively.
//   - `PreviewLike.render(documentId)` — the render_preview persist path
//     (§6 row 14 / the worker's preview pipeline): renders + persists a
//     ≤1024 px PNG and returns its url (http(s):// or root-relative, §6.1)
//     plus the optional revision. A preview failure DEGRADES to a warning —
//     the next model turn just gets no render; the worker owns the policy.
//
// DELTA MODE (§5.4 token discipline): after the first observation of a
// document, subsequent turns emit ONLY the layers that changed since the
// previous observation (+ counts) instead of the full summary — cheaper
// context. The delta is computed by diffing the two compact summaries (both
// carry id-sorted layer rows), so no extra engine round-trip and no new seam.
// Either way the §5.4 cached prefix (items 1-3) is unaffected by
// construction — the summary rides in section 4 (see context.ts).
import { type AgentResult, agentErr, agentOk } from "../errors.js";
import {
  DOC_SUMMARY_CHAR_BUDGET,
  type Rec,
  asRecord,
  canonicalStringify,
  capText,
  compareLayerIds,
  finalizeWarnings,
  isSafeContextUrl,
  readCanvas,
  readLayerId,
  readRevision,
} from "./context.js";

// ---------------------------------------------------------------------------
// Seams (worker-wired; see the file header)
// ---------------------------------------------------------------------------

/** The workspace_snapshot tool's compaction result (defensive union). */
export interface SnapshotReport {
  /** The §5.4-filtered compact summary JSON (the tool's `summary`). */
  readonly summary: string;
  /** The engine revision the summary was taken at (`documentRevision`). */
  readonly revision?: number;
  readonly warnings?: readonly string[];
}

/**
 * The workspace_snapshot compactor seam. The minimal wiring is exactly the
 * pinned shape `compact(documentId): Promise<string>` (the tool's summary
 * string); richer adapters return `SnapshotReport` — both are accepted.
 */
export interface SnapshotLike {
  compact(documentId: string): Promise<string | SnapshotReport>;
}

/** The render_preview persist path result; absence of `previewUrl` = failure. */
export interface PreviewReport {
  readonly previewUrl?: string;
  readonly revision?: number;
  readonly failure?: { readonly code: string; readonly message?: string };
}

export interface PreviewLike {
  render(documentId: string): Promise<PreviewReport>;
}

export interface ObserverSeams {
  readonly snapshot: SnapshotLike;
  readonly preview: PreviewLike;
}

// ---------------------------------------------------------------------------
// Observation (what the next model turn sees)
// ---------------------------------------------------------------------------

export type ObservationMode = "full" | "delta";

/** `afterAction` mode: "auto" = full on first observation, delta afterwards. */
export type ObservationRequestMode = "auto" | ObservationMode;

export interface AfterActionOptions {
  readonly mode?: ObservationRequestMode;
}

/**
 * §5.1/§5.4: the observation handed to the next model turn.
 * `compactSummary` feeds §5.4 section 4 (assembleContext's documentSummary);
 * `previewUrl` feeds the next render/critic input.
 */
export interface Observation {
  /** Compact §5.4 document summary — full tool bytes or the delta JSON. */
  readonly compactSummary: string;
  /** The ≤1024 px render's url; absent when the preview degraded. */
  readonly previewUrl?: string;
  /** The observed engine revision (snapshot first, then preview, then prior). */
  readonly revision?: number;
  /** "full" on first observation / explicit request; "delta" afterwards. */
  readonly mode: ObservationMode;
  /** §22-safe: counts and codes only, never content. */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Pure delta machinery (diffing compact summaries)
// ---------------------------------------------------------------------------

/** Parsed from a compact summary JSON — only the fields delta mode needs. */
export interface ParsedSummary {
  readonly layers?: readonly unknown[];
  readonly canvas?: { readonly widthPx: number; readonly heightPx: number };
}

/** Parses a compact summary's JSON. Never throws; undefined = unparseable. */
export function parseSummary(text: string): ParsedSummary | undefined {
  try {
    const record = asRecord(JSON.parse(text) as unknown);
    if (record === undefined) return undefined;
    const out: { layers?: readonly unknown[]; canvas?: { widthPx: number; heightPx: number } } = {};
    if (Array.isArray(record.layers)) out.layers = record.layers;
    const canvas = readCanvas(record.canvas);
    if (canvas !== undefined) out.canvas = canvas;
    return out;
  } catch {
    return undefined;
  }
}

interface TrackedLayerRow {
  readonly id: string;
  readonly row: Rec;
  /** Canonical row bytes — the comparison key (any field change counts). */
  readonly json: string;
}

interface TrackedRows {
  readonly rows: readonly TrackedLayerRow[];
  readonly skipped: number;
}

function trackRows(value: readonly unknown[] | undefined): TrackedRows {
  if (!Array.isArray(value)) return { rows: [], skipped: 0 };
  const rows: TrackedLayerRow[] = [];
  let skipped = 0;
  for (const raw of value) {
    const row = asRecord(raw);
    const id = row === undefined ? undefined : readLayerId(row.layerId ?? row.id);
    if (row === undefined || id === undefined) {
      skipped += 1; // id-less rows are untrackable, never guessed
      continue;
    }
    rows.push({ id, row, json: canonicalStringify(row) });
  }
  rows.sort((a, b) => compareLayerIds(a.id, b.id)); // §5.4 stable ordering
  return { rows, skipped };
}

/** Pure layer delta between two compact summaries' tracked rows. */
export interface LayerDelta {
  /** Rows present now but not before (current rows, id order). */
  readonly added: readonly Rec[];
  /** Rows whose canonical bytes changed (current rows, id order). */
  readonly changed: readonly Rec[];
  /** Ids that disappeared (id order). */
  readonly removed: readonly string[];
  /** Rows identical in both observations. */
  readonly unchanged: number;
  /** Tracked rows in the current summary. */
  readonly total: number;
  /** Malformed rows dropped while tracking (untrackable). */
  readonly skipped: number;
}

/** Diffs two compact summaries' layer rows; pure and deterministic. */
export function diffLayers(
  previous: readonly unknown[] | undefined,
  current: readonly unknown[],
): LayerDelta {
  const before = trackRows(previous);
  const after = trackRows(current);
  const beforeById = new Map(before.rows.map((row) => [row.id, row] as const));
  const afterById = new Map(after.rows.map((row) => [row.id, row] as const));
  const added: Rec[] = [];
  const changed: Rec[] = [];
  let unchanged = 0;
  for (const row of after.rows) {
    const prior = beforeById.get(row.id);
    if (prior === undefined) added.push(row.row);
    else if (prior.json !== row.json) changed.push(row.row);
    else unchanged += 1;
  }
  const removed: string[] = [];
  for (const prior of before.rows) {
    if (!afterById.has(prior.id)) removed.push(prior.id);
  }
  return {
    added,
    changed,
    removed,
    unchanged,
    total: after.rows.length,
    skipped: before.skipped + after.skipped,
  };
}

/**
 * The delta-mode document summary: only changed/added rows + counts, canonical
 * bytes (stable key order). Cheaper context, same stable §5.4 prefix — this
 * content rides in section 4, after the cached prefix.
 */
export function buildDeltaSummary(
  delta: LayerDelta,
  meta: { revision?: number; canvas?: { readonly widthPx: number; readonly heightPx: number } },
): string {
  const payload: Record<string, unknown> = {
    delta: {
      added: delta.added,
      changed: delta.changed,
      removed: delta.removed,
      unchanged: delta.unchanged,
      total: delta.total,
    },
  };
  if (meta.revision !== undefined) payload.revision = meta.revision;
  if (meta.canvas !== undefined) payload.canvas = meta.canvas;
  return canonicalStringify(payload);
}

function readWarnings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.filter((row): row is string => typeof row === "string");
  return rows.length > 0 ? rows : undefined;
}

// ---------------------------------------------------------------------------
// ObserverService
// ---------------------------------------------------------------------------

interface PriorObservation {
  readonly revision?: number;
  readonly layers: readonly unknown[] | undefined;
}

/**
 * §5.1 "observe after act": the worker calls `afterAction(documentId)` after
 * each execution phase and feeds the returned Observation to the next model
 * turn. One instance per run (the worker owns it); per-document observation
 * memory enables DELTA mode. No engine/tools imports — everything arrives via
 * the injected seams.
 */
export class ObserverService {
  private readonly seams: ObserverSeams;
  private readonly priorByDocument = new Map<string, PriorObservation>();

  constructor(seams: ObserverSeams) {
    this.seams = seams;
  }

  /**
   * Observes a document for the next model turn. Fails (typed envelope, never
   * a throw) only when the compact read is unusable — the snapshot seam owns
   * engine retries (§6.3); a rejection here means the document is unreadable.
   */
  async afterAction(
    documentId: string,
    options: AfterActionOptions = {},
  ): Promise<AgentResult<Observation>> {
    const read = await this.readSnapshot(documentId);
    if (!read.ok) return read;
    const warnings: string[] = [...(read.value.warnings ?? [])];

    // Preview degrades to a warning — never stalls the observe loop.
    const preview = await this.readPreview(documentId, warnings);

    const prior = this.priorByDocument.get(documentId);
    const parsed = parseSummary(read.value.summary);
    const revision =
      readRevision(read.value.revision) ?? readRevision(preview?.revision) ?? prior?.revision;

    const requested: ObservationMode =
      options.mode === "full" || options.mode === "delta"
        ? options.mode
        : prior === undefined
          ? "full"
          : "delta";

    const canDelta =
      prior !== undefined &&
      parsed !== undefined &&
      prior.layers !== undefined &&
      parsed.layers !== undefined;

    let mode: ObservationMode = requested;
    let compactSummary = read.value.summary;
    if (requested === "delta" && !canDelta) {
      mode = "full";
      warnings.push(
        prior === undefined
          ? "delta unavailable (no prior observation); full summary emitted"
          : "delta unavailable (summary carries no trackable layer rows); full summary emitted",
      );
    }
    if (
      mode === "delta" &&
      canDelta &&
      prior?.layers !== undefined &&
      parsed?.layers !== undefined
    ) {
      const delta = diffLayers(prior.layers, parsed.layers);
      if (delta.skipped > 0) {
        warnings.push(
          `${delta.skipped} layer row(s) untrackable (no usable id); delta may under-report changes`,
        );
      }
      compactSummary = buildDeltaSummary(delta, { revision, canvas: parsed.canvas });
    }

    const capped = capText(compactSummary, DOC_SUMMARY_CHAR_BUDGET);
    if (capped.truncated) {
      warnings.push(
        `document summary truncated from ${capped.originalChars} to ${DOC_SUMMARY_CHAR_BUDGET} chars (§5.4 budget)`,
      );
    }

    this.priorByDocument.set(documentId, {
      revision,
      layers: parsed?.layers,
    });

    return agentOk({
      compactSummary: capped.text,
      previewUrl: preview?.previewUrl,
      revision,
      mode,
      warnings: finalizeWarnings(warnings),
    });
  }

  /** True when a document has a prior observation to delta against. */
  hasObserved(documentId: string): boolean {
    return this.priorByDocument.has(documentId);
  }

  /** Clears observation memory (new run; or one document after a rollback). */
  reset(documentId?: string): void {
    if (documentId === undefined) this.priorByDocument.clear();
    else this.priorByDocument.delete(documentId);
  }

  /**
   * The compact read. A thrown rejection means the seam (worker wiring) could
   * not deliver the summary even after its own §6.3 retries — typed envelope,
   * no internals leaked (§22). A malformed seam result is a wiring bug, not
   * retryable.
   */
  private async readSnapshot(documentId: string): Promise<AgentResult<SnapshotReport>> {
    let raw: string | SnapshotReport;
    try {
      raw = await this.seams.snapshot.compact(documentId);
    } catch {
      return agentErr(
        "engine_session_lost",
        "The document could not be observed: the compact summary read failed.",
        {
          hint: "Retry once; if it repeats, stop the run cleanly (§5.2) — the session is unreadable.",
          retryable: true,
        },
      );
    }
    if (typeof raw === "string") return agentOk({ summary: raw });
    const record = asRecord(raw);
    const summary = record === undefined ? undefined : readNonEmptyString(record.summary);
    if (record === undefined || summary === undefined) {
      return agentErr(
        "engine_session_lost",
        "The document could not be observed: the compact seam returned a malformed result.",
        {
          hint: "Wire SnapshotLike.compact to the workspace_snapshot tool run: its `summary` string, or the envelope { summary, revision?, warnings? }.",
          retryable: false, // a wiring bug — retrying will not fix it
        },
      );
    }
    return agentOk({
      summary,
      revision: readRevision(record.revision),
      warnings: readWarnings(record.warnings),
    });
  }

  private async readPreview(
    documentId: string,
    warnings: string[],
  ): Promise<PreviewReport | undefined> {
    try {
      const report = await this.seams.preview.render(documentId);
      const record = asRecord(report) ?? {};
      const revision = readRevision(record.revision);
      const url = readNonEmptyString(record.previewUrl);
      const failure = asRecord(record.failure);
      if (failure !== undefined) {
        const code = typeof failure.code === "string" ? failure.code : "unknown";
        warnings.push(
          `preview unavailable (${code}); the next model turn has no render`, // code only (§22)
        );
        return revision === undefined ? undefined : { revision };
      }
      if (url === undefined) {
        warnings.push("preview unavailable (no url); the next model turn has no render");
        return revision === undefined ? undefined : { revision };
      }
      if (!isSafeContextUrl(url)) {
        warnings.push("preview url rejected (§6.1: http(s) or root-relative only); dropped");
        return revision === undefined ? undefined : { revision };
      }
      return { previewUrl: url, revision };
    } catch {
      warnings.push("preview unavailable (render failed); the next model turn has no render");
      return undefined;
    }
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
