# §13 API contract audit — endpoint table, extras, discrepancies (W4-O)

Owner: **W4-O** (OpenAPI + contract audit). Companion artifacts:

- `apps/gateway/src/openapi.ts` — the hand-authored OpenAPI 3.1 document (typed
  const), `buildOpenApiSpec()`, and `mountOpenApi(app)` serving
  `GET /v1/openapi.json`. W4-R mounts it.
- `apps/gateway/tests/openapi.test.ts` — vitest gate: the table below and the
  spec stay in lockstep (paths, flat envelope, route-file path coverage).
- `docs/BUILD_PROMPT.md` §13 — the authoritative contract being audited.

**Audit method:** every file in `apps/gateway/src/routes/` was read in full
(exports, mounted paths, zod input schemas, response bodies) plus the auth
surface (`src/auth/*`, W4-A) and the §13-relevant middleware (error-mapper,
auth-context, caps, rate-limit). Survey date: wave 4, post W4-G; only
`GET /v1/health*` is mounted in `routes/index.ts` today — every other router
awaits the W4-R wiring pass.

**Status vocabulary** (mirrored by `x-studio-status` on every operation in the
spec, so spec and audit cannot drift):

| Status | Meaning |
|---|---|
| `implemented` | Route module exists **and** is mounted (served today). |
| `wired-in-W4-R` | Route module exists; the `/v1` registry mount is W4-R's. |
| `partial` | Exists but with a flagged §13 divergence (see D-notes). |
| `not-implemented` | Contract-only; no route module yet (see D2/D3). |

**Reconciled decision (this wave):** the error envelope is the FLAT
`{ ok:false, code, message, hint, retryable, docs_url?, details? }`. §13.3's
nested `{ error: { … } }` sketch was **rejected** — `docs/AGENTS.md` code style
mandates the flat shape repo-wide, the shipped mapper
(`src/middleware/error-mapper.ts`, W1-H) emits flat, and the reconcile note in
`docs/api/README.md` ("Error envelope") queued the Wave-4 amendment to this
wave. See also D5 (422 vs 400 for validation) and D6 (401 code drift).

## Endpoint audit table

One row per concrete OpenAPI path. "§13.1 row" quotes the spec's (sometimes
combined) endpoint text; "Route file" is relative to `apps/gateway/src/`.

| §13.1 row (spec text) | OpenAPI path | Route file | Status | Notes |
|---|---|---|---|---|
| `POST /v1/auth/*` Better Auth handlers | `/v1/auth/{handler}` | `src/auth/server.ts` (no routes/ module) | partial | D1: Better Auth mounts at `/api/auth` basePath, §13.1 pins `/v1/auth/*`. W4-A modules landed; W4-R remounts or proxies. |
| `GET /v1/me` user + memberships + plan | `/v1/me` | — | not-implemented | D2 gap. |
| `POST/GET /v1/workspaces` / `GET /v1/workspaces/:id` | `/v1/workspaces` | `src/routes/workspaces.ts` (W4-E, `workspaceRoutes`) | wired-in-W4-R | GET (list mine) + POST (create + trial grant §14.1). Body = `createWorkspaceSchema` (strict). |
| `POST/GET /v1/workspaces/:id` read | `/v1/workspaces/{id}` | `src/routes/workspaces.ts` | wired-in-W4-R | GET any member; PATCH (rename/brand-tokens, admin+) also implemented — see E2. |
| *(none — workspace mgmt)* | `/v1/workspaces/{id}/members` | `src/routes/workspaces.ts` | wired-in-W4-R | E2 extra (admin+). |
| *(none — workspace mgmt)* | `/v1/workspaces/{id}/members/{userId}` | `src/routes/workspaces.ts` | wired-in-W4-R | E2 extra (admin+, last-owner protected). |
| `POST /v1/workspaces/:id/invites` | `/v1/workspaces/{id}/invites` | `src/routes/workspaces.ts` | wired-in-W4-R | GET (list) + POST (role ∈ admin/editor/viewer, never owner). |
| *(none — invite mgmt)* | `/v1/workspaces/{id}/invites/{inviteId}` | `src/routes/workspaces.ts` | wired-in-W4-R | E2 extra (cancel, admin+). |
| *(none — accept flow)* | `/v1/invites/{token}` | `src/routes/workspaces.ts` (`inviteRoutes`) | wired-in-W4-R | E3 extra: GET pre-accept view + DELETE cancel-by-token. |
| `POST /v1/invites/:token/accept` | `/v1/invites/{token}/accept` | `src/routes/workspaces.ts` (`inviteRoutes`) | wired-in-W4-R | TODO(email): address verification lands with the email wave. |
| `GET/POST /v1/projects` | `/v1/projects` | — | not-implemented | D3: no project table (W1-D). |
| `GET/POST /v1/documents` | `/v1/documents` | `src/routes/documents.ts` (W4-F, `documentRoutes` + `withDocumentDeps`) | wired-in-W4-R | Body diverges from §13.1 (D3): required `width`/`height`, no `project_id`, `template` alias of `templateId`. |
| `GET /v1/documents/:id` | `/v1/documents/{id}` | `src/routes/documents.ts` | wired-in-W4-R | Body = document + `latest_version`; §13.1's preview URL + layer summary absent (D9). PATCH/DELETE also implemented (rename/archive; DELETE = archive). |
| `GET /v1/documents/:id/versions` | `/v1/documents/{id}/versions` | `src/routes/documents.ts` | wired-in-W4-R | Ascending timeline (§10.4). |
| `POST /v1/documents/:id/versions/:versionId/restore` | `/v1/documents/{id}/versions/{versionId}/restore` | `src/routes/documents.ts` | wired-in-W4-R | Restore as a NEW version; source bytes untouched. |
| `GET /v1/documents/:id/layers` | `/v1/documents/{id}/layers` | — | not-implemented | D2 gap (layer.list). |
| `GET /v1/documents/:id/inspect` | `/v1/documents/{id}/inspect` | — | not-implemented | D2 gap (filtered scene graph). |
| `POST /v1/documents/:id/runs` | `/v1/documents/{id}/runs` | *(alias absent; canonical = `src/routes/runs.ts`)* | partial | D4: implemented as `POST /v1/runs` (camelCase body, required tier, no `model`); alias + snake_case body reconcile in W4-R. |
| `POST /v1/documents/:id/commands` | `/v1/documents/{id}/commands` | — | not-implemented | D2 gap; W4-K per `routes/documents.ts` note. §13.4 allowlist, no raw engine ids. |
| `POST /v1/documents/:id/undo` | `/v1/documents/{id}/undo` | — | not-implemented | D2 gap; W4-K. |
| `POST /v1/documents/:id/redo` | `/v1/documents/{id}/redo` | — | not-implemented | D2 gap; W4-K. |
| `POST /v1/documents/:id/exports` | `/v1/documents/{id}/exports` | — | not-implemented | D2 gap (worker-side export exists; route pending). §13.1 body documented. |
| `GET /v1/documents/:id/preview?w=1024` | `/v1/documents/{id}/preview` | — | not-implemented | D2 gap; `?w` documented. |
| *(canonical run create + E5)* | `/v1/runs` | `src/routes/runs.ts` (W4-G, `runRoutes` + `mountRunRoutes`) | wired-in-W4-R | POST = implemented §13 run create (Idempotency-Key header-or-body); GET list = E5 extra (org page, `document_id` filter). |
| `GET /v1/runs/:id` | `/v1/runs/{id}` | `src/routes/runs.ts` | wired-in-W4-R | `RunDetailApiView` (status + plan + steps + cost). |
| `POST /v1/runs/:id/cancel` | `/v1/runs/{id}/cancel` | `src/routes/runs.ts` | wired-in-W4-R | §3.4 cancel + release; terminal → 409. |
| `GET /v1/runs/:id/events` (SSE) | `/v1/runs/{id}/events` | `src/routes/runs-events.ts` (W4-H, `runEventRoutes`/`createRunEventRoutes`) | wired-in-W4-R | text/event-stream; Last-Event-ID resume; run.resync sentinel (D8). |
| `POST /v1/uploads` | `/v1/uploads` | `src/routes/uploads.ts` (W4-I, `uploadRoutes`) | wired-in-W4-R | Multipart branch implemented (D10); 413 + §20.2 gates; byte-idempotent dedupe. |
| `GET /v1/assets?project_id=` | `/v1/assets` | `src/routes/uploads.ts` | wired-in-W4-R | `project_id` accepted but does not filter yet (D3). |
| *(none — asset mgmt)* | `/v1/assets/{id}` | `src/routes/uploads.ts` | wired-in-W4-R | E4 extra: GET signed URL (ttl 900 s) + DELETE (editor+). |
| `GET /v1/templates` | `/v1/templates` | — | not-implemented | D2 gap (no catalog route module). |
| `GET /v1/components` | `/v1/components` | — | not-implemented | D2 gap (no catalog route module). |
| `GET /v1/credits` | `/v1/credits` | — | not-implemented | D2 gap (billing wave). |
| `POST /v1/billing/checkout` | `/v1/billing/checkout` | — | not-implemented | D2 gap (Stripe, §14.3). |
| `POST /v1/billing/portal` | `/v1/billing/portal` | — | not-implemented | D2 gap (Stripe, §14.3). |
| `POST /v1/webhooks/stripe` | `/v1/webhooks/stripe` | — | not-implemented | D2 gap; unauthenticated (signature-verified), idempotent by event id. |
| `GET /v1/usage?from=&to=` | `/v1/usage` | — | not-implemented | D2 gap (daily rollups). |
| `GET /v1/health` / `/v1/health/deep` | `/v1/health` | `src/routes/health.ts` + `src/routes/index.ts` | implemented | Mounted today; liveness only, no dependencies touched. |
| `GET /v1/health` / `/v1/health/deep` | `/v1/health/deep` | `src/routes/health.ts` + `src/routes/index.ts` | implemented | Mounted today (same §13.1 row as above; split for one-path-per-row); 503 when a probe is down. |
| *(W4-O, self-hosting meta)* | `/v1/openapi.json` | `src/openapi.ts` (`mountOpenApi`) | implemented | W4-R mounts; serves the audited spec. |

## Extras — implemented endpoints absent from §13.1

- **E1** (folded into E5): paged run listing beyond the single-run `GET /v1/runs/:id`.
- **E2** Workspace management beyond §13.1's "create/read": `PATCH /v1/workspaces/{id}`
  (rename/brand-tokens), `GET …/members`, `DELETE …/members/{userId}`,
  `GET …/invites`, `DELETE …/invites/{inviteId}` — admin+ ladder per ADR-0003.
- **E3** Invite lifecycle beyond `POST …/accept`: `GET /v1/invites/{token}`
  (pre-accept view; token = capability) and `DELETE /v1/invites/{token}` (cancel).
- **E4** Asset management beyond the §13.1 library listing: `GET /v1/assets/{id}`
  (metadata + short-lived signed URL) and `DELETE /v1/assets/{id}` (editor+,
  audited, re-delete → 404).
- **E5** `GET /v1/runs` — org-scoped keyset-paged list with optional
  `document_id` filter (§12.2 shape), used by the dashboard; not in §13.1.

All extras are documented in the OpenAPI spec with the same rigor as §13.1
rows (§13 should adopt or explicitly reject them when it is next amended).

## Discrepancies

- **D1 — auth mount path.** §13.1 pins `POST /v1/auth/*`; the landed auth server
  (W4-A) is Better Auth at its default basePath `/api/auth`
  (`src/auth/client-config.ts` pins `basePath: "/api/auth"`). W4-R must remount
  Better Auth under `/v1/auth` or add a gateway rewrite/proxy. The spec
  documents the §13.1 path (`/v1/auth/{handler}`) with status `partial`.
- **D2 — §13.1 endpoints with no route module yet.** `/v1/me`, `…/layers`,
  `…/inspect`, `…/commands`, `…/undo`, `…/redo`, `…/exports`, `…/preview`,
  `/v1/templates`, `/v1/components`, `/v1/credits`, `/v1/billing/checkout`,
  `/v1/billing/portal`, `/v1/webhooks/stripe`, `/v1/usage`. They answer the
  typed 501 `not_implemented` catch-all in `routes/index.ts` until their waves
  land (commands/undo/redo are W4-K per in-code notes). The spec documents each
  with `x-studio-status: not-implemented` and provisional bodies where §13.1 is
  silent.
- **D3 — projects.** The landed schema has no project table (W1-D; documents
  hang off the organization — noted in `src/routes/uploads.ts`). Consequences:
  `GET/POST /v1/projects` unimplementable as specced; `POST /v1/documents`
  lost `project_id` and gained required `width`/`height` (`createBodySchema`);
  `GET /v1/assets?project_id=` validates the parameter but cannot filter yet.
  §13.1 needs an amendment (either projects as a concept or org-scoped docs).
- **D4 — run-create path + body spelling.** §13.1 spells
  `POST /v1/documents/:id/runs` with `{ prompt, tier?, template?,
  attachment_asset_ids?, model? }` (optional tier). W4-G ships the canonical
  `POST /v1/runs` with a camelCase body (`documentId` required, `tier` REQUIRED,
  no `model` field) per its task contract. W4-R/composition must reconcile:
  alias path, snake_case fields, optional tier, `model` — until then the spec
  documents BOTH (implemented camelCase body + contract-only alias).
- **D5 — validation status code.** §13.3 lists 400 for validation; the gateway
  mapper (W1-H) answers **422** `validation_failed` (ZodError + field
  `details`), while 400 is kept for malformed request *frames* (bad JSON,
  bad multipart, malformed Last-Event-ID). This split is now the documented
  contract in the spec (both statuses appear); clients must treat 422 as the
  schema-error status. (Flagged originally by W1-H + `docs/api/README.md`.)
- **D6 — 401 code drift.** `unauthorized` (W1-H catalog + W4-E/W4-G/W4-H
  routes) vs `unauthenticated` (W4-B `auth-context` middleware). The
  add-only catalog (W4-C flag #3) should gain one canonical code and the other
  route layer should adopt it. The spec documents both as observed on 401.
- **D7 — idempotency enforcement.** §13 preamble: every mutating endpoint
  requires an `Idempotency-Key`. Today only run creation enforces replay/dedup
  (header-or-body, must agree); workspaces/documents mutations validate +
  correlate the key into the audit trail with enforcement deferred to the
  idempotency store wave (`idempotency_keys`, §12.1). The spec keeps the header
  REQUIRED on mutations per the contract and notes the enforcement state.
- **D8 — SSE beyond §13.2.** The stream also emits the `run.resync` gap
  sentinel (id = last contiguous seq; client reconnects with it as
  Last-Event-ID) — a 14th wire event type beyond §13.2's 13 — plus 15 s comment
  heartbeats, a 400 on malformed Last-Event-ID, a 499 pre-stream disconnect
  guard, and 503 `run_events_unavailable` when the router is unwired.
  §13.2 should adopt the sentinel when amended.
- **D9 — `GET /v1/documents/:id` response body.** §13.1 promises metadata +
  latest version + **preview URL + layer summary**; the DTO ships `document` +
  `latest_version` only. The preview/layer fields are covered by the (pending)
  `…/preview` and `…/layers` endpoints (D2) — either add the summary fields to
  the DTO or amend §13.1 to point at those endpoints.
- **D10 — uploads pre-signed branch.** §13.1 offers "pre-signed upload (or
  multipart)"; the multipart branch is implemented (§20.2 gates: magic-byte
  sniff, 25 MB cap → 413, 60 MP ceiling, EXIF strip in the worker, sha256
  dedupe). The pre-signed branch is not implemented; the spec documents the
  multipart contract.

## W4-R wiring notes (composition-root checklist)

1. `mountOpenApi(app)` → serves `GET /v1/openapi.json` (the spec const).
2. `v1.route("/workspaces", workspaceRoutes(deps))` +
   `v1.route("/invites", inviteRoutes(deps))` (W4-E exports both; `deps.auth`
   via `createWorkspaceAuth(resolver)`).
3. `mountRunRoutes(v1, deps, { path: "/runs" })` (W4-G one-call mount, before
   the catch-all).
4. `v1.route("/", createRunEventRoutes({ auth, runLookup, bus }))` — or keep the
   exported `runEventRoutes` const and call `wireRunEventRoutes(deps)`
   (W4-H); the bus seam adapts `@studio/agent`'s `RunEventBus` over
   `DrizzleEventStore`.
5. `v1.route("/documents", withDocumentDeps(documentRoutesDeps(db, …)))` (W4-F).
6. Uploads (W4-I): mount `uploadRoutes` on `/v1` with the two context variables
   set upstream — `uploadsDeps` (service + limits) and `auth`
   (userId/org/role) — before the router runs.
7. Resolve D1 (Better Auth under `/v1/auth`), then the D2 waves land their own
   route modules (commands/undo/redo = W4-K).
8. Keep the 501 catch-all LAST in `routes/index.ts` so concrete routes win.
