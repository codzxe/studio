// @studio/contracts — write tools (M5 seam, BUILD_PLAN §M5.1, PA §8.4/§8.7).
//
// STUB — M5-A owns this file in Wave 1 and replaces this content with the
// eight write-tool definitions: create_composition, create_text,
// set_properties, add_effect, set_keyframes, apply_preset, undo_run,
// save_version. Each tool takes CURATED args (never raw command ids — law #5)
// and its result is a PROPOSED batch (never a direct execution).
import { z } from "zod";

/** The eight write-tool ids (BUILD_PLAN §M5.1). */
export const WRITE_TOOL_IDS = [
  "create_composition",
  "create_text",
  "set_properties",
  "add_effect",
  "set_keyframes",
  "apply_preset",
  "undo_run",
  "save_version",
] as const;

export type WriteToolId = (typeof WRITE_TOOL_IDS)[number];

/** Placeholder args schema registry — M5-A replaces with real per-tool ZodObjects. */
export const WRITE_TOOL_ARGS_SCHEMAS: Readonly<Record<WriteToolId, z.ZodTypeAny>> =
  Object.freeze(
    Object.fromEntries(
      WRITE_TOOL_IDS.map(
        (id) => [id, z.object({}).passthrough()] as const,
      ),
    ) as unknown as Record<WriteToolId, z.ZodTypeAny>,
  );
