// packages/storage/tests/fuzz/fuzz-validate.test.ts — W10-A.
//
// §21 Security row (upload fuzzing: polyglot files, zip bombs, EXIF
// payloads) driven against the byte guards in ../../src/validate.ts:
// `validateUpload` + `sniffMime` + `stripExifPlan`, over the in-memory
// attack corpus in ./corpus.mjs (zero-dep, deterministic).
//
// Invariants asserted for EVERY corpus case and every seeded mutant:
//  1. Never a crash: no guard throws on hostile bytes — malformed input
//     yields a typed §1.5-4 envelope `{ ok:false, code, message, retryable }`.
//  2. Truth table: each case pins the EXACT expected verdict code (or ok).
//  3. stripExifPlan never increases byte size (§15.2 strip EXIF): keep ∪
//     removed partitions the file exactly; a needsStrip plan, reassembled,
//     re-validates clean and carries no EXIF.

import { describe, expect, it } from "vitest";
import {
  type SniffResult,
  type StripExifPlan,
  type StripExifResult,
  type UploadErrorCode,
  type UploadFailure,
  type UploadValidation,
  hasExif,
  sniffMime,
  stripExifPlan,
  validateUpload,
} from "../../src/validate.js";
import { CORPUS, type CorpusCase, mutatedCopy } from "./corpus.mjs";

// ---------------------------------------------------------------------------
// §1.5-4 envelope machinery — "never a crash" is the first-class assertion
// ---------------------------------------------------------------------------

type AnyVerdict = UploadValidation | SniffResult | StripExifResult;

type Attempt<T> =
  | { readonly threw: false; readonly value: T }
  | { readonly threw: true; readonly error: unknown };

function attempt<T>(call: () => T): Attempt<T> {
  try {
    return { threw: false, value: call() };
  } catch (error: unknown) {
    return { threw: true, error };
  }
}

/** A guard that throws on fuzz input is a bug — fail the test with context. */
function unwrap<T>(result: Attempt<T>): T {
  if (result.threw) {
    throw new Error(`guard crashed instead of returning a typed envelope: ${String(result.error)}`);
  }
  return result.value;
}

const KNOWN_CODES: readonly UploadErrorCode[] = [
  "unsupported_media_type",
  "upload_too_large",
  "resolution_exceeds_ceiling",
  "file_corrupt",
  "polyglot_detected",
];

/** Envelope conformance (§1.5-4) plus the exact expected rejection code. */
function assertFailureEnvelope(
  failure: UploadFailure,
  expected: UploadErrorCode | undefined,
): void {
  expect(failure.ok).toBe(false);
  expect(KNOWN_CODES).toContain(failure.code);
  if (expected !== undefined) {
    expect(failure.code).toBe(expected);
  }
  expect(failure.retryable).toBe(false); // upload rejections are never retryable
  expect(typeof failure.message).toBe("string");
  expect(failure.message.length).toBeGreaterThan(0);
  if (failure.hint !== undefined) {
    expect(failure.hint.length).toBeGreaterThan(0);
  }
  // AGENTS.md: user-facing errors never leak stack traces or absolute paths.
  expect(failure.message).not.toMatch(/\n/);
  expect(failure.message).not.toMatch(/\/(home|Users|root|tmp)\//);
}

/** Shape check for mutants: any ok/err arm, but never an unknown code. */
function assertVerdictShape(verdict: AnyVerdict): void {
  if (verdict.ok) {
    return; // ok arms are well-typed by construction
  }
  assertFailureEnvelope(verdict, undefined);
}

// ---------------------------------------------------------------------------
// stripExifPlan invariants — §15.2 strip EXIF, never grow the file
// ---------------------------------------------------------------------------

interface Range {
  readonly start: number;
  readonly end: number;
}

function sumOf(ranges: readonly Range[]): number {
  let total = 0;
  for (const range of ranges) {
    total += range.end - range.start;
  }
  return total;
}

/** Ranges stay in-bounds, ascending and non-overlapping. */
function assertRangesWellFormed(ranges: readonly Range[], totalLength: number): void {
  let cursor = 0;
  for (const range of ranges) {
    expect(range.start).toBeGreaterThanOrEqual(cursor);
    expect(range.end).toBeGreaterThanOrEqual(range.start);
    expect(range.end).toBeLessThanOrEqual(totalLength);
    cursor = range.end;
  }
}

const MAX_REASSEMBLE_BYTES = 1 << 20; // skip byte-copying the >25 MB fixture
const DECODER = new TextDecoder();

function reassemble(bytes: Uint8Array, plan: StripExifPlan): Uint8Array | null {
  if (bytes.length > MAX_REASSEMBLE_BYTES) {
    return null;
  }
  const out = new Uint8Array(sumOf(plan.keepBytes));
  let at = 0;
  for (const range of plan.keepBytes) {
    out.set(bytes.subarray(range.start, range.end), at);
    at += range.end - range.start;
  }
  return out;
}

/**
 * Strip invariants for every ok plan: kept bytes never exceed the input,
 * keep ∪ removed partitions the file exactly, and only APP1/APP2/COM are
 * ever dropped (ICC APP2 colour profiles survive — §15.2).
 */
function assertStripInvariants(bytes: Uint8Array, plan: StripExifPlan): void {
  const kept = sumOf(plan.keepBytes);
  expect(kept).toBeLessThanOrEqual(bytes.length); // never increases byte size
  assertRangesWellFormed(plan.keepBytes, bytes.length);
  assertRangesWellFormed(plan.removed, bytes.length);
  for (const segment of plan.removed) {
    expect(["APP1", "APP2", "COM"]).toContain(segment.marker);
  }
  if (plan.needsStrip) {
    expect(plan.removed.length).toBeGreaterThan(0);
    expect(kept).toBeLessThan(bytes.length);
    expect(kept + sumOf(plan.removed)).toBe(bytes.length);
  } else {
    expect(plan.removed).toEqual([]);
    expect(plan.keepBytes).toEqual([{ start: 0, end: bytes.length }]);
  }
}

// ---------------------------------------------------------------------------
// Truth-table row runner
// ---------------------------------------------------------------------------

function caseById(id: string): CorpusCase {
  const found = CORPUS.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`corpus case not found: ${id}`);
  }
  return found;
}

function checkSniff(entry: CorpusCase): SniffResult {
  const sniffed = unwrap(attempt(() => sniffMime(entry.bytes)));
  if (entry.expect.sniff === "unsupported_media_type") {
    if (sniffed.ok) {
      throw new Error(`expected unsupported sniff, got ${sniffed.mime}`);
    }
    assertFailureEnvelope(sniffed, "unsupported_media_type");
    return sniffed;
  }
  if (!sniffed.ok) {
    throw new Error(`expected sniff ${entry.expect.sniff}, got ${sniffed.code}`);
  }
  expect(sniffed.mime).toBe(entry.expect.sniff);
  return sniffed;
}

function checkValidate(entry: CorpusCase): UploadValidation {
  const validated = unwrap(attempt(() => validateUpload(entry.bytes)));
  if (entry.expect.validate === "ok") {
    if (!validated.ok) {
      throw new Error(`expected ok, got ${validated.code}: ${validated.message}`);
    }
    expect(["image/png", "image/jpeg"]).toContain(validated.mime);
    expect(Number.isInteger(validated.width)).toBe(true);
    expect(validated.width).toBeGreaterThan(0);
    expect(validated.height).toBeGreaterThan(0);
    expect(validated.megapixels).toBeCloseTo((validated.width * validated.height) / 1e6, 9);
    if (entry.expect.dims !== undefined) {
      expect(validated.width).toBe(entry.expect.dims.width);
      expect(validated.height).toBe(entry.expect.dims.height);
    }
    return validated;
  }
  if (validated.ok) {
    throw new Error(`expected rejection ${entry.expect.validate}, got ok`);
  }
  assertFailureEnvelope(validated, entry.expect.validate);
  return validated;
}

function checkStrip(entry: CorpusCase): void {
  const plan = unwrap(attempt(() => stripExifPlan(entry.bytes)));
  if (entry.expect.strip === "file_corrupt") {
    if (plan.ok) {
      throw new Error("expected file_corrupt strip plan, got ok");
    }
    assertFailureEnvelope(plan, "file_corrupt");
    return;
  }
  if (!plan.ok) {
    throw new Error(`expected ${entry.expect.strip} strip plan, got ${plan.code}`);
  }
  expect(plan.needsStrip).toBe(entry.expect.strip === "ok-strip");
  assertStripInvariants(entry.bytes, plan);
  if (entry.expect.stripRemoved !== undefined) {
    expect(plan.removed.map((segment) => segment.marker)).toEqual(entry.expect.stripRemoved);
  }
  const stripped = reassemble(entry.bytes, plan);
  if (stripped === null) {
    return;
  }
  expect(stripped.length).toBeLessThanOrEqual(entry.bytes.length);
  if (plan.needsStrip) {
    // The rebuilt file is validator-clean and EXIF-free (§15.2 strip EXIF).
    expect(unwrap(attempt(() => validateUpload(stripped))).ok).toBe(true);
    expect(unwrap(attempt(() => hasExif(stripped)))).toBe(false);
  }
  for (const probe of entry.expect.probes ?? []) {
    expect(DECODER.decode(stripped).includes(probe.needle)).toBe(probe.survives);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("corpus integrity", () => {
  it("ids are unique and every case carries usable attack metadata", () => {
    expect(new Set(CORPUS.map((entry) => entry.id)).size).toBe(CORPUS.length);
    for (const entry of CORPUS) {
      expect(entry.bytes).toBeInstanceOf(Uint8Array);
      expect(entry.filename.length).toBeGreaterThan(0);
      expect(entry.claimedExt.startsWith(".")).toBe(true);
      expect(entry.claimedMime.length).toBeGreaterThan(0);
      expect(entry.threat.length).toBeGreaterThan(0);
    }
  });
});

describe("§21 upload fuzz — truth table over the corpus", () => {
  for (const entry of CORPUS) {
    it(`${entry.id} → sniff=${entry.expect.sniff} validate=${entry.expect.validate}`, () => {
      const sniffed = checkSniff(entry);
      const validated = checkValidate(entry);
      if (sniffed.ok && validated.ok) {
        // §15.2: validateUpload trusts magic bytes only, never the claim.
        expect(validated.mime).toBe(sniffed.mime);
      }
      if (entry.expect.hasExif !== undefined) {
        expect(unwrap(attempt(() => hasExif(entry.bytes)))).toBe(entry.expect.hasExif);
      }
      checkStrip(entry);
    });
  }
});

describe("megapixel ceiling boundary (§20.2 bomb gate, §14.1 plan cap)", () => {
  const claim60 = caseById("zip-bomb/png-60mp-claim-1kb-payload-inert");
  const claim61 = caseById("zip-bomb/png-61mp-claim-1kb-payload");

  it("exactly 60 MP sits inside the cap; 61 MP rejects from the header alone", () => {
    const atCap = unwrap(attempt(() => validateUpload(claim60.bytes)));
    if (!atCap.ok) {
      throw new Error(`60 MP claim rejected: ${atCap.code}`);
    }
    expect(atCap.megapixels).toBe(60);
    const over = unwrap(attempt(() => validateUpload(claim61.bytes)));
    if (over.ok) {
      throw new Error("61 MP claim must not validate");
    }
    expect(over.code).toBe("resolution_exceeds_ceiling");
  });

  it("planCeiling narrows via min(); a tighter maxMegapixels rejects too (§14.1)", () => {
    const byPlan = unwrap(attempt(() => validateUpload(claim60.bytes, { planCeiling: 50 })));
    if (byPlan.ok) {
      throw new Error("60 MP claim over a 50 MP plan ceiling must reject");
    }
    expect(byPlan.code).toBe("resolution_exceeds_ceiling");
    const byLimit = unwrap(attempt(() => validateUpload(claim60.bytes, { maxMegapixels: 59.99 })));
    if (byLimit.ok) {
      throw new Error("60 MP claim under a 59.99 MP limit must reject");
    }
    expect(byLimit.code).toBe("resolution_exceeds_ceiling");
    const generousPlan = unwrap(attempt(() => validateUpload(claim60.bytes, { planCeiling: 61 })));
    expect(generousPlan.ok).toBe(true); // min(60, 61) = 60 → still inside
  });
});

describe("deterministic mutation sweep — typed verdicts, never a crash", () => {
  const MUTATIONS_PER_CASE = 24;
  const MAX_MUTANT_BYTES = 8192;

  CORPUS.forEach((entry, caseIndex) => {
    if (entry.bytes.length === 0 || entry.bytes.length > MAX_MUTANT_BYTES) {
      return;
    }
    it(`${entry.id} survives ${MUTATIONS_PER_CASE} seeded mutations`, () => {
      for (let mutation = 0; mutation < MUTATIONS_PER_CASE; mutation++) {
        const seed = (caseIndex + 1) * 7919 + mutation * 104729;
        const mutant = mutatedCopy(entry.bytes, seed);

        const validated = unwrap(attempt(() => validateUpload(mutant)));
        assertVerdictShape(validated);
        if (validated.ok) {
          expect(Number.isFinite(validated.megapixels)).toBe(true);
          expect(validated.megapixels).toBeGreaterThan(0);
        }

        const plan = unwrap(attempt(() => stripExifPlan(mutant)));
        if (plan.ok) {
          assertStripInvariants(mutant, plan);
        } else {
          assertVerdictShape(plan);
        }

        assertVerdictShape(unwrap(attempt(() => sniffMime(mutant))));
      }
    });
  });
});

describe("byte-view offset safety (guards must honour byteOffset)", () => {
  it("a subarray view validates identically to its own bytes, not the shell", () => {
    const png = caseById("mislabeled/png-bytes-jpg-claim").bytes;
    const padded = new Uint8Array(5 + png.length + 3).fill(0xaa);
    padded.set(png, 5);
    const view = unwrap(attempt(() => validateUpload(padded.subarray(5, 5 + png.length))));
    if (!view.ok) {
      throw new Error(`subarray view rejected: ${view.code}`);
    }
    expect(view.mime).toBe("image/png");

    const jpeg = caseById("exif/app1-gps-thumbnail-and-comment").bytes;
    const shell = new Uint8Array(9 + jpeg.length).fill(0x55);
    shell.set(jpeg, 9);
    const direct = unwrap(attempt(() => stripExifPlan(jpeg)));
    const viaView = unwrap(attempt(() => stripExifPlan(shell.subarray(9))));
    if (!direct.ok || !viaView.ok) {
      throw new Error("strip plans failed on the EXIF fixture");
    }
    expect(viaView.needsStrip).toBe(true);
    expect(viaView.removed).toEqual(direct.removed);
    expect(viaView.keepBytes).toEqual(direct.keepBytes);
  });
});
