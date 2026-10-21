// @studio/engine-client — typed builders for the capability-scoped export/import methods (W2-C).
//
// Sources (vendor pinned 872748fb — verified):
//   - rpc.rs: `doc.exportLayers {dir, format?, prefix?, visibleOnly?, quality?, index?}` and
//     `doc.exportDataSets {dir, format?, dataSets?, naming?, index?}` both reply
//     `{files, count}`; `doc.importDataSets {path, delimiter?, index?}` replies `{imported}`.
//   - These are the capability-scoped counterparts of the refused ambient commands
//     (#2810/#3216): dirs resolve beneath the WRITE root, the CSV beneath the READ root;
//     the write capability refuses to overwrite existing files, and colliding data-set
//     names are refused before any file is written.
//   - crates/engine/src/file_cmds.rs `export_layers_with` (format default png, visibleOnly
//     default true, `<prefix>_<NNNN>_<layer>.<format>` naming) and variables_cmds.rs
//     `export_data_sets_with` (naming template default `{name}`, 1-based `{index}`,
//     `{document}` stem) / `import_data_sets_text` (delimiter = first byte, default `,`).

import { z } from "zod";
import {
  type BuiltMethodCall,
  PROTOCOL_METHODS,
  READ_ROOT_PATH,
  WRITE_ROOT_PATH,
  buildCall,
} from "./protocol.js";

const nonNegativeInt = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// doc.exportLayers — one file per exported layer (write-root scoped)
// ---------------------------------------------------------------------------

export const DOC_EXPORT_LAYERS_PARAMS = z
  .object({
    /** Directory beneath the automation write root. */
    dir: WRITE_ROOT_PATH,
    /** Export format; default `png` (leading dot trimmed, lowercased by the engine). */
    format: z.string().optional(),
    /** Filename prefix; default is the document name stem. */
    prefix: z.string().optional(),
    /** Export only visible layers; default true. */
    visibleOnly: z.boolean().optional(),
    /** Encoder quality, 0..100. */
    quality: z.number().finite().min(0).max(100).optional(),
    index: nonNegativeInt.optional(),
  })
  .strict();

export type DocExportLayersParams = z.infer<typeof DOC_EXPORT_LAYERS_PARAMS>;
export type DocExportLayersInput = DocExportLayersParams;

/** `{files: ["<dir>/<name>", …], count: n}` (headless.rs `exported`). */
export const EXPORT_RESULT = z
  .object({ files: z.array(z.string()), count: nonNegativeInt })
  .passthrough();

export type ExportResult = z.infer<typeof EXPORT_RESULT>;

export function docExportLayers(
  input: DocExportLayersInput,
): BuiltMethodCall<DocExportLayersParams, ExportResult> {
  return buildCall(
    PROTOCOL_METHODS.docExportLayers,
    DOC_EXPORT_LAYERS_PARAMS,
    input,
    EXPORT_RESULT,
  );
}

// ---------------------------------------------------------------------------
// doc.exportDataSets — one flattened file per data set (write-root scoped)
// ---------------------------------------------------------------------------

export const DOC_EXPORT_DATA_SETS_PARAMS = z
  .object({
    dir: WRITE_ROOT_PATH,
    format: z.string().optional(),
    /** Data-set names to export; omit for all. */
    dataSets: z.array(z.string()).optional(),
    /** Filename template over `{name}` (sanitised), `{index}` (1-based) and `{document}`;
     *  default `{name}`. Collisions are refused before any file is written. */
    naming: z.string().optional(),
    index: nonNegativeInt.optional(),
  })
  .strict();

export type DocExportDataSetsParams = z.infer<typeof DOC_EXPORT_DATA_SETS_PARAMS>;
export type DocExportDataSetsInput = DocExportDataSetsParams;

export function docExportDataSets(
  input: DocExportDataSetsInput,
): BuiltMethodCall<DocExportDataSetsParams, ExportResult> {
  return buildCall(
    PROTOCOL_METHODS.docExportDataSets,
    DOC_EXPORT_DATA_SETS_PARAMS,
    input,
    EXPORT_RESULT,
  );
}

// ---------------------------------------------------------------------------
// doc.importDataSets — CSV data sets (read-root scoped)
// ---------------------------------------------------------------------------

export const DOC_IMPORT_DATA_SETS_PARAMS = z
  .object({
    /** CSV path beneath the automation read root. */
    path: READ_ROOT_PATH,
    /** The engine uses the FIRST byte of this string as the delimiter; default `,`. */
    delimiter: z.string().min(1).optional(),
    index: nonNegativeInt.optional(),
  })
  .strict();

export type DocImportDataSetsParams = z.infer<typeof DOC_IMPORT_DATA_SETS_PARAMS>;
export type DocImportDataSetsInput = DocImportDataSetsParams;

export const IMPORT_DATA_SETS_RESULT = z.object({ imported: nonNegativeInt }).passthrough();
export type ImportDataSetsResult = z.infer<typeof IMPORT_DATA_SETS_RESULT>;

export function docImportDataSets(
  input: DocImportDataSetsInput,
): BuiltMethodCall<DocImportDataSetsParams, ImportDataSetsResult> {
  return buildCall(
    PROTOCOL_METHODS.docImportDataSets,
    DOC_IMPORT_DATA_SETS_PARAMS,
    input,
    IMPORT_DATA_SETS_RESULT,
  );
}
