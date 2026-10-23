# @studio/storage

Upload validation only (since W2-B6). This package is the byte-guard seam for
the asset upload path: magic-byte MIME sniffing, size + megapixel ceilings and
EXIF strip planning — pure, zero-dependency (`node:crypto` only) readers that
never decode or inflate pixel data.

> Scope note (ADR-0006): the PhotoCraft-era object-storage surface — the
> S3/R2 + local drivers, the `.pcraft` document key space, SigV4 presigning
> and the `createStorageFromEnv` factory — was deleted in W2-B6. It was
> dormant: nothing outside its own tests consumed it. Live object storage
> lives in the gateway (`services/gateway/src/storage.ts` — LocalFS/S3
> drivers + asset/render/snapshot key builders, shared with the worker via
> `@studio/gateway/storage`).

## Live surface

| Import | What |
|---|---|
| `@studio/storage/validate` (also the root export `.`) | `sniffMime`, `dimensions` (PNG IHDR / JPEG SOF header parsing), `validateUpload`, `stripExifPlan`, `hasExif`, `checksum`, `DEFAULT_MAX_UPLOAD_*` limits |

Sole consumer: the gateway asset routes
(`services/gateway/src/routes/assets.ts`) — upload accept/verify steps use
`DEFAULT_MAX_UPLOAD_MEGAPIXELS`, `dimensions`, `sniffMime`.

## Security posture

- Dimensions come from HEADER PARSING ONLY; pixel data is never inflated, so
  zip-bomb IDAT payloads cannot hurt this module (§20.2: the 60 MP ceiling is
  enforced on the claimed dimensions).
- Polyglot policy: a PNG must terminate at IEND with nothing after it; the
  whole-buffer scan only trusts signatures ≥ 8 bytes long.
- All failures are typed envelopes `{ ok:false, code, message, hint,
  retryable:false }`; nothing throws on malformed input.
- SVG is deliberately not sniffable (§15.2 XSS note) → `unsupported_media_type`.

## Tests

- `tests/validate.test.ts` — §20.2 acceptance + §15.2/§21 guards (synthetic
  hand-crafted byte fixtures only, no image libraries).
- `tests/fuzz/` — §21 upload-fuzzing corpus: truth table, invariants and a
  seeded mutation sweep. See `tests/fuzz/README.md`.

Run: `corepack pnpm --filter @studio/storage test`
