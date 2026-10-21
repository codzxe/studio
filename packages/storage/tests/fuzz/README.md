# Upload fuzzing corpus (W10-A)

§21 Security row — *"upload fuzzing (polyglot files, zip bombs, EXIF payloads)"*
— driven against the byte guards in [`packages/storage/src/validate.ts`](../../src/validate.ts):
`validateUpload`, `sniffMime`, `stripExifPlan` (plus `hasExif` as the detector pin).

## Layout

| File | Role |
|---|---|
| `corpus.mjs` | Zero-dep in-memory attack fixture generator (no image libraries, no files on disk — §21 "synthetic test data only"). Exports `CORPUS` (typed truth table) and `mutatedCopy` (seeded mutator). |
| `corpus.d.mts` | Hand-maintained type surface for `corpus.mjs` (NodeNext). |
| `fuzz-validate.test.ts` | Vitest suite: truth table + invariants + deterministic mutation sweep. |

Run: `pnpm --filter @studio/storage test` (Vitest discovers `tests/fuzz/` automatically).

## What is asserted

1. **Never a crash** — every corpus case and every seeded mutant goes through all
   three guards wrapped in `attempt()`; a throw fails the test. Malformed input
   must produce a typed §1.5-4 envelope `{ ok:false, code, message, retryable:false }`.
2. **Truth table** — each case pins the exact verdict: the sniffed mime, the
   `UploadErrorCode` (or `ok`), and the strip-plan outcome. Codes are from the
   closed set `unsupported_media_type | upload_too_large | resolution_exceeds_ceiling
   | file_corrupt | polyglot_detected`.
3. **stripExifPlan never increases byte size** (§15.2): keep ∪ removed partitions
   the file exactly; a `needsStrip` plan reassembled re-validates clean, carries no
   EXIF, and XMP APP1 / ICC APP2 (colour profiles) survive while APP1-EXIF and
   COM segments are dropped.
4. **Boundary pins** — exactly 60 MP is inside the §20.2 cap (`>` is strict);
   61 MP rejects from the header claim alone (nothing is ever decompressed — the
   inert-header rule); `planCeiling` narrows via `min()` (§14.1); the 25 MB size
   gate fires before any sniff (pinned by a `25 MB + 1` PNG-prefixed buffer).
5. **View safety** — guards honour `byteOffset` (subarray views of a padded shell
   validate identically to their own bytes).
6. **Mutation sweep** — 24 deterministic xorshift-seeded mutations per small
   fixture (flips, scribbles, truncation, insertion, zeroing): any verdict is
   allowed, but only typed envelopes and strip invariants are accepted.

## §21 Security row — covered here vs deferred

| §21 item | Status | Where |
|---|---|---|
| Polyglot files | **Covered** | 5 cases: PNG header + JPEG trailer (caught by the post-IEND tail scan), PNG + WebP trailer (strong-signature scan), double SOI, PNG hidden inside an EXIF APP1, whole PNG appended after a JPEG EOI. |
| Zip bombs | **Covered as image claims** | 60/61 MP headers on 1 KB payloads (PNG + JPEG). The megapixel bomb is rejected from the header claim alone (`resolution_exceeds_ceiling`); the validator never inflates IDAT/entropy data (inert-header rule). An at-cap 60 MP claim passes the byte gate by design — the worker's decode step owns actual decompression limits. |
| EXIF payloads | **Covered** | APP1 with IFD0 + GPS block + embedded thumbnail JPEG (nested SOI is legal and is removed with the segment), dual APP1 (II/MM byte orders), COM script payloads, XMP/ICC survival. Upload is never rejected for carrying EXIF (§20.2: stripped downstream, never rejected). |
| Corrupt structure | **Covered** | Bad IHDR CRC, truncated IHDR, chunk length overrun, duplicate IHDR, trailing junk after IEND, zero dimensions, JPEG bad marker/length/no-SOF/desync/second-SOF/double-SOI. |
| SVG with scripts | **Covered** | `unsupported_media_type` — SVG is deliberately not sniffable (§15.2 XSS note: only sanitised SVG may be accepted, never via this path). |
| Renamed extensions vs magic mismatch | **Covered** | PNG claiming JPEG, JPEG claiming PNG, GIF/ZIP/EXE renamed to image extensions, WebP outside the JPEG/PNG upload surface — §15.2: the sniffed magic always wins over client claims. |
| Filename payloads (traversal, null bytes, huge names, RTLO) | **Corpus only (deferred enforcement)** | The four `filename/*` cases carry the payloads as metadata with clean bytes; `validate.ts` is deliberately **bytes-only** (it never sees filenames). The gateway upload route owns filename policy — reject traversal, NUL bytes, oversized and RTLO names **before** storage keys are minted. |
| SSRF on webhook-like URLs | **Deferred** | Needs the storage driver layer (S3 endpoint/presign) and the gateway's outbound fetch — `validate.ts` performs no I/O. Documented as a **gateway concern**. |
| CSRF / session replay | **Deferred** | HTTP-layer concerns (gateway auth/middleware), not byte validation. |
| Rate-limit bypass, prompt injection, cross-tenant | **Other suites** | Gateway `tests/integration/` and `packages/agent` suites own these. |

## Known boundaries (documented, deliberate)

- **JPEG trailing data after EOI is not tail-checked**: only PNG gets the strict
  post-IEND walk (a JPEG's own nested SOI is legal — EXIF thumbnails). A
  JPEG+JPEG concatenation therefore validates with the first frame's dimensions;
  the downstream decoder stops at the first EOI. PNG is the strictly
  tail-checked format.
- **`stripExifPlan` is a planner, not a gate**: it has no size/megapixel ceilings
  (that is `validateUpload`'s job) and plans a whole-file keep for anything that
  is not a JPEG (PNG has no EXIF standard).
- **Divergence is pinned, not hidden**: e.g. the EXIF-stowaway PNG case rejects
  in `validateUpload` (`polyglot_detected`) while the strip plan still describes
  removing the APP1 — the worker only ever strips files validation accepted.
