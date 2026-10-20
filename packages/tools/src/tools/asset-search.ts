// @studio/tools — asset_search (§6 row 6): find a workspace asset.
//
// A read-only lookup over the `ctx.assets` seam (AssetStoreLike, §6 row 6 / §20
// uploads): the store is tenant-scoped by the repository (§15.1), so this tool
// only shapes the reply. The compact-reply rule (§6.1) is load-bearing here —
// an asset library can hold hundreds of rows, so the summary is a compact
// `{ "assets": [{ id, name, width, height, kind }] }` table, never a row dump:
// no storage URLs, no mime internals, no engine payloads.

import { z } from "zod";
import { MAX_SUMMARY_CHARS, cappedString, defineTool, ok, strictObject } from "../kit.js";
import type { AssetRecord, Tool } from "../types.js";

/** §6.1 string caps: the query stays a short filename-ish search string. */
export const MAX_QUERY_CHARS = 120;
/** Result window: 20 by default, 120 at most (W5-E contract for this tool). */
export const DEFAULT_RESULTS = 20;
export const MAX_RESULTS = 120;
/** Display cap for filenames in the summary table (ids are never truncated). */
export const MAX_NAME_CHARS = 40;

export const assetSearchArgs = strictObject({
  /** Empty/omitted query lists the library (recent first, per the store). */
  query: cappedString(MAX_QUERY_CHARS).optional(),
  /** Add-only catalogue (§13.3): "image" today; png/jpeg both place via doc.place. */
  kind: z.enum(["image"]).optional(),
  limit: z.number().int().min(1).max(MAX_RESULTS).default(DEFAULT_RESULTS),
});

export type AssetSearchArgs = z.infer<typeof assetSearchArgs>;

/** One compact summary row — the four fields the model needs to pick and place. */
export interface AssetRow {
  readonly id: string;
  readonly name: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly kind: string;
}

/** §20: uploads are png/jpeg only; both are placeable raster images. */
export function assetKind(record: AssetRecord): string {
  return record.mimeType === "image/png" || record.mimeType === "image/jpeg" ? "image" : "other";
}

/** Projects an AssetRecord into the summary row; unrecorded dimensions surface as null. */
export function toAssetRow(record: AssetRecord): AssetRow {
  const { widthPx, heightPx } = record;
  const dimension = (value: number | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  return {
    id: record.assetId,
    name:
      record.filename.length > MAX_NAME_CHARS
        ? `${record.filename.slice(0, MAX_NAME_CHARS - 3)}...`
        : record.filename,
    width: dimension(widthPx),
    height: dimension(heightPx),
    kind: assetKind(record),
  };
}

/**
 * Serializes the table as the tool summary, trimming rows (never fields) until
 * it fits the kit's 2000-char cap — ok() enforces the same ceiling at runtime,
 * so the trim here is what keeps the reply deliverable (§6.1 small replies).
 */
export function compactAssetTable(rows: readonly AssetRow[]): { summary: string; shown: number } {
  const shown = [...rows];
  let summary = `{"assets":${JSON.stringify(shown)}}`;
  while (summary.length > MAX_SUMMARY_CHARS && shown.length > 1) {
    shown.pop();
    summary = `{"assets":${JSON.stringify(shown)}}`;
  }
  return { summary, shown: shown.length };
}

export const assetSearchTool: Tool<AssetSearchArgs> = defineTool({
  name: "asset_search",
  description:
    "Search this workspace's asset library and return a compact table of image assets (id, name, pixel size) for placement.",
  args: assetSearchArgs,
  async run(ctx, args) {
    const limit = Math.min(args.limit, MAX_RESULTS);
    const records = await ctx.assets.search(args.query ?? "", { limit });
    const matching =
      args.kind === undefined
        ? records
        : records.filter((record) => assetKind(record) === args.kind);
    const rows = matching.slice(0, limit).map(toAssetRow);
    const { summary, shown } = compactAssetTable(rows);
    const warnings: string[] = [];
    if (matching.length > shown) {
      warnings.push(
        `Showing ${shown} of ${matching.length} matching assets (compact-reply cap); narrow the query to see the rest.`,
      );
    }
    ctx.logger.debug("asset_search", { matched: matching.length, shown });
    return ok({ summary, warnings: warnings.length > 0 ? warnings : undefined });
  },
});
