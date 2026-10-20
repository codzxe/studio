# @studio/storage

The `objects` service seam (spec §3.1): object storage for uploaded originals,
generated images, previews, exports and `.pcraft` backups on **AWS S3 or
Cloudflare R2** (MinIO/Garage are AGPL and forbidden, §16.5), plus a local
filesystem driver for dev/single-box. Structural, injected everywhere; zod-only
runtime dependency (`aws4fetch` is optional, MIT).

## Key space (src/keys.ts)

Every key embeds the tenant: `…/organizations/<orgId>/…` (§15.1 per-workspace
prefixes). Builders validate every input and drivers re-validate every key —
rejection, never normalization.

| Kind | Key |
|---|---|
| Uploaded asset | `assets/organizations/<orgId>/assets/<assetId>[/<filename>]` |
| Cached preview | `renders/organizations/<orgId>/documents/<docId>/preview-<width>-<revision>.png` |
| Export | `exports/organizations/<orgId>/documents/<docId>/<format>-<versionId>.<format>` |
| Document version | `documents/organizations/<orgId>/documents/<docId>/<versionId>.pcraft` |
| Session checkpoint | `checkpoints/organizations/<orgId>/documents/<docId>/sessions/<sessionId>/checkpoint-<revision>.pcraft` |

`assertTenant(key, orgId)` (keys.ts) is the cross-tenant guard: run it on any
key derived from request input before touching storage. `list(prefix)` is
prefix-scoped only — keep applying the guard to every yielded key.

## Storage surface (src/types.ts)

`put(key, data, { contentType, contentSha256? })` → `StorageObject`
(sha256 always computed; supplied digests are verified);
`get(key)` → `Uint8Array | null`; `delete(key)` idempotent;
`sign(key, { ttlSeconds ≤ 900, download? })` → `{ url, expiresAt }`
(§15.1: short-lived URLs, no public buckets); `list(prefix)` → `AsyncIterable<string>`.

Pure helpers return typed result envelopes; driver methods reject with
`StorageError`, which IS the `{ ok:false, code, message, hint, retryable? }`
envelope (`toFailure()` for the plain shape).

## Drivers

- **local** (`src/drivers/local-fs.ts`) — `node:fs/promises` under a base dir,
  traversal-proof (validate + containment re-check). Signed URLs are
  HMAC-SHA256 query URLs: `GET <base>/v1/storage/local-object?key&exp&sig[&dl=1]`,
  `sig = HMAC-SHA256(secret, `${key}\n${exp}\n${inline|attachment}`)`. The dev
  gateway verifies with the exported `verifyLocalSignedUrlParams` (timing-safe).
- **s3** (`src/drivers/s3.ts`) — global fetch, headers signed via the OPTIONAL
  `aws4fetch` (dynamic import; missing → typed `storage_driver_unavailable`).
  Presigned GETs are produced inline (zero deps, `src/drivers/sigv4.ts`),
  canonical request unit-tested against botocore-verified vectors.
  `forceR2Compat` = path-style addressing for R2/compatible endpoints.

## Driver selection (src/index.ts)

```ts
const result = createStorageFromEnv(parsedEnv); // StorageResult<Storage>
```

`STORAGE_DRIVER=local|s3` (required — no silent local fallback), fail-fast on
missing driver config. See `src/index.ts` header for the full env key list to
add to `packages/config` schemas + `.env.example`.
