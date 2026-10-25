# Gateway API Gap Map (W-R2, reader agent)

> **SUPERSEDED (W5-08, 2026-10-23):** this is a pre-landing read-wave audit
> snapshot. Waves W1–W5 have landed the product it maps — see the per-milestone
> evidence files (`docs/phases/M0.md`–`M8.md`), `docs/phases/m8-cli-spike.md`
> and the fleet `worklog.md` for current state. Every DONE/PARTIAL/MISSING
> verdict below is historical, not a statement about the tree today. Kept for
> the paper trail; do not cite it as a gap list.


Scope: `services/gateway/**` (app.ts, all 18 src modules, all 17 route modules,
tests/) assessed against `docs/BUILD_PLAN.md` M1-M8 API-relevant tasks.
Verdicts: DONE / PARTIAL / MISSING / STUB. Evidence is `file:line` under
`services/gateway/` unless another path is given. Date: 2026-10-22.

Headline: the gateway is a well-built API skeleton (W2-b/W3-gw, commits b34b5ec
+ 76c8d4a) with real auth, tenancy, versions, leases, credits plumbing and a
clean SSE transport - but the two things that make the product work are absent:
the model runner is a MOCK (no LiteLLM client anywhere) and the render worker
does not exist (`services/worker/src/` is an empty directory).

## 1. Route inventory (43 registrations)

Auth column: `session` = Better Auth cookie (requireAuth), `+role` = minimum
workspace role via x-workspace-id (requireWorkspace), `token` = unguessable
signed-URL token, `sig` = Stripe signature.

| # | Method | Path | Handler | Auth | Status |
|---|--------|------|---------|------|--------|
| 1 | POST,GET | /v1/auth/* | app.ts:104 (better-auth handler) | session plugin | DONE (email/pw + OAuth; apiKey/admin/org plugins in packages/db/src/auth.ts:103-123) |
| 2 | GET | /health | routes/health.ts:24 | none | DONE (db:false degraded boot) |
| 3 | GET | /v1/health | routes/health.ts:25 | none | DONE |
| 4 | GET | /v1/me | routes/me.ts:19 | session | DONE (plan stubbed "trial", real ledger balance) |
| 5 | GET | /v1/workspaces | routes/workspaces.ts:29 | session | DONE |
| 6 | POST | /v1/workspaces | routes/workspaces.ts:34 | session | DONE (slug check, audit) |
| 7 | GET | /v1/workspaces/:id | routes/workspaces.ts:60 | session+viewer | DONE (id or slug) |
| 8 | PATCH | /v1/workspaces/:id | routes/workspaces.ts:75 | session+admin | DONE |
| 9 | POST | /v1/workspaces/:id/invites | routes/invites.ts:19 | admin | DONE (audited) |
| 10 | POST | /v1/invites/:token/accept | routes/invites.ts:62 | session | DONE (audited) |
| 11 | GET | /v1/projects | routes/projects.ts:40 | viewer | DONE (cursor page) |
| 12 | POST | /v1/projects | routes/projects.ts:60 | editor | DONE (blank only; no .ecproj import) |
| 13 | GET | /v1/projects/:id | routes/projects.ts:127 | viewer | DONE |
| 14 | GET | /v1/projects/:id/manifest | routes/projects.ts:79 | viewer | DONE (M3 load sequence: version + assets + 10-min signed URLs, signing.ts:4) |
| 15 | PATCH | /v1/projects/:id | routes/projects.ts:132 | editor | PARTIAL (name/description only; no thumbnail) |
| 16 | DELETE | /v1/projects/:id | routes/projects.ts:150 | editor | PARTIAL (soft delete; no restore endpoint) |
| 17 | GET | /v1/projects/:id/versions | routes/versions.ts:76 | viewer | DONE |
| 18 | POST | /v1/projects/:id/versions | routes/versions.ts:96 | editor | DONE (multipart + raw; server sha256; 409 on stale base) |
| 19 | POST | /v1/projects/:id/versions/:version/restore | routes/versions.ts:217 | editor | DONE (restore = new version) |
| 20 | POST | /v1/projects/:id/lease | routes/leases.ts:20 | editor | DONE (acquire = renew; readOnly flag) |
| 21 | DELETE | /v1/projects/:id/lease | routes/leases.ts:56 | editor | DONE |
| 22 | GET | /v1/assets | routes/assets.ts:43 | viewer | DONE |
| 23 | POST | /v1/assets | routes/assets.ts:65 | editor | PARTIAL (two-phase presign; no MIME sniff/probe/dedupe - client-declared, assets.ts:1-4) |
| 24 | GET | /v1/assets/:id/url | routes/assets.ts:122 | viewer | DONE |
| 25 | GET | /v1/projects/:id/threads | routes/threads.ts:41 | viewer | DONE |
| 26 | POST | /v1/projects/:id/threads | routes/threads.ts:61 | editor | DONE |
| 27 | GET | /v1/threads/:id/messages | routes/threads.ts:79 | viewer | DONE |
| 28 | POST | /v1/threads/:id/chat | routes/chat.ts:50 | editor | PARTIAL (real SSE transport; MOCK runner, see sec 3) |
| 29 | GET | /v1/runs/:id | routes/runs.ts:54 | viewer | DONE |
| 30 | POST | /v1/runs/:id/cancel | routes/runs.ts:59 | editor | DONE (cancel + full refund) |
| 31 | POST | /v1/runs/:id/events | routes/runs.ts:102 | editor | DONE (tool.result sink + apply.result -> version + settle) |
| 32 | GET | /v1/credits | routes/credits.ts:43 | viewer | PARTIAL (balance real; plan/includedCredits stubbed) |
| 33 | GET | /v1/credits/ledger | routes/credits.ts:73 | viewer | DONE (append-only ledger page) |
| 34 | POST | /v1/billing/checkout | routes/billing.ts:39 | admin | DONE (Stripe SDK; subscription + packs) |
| 35 | POST | /v1/billing/portal | routes/billing.ts:105 | admin | DONE (customer auto-create, id in org metadata) |
| 36 | POST | /v1/webhooks/stripe | routes/billing.ts:143 | sig | PARTIAL (signature + event-id idempotency; ONLY checkout.session.completed handled) |
| 37 | POST | /v1/renders | routes/renders.ts:62 | editor | STUB (row queued; noop worker, renders.ts:25-31) |
| 38 | GET | /v1/renders/:id | routes/renders.ts:84 | viewer | STUB (nothing ever advances status) |
| 39 | GET | /v1/projects/:id/comments | routes/comments.ts:32 | viewer | PARTIAL (list + resolved filter; compId filter is client-side, comments.ts:52-55) |
| 40 | POST | /v1/projects/:id/comments | routes/comments.ts:58 | viewer | PARTIAL (create only; no reply/resolve endpoints) |
| 41 | GET | /v1/projects/:id/activity | routes/activity.ts:30 | viewer | PARTIAL (feed real; actorName null, activity.ts:23; no export) |
| 42 | GET | /v1/local-storage/:token | routes/local-storage.ts:18 | token | DONE (local env only) |
| 43 | PUT | /v1/local-storage/:token | routes/local-storage.ts:33 | token | DONE (streams to disk) |

Routes with NO implementation anywhere in the gateway (BUILD_PLAN asks for
them): member removal / role change / transfer ownership / switch workspace;
project duplicate + import; asset delete; render list/history/cancel/progress;
comments reply/resolve + guest comments; presence; share/review token
(`/s/:token`); audit export; OpenAPI spec (docs/api README defers to Wave 4).

## 2. Milestone coverage (BUILD_PLAN M1-M8, API-relevant tasks)

| Milestone / task | Verdict | Evidence |
|---|---|---|
| M1 Better Auth (org+apiKey+admin plugins, email/pw, Google/GitHub, roles) | DONE | packages/db/src/auth.ts:103-123; gateway seam src/auth.ts:78-92; roles enforced middleware.ts:253-297 |
| M1 workspace lifecycle | PARTIAL | create/slug/invite/accept DONE (workspaces.ts, invites.ts); remove member, transfer ownership, switch: MISSING |
| M1 API foundation (Zod envelopes, request ids, error map, tenant repos, idempotency) | DONE | http.ts:14-52; middleware.ts:27-35,120-214; errors.ts:26-216; cross-tenant 404s middleware.ts:277-284 + tests |
| M1 onboarding trial stub | PARTIAL | me.ts:49-55 hardcodes plan "trial"; credits.ts:18-23 stub allowance |
| M1 tests (auth, invite, role matrix, cross-tenant, api-key scopes) | PARTIAL | 10 auth-workspace tests incl. viewer 403; API-key scope tests MISSING |
| M2 projects CRUD | PARTIAL | CRUD+soft-delete DONE (projects.ts); duplicate/import/thumbnail/restore-after-delete MISSING |
| M2 assets (sniff, probe, sha dedupe, signed URLs, scoping) | PARTIAL | presigned two-phase upload DONE (assets.ts:65-120); sniffing/probe/dedupe MISSING (client-declared; verify-by-head deferred, assets.ts:2-4) |
| M2 versions (immutable, base, sha, restore, 409) | DONE | versions.ts:96-245; sha256 verified server-side :181-189; 409 via repo |
| M2 lease (acquire/renew/release, TTL, read-only) | DONE | leases.ts:20-65; env lease.ttlMs (config default 300000) |
| M2 quotas per plan + usage counters | PARTIAL | global env caps enforced (versions.ts:99-110 429; assets.ts:76-82 413); per-plan limits + counters MISSING |
| M3 load sequence endpoint (manifest -> signed URLs) | DONE | projects.ts:79-125; storage.ts:85-99 key layout; signing.ts TTL 600s |
| M3 autosave -> version upload + conflict | DONE | versions.ts POST (both multipart + raw query descriptor) |
| M4 SSE chat route (persist, Last-Event-ID replay, cancel, credits) | DONE (transport) | chat.ts:50-321; replay chat.ts:71-76,374-411; timeout chat.ts:44 (120s); cancel via runs.ts:59 |
| M4 model picker by plan entitlements | MISSING | model hardcoded `defaultModelForPlan("trial")` chat.ts:78; request model ignored |
| M4 LiteLLM integration | MISSING | runner.ts:330-332 (mock or unavailable); no OpenAI-compatible client; LITELLM_* env parsed (packages/config/src/env.ts:274-291) but unused by gateway |
| M4 context assembly endpoints | PARTIAL | ContextSelection + pinned on the wire (chat.ts:95-99); server-side assembly/inspection MISSING (mock ignores content, runner.ts:256-305) |
| M4 read tools (get_context, list_layers, get_properties, plan_edit, render_preview) | PARTIAL | 13-tool registry in packages/contracts/src/tools.ts:28-33; gateway validates expected toolCallId (runs.ts:137-155) but NO tool loop/execution in any runner |
| M4 safety (no write tools, step/time limits, injection tests) | PARTIAL | 120s ceiling chat.ts:44,278-284; CHAT_MAX_STEPS env parsed but NOT enforced in gateway; injection tests MISSING |
| M4 tests (SSE contract, reconnect, cancel, tool validation) | MISSING | zero tests touch /v1/threads/:id/chat or /v1/runs/* (42-test suite has none) |
| M5 plan compiler (EditPlan -> validated batch, allowlist, 100 steps/2MB/60s) | MISSING | EDIT_PLAN_SCHEMA shape-validated only (runner.ts:229-254); no command-registry validation; AGENT_BATCH_MAX_* env parsed, unused |
| M5 write tools + proposal-only batches | MISSING | defined in contracts tools.ts; no runner implements them |
| M5 apply path (version + commit credits, 409 -> refund) | DONE | runs.ts:186-262 (sha256 required, version via repo, settle, PROJECT_VERSION_CONFLICT -> refund) |
| M5 undo (undo_run) | MISSING | no gateway endpoint/tool; client-side edit.undo only |
| M6 Stripe checkout/portal/webhooks | DONE (surface) | billing.ts:39-177; real SDK (stripe.ts:11-71) |
| M6 subscription state machine (trial/renewal/past due/cancel/grace) | MISSING | only checkout.session.completed handled, billing.ts:164-175 |
| M6 credit ledger reserve/commit/refund + idempotency | DONE | chat.ts:104-201; runs.ts:209-262; ledger idempotency keys `chat:<runId>:...` |
| M6 block zero balance before model call | DONE | chat.ts:66-69 (INSUFFICIENT_CREDITS 402) |
| M6 entitlements gate models/seats/storage/renders server-side | MISSING | plan always "trial" (me.ts, credits.ts); MODEL allowedPlans in contracts never consulted at runtime |
| M6 reconciliation job (LiteLLM spend / render usage) | MISSING | none |
| M6 abuse controls (one trial, Radar, disposable domains) | MISSING | none |
| M6 billing tests | MISSING | stripe: null in test deps (tests/helpers.ts:551,611); no webhook/ledger-route tests |
| M7 comments (create/reply/resolve/filters/guest) | PARTIAL | create+list DONE (comments.ts:32-78); reply/resolve/guest MISSING |
| M7 presence (viewers, comp, playhead, heartbeat) | MISSING | no endpoints; no repo (packages/db/src/repos has no presence.ts) |
| M7 lease UX data (holder name, read-only) | DONE | leases.ts:37-53 |
| M7 versions timeline + restore + diff summary | PARTIAL | list/restore DONE; diff summary MISSING |
| M7 activity feed + audit export | PARTIAL | activity.ts:30-51; actorName null :23; export MISSING |
| M7 share/review page + tokens | MISSING | no /s/:token, no share token table/route anywhere (grep clean) |
| M8 render API (queue, status, history, estimate, download) | PARTIAL/STUB | queue+status only (renders.ts:62-87); no list/cancel/progress; credits hardcoded 0 (:73); objectKey computed but NOT persisted to the row (:76-78) |
| M8 worker (effectcraft-cli runner, Valkey/BullMQ, retries) | MISSING | services/worker/src EMPTY dir; noop worker renders.ts:25-31; VALKEY_URL declared optional+unused (rate-limit.ts:6-7 TODO W4) |
| M8 storage lifecycle (retention, cleanup) | MISSING | none |

## 3. Runner / agent integration verdict: MOCK, not a real model call

**Verdict: the SSE chat is a real transport wrapped around a canned script.**
Zero network calls to any model provider.

Evidence:
- src/runner.ts:330-332 `createRunnerForEnv(mockModel)` returns MockRunner or
  UnavailableRunner - the ONLY two implementations in the codebase.
- MockRunner (runner.ts:256-305) emits 2 fixed text deltas, one hardcoded
  EditPlan ("Rename layer", runner.ts:229-254), one canned
  `studio.get_context` tool.started/tool.result pair, then "completed" with
  `committedCredits = ceil(reserved/2)` - no input-dependent behavior.
- UnavailableRunner (runner.ts:311-327) emits run.started then
  run.failed RUN_MODEL_UNAVAILABLE (502, refunded). With MOCK_MODEL=false
  (and MOCK_MODEL is rejected when APP_ENV=production, packages/config
  src/env.ts:98-108) every real chat run fails.
- No provider SDK: gateway package.json deps are hono/better-auth/stripe/
  aws-sdk/zod only; repo-wide grep for litellm/openai/anthropic/provider-SDK usage
  finds only comments, env plumbing and an EDIT-ME infra template
  (infra/litellm/config.yaml: studio-fast=gpt-4o-mini, studio-smart=gpt-4o).
- The chat route itself is clean and provider-agnostic: create run -> balance
  precheck -> reserve -> hand to AgentRunner (chat.ts:17-19, 285), finalize
  settles/refunds (chat.ts:140-213).

Where LiteLLM plugs in (single seam, already shaped for it):
- Implement `AgentRunner` (interface at runner.ts:66-69) and swap it in at
  `createRunnerForEnv` (runner.ts:330). The runner receives AgentRun
  (message, context, pinned, model) and emits 12 StudioStreamEvent types
  through AgentRunStream (runner.ts:51-59), including expectToolCall -> the
  client reports results via POST /v1/runs/:id/events (runs.ts:137-155).
- Config side exists: LITELLM_BASE_URL / LITELLM_API_KEY / (optional)
  LITELLM_VIRTUAL_KEY are required-by-schema env vars
  (packages/config/src/env.ts:274-300); model aliases studio-fast/smart/vision
  + entitlements in packages/contracts/src/models.ts:42-67; infra/litellm/
  config.yaml is the proxy template.
- Nothing else in the chat path needs to change; tests inject runners via
  GatewayDeps.runner (tests/helpers.ts:538,605).

Related but not wired: packages/billing/src/guardrails/provider-killswitch.ts
(references a @studio/agent ModelRouter that does not exist in this tree) is
leftover from the legacy PhotoCraft build and is not imported by the gateway.

## 4. What the 42 tests cover (and what they do not)

- tests/app.test.ts - 15 stub-deps tests (no Postgres): /health + degraded
  boot (2), request-id echo (3), exact AUTH_REQUIRED/NOT_FOUND envelopes (2),
  Zod boundary rejection (1), rate limiting 429 + per-class isolation (2),
  idempotency (4: key required, replay, key+payload mismatch, replay status),
  Ok envelope shape (1).
- tests/auth-workspace.test.ts - 10 REAL end-to-end tests over HTTP against
  live Postgres + Better Auth (skips without DB): sign-up + session cookie,
  duplicate sign-up, /v1/me, workspace list/create/get-by-id, duplicate slug
  409, PATCH rename, cross-tenant 404 x2 (no enumeration leak), invite
  viewer -> accept -> 403 on project create.
- tests/leases.test.ts - 7: acquire, refused (readOnly + holder), renew,
  release/takeover, release-unheld, expiry steal (short TTL), cross-tenant 404.
- tests/projects-versions.test.ts - 10: create, raw upload v1 (no base),
  multipart v2, stale base -> 409, sha256 mismatch -> nothing stored, manifest
  + 10-min signed URL, restore-creates-new-version, post-restore base, soft
  delete semantics, cross-tenant 404.
- NOT covered anywhere: /v1/threads/:id/chat SSE, /v1/runs/:id(/cancel|/events),
  /v1/credits*, /v1/billing*, /v1/webhooks/stripe, /v1/renders*,
  /v1/comments, /v1/activity, /v1/assets*, API-key auth. (The W3-gw commit
  message mentions "credits+SSE mock runner" tests, but no such tests exist
  in the current tree - only the four files above.)

## 5. Gaps and risks (ranked)

1. **No model integration (M4/M5 core).** MockRunner/UnavailableRunner only.
   With MOCK_MODEL banned in production, chat cannot work at all in a real
   deployment. Blocks M4 exit criteria (read-only agent answers) and every M5
   golden-prompt test.
2. **No plan compiler / tool loop (M5).** EDIT_PLAN_SCHEMA validates shape, but
   nothing compiles model output into an allowlisted, bounded engine.batch;
   AGENT_BATCH_MAX_STEPS/BYTES/TIMEOUT_MS are parsed and unused. Adversarial
   plan input is unguarded server-side.
3. **Renders are a stub (M8).** Noop worker (renders.ts:25-31); services/
   worker/src empty; jobs stay queued forever; credits never charged;
   objectKey pre-computed but never persisted (renders.ts:76-78), so even a
   future worker completing a job would not surface resultUrl.
4. **Billing is half-real (M6).** Stripe SDK + checkout/portal/webhook are real,
   but only checkout.session.completed is handled (no trial start, renewal,
   past-due, cancel, grace); plan entitlements are hardcoded "trial"
   (me.ts:49-55); webhook event-id dedupe is an in-memory Set (stripe.ts:65-69)
   - a restart replays events and relies solely on the ledger idempotency key.
5. **M7 collaboration endpoints missing.** Presence: nothing. Share/review
   tokens: nothing. Comments: no reply/resolve; compId filtered client-side.
   Activity: actorName always null, no audit export.
6. **Single-instance in-memory state.** RunRegistry, chatReplay, rate limiter
   and idempotency store are all Maps (runner.ts:158-184, context.ts:33-44,
   rate-limit.ts:45-81, idempotency.ts:46-118). A gateway restart or >1
   replica loses SSE replay, live-run cancel, dedupe and limits. Valkey seams
   are commented TODO(W4) (rate-limit.ts:6-7). runs.ts:76-90 has a safe
   cancel+refund fallback for runs missing a live log.
7. **Model picker + step limits not enforced.** chat.ts:78 ignores any
   requested model and always uses the trial default; CHAT_MAX_STEPS parsed,
   never checked (only the 120s wall clock, chat.ts:44).
8. **Quotas are global, not per-plan.** ASSET_MAX_BYTES/PROJECT_MAX_BYTES env
   caps (M2 exit criterion "quotas enforced server-side" only half-met: they
   ARE enforced, but per-plan differentiation and usage counters are absent).
9. **Test coverage is narrow.** 42 tests cover middleware core + auth +
   workspaces + projects/versions + leases; the entire chat/runs/credits/
   billing/renders/comments surface ships untested (see sec 4).
10. **Doc drift.** docs/api/README.md still describes the archived PhotoCraft
    gateway (apps/gateway, flat envelope, GET /v1/runs/:id/events SSE, 13
    different event names). The live gateway uses the nested section-7.3
    envelope and POST /v1/threads/:id/chat. packages/api-client (current,
    W2-d/W3-fix) does match the live envelope; the stale README risks
    misleading the next agent.

## Boot requirements (env.ts / @studio/config)

parseEnv fail-fast REQUIRED: APP_URL, APP_ENV, DATABASE_URL, ASSET_MAX_BYTES,
PROJECT_MAX_BYTES, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_IDS, AUTH_SECRET,
AUTH_GOOGLE_ID/SECRET, AUTH_GITHUB_ID/SECRET, LITELLM_BASE_URL, LITELLM_API_KEY,
CHAT_MAX_STEPS (packages/config/src/env.ts:70-336). Optional-with-default:
LOG_LEVEL, MOCK_MODEL (rejected in production), LEASE_HEARTBEAT_MS/TTL_MS
(120000/300000), AGENT_BATCH_* (100 steps / 2 MB / 60s), EDITOR_*.
Optional-unset: VALKEY_URL, S3_* (local falls back to the LocalFS driver,
storage.ts:325-335), STRIPE_SECRET_KEY (required staging/prod; absent -> billing
routes 400 "billing not configured in this environment", billing.ts:29-37),
LITELLM_VIRTUAL_KEY, OTEL_*. The gateway itself boots lazily without a
reachable DB (index.ts:38-43; /health reports db:false; DB-needing routes
degrade to typed SERVICE_UNAVAILABLE, errors.ts:198-214).
