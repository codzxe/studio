# §13 API contract audit — FINAL endpoint table + discrepancy resolutions (W10-G)

Owner: **W10-G** (OpenAPI final audit). This is the **final audit** — it supersedes
the W4-O wave-4 audit and re-surveys everything that landed since: catalog
(W4-J), commands (W4-K), exports/preview (W4-L), credits/usage (W4-M),
billing/webhooks (W4-N), audit export/summary (W9-H), metrics (W9-G).

Companion artifacts:

- `apps/gateway/src/openapi.ts` — the hand-authored OpenAPI 3.1 document (typed
  const), `buildOpenApiSpec()`, and `mountOpenApi(app, { version })`. Every
  operation's `x-studio-status` mirrors the Status column below — spec and
  audit cannot drift silently (enforced by the test).
- `apps/gateway/tests/openapi.test.ts` — the vitest gate: audit table ⇄ spec
  path-set equality, flat envelope, route-source scan coverage (now including
  a routes-dir completeness check + the /metrics exclusion), CSV response,
  and (W10-R) a sweep asserting NO operation still awaits its mount.
- `apps/gateway/tests/mount-coverage.test.ts` — the W10-R registry diff: every
  route file must export a mount fn or router const AND the composition root
  must reference it.
- `docs/BUILD_PROMPT.md` §13 — the authoritative contract being audited.

**Audit method (final survey, wave 10; wiring follow-up W10-R):** every module
in `apps/gateway/src/routes/` was surveyed (workspaces, documents, runs,
runs-events, uploads, catalog, commands, exports, credits, billing, audit,
metrics, health, index) plus the composition root `src/app.ts` (the W4-R
wiring: `buildApp` mounts five groups) and `src/routes/index.ts` (health +
credit/billing/audit registry mounts + the typed 501 catch-all).
**W10-R (final integration) wired the awaiting-mount checklist:** buildApp
now mounts catalog/commands/exports through their one-call helpers (pre-baked
deps — their service seams are env/worker-driven), seam-builds the
credits/billing/audit deps (drizzle adapters in app.ts; billing additionally
gates on `GatewayDeps.billingWiring`), serves THIS audited spec at
`/v1/openapi.json` (D11), and proxies the §13.1 `/v1/auth/*` alias onto the
Better Auth handlers (D1). Absent deps ⇒ the typed 501 catch-all (W8-K).

## Status vocabulary

| Status (this table) | `x-studio-status` (spec) | Meaning |
|---|---|---|
| IMPLEMENTED+MOUNTED | `implemented` | Route module landed **and** wired by the composition root (app.ts — per-group deps gates: absent seams ⇒ the /v1 catch-all answers 501). |
| IMPLEMENTED-AWAITING-MOUNT | `implemented-awaiting-mount` | Route module + one-call mount helper landed; composition root not wired yet. **No row carries this since W10-R** — kept for future modules. |
| PARTIAL | `partial` | Served, but with a flagged §13 divergence (D-notes). |
| NOT-IMPLEMENTED | `not-implemented` | Contract-only; no route module. |

Reconciliation: the wave-4 vocabulary `wired-in-W4-R` is **retired** — every
row that carried it is now IMPLEMENTED+MOUNTED (W4-R happened, in app.ts).
W10-R then flipped the 19 awaiting-mount rows: all 47 audited paths that have
a route module are mounted as of wave 10.

## The flat error envelope — DECIDED (decision note + authority pointers)

Every error on `/v1` is the FLAT envelope
`{ ok:false, code, message, hint, retryable, docs_url?, details? }`.
§13.3's sketch of a nested `{ error: { … } }` shape was **rejected** in wave 4
(decision W4-O) and is **re-affirmed** by this final audit. Authority chain:

1. `docs/AGENTS.md` "Code style" (fleet law): *typed result envelopes
   `{ ok:false, code, message, hint, retryable? }`*.
2. The shipped mapper: `apps/gateway/src/middleware/error-mapper.ts` (W1-H) —
   the only error renderer on /v1.
3. The reconcile note: `docs/api/README.md` → "Error envelope" (queued the
   wave-4 amendment; also records the 400-vs-422 split, D5).
4. Recorded in `apps/gateway/src/openapi.ts` RECONCILED DECISIONS #1 and in
   the served `ErrorEnvelope` schema (test-enforced: the nested shape must NOT
   appear).

There is **no numbered ADR for this decision yet** — next action: record it as
`docs/adr/0006-error-envelope.md` (owner: the docs/ADR owner; this wave does
not create files outside its scope). The only place a nested error shape
exists in the repo is the internal `/metrics` 401 (out-of-band, below) —
outside the /v1 contract.

## Final endpoint audit table

One row per concrete OpenAPI path (47). "§13.1 row" quotes the spec's
(sometimes combined) endpoint text; "Route file · wire fn" is the evidence
(exported router const / one-call mount helper, and the app.ts mount for
IMPLEMENTED+MOUNTED rows). Route files are relative to `apps/gateway/src/`.

| §13.1 row (spec text) | OpenAPI path | Route file · wire fn | Status | Notes |
|---|---|---|---|---|
| `POST /v1/auth/*` Better Auth handlers | `/v1/auth/{handler}` | `src/auth/server.ts` · **app.ts (W10-R): `/api/auth/*{path}` + the `/v1/auth/*{path}` URL-rewrite proxy** | IMPLEMENTED+MOUNTED | D1 RESOLVED: Better Auth stays at its pinned basePath `/api/auth` (client-config.ts); the composition root proxies the §13.1 alias onto the same handler (method/headers/body verbatim). |
| `GET /v1/me` user + memberships + plan | `/v1/me` | — | NOT-IMPLEMENTED | D2 remainder. |
| `POST/GET /v1/workspaces` | `/v1/workspaces` | `routes/workspaces.ts` `workspaceRoutes` · app.ts:660 `v1.route("/workspaces", …)` | IMPLEMENTED+MOUNTED | GET list-mine + POST create (+ trial grant §14.1); `createWorkspaceSchema` strict. |
| `GET /v1/workspaces/:id` (+mgmt) | `/v1/workspaces/{id}` | `routes/workspaces.ts` · app.ts:660 | IMPLEMENTED+MOUNTED | GET any member; PATCH rename/brand-tokens (admin+) — E2. |
| *(none — workspace mgmt)* | `/v1/workspaces/{id}/members` | `routes/workspaces.ts` · app.ts:660 | IMPLEMENTED+MOUNTED | E2 extra (admin+). |
| *(none — workspace mgmt)* | `/v1/workspaces/{id}/members/{userId}` | `routes/workspaces.ts` · app.ts:660 | IMPLEMENTED+MOUNTED | E2 extra (admin+, last-owner protected). |
| `POST /v1/workspaces/:id/invites` | `/v1/workspaces/{id}/invites` | `routes/workspaces.ts` · app.ts:660 | IMPLEMENTED+MOUNTED | GET (list) + POST (role ∈ admin/editor/viewer, never owner). |
| *(none — invite mgmt)* | `/v1/workspaces/{id}/invites/{inviteId}` | `routes/workspaces.ts` · app.ts:660 | IMPLEMENTED+MOUNTED | E2 extra (cancel, admin+). |
| *(none — accept flow)* | `/v1/invites/{token}` | `routes/workspaces.ts` `inviteRoutes` · app.ts:663 | IMPLEMENTED+MOUNTED | E3 extra: pre-accept view + DELETE cancel-by-token. |
| `POST /v1/invites/:token/accept` | `/v1/invites/{token}/accept` | `routes/workspaces.ts` `inviteRoutes` · app.ts:663 | IMPLEMENTED+MOUNTED | TODO(email): address verification lands with the email wave. |
| `GET/POST /v1/projects` | `/v1/projects` | — | NOT-IMPLEMENTED | D3 OPEN: no project table (W1-D). |
| `GET/POST /v1/documents` | `/v1/documents` | `routes/documents.ts` `documentRoutes`/`withDocumentDeps` · app.ts:676 | IMPLEMENTED+MOUNTED | Body diverges from §13.1 (D3): required `width`/`height`, no `project_id`, `template` alias of `templateId`. |
| `GET /v1/documents/:id` | `/v1/documents/{id}` | `routes/documents.ts` · app.ts:676 | IMPLEMENTED+MOUNTED | `document` + `latest_version`; §13.1's preview URL + layer summary not in the DTO (D9). PATCH/DELETE (archive) also implemented. |
| `GET /v1/documents/:id/versions` | `/v1/documents/{id}/versions` | `routes/documents.ts` · app.ts:676 | IMPLEMENTED+MOUNTED | Ascending timeline (§10.4). |
| `POST /v1/documents/:id/versions/:versionId/restore` | `/v1/documents/{id}/versions/{versionId}/restore` | `routes/documents.ts` · app.ts:676 | IMPLEMENTED+MOUNTED | Restore as a NEW version; source bytes untouched. |
| `GET /v1/documents/:id/layers` | `/v1/documents/{id}/layers` | — | NOT-IMPLEMENTED | D2 remainder (layer.list). |
| `GET /v1/documents/:id/inspect` | `/v1/documents/{id}/inspect` | — | NOT-IMPLEMENTED | D2 remainder (filtered scene graph). |
| `POST /v1/documents/:id/runs` (§13.1 alias) | `/v1/documents/{id}/runs` | *(alias absent; canonical = `routes/runs.ts`)* | PARTIAL | D4 OPEN: implemented as `POST /v1/runs` (camelCase body, required tier). Alias + snake_case reconcile pending. |
| *(canonical run create)* | `/v1/runs` | `routes/runs.ts` `runRoutes`/`mountRunRoutes` · app.ts:687 | IMPLEMENTED+MOUNTED | POST = §13 run create (Idempotency-Key header-or-body, replay enforced). GET = E1/E5 org page with `document_id` filter. |
| `GET /v1/runs/:id` | `/v1/runs/{id}` | `routes/runs.ts` · app.ts:687 | IMPLEMENTED+MOUNTED | `RunDetailApiView` (status + plan + steps + cost). |
| `POST /v1/runs/:id/cancel` | `/v1/runs/{id}/cancel` | `routes/runs.ts` · app.ts:687 | IMPLEMENTED+MOUNTED | §3.4 cancel + release; terminal → 409. |
| `GET /v1/runs/:id/events` (SSE) | `/v1/runs/{id}/events` | `routes/runs-events.ts` `createRunEventRoutes` · app.ts:705 | IMPLEMENTED+MOUNTED | text/event-stream; Last-Event-ID resume; `run.resync` sentinel (D8). SSE notes below. |
| `POST /v1/documents/:id/commands` | `/v1/documents/{id}/commands` | `routes/commands.ts` `commandRoutes`/`mountCommandRoutes` · **app.ts mount (W10-R, pre-baked deps)** | IMPLEMENTED+MOUNTED | W4-K. §13.4 allowlist only (raw engine ids never exposed); idempotency key REQUIRED header-or-body (absent ⇒ 422); §6.1 compact `CommandReply`. |
| `POST /v1/documents/:id/undo` | `/v1/documents/{id}/undo` | `routes/commands.ts` · **app.ts mount (W10-R)** | IMPLEMENTED+MOUNTED | W4-K. ONE step (engine edit.undo); same key rule; same reply. |
| `POST /v1/documents/:id/redo` | `/v1/documents/{id}/redo` | `routes/commands.ts` · **app.ts mount (W10-R)** | IMPLEMENTED+MOUNTED | W4-K. ONE step (engine edit.redo). |
| `POST /v1/documents/:id/exports` | `/v1/documents/{id}/exports` | `routes/exports.ts` `exportRoutes`/`mountExportRoutes` · **app.ts mount (W10-R, pre-baked deps)** | IMPLEMENTED+MOUNTED | W4-L. POST 202 `{ export_id, status, revision, warnings }` (jobId = key); GET = past-jobs listing (E10). Editor+ / viewer+ per method. |
| `GET /v1/documents/:id/preview?w=1024` | `/v1/documents/{id}/preview` | `routes/exports.ts` `previewRoutes`/`mountExportRoutes` · **app.ts mount (W10-R, pre-baked deps)** | IMPLEMENTED+MOUNTED | W4-L. Signed URL (ttl 900 s) + Location; 404 `preview_not_rendered` until the worker renders. |
| `POST /v1/uploads` | `/v1/uploads` | `routes/uploads.ts` `uploadRoutes` · app.ts:740 (auth gate + §20.2 cap + context) | IMPLEMENTED+MOUNTED | Multipart branch (D10); 413 + §20.2 gates; byte-idempotent dedupe. |
| `GET /v1/assets?project_id=` | `/v1/assets` | `routes/uploads.ts` · app.ts:740 | IMPLEMENTED+MOUNTED | `project_id` accepted but does not filter (D3). |
| *(none — asset mgmt)* | `/v1/assets/{id}` | `routes/uploads.ts` · app.ts:740 | IMPLEMENTED+MOUNTED | E4 extra: GET signed URL (ttl 900 s) + DELETE (editor+). |
| `GET /v1/templates` | `/v1/templates` | `routes/catalog.ts` `catalogRoutes`/`mountCatalogRoutes` · **app.ts mount (W10-R, pre-baked deps)** | IMPLEMENTED+MOUNTED | W4-J. Discovery cards (§7.4) — NOT manifests; `?tags` (AND) + `?query`; per-org bucket 120/min fails open. |
| *(none — manifest fetch)* | `/v1/templates/{id}` | `routes/catalog.ts` · **app.ts mount (W10-R)** | IMPLEMENTED+MOUNTED | E6 extra (W4-J): full §7.2 manifest; `?version=N` pin; miss ⇒ 404 `unknown_template`. |
| `GET /v1/components` | `/v1/components` | `routes/catalog.ts` · **app.ts mount (W10-R)** | IMPLEMENTED+MOUNTED | W4-J. Discovery cards (§8.3); same filter semantics. |
| *(none — manifest fetch)* | `/v1/components/{id}` | `routes/catalog.ts` · **app.ts mount (W10-R)** | IMPLEMENTED+MOUNTED | E6 extra (W4-J): full manifest; miss ⇒ 404 `unknown_component`. |
| *(none — workspace templates)* | `/v1/workspaces/{id}/templates` | `routes/catalog.ts` · **app.ts mount (W10-R)** | IMPLEMENTED+MOUNTED | E7 extra (W4-J, §7.2): admin+ registers a workspace-private manifest; Idempotency-Key header REQUIRED; replay ⇒ 200 duplicate. |
| `GET /v1/credits` | `/v1/credits` | `routes/credits.ts` `creditRoutes`/`mountCreditsRoutes` · **routes/index.ts registry (W10-R seam-built deps)** | IMPLEMENTED+MOUNTED | W4-M. Viewer+ (no billing READ row in the matrix); `{ balance, ledger: { rows, next_cursor? } }` (§12.2 sum sanity). |
| *(none — billing card)* | `/v1/credits/summary` | `routes/credits.ts` · **routes/index.ts registry (W10-R)** | IMPLEMENTED+MOUNTED | E8 extra (W4-M): 30d spend, open holds, trial flag. |
| `GET /v1/usage?from=&to=` | `/v1/usage` | `routes/credits.ts` `usageRoutes`/`mountCreditsRoutes` · **routes/index.ts registry (W10-R seam-built deps)** | IMPLEMENTED+MOUNTED | W4-M. Zero-filled UTC-day rollups: per-kind credit sums + run stats + totals; window ≤ USAGE_MAX_DAYS ⇒ 422. |
| *(none — plans)* | `/v1/billing/plans` | `routes/billing.ts` `billingRoutes`/`mountBillingRoutes` · **routes/index.ts registry (W10-R; gates on `billingWiring`)** | IMPLEMENTED+MOUNTED | E9 extra (W4-N): public plan cards + credit pack from @studio/config. |
| `POST /v1/billing/checkout` | `/v1/billing/checkout` | `routes/billing.ts` · **routes/index.ts registry (W10-R)** | IMPLEMENTED+MOUNTED | W4-N. Owner/admin (ADR-0003 row 8). camelCase body `{ planCode, workspaceId }` (D4). |
| `POST /v1/billing/portal` | `/v1/billing/portal` | `routes/billing.ts` · **routes/index.ts registry (W10-R)** | IMPLEMENTED+MOUNTED | W4-N. Owner/admin; body `{ workspaceId }`. |
| `POST /v1/webhooks/stripe` | `/v1/webhooks/stripe` | `routes/billing.ts` `stripeWebhookRoutes`/`mountBillingRoutes` · **routes/index.ts registry (W10-R)** | IMPLEMENTED+MOUNTED | W4-N. No auth (signature is the auth); RAW-body verify ⇒ 400 `invalid_signature`; idempotent by event id; `{ ok, received, handled, duplicate }`. |
| *(none — §22 export)* | `/v1/workspaces/{id}/audit` | `routes/audit.ts` `workspaceAuditRoutes`/`mountAuditRoutes` · **routes/index.ts registry (W10-R seam-built deps)** | IMPLEMENTED+MOUNTED | E11 extra (W9-H, §22): admin+ cursor-paged export; `?format=csv` = same rows as RFC 4180 download (cursor in `X-Next-Cursor`); D13 RBAC note. |
| *(none — §22 summary)* | `/v1/audit/summary/{id}` | `routes/audit.ts` `auditSummaryRoutes`/`mountAuditRoutes` · **routes/index.ts registry (W10-R seam-built deps)** | IMPLEMENTED+MOUNTED | E11 extra (W9-H, §22): counts by action, last 30 days (admin tooling). |
| `GET /v1/health` | `/v1/health` | `routes/health.ts` `healthRoutes` · routes/index.ts:44 via `registerRoutes` (app.ts:749) | IMPLEMENTED+MOUNTED | Liveness only; O(1). |
| `GET /v1/health/deep` | `/v1/health/deep` | `routes/health.ts` · routes/index.ts:44 | IMPLEMENTED+MOUNTED | 503 when a probe is down. |
| *(W4-O meta)* | `/v1/openapi.json` | **app.ts `mountOpenApi(app, { version })` (W10-R)** — the audited spec | IMPLEMENTED+MOUNTED | D11 RESOLVED: serves `buildOpenApiSpec()` over the audited `OPENAPI_SPEC` with the running version stamped; the W4-R minimal runtime document was retired. |

**Tally (W10-R):** 42 IMPLEMENTED+MOUNTED · 0 IMPLEMENTED-AWAITING-MOUNT ·
1 PARTIAL · 4 NOT-IMPLEMENTED — 47 paths, one audit row each (test-enforced
set equality with the spec). The one PARTIAL row is the D4 alias
(`/v1/documents/{id}/runs` — §13.1 reconcile pending); the four
NOT-IMPLEMENTED rows are `/v1/me`, `/v1/projects`, and the `…/layers` +
`…/inspect` reads.

## Extras — implemented endpoints absent from §13.1 (amendment candidates)

- **E1/E5** `GET /v1/runs` — org-scoped keyset-paged run list with optional
  `document_id` filter (§12.2 shape), used by the dashboard.
- **E2** Workspace management: `PATCH /v1/workspaces/{id}`,
  `GET …/members`, `DELETE …/members/{userId}`, `GET …/invites`,
  `DELETE …/invites/{inviteId}` — admin+ ladder per ADR-0003.
- **E3** Invite lifecycle: `GET /v1/invites/{token}` (token = capability),
  `DELETE /v1/invites/{token}`.
- **E4** Asset management: `GET /v1/assets/{id}` (signed URL, ttl 900 s),
  `DELETE /v1/assets/{id}` (editor+, audited).
- **E6** Catalog item reads: `GET /v1/templates/{id}`,
  `GET /v1/components/{id}` — full §7.2/§8 manifests with `?version=N` pins.
- **E7** `POST /v1/workspaces/{id}/templates` — workspace-private template
  registration (§7.2 license).
- **E8** `GET /v1/credits/summary` — 30-day spend / open holds / trial flag.
- **E9** `GET /v1/billing/plans` — public §14.1 plan cards.
- **E10** `GET /v1/documents/{id}/exports` — past-jobs listing for one
  document (the §13.1 flow only specced the create).
- **E11** §22 audit surface (W9-H): `GET /v1/workspaces/{id}/audit` (the
  "exportable per workspace" requirement, JSON **or** RFC 4180 CSV) +
  `GET /v1/audit/summary/{id}` (support landing card).

All extras are documented in the spec with the same rigor as §13.1 rows. §13
should adopt or explicitly reject each when next amended.

## Discrepancies — W4-O's list, resolved or explained

- **D1 — auth mount path. RESOLVED (W10-R).** §13.1 pins `/v1/auth/*`; the
  auth server (W4-A) keeps its pinned basePath
  (`src/auth/client-config.ts` pins `"/api/auth"` — the web client + the
  Caddyfile route it). The composition root (app.ts) now executes W4-A's
  mount recipe verbatim — `app.all("/api/auth/*{path}")` — and adds the
  §13.1 alias `app.all("/v1/auth/*{path}")`, a URL-rewrite proxy that maps
  the basePath portion only (method/headers/body verbatim) so ONE Better
  Auth handler serves both prefixes. Both resolve `getAuthServer()` lazily
  (§4 fail-fast on first auth request when BETTER_AUTH_URL is missing).
- **D2 — §13.1 endpoints with no route module. MOSTLY RESOLVED.** Of W4-O's 15
  gaps, eleven now have route modules (commands/undo/redo = W4-K, exports +
  preview = W4-L, templates/components + registration = W4-J, credits +
  summary + usage = W4-M, checkout/portal/webhook + plans = W4-N). Remaining
  NOT-IMPLEMENTED: `/v1/me`, `/v1/documents/{id}/layers`,
  `/v1/documents/{id}/inspect` (+ `/v1/projects`, D3). The typed 501
  catch-all in `routes/index.ts` answers for all of them.
- **D3 — projects. OPEN.** No project table (W1-D); documents hang off the
  organization. `POST /v1/documents` has no `project_id`; `?project_id=` on
  assets validates but does not filter. §13.1 needs an amendment (projects as
  a concept, or org-scoped documents).
- **D4 — §13.1 alias + field spelling. OPEN.** `POST /v1/documents/:id/runs`
  with snake_case `{ prompt, tier?, template?, attachment_asset_ids?, model? }`
  is still contract-only; the canonical `POST /v1/runs` (W4-G) takes a
  camelCase body with REQUIRED `tier` and no `model`. The family grew in
  wave 4: `POST /v1/billing/checkout` also ships a camelCase body
  (`{ planCode, workspaceId }`, W4-N contract, runs.ts precedent). Both await
  the §13.1 reconciliation (alias paths + snake_case acceptance).
- **D5 — validation status code. RESOLVED (documented contract).** 400 =
  malformed request frames (bad JSON/multipart/Last-Event-ID); 422 =
  `validation_failed` + field-level `details` (W1-H mapper). Both statuses are
  documented in the spec on every affected operation; the §13.3 text amendment
  is pending but the wire contract is decided.
- **D6 — 401 code drift. OPEN.** `unauthorized` (W1-H catalog + the W4-K/L/M/J
  auth seam types) vs `unauthenticated` (W4-B `auth-context`; the uploads gate
  in app.ts; internal /metrics). The add-only @studio/config catalog should
  gain one canonical code; route layers adopt it. The spec documents both as
  observed on 401.
- **D7 — idempotency enforcement. PARTIALLY RESOLVED.** Enforced today (not
  just correlated): run create (replay, jobId = runId), manual
  commands/undo/redo (key REQUIRED header-or-body, §3.4 replay), export create
  (key REQUIRED, jobId = key), workspace template registration (header
  REQUIRED). Still validate/correlate-only: workspace and document mutations
  (idempotency store wave pending). Billing checkout/portal accept the header
  per §13 but route-side validation was not observed (Stripe-side idempotency
  lives in the service).
- **D8 — SSE beyond §13.2. OPEN (adoption pending).** The stream emits the
  `run.resync` gap sentinel (14th wire type; id = last contiguous seq), 15 s
  comment heartbeats, 400 on malformed Last-Event-ID, a 499 pre-stream
  disconnect guard, and 503 `run_events_unavailable` when unwired. All are in
  the spec; §13.2 should adopt the sentinel when amended.
- **D9 — `GET /v1/documents/:id` body. PARTIALLY RESOLVED.** The DTO ships
  `document` + `latest_version` only. The §13.1 preview URL is now served by
  `GET …/preview` (W4-L — mounted by app.ts since W10-R); the layer summary
  needs `…/layers` (still D2). Recommended amendment: §13.1 points at those
  endpoints instead of inlining the fields.
- **D10 — uploads pre-signed branch. UNCHANGED (explained).** The multipart
  branch is the implemented §13.1 offer (§20.2 gates: magic-byte sniff, 25 MB
  cap → 413, 60 MP ceiling, EXIF strip in the worker, sha256 dedupe). The
  pre-signed branch is not implemented and not documented.
- **D11 — `/v1/openapi.json` serves a different document. RESOLVED (W10-R,
  found by this audit).** app.ts now registers the endpoint via
  `mountOpenApi(app, { version: deps.version })` — the audited document
  (`buildOpenApiSpec()` over `OPENAPI_SPEC`, running version stamped into
  `info.version`) is served and the W4-R minimal runtime document
  (`openApiDocument(deps.version, openapiPaths)`) was retired with it. A
  generated spec may still supersede this one per `docs/api/README.md`
  "OpenAPI".
- **D12 — read-side envelopes omit `ok:true`. EXPLAINED-ACCEPTED (new).** List
  endpoints answer bare payloads (`{ runs }`, `{ assets }`, `{ templates }`,
  `{ components }`, `{ balance, ledger }`, `{ from, to, days, totals }`,
  `{ exports }`, `{ rows }`), while other success bodies carry `ok:true`
  (billing, commands, preview, registration, restore). §13.1 never pinned
  `ok` on reads; the spec documents each body as shipped. Amendment should
  standardize one style (either is defensible — pick one).
- **D13 — audit RBAC rides `members:manage`. EXPLAINED (new).** ADR-0003's
  matrix has no audit permission and one may not be invented locally (matrix
  drift fails CI). W9-H gates admin+ via the matrix-granted
  `members:manage` capability (assertCan ALSO narrows API-key scopes) with a
  one-line swap constant (`AUDIT_GATE_PERMISSION`) for when the matrix grows
  `audit:read`.

## SSE contract notes (§13.2, as shipped)

- `GET /v1/runs/{id}/events` — `text/event-stream`; frames
  `id: <seq>`, `event: <type>`,
  `data: { seq, run_id, at, type, payload }`. Event strings are owned by
  `@studio/config` (`packages/config/src/constants/events.ts`) — never rename.
- 13 §13.2 types + the `run.resync` gap sentinel (D8): backfill replays
  `run_events` rows with `seq > Last-Event-ID`, then live delivery, deduped by
  `seq` on both sides. The header wins over `?lastEventId=`.
- A seq gap emits `run.resync` (id = last contiguous seq) and closes the
  response — reconnect with that Last-Event-ID to re-heal from the durable
  store. The stream also closes after a terminal event
  (`run.succeeded|failed|cancelled`). Comment heartbeat (`: hb`) every 15 s.
- Failure modes: 400 malformed Last-Event-ID; 404 with the SAME envelope for
  unknown and cross-tenant run ids (§15.1 existence hiding); 503
  `run_events_unavailable` when the router is unwired; 499-style pre-stream
  disconnect guard.

## Out-of-band surfaces (documented, deliberately NOT §13 paths)

- **`GET /metrics`** (`routes/metrics.ts`, W9-G) — the internal-only Prometheus
  exposition (§22/§17.2): gateway HTTP counters, the shared W9-D registry,
  queue-depth gauges, engine-session gauges, uptime/build. It mounts OUTSIDE
  `/v1`, the compose wiring must bind it to the internal network only, and it
  sits behind the METRICS_TOKEN Basic-auth seam (fail-closed 401 when the
  token is unset — note its 401 uses the nested `error:{…}` shape, which is
  tolerable ONLY because this surface is out-of-band and not part of the
  flat-envelope /v1 contract; normalization flagged to the owner). It is
  deliberately absent from the OpenAPI document (test-enforced).
- **`/api/auth/*{path}`** — the Better Auth handlers (W4-A), publicly reachable
  but outside the versioned /v1 surface; see D1.

## Composition-root checklist (the awaiting-mount wiring)

One helper call per landed module — mount BEFORE the /v1 catch-all in
`routes/index.ts` / the app bootstrap (app.ts):

| One-call mount helper (wire fn) | Route file | Spec paths it covers |
|---|---|---|
| `mountAuditRoutes(app, deps)` | `routes/audit.ts` | `/v1/workspaces/{id}/audit`, `/v1/audit/summary/{id}` |
| `mountCatalogRoutes(app, deps)` | `routes/catalog.ts` | `/v1/templates`, `/v1/templates/{id}`, `/v1/components`, `/v1/components/{id}`, `/v1/workspaces/{id}/templates` |
| `mountCommandRoutes(app, deps)` | `routes/commands.ts` | `/v1/documents/{id}/commands`, `/v1/documents/{id}/undo`, `/v1/documents/{id}/redo` |
| `mountExportRoutes(app, deps)` | `routes/exports.ts` | `/v1/documents/{id}/exports`, `/v1/documents/{id}/preview` |
| `mountCreditsRoutes(app, deps)` | `routes/credits.ts` | `/v1/credits`, `/v1/credits/summary`, `/v1/usage` |
| `mountBillingRoutes(app, deps)` | `routes/billing.ts` | `/v1/billing/plans`, `/v1/billing/checkout`, `/v1/billing/portal`, `/v1/webhooks/stripe` |
| `metricsRoutes(deps)` via the bootstrap mount hook | `routes/metrics.ts` | `/metrics` — internal-only, never under /v1 |

Each helper guards its own deps seam (missing seams ⇒ typed 500 `internal_error`
with a wiring hint, or the 503 `not_configured` placeholder in billing.ts).

## Next actions (owners beyond this wave's scope)

1. **Wire the seven modules** above in the composition root (app.ts bootstrap
   owner) — that flips 19 IMPLEMENTED-AWAITING-MOUNT rows to
   IMPLEMENTED+MOUNTED; the audit table + `x-studio-status` values move with
   them (mechanically).
2. **D11:** serve the audited spec at `/v1/openapi.json` (call
   `mountOpenApi(app)` or `buildOpenApiSpec()` from the bootstrap), or land
   the zod-generated spec per `docs/api/README.md` and retire the const.
3. **D1:** remount/proxy Better Auth under `/v1/auth/*`.
4. **Remaining D2 rows:** `/v1/me`, `…/layers`, `…/inspect` — owner waves TBD.
5. **D6:** canonicalize the 401 code in the add-only @studio/config catalog.
6. **Record the flat-envelope ADR** (`docs/adr/0006-error-envelope.md`).
7. **§13 amendment bundle:** adopt/reject E2–E11; resolve D3 (projects), D4
   (alias + snake_case), D5 (422 text), D8 (sentinel), D12 (ok:true style).
