// packages/storage/tests/fuzz/corpus.d.mts — hand-maintained type surface for
// corpus.mjs (NodeNext resolves `./corpus.mjs` imports to this file). Keep in
// sync with the generator; the fuzz test asserts the corpus against
// ../../src/validate.ts typed envelopes (§1.5-4) and never widens to `any`.

export type CorpusCategory =
  | "polyglot"
  | "zip-bomb"
  | "exif-payload"
  | "corrupt"
  | "unsupported"
  | "mislabeled"
  | "filename"
  | "degenerate";

/** Removed-segment marker labels the strip plan may report. */
export type StripMarker = "APP1" | "APP2" | "COM";

/** An ASCII needle looked up in the post-strip bytes. */
export interface CorpusProbe {
  readonly needle: string;
  readonly survives: boolean;
}

/** Exact expected verdicts for the three guards under test. */
export interface CorpusExpect {
  readonly sniff:
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "unsupported_media_type";
  readonly validate:
    | "ok"
    | "unsupported_media_type"
    | "upload_too_large"
    | "resolution_exceeds_ceiling"
    | "file_corrupt"
    | "polyglot_detected";
  readonly strip: "ok-keep" | "ok-strip" | "file_corrupt";
  /** Pin of `hasExif` for EXIF-family cases. */
  readonly hasExif?: boolean;
  /** Exact ordered marker list the strip plan must remove. */
  readonly stripRemoved?: readonly StripMarker[];
  /** ASCII probes over the reassembled post-strip bytes. */
  readonly probes?: readonly CorpusProbe[];
  /** Dimension pin for validate-ok cases where the claim matters. */
  readonly dims?: { readonly width: number; readonly height: number };
}

export interface CorpusCase {
  readonly id: string;
  readonly category: CorpusCategory;
  /** Which §21 attack idea the case exercises, in one line. */
  readonly threat: string;
  /** The extension the client claims (a lie in mislabeled cases). */
  readonly claimedExt: string;
  /** The Content-Type the client claims (a lie in mislabeled cases). */
  readonly claimedMime: string;
  /** The upload filename — carries the payload in `filename` cases. */
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly expect: CorpusExpect;
}

export declare const CORPUS: readonly CorpusCase[];

/** Deterministic seeded mutation of a fixture (never mutates the input). */
export declare function mutatedCopy(bytes: Uint8Array, seed: number): Uint8Array;
