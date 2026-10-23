"use client";

/**
 * Diff card (W1-d) — the EDITOR_CHAT_UX §6.3 "semantic diff, not a text diff"
 * (AUD-3 gap 1): per-property old → new rows derived from the plan's SERVER-
 * compiled batch, grouped by layer, with +/− rows for added/removed things.
 *
 *   Headline
 *     text/sourceText   Studio      → New headline
 *     transform/scale   100         → keyframed (20 @ 0s, 110 @ 0.45s)
 *     Name              Headline   → Subtitle
 *   + Badge            Text layer "New"
 *
 * Derivation (pure, exported for tests): `derivePlanDiff` walks the compiled
 * `engine.batch` steps over the CURATED command vocabulary the plan compiler
 * emits (prop.set / prop.addKey / layer.rename / layer.newText|newSolid|
 * newNull|newAdjustment / effect.apply / anim.applyBuiltinPreset / comp.new —
 * services/gateway/src/plan-compiler.ts) plus a bounded generic fallback, so
 * ANY wire-valid batch derives an honest diff. Layer refs on the wire are
 * layer NAMES (the compiler keeps names), resolved numeric ids, or the pinned
 * `$request:<id>` placeholder tokens (§8.7) — tokens display via the plan's
 * resolutionRequests.
 *
 * OLD VALUES ("before") come from the LIVE editor through the existing chat
 * context surface (`lib/chat/context.ts` `collectOldPropertyValues`: ONE
 * `comp.info` + `prop.get` per pair, read-only). The card mounts only while
 * the plan is PROPOSED, so what it reads IS the pre-change state; once
 * applied/undone the card unmounts and never shows a stale before-value.
 * An unreadable old value renders "—" — never a guess.
 *
 * Safety (M4-N posture): every batch field is UNTRUSTED model output. All
 * derivation is bounded (groups/rows/keys caps, truncated value strings) and
 * total (never throws on hostile shapes); everything renders as React-escaped
 * text with `dir="auto"`, truncating safely. Styling is tokens-only
 * (packages/ui; no raw hex — law #8). No live regions (thread.tsx §9.2 owns
 * announcing).
 */

import { collectOldPropertyValues, type OldValueRequest, type OldValueResult } from "@/lib/chat/context";
import type { AgentBatchInput, EditorBridge } from "@studio/editor-bridge";
import { type ReactElement, useEffect, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Model (the derived diff)
// ---------------------------------------------------------------------------

export type PlanDiffRowKind = "set" | "rename" | "keyframe" | "generic";

/** One proposed keyframe of a {@link PlanDiffRow} ("keyframe" kind). */
export interface PlanDiffKey {
  /** Key time in seconds (engine layer-time; display-only). */
  readonly time?: unknown;
  readonly value?: unknown;
}

export interface PlanDiffRow {
  /** Group-local derivation key (stable per batch content; the React key). */
  readonly key: string;
  readonly kind: PlanDiffRowKind;
  /** Display label: the property path, or "Name"/"Effect"/"Layer"/…. */
  readonly path: string;
  /** +/− affordance rows (§6.3 "for added/removed layers, use +/− rows"). */
  readonly sign?: "+" | "−";
  /** The raw layer ref this row's before-value must be read for. */
  readonly layerRef?: number | string;
  /** The property path to read the before-value from (set/keyframe rows). */
  readonly propPath?: string;
  /** Known-by-construction before (rename rows: the current layer name). */
  readonly before?: unknown;
  /** The proposed new value. */
  readonly after?: unknown;
  /** Keyframes of a "keyframe" row (capped; `moreKeyCount` says the rest). */
  readonly keys?: readonly PlanDiffKey[];
  readonly moreKeyCount?: number;
}

export interface PlanDiffGroup {
  /** The raw layer ref — the grouping identity (stable across async reads). */
  readonly ref: number | string;
  /** Display label (tokens resolved; numeric refs show "layer N" until the read lands). */
  readonly label: string;
  readonly rows: readonly PlanDiffRow[];
}

export interface PlanDiff {
  readonly groups: readonly PlanDiffGroup[];
  /** Rows/groups hidden by the display bounds — rendered as "+ N more". */
  readonly hiddenCount: number;
}

// ---------------------------------------------------------------------------
// Bounds (hostile batches are DATA: every walk is bounded)
// ---------------------------------------------------------------------------

const MAX_GROUPS = 60;
const MAX_ROWS_PER_GROUP = 30;
const MAX_KEYFRAME_KEYS = 12;
const MAX_VALUE_CHARS = 48;
const MAX_JSON_CHARS = 72;

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

/** A `$request:`-token lookup map built from the plan's resolution requests. */
type TokenNames = ReadonlyMap<string, string>;

function displayRef(ref: number | string, tokens: TokenNames): string {
  if (typeof ref === "number") return `layer ${ref}`;
  if (ref.startsWith("$request:")) {
    return tokens.get(ref.slice("$request:".length)) ?? ref;
  }
  return ref;
}

/** Is this param value a usable layer ref (name / id / token)? */
function isLayerRef(value: unknown): value is number | string {
  return typeof value === "number" || (typeof value === "string" && value.length > 0);
}

/**
 * The layer refs a command's params address: `layers` (array or single) or
 * `layer` — the two param spellings the curated registry uses. Order-stable.
 */
function layerRefsOf(params: Record<string, unknown>): readonly (number | string)[] {
  const out: Array<number | string> = [];
  const layers = params.layers;
  if (Array.isArray(layers)) {
    for (const entry of layers) {
      if (isLayerRef(entry) && !out.includes(entry)) out.push(entry);
    }
  } else if (isLayerRef(layers)) {
    out.push(layers);
  }
  const layer = params.layer;
  if (isLayerRef(layer) && !out.includes(layer)) out.push(layer);
  return out;
}

/** Bounded compact JSON for generic rows (hostile values truncate, never throw). */
function compactParams(params: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(params) ?? "{}";
    return text.length > MAX_JSON_CHARS ? `${text.slice(0, MAX_JSON_CHARS)}…` : text;
  } catch {
    return "{}";
  }
}

/**
 * One mutable group accumulator; `derivePlanDiff` freezes them into the
 * result. Rows are keyed (merges land in `byPath`, order in `rowKeys`).
 */
interface GroupAcc {
  readonly ref: number | string;
  readonly label: string;
  readonly byPath: Map<string, PlanDiffRow>;
  readonly rowKeys: string[];
  rowLimitHit: boolean;
}

/**
 * Derive the §6.3 semantic diff from the compiled batch. Pure, total and
 * deterministic: hostile or unrecognized steps degrade to bounded generic
 * rows, merges are last-write-wins for `prop.set` (the semantic FINAL value)
 * and append-capped for `prop.addKey`, and the display bounds cap both
 * breadth and depth (`hiddenCount` is reported, never silently dropped).
 */
export function derivePlanDiff(
  batch: AgentBatchInput,
  resolutionRequests?: readonly { readonly requestId: string; readonly layerName: string }[] | null,
): PlanDiff {
  const tokens: TokenNames = new Map(
    (resolutionRequests ?? []).map((request) => [request.requestId, request.layerName]),
  );

  const groups = new Map<number | string, GroupAcc>();
  let hiddenCount = 0;
  let rawRowCount = 0;

  const groupFor = (ref: number | string): GroupAcc | null => {
    if (groups.size >= MAX_GROUPS && !groups.has(ref)) {
      hiddenCount += 1; // a whole group over the breadth cap — reported, not rendered
      return null;
    }
    let acc = groups.get(ref);
    if (acc === undefined) {
      acc = {
        ref,
        label: displayRef(ref, tokens),
        byPath: new Map<string, PlanDiffRow>(),
        rowKeys: [],
        rowLimitHit: false,
      };
      groups.set(ref, acc);
    }
    return acc;
  };

  /** Append/merge one row into its group, honoring the per-group row cap. */
  const putRow = (
    ref: number | string,
    key: string,
    make: (existing: PlanDiffRow | undefined) => Omit<PlanDiffRow, "key">,
  ): void => {
    const group = groupFor(ref);
    if (group === null) return;
    const existing = group.byPath.get(key);
    if (existing !== undefined) {
      group.byPath.set(key, { key, ...make(existing) });
      return;
    }
    if (group.rowKeys.length >= MAX_ROWS_PER_GROUP) {
      if (!group.rowLimitHit) group.rowLimitHit = true;
      hiddenCount += 1;
      return;
    }
    const row = { key, ...make(undefined) };
    group.byPath.set(key, row);
    group.rowKeys.push(key);
  };

  const steps = Array.isArray(batch?.steps) ? batch.steps : [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const command = typeof step.command === "string" ? step.command : "";
    const params =
      typeof step.params === "object" && step.params !== null && !Array.isArray(step.params)
        ? (step.params as Record<string, unknown>)
        : {};
    const path = typeof params.path === "string" && params.path !== "" ? params.path : undefined;
    const propPath = path ?? (typeof params.prop === "string" ? params.prop : undefined);

    switch (command) {
      case "prop.set": {
        for (const ref of layerRefsOf(params)) {
          const rowKey = `set:${propPath ?? ""}`;
          putRow(ref, rowKey, (existing) => ({
            ...(existing ?? {}),
            kind: "set",
            path: propPath ?? "(property)",
            layerRef: ref,
            propPath,
            after: "value" in params ? params.value : undefined,
          }));
        }
        break;
      }
      case "prop.addKey": {
        for (const ref of layerRefsOf(params)) {
          const rowKey = `keys:${propPath ?? ""}`;
          const key: PlanDiffKey = {
            ...(typeof params.time === "number" ? { time: params.time } : {}),
            ...("value" in params ? { value: params.value } : {}),
          };
          putRow(ref, rowKey, (existing) => {
            if (existing === undefined || existing.kind !== "keyframe") {
              return {
                kind: "keyframe",
                path: propPath ?? "(property)",
                layerRef: ref,
                propPath,
                keys: [key],
              };
            }
            const keys = [...(existing.keys ?? [])];
            if (keys.length < MAX_KEYFRAME_KEYS) {
              keys.push(key);
              return { ...existing, keys };
            }
            return { ...existing, moreKeyCount: (existing.moreKeyCount ?? 0) + 1 };
          });
        }
        break;
      }
      case "layer.rename": {
        for (const ref of layerRefsOf(params)) {
          putRow(ref, "rename", () => ({
            kind: "rename",
            path: "Name",
            layerRef: ref,
            before: displayRef(ref, tokens),
            after: typeof params.name === "string" ? params.name : undefined,
          }));
        }
        break;
      }
      case "layer.newText":
      case "layer.newSolid":
      case "layer.newNull":
      case "layer.newAdjustment": {
        const kindLabel =
          command === "layer.newText"
            ? "Text layer"
            : command === "layer.newSolid"
              ? "Solid layer"
              : command === "layer.newNull"
                ? "Null layer"
                : "Adjustment layer";
        const name = typeof params.name === "string" && params.name !== "" ? params.name : undefined;
        const text = typeof params.text === "string" && params.text !== "" ? params.text : undefined;
        const label = name ?? text ?? "(new layer)";
        rawRowCount += 1;
        putRow(label, `raw:${rawRowCount}`, () => ({
          kind: "generic",
          path: kindLabel,
          sign: "+",
          after: text ?? name,
        }));
        break;
      }
      case "comp.new": {
        rawRowCount += 1;
        putRow("(composition)", `raw:${rawRowCount}`, () => ({
          kind: "generic",
          path: "Composition",
          sign: "+",
          after: typeof params.name === "string" ? params.name : undefined,
        }));
        break;
      }
      case "effect.apply":
      case "effect.remove": {
        for (const ref of layerRefsOf(params)) {
          putRow(ref, `effect:${command}`, () => ({
            kind: "generic",
            path: "Effect",
            sign: command === "effect.apply" ? "+" : "−",
            after: typeof params.effect === "string" ? params.effect : undefined,
          }));
        }
        break;
      }
      case "anim.applyBuiltinPreset": {
        for (const ref of layerRefsOf(params)) {
          putRow(ref, "preset", () => ({
            kind: "generic",
            path: "Preset",
            after: typeof params.preset === "string" ? params.preset : undefined,
          }));
        }
        break;
      }
      case "layer.style.add":
      case "layer.style.remove": {
        for (const ref of layerRefsOf(params)) {
          putRow(ref, `style:${command}`, () => ({
            kind: "generic",
            path: "Style",
            sign: command === "layer.style.add" ? "+" : "−",
            after: typeof params.style === "string" ? params.style : undefined,
          }));
        }
        break;
      }
      case "layer.setBlendMode": {
        for (const ref of layerRefsOf(params)) {
          putRow(ref, "blend", () => ({
            kind: "generic",
            path: "Blend mode",
            after: typeof params.mode === "string" ? params.mode : undefined,
          }));
        }
        break;
      }
      case "layer.setText": {
        for (const ref of layerRefsOf(params)) {
          putRow(ref, "text", () => ({
            kind: "generic",
            path: "Text",
            after: typeof params.text === "string" ? params.text : undefined,
          }));
        }
        break;
      }
      case "edit.undo": {
        rawRowCount += 1;
        putRow("(history)", `raw:${rawRowCount}`, () => ({
          kind: "generic",
          path: "Undo",
          after: "the most recent applied agent batch",
        }));
        break;
      }
      default: {
        // Bounded honest fallback: any other registry/unknown command is one
        // "Other change" row on the layers it addresses (or the project).
        const refs = layerRefsOf(params);
        rawRowCount += 1;
        const makeRow = (): Omit<PlanDiffRow, "key"> => ({
          kind: "generic",
          path: "Other change",
          after: compactParams(params),
        });
        if (refs.length === 0) {
          putRow("(project)", `raw:${rawRowCount}`, makeRow);
        } else {
          for (const ref of refs) {
            putRow(ref, `raw:${rawRowCount}:${typeof ref === "number" ? ref : ref}`, makeRow);
          }
        }
        break;
      }
    }
  }

  return {
    groups: [...groups.values()].map((group) => ({
      ref: group.ref,
      label: group.label,
      rows: group.rowKeys.map((key) => group.byPath.get(key)).filter((row): row is PlanDiffRow => row !== undefined),
    })),
    hiddenCount,
  };
}

// ---------------------------------------------------------------------------
// Value formatting (display-only, bounded)
// ---------------------------------------------------------------------------

/** Human-safe display text for a before/after value; "—" when unknown. */
function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : String(value);
  }
  if (typeof value === "string") {
    return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value;
  }
  try {
    const text = JSON.stringify(value) ?? "—";
    return text.length > MAX_JSON_CHARS ? `${text.slice(0, MAX_JSON_CHARS)}…` : text;
  } catch {
    return "—";
  }
}

/** "20 @ 0s, 110 @ 0.45s" — the §6.3 keyframe note (times are seconds). */
function formatKeys(row: PlanDiffRow): string | undefined {
  const keys = row.keys ?? [];
  if (keys.length === 0) return undefined;
  const parts = keys.map((key) => {
    const value = formatValue(key.value);
    if (typeof key.time === "number" && Number.isFinite(key.time)) {
      return `${value} @ ${key.time}s`;
    }
    return value;
  });
  const more =
    row.moreKeyCount !== undefined && row.moreKeyCount > 0 ? `, +${row.moreKeyCount} more` : "";
  return `(keyframed: ${parts.join(", ")}${more})`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PlanDiffCardProps {
  /** The server-compiled §8.5 agent batch (untrusted data; derived, never executed). */
  readonly batch: AgentBatchInput;
  /** Optional bridge — with it, before-values are READ from the live (pre-apply) editor. */
  readonly bridge?: EditorBridge;
  /** The plan's layer-resolution requests (`$request:` token → display name). */
  readonly resolutionRequests?: readonly { readonly requestId: string; readonly layerName: string }[] | null;
}

/** The (layer, path) reads a diff needs — one per distinct set/keyframe row. */
function oldValueRequestsOf(diff: PlanDiff): readonly OldValueRequest[] {
  const out: OldValueRequest[] = [];
  for (const group of diff.groups) {
    for (const row of group.rows) {
      if (row.layerRef === undefined || row.propPath === undefined) continue;
      if (row.kind !== "set" && row.kind !== "keyframe") continue;
      if (out.some((r) => r.layer === row.layerRef && r.path === row.propPath)) continue;
      out.push({ layer: row.layerRef, path: row.propPath });
    }
  }
  return out;
}

/** Stable content identity for the batch prop (plan events arrive as fresh literals). */
function batchKeyOf(batch: AgentBatchInput): string {
  try {
    return JSON.stringify(batch) ?? "";
  } catch {
    return "";
  }
}

export function PlanDiffCard({ batch, bridge, resolutionRequests }: PlanDiffCardProps): ReactElement {
  const batchKey = useMemo(() => batchKeyOf(batch), [batch]);
  const diff = useMemo(
    () => derivePlanDiff(batch, resolutionRequests),
    // batchKey is the content identity; resolutionRequests ride the same event.
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-deriving on a fresh batch literal with identical content would churn the old-value reads; the key pins the identity
    [batchKey, resolutionRequests],
  );

  // Before-values: read ONCE per batch content while the plan is proposed.
  const [reads, setReads] = useState<ReadonlyMap<string, OldValueResult> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: diff is memoized on batchKey; requests derive from it deterministically
  useEffect(() => {
    if (bridge === undefined) return;
    const requests = oldValueRequestsOf(diff);
    if (requests.length === 0) return;
    let cancelled = false;
    void collectOldPropertyValues(bridge, requests)
      .then((results) => {
        if (cancelled) return;
        setReads(
          new Map(
            results.map((result) => [
              `${typeof result.layer}:${String(result.layer)}\u0000${result.path}`,
              result,
            ]),
          ),
        );
      })
      .catch(() => undefined); // never throws; a failed read just leaves "—"
    return () => {
      cancelled = true;
    };
  }, [bridge, diff]);

  const readOf = (row: PlanDiffRow): OldValueResult | undefined =>
    row.layerRef !== undefined && row.propPath !== undefined
      ? reads?.get(`${typeof row.layerRef}:${String(row.layerRef)}\u0000${row.propPath}`)
      : undefined;
  return (
    <div data-testid="plan-diff-card" className="flex flex-col gap-1">
      <p data-testid="plan-diff-title" className="text-caption text-muted">
        Changes
      </p>
      {diff.groups.map((group) => {
        // A numeric ref's display upgrades to the layer's real name once a
        // read resolves it; tokens/names already display correctly.
        const namedRow = group.rows.find((row) => readOf(row)?.layerName !== undefined);
        const label = namedRow !== undefined ? readOf(namedRow)?.layerName : undefined;
        return (
          <div key={`${typeof group.ref}:${String(group.ref)}`} data-testid="plan-diff-group">
            <p
              data-testid="plan-diff-layer"
              dir="auto"
              title={group.label}
              className="min-w-0 truncate text-caption font-medium text-primary"
            >
              {label ?? group.label}
            </p>
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {group.rows.map((row) => {
                const read = readOf(row);
                const beforeText =
                  row.kind === "set" || row.kind === "keyframe"
                    ? (read !== undefined && read.known ? formatValue(read.value) : "—")
                    : formatValue(row.before);
                const afterText = row.kind === "keyframe" ? "keyframed" : formatValue(row.after);
                const keysNote = formatKeys(row);
                return (
                  <li
                    key={row.key}
                    data-testid="plan-diff-row"
                    data-kind={row.kind}
                    data-sign={row.sign ?? ""}
                    className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0 text-caption"
                  >
                    {row.sign !== undefined ? (
                      <span
                        aria-hidden="true"
                        className={`shrink-0 font-bold ${row.sign === "+" ? "text-success" : "text-danger"}`}
                      >
                        {row.sign}
                      </span>
                    ) : null}
                    {/* Untrusted path — data, RTL-iso, truncates safely. */}
                    <span
                      data-testid="plan-diff-path"
                      dir="auto"
                      title={row.path}
                      className="min-w-0 max-w-[26ch] shrink-0 truncate font-medium text-secondary"
                    >
                      {row.path}
                    </span>
                    {row.sign === undefined && row.kind !== "generic" ? (
                      <>
                        <span
                          data-testid="plan-diff-before"
                          dir="auto"
                          title={beforeText}
                          className="min-w-0 max-w-[24ch] truncate font-mono text-muted"
                        >
                          {beforeText}
                        </span>
                        <span aria-hidden="true" className="shrink-0 text-muted">
                          →
                        </span>
                      </>
                    ) : null}
                    <span
                      data-testid="plan-diff-after"
                      dir="auto"
                      title={afterText}
                      className="min-w-0 flex-1 truncate font-mono text-primary"
                    >
                      {afterText}
                    </span>
                    {keysNote !== undefined ? (
                      <span
                        data-testid="plan-diff-keys"
                        dir="auto"
                        className="w-full font-mono text-muted"
                      >
                        {keysNote}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {diff.hiddenCount > 0 ? (
        <p data-testid="plan-diff-more" className="text-caption text-muted">
          + {diff.hiddenCount} more change{diff.hiddenCount === 1 ? "" : "s"} not shown
        </p>
      ) : null}
    </div>
  );
}
