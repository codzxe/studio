/**
 * studio.list_commands / studio.describe_command — the round-12 catalog
 * discovery pair, client-executed like the other read tools
 * (research/round12-design.md "Tool catalog v3" + research/
 * engine-command-surface.md §4a: the MCP-proven list → describe → propose
 * flow).
 *
 * Both tools answer with the ALLOWED catalog ONLY:
 *  - `list_commands` asks the LIVE engine registry (`command.list` — the web
 *    bridge's generic `query` seam reaches every engine command today) and
 *    then FILTERS the answer against the tier-2 ALLOWED_COMMAND_IDS list from
 *    `@studio/contracts` (apps/web/package.json depends on it; the round-12
 *    task pins this import). Denied ids (app chrome, filesystem, code exec,
 *    destructive, render-output writers) never reach the model — it must not
 *    waste repair turns discovering ids the gateway compiler would refuse.
 *  - when the live registry is unreachable (an editor dist older than the
 *    `command.list` query id), `list_commands` degrades to grouping the local
 *    ALLOWED_COMMAND_IDS copy (ids without titles) instead of failing — the
 *    model can still discover ids, then `describe_command` per id.
 *  - `describe_command` verifies the id against ALLOWED_COMMAND_IDS FIRST
 *    (unknown/denied → typed UNKNOWN_COMMAND naming the closest allowed ids —
 *    the repairable-error pattern the plan compiler uses), then asks the live
 *    engine `command.describe` for the verbatim params doc + JSON schema.
 *
 * The result shapes stay compact (§8.3 budgets): list = categories with
 * `{id, title}` one-liners (never the ~100 KB params docs); describe = one
 * command's full params doc.
 */

import { ALLOWED_COMMAND_IDS, isAllowedEngineCommand } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import { isBridgeError, messageOf } from "@studio/editor-bridge";

import { ClientToolError } from "./client-tool-error";

// ---------------------------------------------------------------------------
// Local catalog facts (tier-2 ids only — never the full params-doc catalog)
// ---------------------------------------------------------------------------

/** Allowed ids grouped by id prefix (`layer`, `comp`, …), sorted by category. */
function allowedIdsByCategory(): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const id of ALLOWED_COMMAND_IDS) {
    const category = id.split(".")[0] ?? "";
    const bucket = groups.get(category);
    if (bucket === undefined) groups.set(category, [id]);
    else bucket.push(id);
  }
  return groups;
}

/** The ids the closest-match suggestion logic may ever propose (allowed only). */
const SUGGESTION_POOL: readonly string[] = ALLOWED_COMMAND_IDS;

/** Up to `limit` allowed ids close to `query` (prefix hits, then edit distance ≤ 2). */
function closestAllowedIds(query: string, limit = 5): string[] {
  const needle = query.toLowerCase();
  const starts: string[] = [];
  const near: Array<{ id: string; distance: number }> = [];
  for (const id of SUGGESTION_POOL) {
    const haystack = id.toLowerCase();
    if (haystack.startsWith(needle) || haystack.includes(`.${needle}`)) {
      starts.push(id);
      continue;
    }
    const distance = editDistance(needle, haystack);
    if (distance <= 2) near.push({ id, distance });
  }
  near.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
  return [...starts.sort(), ...near.map((entry) => entry.id)].slice(0, limit);
}

/** Classic bounded Levenshtein (needle × haystack, small strings only). */
function editDistance(a: string, b: string): number {
  const width = b.length + 1;
  let previous = Array.from({ length: width }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j < width; j++) {
      const cost = a.codePointAt(i - 1) === b.codePointAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

// ---------------------------------------------------------------------------
// Bridge error mapping
// ---------------------------------------------------------------------------

/** Bridge codes that mean "the editor is not answering". */
const DISCONNECT_CODES: ReadonlySet<string> = new Set([
  "EDITOR_DISCONNECTED",
  "EDITOR_NOT_READY",
  "EDITOR_LOAD_FAILED",
  "EDITOR_TIMEOUT",
]);

function catalogQueryError(error: unknown): ClientToolError {
  if (isBridgeError(error) && DISCONNECT_CODES.has(error.code)) {
    return new ClientToolError(
      "EDITOR_DISCONNECTED",
      "The editor is not responding, so the command catalog could not be read.",
    );
  }
  return new ClientToolError(
    "TOOL_FAILED",
    `The command catalog could not be read: ${messageOf(error)}`,
  );
}

// ---------------------------------------------------------------------------
// studio.list_commands
// ---------------------------------------------------------------------------

export interface ListCommandsArgs {
  readonly category?: string;
}

export interface CatalogListResult {
  readonly categories: ReadonlyArray<{
    readonly category: string;
    readonly count: number;
    readonly commands: ReadonlyArray<{ readonly id: string; readonly title: string | null }>;
  }>;
  /** `"live"` = the engine registry; `"local"` = the bundled allowed-ids fallback. */
  readonly source: "live" | "local";
}

type CatalogCategory = CatalogListResult["categories"][number];

/**
 * The command catalog, grouped by category prefix. `command.list` is a
 * read-only engine query (query.rs) reachable through the generic bridge
 * `query` seam; the answer is filtered to ALLOWED ids and — when `category`
 * is given — to that prefix. A bridge failure degrades to the local ids-only
 * grouping (never an abort: discovery must keep working on old dists).
 */
export async function runListCommands(
  args: ListCommandsArgs,
  bridge: EditorBridge,
): Promise<CatalogListResult> {
  const category = args.category;
  let live: ReadonlyArray<Record<string, unknown>> | null = null;
  try {
    live = await bridge.query<ReadonlyArray<Record<string, unknown>>>("command.list", {});
  } catch {
    live = null; // old engine dist without the command.list query id — degrade below
  }

  if (live !== null) {
    const grouped = new Map<string, Array<{ id: string; title: string | null }>>();
    for (const entry of live) {
      const id = typeof entry.id === "string" ? entry.id : null;
      if (id === null || !isAllowedEngineCommand(id)) continue;
      if (category !== undefined && !id.startsWith(`${category}.`)) continue;
      const label = typeof entry.label === "string" && entry.label.length > 0 ? entry.label : null;
      const prefix = id.split(".")[0] ?? "";
      const bucket = grouped.get(prefix);
      const row = { id, title: label };
      if (bucket === undefined) grouped.set(prefix, [row]);
      else bucket.push(row);
    }
    if (grouped.size > 0) {
      return {
        categories: [...grouped.entries()]
          .map(([cat, commands]) => ({
            category: cat,
            count: commands.length,
            commands,
          }))
          .sort((a, b) => (a.category < b.category ? -1 : 1)),
        source: "live",
      };
    }
    // Fall through when the category filter matched nothing (the local
    // fallback below answers the same question from the tier-2 list).
  }

  const grouped = allowedIdsByCategory();
  const categories: CatalogCategory[] = [];
  for (const [prefix, ids] of grouped) {
    if (category !== undefined && prefix !== category) continue;
    categories.push({
      category: prefix,
      count: ids.length,
      commands: ids.map((id) => ({ id, title: null })),
    });
  }
  return { categories, source: "local" };
}

// ---------------------------------------------------------------------------
// studio.describe_command
// ---------------------------------------------------------------------------

export interface DescribeCommandArgs {
  readonly command: string;
}

export interface CatalogDescribeResult {
  readonly command: string;
  /** Menu label, verbatim from the engine registration. */
  readonly title: string | null;
  /** The registration's params doc, verbatim (the params-doc grammar). */
  readonly paramsDoc: string | null;
  /** Derived JSON Schema for the params (engine `command.describe {schemas}` grammar). */
  readonly schema: unknown;
  /** Whether the command journals an undoable edit. */
  readonly undoable: boolean | null;
  /** Whether the command is currently enabled + the engine's "why" when not. */
  readonly enabled: boolean | null;
  readonly why: string | null;
}

/**
 * The full params documentation for ONE command id. The id must be in the
 * ALLOWED tier-2 list first (unknown/denied → typed UNKNOWN_COMMAND with the
 * closest allowed matches); then the live engine `command.describe` query
 * supplies the verbatim params doc + JSON schema. The tool contract has no
 * local paramsDoc fallback: the tier-2 list is ids-only by design (the full
 * catalog never rides the browser bundle), so a bridge failure on a KNOWN id
 * is an honest typed failure, never a fabricated doc.
 */
export async function runDescribeCommand(
  args: DescribeCommandArgs,
  bridge: EditorBridge,
): Promise<CatalogDescribeResult> {
  const command = args.command;
  if (!isAllowedEngineCommand(command)) {
    const closest = closestAllowedIds(command);
    const hint = closest.length > 0 ? ` Closest allowed ids: ${closest.join(", ")}.` : "";
    throw new ClientToolError(
      "UNKNOWN_COMMAND",
      `"${command}" is not an allowed command id.${hint} Discover ids with studio.list_commands.`,
    );
  }
  let described: Record<string, unknown>;
  try {
    described = await bridge.query<Record<string, unknown>>("command.describe", { command });
  } catch (error) {
    throw catalogQueryError(error);
  }
  return {
    command,
    title:
      typeof described.label === "string" && described.label.length > 0 ? described.label : null,
    paramsDoc:
      typeof described.params === "string" && described.params.length > 0 ? described.params : null,
    schema: "schema" in described ? (described.schema as unknown) : null,
    undoable: typeof described.undoable === "boolean" ? described.undoable : null,
    enabled: typeof described.enabled === "boolean" ? described.enabled : null,
    why: typeof described.why === "string" && described.why.length > 0 ? described.why : null,
  };
}
