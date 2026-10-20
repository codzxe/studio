// @studio/tools — component_list (§6 row 12; engine `component.list`, §8.3).
//
// CARD view, never a manifest dump: each row is {id, name, version, tags,
// variables} with variable NAMES ONLY — the §8.2 specs (kind, default, maxChars)
// are component.place's business (manifest inspect), not a listing's. Cards ride
// the §6.1 envelope as compact JSON in the `summary` string ({"components":[…]},
// the engine's §8.3 reply shape) because the kit's result envelopes carry a
// string summary.
//
// The ENGINE owns the filtering (component_cmds.rs `list_core`): `tags` match
// AND, lowercased; `query` is a case-insensitive substring of the id or name.
// This tool caps the arguments (§6.1: ≤12 tags, ≤120-char query), maps `problems`
// rows to warnings (a broken component never fails the list — §8.3), skips
// unreadable rows instead of fabricating cards, and keeps the reply under the
// 2000-char small-reply budget by trimming cards with a "showing K of M" note.
//
// Shared pieces (command id, reply reader, failure mapper, pin cap) are exported
// for component-place.ts, which needs candidate pins for its unknown-id error.

import { z } from "zod";
import {
  MAX_ERROR_MESSAGE_CHARS,
  MAX_HINT_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_WARNINGS,
  MAX_WARNING_CHARS,
  cappedArray,
  cappedString,
  defineTool,
  err,
  ok,
  strictObject,
} from "../kit.js";
import type {
  EngineCommandReport,
  EngineFailure,
  Tool,
  ToolErr,
  ToolErrorCode,
} from "../types.js";
import { capText } from "./template-list.js";

// ---------------------------------------------------------------------------
// Contract limits (engine component_cmds.rs caps + §6.1 tool caps)
// ---------------------------------------------------------------------------

/** The single engine command underneath (§6 row 12); the model never sees this id. */
export const COMPONENT_LIST_COMMAND = "component.list";

/** `tags` filter cap — the task's tool contract (engine MAX_TAGS is 32). */
export const MAX_LIST_TAGS = 12;
/** Tag strings are 1..64 chars (gateway catalog tag schema, W5-B precedent). */
export const MAX_TAG_CHARS = 64;
/** `query` cap (tool contract; the engine leaves it unbounded). */
export const MAX_QUERY_CHARS = 120;
/** §6.1 compact reply fits ~16 cards; the engine scans up to 512 directories. */
export const MAX_LIST_CARDS = 16;
/** Error hints list at most this many `id@version` pins (engine SHOWN_PINS). */
export const MAX_SHOWN_PINS = 8;
/** Warnings list at most this many library problems, then a count tail. */
const MAX_SHOWN_PROBLEMS = 8;

// ---------------------------------------------------------------------------
// Reply reading (defensive: the minimal EngineCommandReport seam carries the
// rich §8.3 result structurally, or JSON-encoded in `message` — adapter conformance)
// ---------------------------------------------------------------------------

/** One §8.3 listing row, narrowed to what the card view needs. */
export interface ComponentListRow {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly tags: readonly string[];
  /** Variable NAMES only (the engine's list reply sends the manifest's keys). */
  readonly variables: readonly string[];
}

export interface ComponentListReply {
  readonly rows: readonly ComponentListRow[];
  /** Library problems rendered as compact strings (§8.3 `problems`). */
  readonly problems: readonly string[];
  /** Rows that failed validation and were skipped — never fabricated. */
  readonly unreadableRows: number;
}

/** Variable names from either reply shape: the engine's name array, or a spec record. */
function variableNames(raw: unknown): readonly string[] {
  if (Array.isArray(raw)) {
    return raw.filter((name): name is string => typeof name === "string" && name.length > 0);
  }
  if (typeof raw === "object" && raw !== null) {
    return Object.keys(raw as Record<string, unknown>).filter((name) => name.length > 0);
  }
  return [];
}

const ROW_ID = cappedString(64, 1); // engine MAX_ID_CHARS
const ROW_NAME = cappedString(128, 1); // engine MAX_NAME_CHARS
const ROW_VERSION = z.number().int().min(1);

/** One raw engine row → a validated card row; undefined when unreadable. */
function probeListRow(raw: unknown): ComponentListRow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = ROW_ID.safeParse(record.id);
  const version = ROW_VERSION.safeParse(record.version);
  if (!id.success || !version.success) return undefined;
  const name = ROW_NAME.safeParse(record.name);
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0)
    : [];
  return {
    id: id.data,
    // A missing name never hides a valid component: the id is the identity.
    name: name.success ? name.data : id.data,
    version: version.data,
    tags,
    variables: variableNames(record.variables),
  };
}

/** One §8.3 `problems` entry as a compact string (never an object dump). */
function renderProblem(entry: unknown): string {
  if (typeof entry === "string") return capText(entry, MAX_WARNING_CHARS);
  if (typeof entry === "object" && entry !== null) {
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    const error = typeof record.error === "string" ? record.error : undefined;
    if (id !== undefined && error !== undefined) {
      return capText(`component \`${id}\`: ${error}`, MAX_WARNING_CHARS);
    }
    if (error !== undefined) return capText(error, MAX_WARNING_CHARS);
    if (id !== undefined) return capText(`component \`${id}\` has a problem`, MAX_WARNING_CHARS);
  }
  return "a component library problem could not be rendered";
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Reads the engine's `{components, problems}` reply off the minimal
 * `EngineCommandReport` seam: the fields ride along structurally, or arrive
 * JSON-encoded in `message` (adapter conformance). Unreadable rows are counted,
 * never echoed (§6.1).
 */
export function readComponentList(report: EngineCommandReport): ComponentListReply {
  type ListFields = EngineCommandReport & { components?: unknown; problems?: unknown };
  const source = report as ListFields;
  let components = Array.isArray(source.components) ? source.components : undefined;
  let problems = Array.isArray(source.problems) ? source.problems : undefined;
  if (components === undefined && problems === undefined) {
    const parsed = typeof report.message === "string" ? tryParseObject(report.message) : undefined;
    if (Array.isArray(parsed?.components)) components = parsed.components;
    if (Array.isArray(parsed?.problems)) problems = parsed.problems;
  }
  const rows: ComponentListRow[] = [];
  let unreadableRows = 0;
  for (const raw of components ?? []) {
    const row = probeListRow(raw);
    if (row === undefined) {
      unreadableRows += 1;
      continue;
    }
    rows.push(row);
  }
  return { rows, problems: (problems ?? []).map(renderProblem), unreadableRows };
}

// ---------------------------------------------------------------------------
// Shared failure mapper + candidate pins (used by component-place.ts)
// ---------------------------------------------------------------------------

/** Engine seam failure → ToolErr passthrough (code preserved, text kit-capped). */
export function engineFailureErr(failure: EngineFailure): ToolErr {
  const message =
    failure.message.trim().length > 0
      ? capText(failure.message, MAX_ERROR_MESSAGE_CHARS)
      : "the engine command was rejected";
  return err(failure.code, message, {
    hint: failure.hint === undefined ? undefined : capText(failure.hint, MAX_HINT_CHARS),
    retryable: failure.retryable,
  });
}

/** `id@version` pins for error hints, sorted by id then version, deduped. */
export function candidatePins(rows: readonly ComponentListRow[]): readonly string[] {
  const pins = new Set<string>();
  for (const row of [...rows].sort((a, b) =>
    a.id !== b.id ? (a.id < b.id ? -1 : 1) : a.version - b.version,
  )) {
    pins.add(`${row.id}@${row.version}`);
  }
  return [...pins].slice(0, MAX_SHOWN_PINS);
}

// ---------------------------------------------------------------------------
// component_list (§6 row 12)
// ---------------------------------------------------------------------------

export interface ComponentListArgs {
  readonly tags?: readonly string[];
  readonly query?: string;
}

/** §8.3 card row: discovery shape — variable names only, NOT a manifest. */
export interface ComponentCardView {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly tags: readonly string[];
  readonly variables: readonly string[];
}

const componentListArgs = strictObject({
  // Engine `list_core`: a non-empty array of non-empty strings, or absent.
  tags: cappedArray(MAX_LIST_TAGS, cappedString(MAX_TAG_CHARS, 1)).min(1).optional(),
  query: cappedString(MAX_QUERY_CHARS, 1).optional(),
});

export const componentListTool: Tool<ComponentListArgs> = defineTool({
  name: "component_list",
  description:
    "List reusable component cards (id, name, version, tags, variable names) with AND-tag and text-query filters; component_place instantiates a pinned id@version.",
  args: componentListArgs,
  async run(ctx, args, signal) {
    // The engine applies the filters (AND over tags, substring over id+name);
    // pass only what the model actually sent.
    const params: Record<string, unknown> = {};
    if (args.tags !== undefined) params.tags = [...args.tags];
    if (args.query !== undefined) params.query = args.query;

    const reply = await ctx.engine.execute(
      { id: COMPONENT_LIST_COMMAND, params },
      { signal },
    );
    if (!reply.ok) return engineFailureErr(reply);

    const { rows, problems, unreadableRows } = readComponentList(reply.value);

    // Warnings (≤ §6.1 caps): library problems first, then reply health, then
    // the "showing K of M" trim note — every entry already ≤500 chars.
    const warnings: string[] = problems.slice(0, MAX_SHOWN_PROBLEMS);
    if (problems.length > MAX_SHOWN_PROBLEMS) {
      warnings.push(`${problems.length - MAX_SHOWN_PROBLEMS} more library problems omitted`);
    }
    if (unreadableRows > 0) {
      warnings.push(`${unreadableRows} component row(s) from the reply were unreadable and skipped`);
    }
    if (rows.length === 0) {
      const filtered = args.tags !== undefined || args.query !== undefined;
      warnings.push(
        filtered
          ? "no component matches these filters; list without tags or query to see every component"
          : "the component library is empty — nothing to list",
      );
    }

    // Deterministic order (the engine sorts its scan; sort defensively anyway).
    const sorted = [...rows].sort((a, b) =>
      a.id !== b.id ? (a.id < b.id ? -1 : 1) : a.version - b.version,
    );
    const cards: ComponentCardView[] = sorted
      .slice(0, MAX_LIST_CARDS)
      .map((row) => ({
        id: row.id,
        name: row.name,
        version: row.version,
        tags: [...row.tags],
        variables: [...row.variables],
      }));
    let summaryJson = JSON.stringify({ components: cards });
    while (summaryJson.length > MAX_SUMMARY_CHARS && cards.length > 0) {
      cards.pop();
      summaryJson = JSON.stringify({ components: cards });
    }
    if (sorted.length > cards.length) {
      warnings.push(
        `showing ${cards.length} of ${sorted.length} components; narrow with tags or query`,
      );
    }

    ctx.logger.debug("component_list resolved", {
      shown: cards.length,
      total: sorted.length,
      problems: problems.length,
    });
    return ok({
      summary: summaryJson,
      warnings: warnings.length > 0 ? warnings.slice(0, MAX_WARNINGS) : undefined,
    });
  },
});
