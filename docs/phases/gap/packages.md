# Packages layer cross-module map and gap - W-R3 (reader, 2026-10-22)

> **SUPERSEDED (W5-08, 2026-10-23):** this is a pre-landing read-wave audit
> snapshot. Waves W1–W5 have landed the product it maps — see the per-milestone
> evidence files (`docs/phases/M0.md`–`M8.md`), `docs/phases/m8-cli-spike.md`
> and the fleet `worklog.md` for current state. Every DONE/PARTIAL/MISSING
> verdict below is historical, not a statement about the tree today. Kept for
> the paper trail; do not cite it as a gap list.


Read-only survey of `packages/**` (contracts, db, config, editor-bridge, ui,
api-client, storage, billing) plus each package.json and test tree. No product
code modified, no installs run. Symbol names are copied letter-perfect from
source. Consumers verified by grep against `services/gateway/src/routes/*` and
`apps/web/src`.

Headline numbers: 20 DB tables, 53 repo methods (10 repo files), 34 declared
env vars, 19 EditorBridge methods, 13 agent tools, 12 SSE event types, 24 UI
component files, 34 api-client methods, 16 contracts route domain files.

Verdict scale: MET / PARTIAL / MISSING.

---

## 1. CONTRACTS (`packages/contracts`, @studio/contracts v0.1.0, zod ^4.6.7)

### 1.1 Exported surface by file (all re-exported from src/index.ts)

envelope.ts (wire envelope, PRODUCT_ARCHITECTURE 7.3):
- `WIRE_ERROR_CODES` (14 codes): RUN_MODEL_UNAVAILABLE, RUN_INVALID_TOOL,
  RUN_INVALID_COMMAND, RUN_BATCH_ROLLED_BACK, EDITOR_DISCONNECTED,
  RENDER_TIMEOUT, PROJECT_VERSION_CONFLICT, INSUFFICIENT_CREDITS,
  VALIDATION_FAILED, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, RATE_LIMITED,
  INTERNAL_ERROR; `WireErrorCode`, `WIRE_ERROR_CODE_SCHEMA`
- `ERROR_CODE_SCHEMA`, `REQUEST_ID_SCHEMA`, `META_SCHEMA`,
  `ERROR_BODY_SCHEMA`, `ERR_SCHEMA`, `Ok<T>`, `Envelope<T>`, `Err`
- constructors/guards: `ok()`, `err()`, `okSchema()`, `isEnvelope()`,
  `isOk()`, `isErr()`

engine-batch.ts (engine.batch wire contract, 8.5):
- bounds: `MAX_BATCH_STEPS = 100`, `MAX_BATCH_BYTES = 2 * 1024 * 1024`,
  `MAX_BATCH_TIMEOUT_MS = 60_000`, `DEFAULT_BATCH_TIMEOUT_MS`,
  `MAX_BATCH_LABEL_LENGTH = 280`
- schemas/types: `BATCH_STEP_SCHEMA` ({command, params}),
  `BatchStep`, `AGENT_BATCH_SCHEMA` (superRefine: 2 MB serialized cap +
  `$N.key` ref validation; `atomic` is `z.literal(true)`),
  `AgentBatch`, `CommandParamInfo`, `CommandInfo`, `CommandSchema`,
  `BatchCommandIssue`
- functions: `collectRefs(value, origin)` (extracts `$N.key`, bare `$N`
  deliberately NOT a ref - currency safety), `validateBatchRefs(steps)`
  (reasons: "forward" | "self" | "out_of_range"), `checkBatchCommands(batch,
  registry)` (reasons: unknown_command | missing_required_param)

edit-plan.ts (EditPlan, 8.6):
- `PLAN_INTENT_SCHEMA` = create | edit | animate | style | organize | render |
  explain | clarify; `PlanIntent`
- `PLAN_RISK_SCHEMA` = low | medium | high; `PlanRisk`
- `AFFECTED_LAYER_SCHEMA` {id?, name, change}; `AffectedLayer`
- `PLAN_STEP_SCHEMA` {title, tool, args, batch {label, steps 1..100}}
- `EDIT_PLAN_SCHEMA`: intent, summary (max 280), risk, requiresApproval,
  affectedLayers (max 50), estimatedCredits (nonnegative),
  steps (1..20); `EditPlan`
- constants: `MAX_PLAN_STEPS = 20`, `MAX_PLAN_AFFECTED_LAYERS = 50`,
  `MAX_PLAN_SUMMARY_LENGTH = 280`
- risk helpers: `PLAN_RISK_ORDER`, `isRiskAtLeast(risk, floor)`,
  `needsConfirmCheckbox(risk)`, `AUTO_APPLYABLE_INTENTS` = edit | style |
  animate, `isAutoApplicable(plan)`
- credit estimate: `ESTIMATE_BASE_CREDITS = 1`,
  `ESTIMATE_CREDITS_PER_STEP = 0.5`, `ESTIMATE_RISK_MULTIPLIERS`
  {low:1, medium:1.25, high:1.5}, `CREDIT_RESERVE_MULTIPLIER = 1.2`,
  `CREDIT_RESERVE_MINIMUM = 1`, `estimateCredits(plan)`,
  `reserveFor(estimatedCredits)` (both round to 2 decimals - see gap 7.6)

events.ts (SSE events 7.4 + client reducer, EDITOR_CHAT_UX 8.1/8.2):
- 12 event schemas (each carries runId + monotonic seq):
  RUN_STARTED_EVENT_SCHEMA, MESSAGE_DELTA_EVENT_SCHEMA,
  TOOL_STARTED_EVENT_SCHEMA, TOOL_DELTA_EVENT_SCHEMA,
  TOOL_RESULT_EVENT_SCHEMA, PLAN_EVENT_SCHEMA, PREVIEW_EVENT_SCHEMA
  (pngBase64, width, height), APPROVAL_REQUIRED_EVENT_SCHEMA,
  CREDITS_EVENT_SCHEMA (reserved, committed, balance),
  RUN_COMPLETED_EVENT_SCHEMA (versionId?), RUN_FAILED_EVENT_SCHEMA
  (code, message, retryable), RUN_CANCELLED_EVENT_SCHEMA
- union: `STUDIO_STREAM_EVENT_TYPES` (12 members, wire order),
  `STUDIO_STREAM_EVENT_SCHEMA` (discriminatedUnion "type"),
  `StudioStreamEvent`, `isStudioStreamEvent()`
- client state machine: `RUN_STATUSES` (11: idle, sending, streaming,
  awaiting_approval, applying, applied, undoing, undone, cancelling,
  cancelled, failed), `RunStatus`, `ToolCallState`, `RunPreviewState`,
  `RunCreditsState`, `RunErrorState`, `RunState`, `INITIAL_RUN_STATE`,
  `RunClientAction` (run.submit | run.apply | run.applied | run.undo |
  run.undone | run.cancel), `applyEvents(state, input)` (pure, total),
  `reduceEvents(inputs, initial)`

models.ts (model routing 8.2, plan entitlements 10.1):
- `MODEL_IDS` = studio-fast | studio-smart | studio-vision; `ModelId`,
  `ModelTier` = fast | smart | vision; `MODEL_CATALOG` (creditsPer1kInput /
  creditsPer1kOutput per model; studio-fast 0.01/0.03 all plans,
  studio-smart 0.1/0.4 pro+studio, studio-vision 0.25/0.5 studio only)
- `PLAN_IDS` = trial | starter | pro | studio; `PAID_PLAN_IDS` = starter |
  pro | studio; `PLAN_MODEL_ENTITLEMENTS` (trial->fast, starter->fast,
  pro->fast+smart, studio->all); `allowedModelsForPlan()`,
  `modelAllowedForPlan()`, `defaultModelForPlan()`

tools.ts (curated tool surface 8.4):
- `TOOL_IDS` (13, all implemented; doc said "~12"), `ToolId`,
  `TOOL_ID_SCHEMA`, `ToolKind` = read | write,
  `ToolReturns` = data | "proposed-batch", `ToolDefinition`
  {id, kind, risk, description, args (zod), returns}, `TOOL_LIST`,
  `TOOL_CATALOG`, `getTool(id)`, `isWriteTool(id)`, `isReadTool(id)`

routes/* (16 domain files + routes/index.ts barrel; all via src/index.ts):
common.ts: `ID_SCHEMA`, `Id`, `SHA256_SCHEMA`, `ROLES` = owner | admin |
  editor | viewer, `ROLE_SCHEMA`, `Role`, `IDEMPOTENCY_KEY_SCHEMA`
  (8..128 chars), `ISO8601_SCHEMA`, `PAGINATION_QUERY_SCHEMA`
  (cursor?, limit 1..100 default 50), `Page<T>`, `MAX_PAGE_LIMIT`,
  `CONTEXT_BLOCK_KEYS` (9), `CONTEXT_SELECTION_SCHEMA`,
  `PINNED_CONTEXT_KINDS` = frame | selection | composition | asset | comment,
  `PINNED_CONTEXT_ITEM_SCHEMA`
activity.ts: `ACTIVITY_QUERY_SCHEMA`, `ActivityEntry`
assets.ts: `ASSET_NAME_SCHEMA`, `ASSET_MIME_SCHEMA`, `CREATE_ASSET_SCHEMA`
  (name, mime, sizeBytes, sha256, width?, height?, durationTicks?),
  `Asset`, `CreateAssetResponse` (asset + upload {url, method "PUT",
  expiresAt, headers}), `SignedUrlResponse`
billing.ts: `CHECKOUT_SCHEMA` (exactly one of planId | packId),
  `CheckoutResponse` (sessionId, url), `PORTAL_SCHEMA` (returnUrl?),
  `PortalResponse` (url)
chat.ts: `CHAT_MESSAGE_SCHEMA` (1..8000), `CHAT_REQUEST_SCHEMA`
  {message, context, idempotencyKey, pinned (max 20)}
comments.ts: `CREATE_COMMENT_SCHEMA` (compId required, layerId?,
  timeTicks?, body 1..2000), `COMMENTS_QUERY_SCHEMA` (compId?, resolved?),
  `RESOLVE_COMMENT_SCHEMA` {resolved}, `Comment`
credits.ts: `LEDGER_KINDS` = grant | reserve | commit | refund | adjust,
  `LEDGER_KIND_SCHEMA`, `CreditsSummary` (balance, includedCredits,
  purchasedCredits, reserved, plan, renewsAt), `LEDGER_QUERY_SCHEMA`,
  `LedgerEntry` (id, workspaceId, kind, amount, balanceAfter, runId?,
  idempotencyKey, metadata, createdAt)
invites.ts: `INVITE_MEMBER_SCHEMA` (email, role), `ACCEPT_INVITE_SCHEMA`,
  `Invite`, `AcceptedInvite`, `INVITE_ID_SCHEMA`
leases.ts: `LEASE_HEARTBEAT_MS = 120_000`, `LEASE_TTL_MS = 300_000`,
  `LEASE_SESSION_ID_SCHEMA` (8..128), `ACQUIRE_LEASE_SCHEMA` {sessionId},
  `RELEASE_LEASE_SCHEMA`, `ProjectLease`
me.ts: `Membership`, `PlanSummary`, `MeResponse` (user + memberships + plan)
projects.ts: `CREATE_PROJECT_SCHEMA`, `PATCH_PROJECT_SCHEMA`
  (name? or description?), `DELETE_PROJECT_SCHEMA`, `Project`,
  `SignedUrl` (method GET | PUT | POST), `ManifestAsset`, `ProjectManifest`
  (currentVersion {id, version, sha256, label, sizeBytes, createdAt, url} |
  null + assets with signed urls)
renders.ts: `RENDER_FORMATS` = mp4 | prores | png-seq | gif | wav,
  `RENDER_SETTINGS_SCHEMA` (timeFrom?, timeTo? >= timeFrom, width?, height?,
  frameRate?, quality draft|good|best, extra?), `QUEUE_RENDER_SCHEMA`
  {projectId, compId, format, settings, idempotencyKey}, `RENDER_STATUSES` =
  queued | running | succeeded | failed | cancelled, `RenderJob`
runs.ts: `SERVER_RUN_STATUSES` = queued | streaming | awaiting_approval |
  applying | completed | failed | cancelled (NOTE: differs from db
  RunStatus - see gap 7.6), `TOOL_RESULT_EVENT_REQUEST_SCHEMA`,
  `APPLY_RESULT_EVENT_REQUEST_SCHEMA` (ok + sha256 required on success,
  errorCode on failure), `RUN_EVENT_REQUEST_SCHEMA`, `CANCEL_RUN_SCHEMA`,
  `RunStepRecord`, `RunRecord`, `RUN_ID_SCHEMA`
threads.ts: `CREATE_THREAD_SCHEMA` (title?), `Thread`,
  `THREAD_MESSAGE_ROLE_SCHEMA` = user | assistant | system,
  `ThreadMessage` (content opaque), `THREAD_ID_SCHEMA`
versions.ts: `UPLOAD_VERSION_SCHEMA` {baseVersionId, sha256, label?,
  agentRunId?, sizeBytes}, `RESTORE_VERSION_SCHEMA` {note?},
  `ProjectVersion` (no objectKey on the wire)
workspaces.ts: `WORKSPACE_SLUG_SCHEMA`, `WORKSPACE_NAME_SCHEMA`,
  `CREATE_WORKSPACE_SCHEMA` {name, slug}, `PATCH_WORKSPACE_SCHEMA`,
  `Workspace`

### 1.2 Tool list (13, read then write, exact ids + arg shapes)

Read (kind "read", returns "data"):
1. `studio.get_context` - args {include?: array of CONTEXT_BLOCK (max 9)}
2. `studio.list_layers` - args {compId?, depth int 1..8 default 2}
3. `studio.get_properties` - args {layerIds 1..12, paths? max 12}
4. `studio.plan_edit` - args {goal 1..4000}
5. `studio.render_preview` - args {compId?, timeSeconds?, maxWidth
   16..1200 default 1200}

Write (kind "write", returns "proposed-batch" - proposal-only, 8.4 rules):
6. `studio.create_composition` (risk medium) - {name 1..120, width 16..8192,
   height 16..8192, frameRate <= 480 default 30, durationSeconds <= 3600
   default 10}
7. `studio.create_text` (risk low) - {compId?, text 1..5000, name?,
   fontSize?, fontFamily?, color? #hex, position? [x, y]}
8. `studio.set_properties` (risk low) - {updates 1..50 of {layer, path,
   value}}
9. `studio.add_effect` (risk medium) - {layer, effect, params?}
10. `studio.set_keyframes` (risk low) - {layer, propertyPath, keyframes
    1..200 of {time, value, easing? linear|ease-in|ease-out|ease-in-out}}
11. `studio.apply_preset` (risk medium) - {preset 1..200, targets 1..50}
12. `studio.undo_run` (risk medium) - {runId?}
13. `studio.save_version` (risk low) - {label? max 280}

### 1.3 Consumer matrix (who imports what)

- gateway (`services/gateway`, package.json deps: @studio/config,
  @studio/contracts, @studio/db): all route schemas from routes/*,
  envelope helpers, events reducer (chat SSE), edit-plan, engine-batch,
  tools catalog (chat runner), models (model gating)
- web (`apps/web`, deps: @studio/config, @studio/contracts, @studio/ui):
  currently consumes contracts types in lib/demo.ts etc.; does NOT yet
  import @studio/api-client or @studio/editor-bridge (gap 7.1)
- editor-bridge: imports AGENT_BATCH_SCHEMA / BATCH_STEP_SCHEMA /
  MAX_BATCH_* from @studio/contracts (batch.ts re-exports them)
- api-client: imports every route schema + events reducer + models types
- worker: imports nothing (worker src is empty - W-R4 finding confirmed)

### 1.4 Contracts tests (8 files)

barrel.test.ts, edit-plan.test.ts, engine-batch.test.ts, envelope.test.ts,
events.test.ts, models.test.ts, routes.test.ts, tools.test.ts
(plus vitest.config.ts). All 16 route domains + core modules covered.

### 1.5 Contracts vs BUILD_PLAN

Fulfills: M1 (workspaces/me/invites + roles + idempotency keys), M2
(projects/assets/versions/leases + manifest + 409 shape), M4 (chat request,
SSE events, read tools, context/pinned schemas), M5 (EditPlan + engine.batch
+ write tools + apply.result sha256 protocol), M6 (billing/credits/ledger
kinds), M7 (comments, activity), M8 (renders). MET for the wire layer.
Missing: M7 share-link contracts (`/s/:token`, share token revoke), presence
contracts (who is viewing / active comp / playheart), render LIST route
contract (repo + UI need it; only queue + get are typed), plan catalog route
(no GET /v1/plans), Stripe webhook event contracts (deliberately
service-side, but no typed webhook payload schemas anywhere).

---

## 2. DB (`packages/db`, @studio/db v0.1.0; better-auth ^1.7.12, drizzle-orm ^0.45.4, postgres ^3.4.9)

### 2.1 schema.ts - all 20 tables (name + columns + relations)

Better Auth core (property names = plugin model fields, adapter requirement):
1. `user` - id, name, email (unique), emailVerified, image, createdAt,
   updatedAt, role (admin plugin), banned, banReason, banExpires. Relations:
   many session/account/member.
2. `session` - id, expiresAt, token (unique), createdAt, updatedAt,
   ipAddress, userAgent, userId -> user, activeOrganizationId (org plugin),
   impersonatedBy (admin plugin).
3. `account` - id, accountId, providerId, userId -> user, accessToken,
   refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt,
   scope, password, createdAt, updatedAt.
4. `verification` - id, identifier, value, expiresAt, createdAt, updatedAt.

Organization plugin (workspace == organization, ADR-0003):
5. `organization` - id, name, slug (unique), logo, createdAt, metadata
   (text JSON). Relations: many member/invitation/projects/assets/
   ledgerEntries/auditEntries.
6. `member` - id, organizationId -> organization, userId -> user, role
   (default "member"; product assigns owner/admin/editor/viewer), createdAt.
7. `invitation` - id, organizationId, email, role, status (default
   "pending"), expiresAt, inviterId -> user, createdAt.

apiKey plugin:
8. `apikey` - id, configId (default "default"), name, start, referenceId
   (= user id), prefix, key (hashed), refillInterval, refillAmount,
   lastRefillAt, enabled, rateLimitEnabled, rateLimitTimeWindow
   (default 86_400_000), rateLimitMax (default 10), requestCount, remaining,
   lastRequest, expiresAt, createdAt, updatedAt, permissions, metadata.

Product (9.1; text pks `${prefix}_${uuid}` app-side, timestamps with tz):
9. `projects` - id (prj_), workspaceId -> organization, name, slug
   (uniqueIndex with workspaceId), description, thumbnailUrl,
   currentVersionId (text, NO FK - circular pair with project_versions,
   integrity enforced in version repo transactions), createdBy -> user,
   createdAt, updatedAt, deletedAt (soft delete). Relations: workspace,
   currentVersion (relationName "current"), versions ("history"), lease,
   assets, threads, runs, renders, comments, creator.
10. `project_versions` - id (ver_), projectId -> projects, version (int),
    parentVersionId (text, no FK), objectKey, sha256, sizeBytes (bigint),
    label, agentRunId, createdBy -> user, createdAt. IMMUTABLE (no update
    paths). Indexes: (projectId, version desc), (projectId, sha256), parent.
11. `project_leases` - projectId (pk) -> projects, userId -> user,
    sessionId, expiresAt. Single row per project = the atomic lease guard.
12. `assets` - id (ast_), workspaceId -> organization, projectId -> projects
    (set null), name, mime, sizeBytes (bigint), sha256, objectKey, width,
    height, durationTicks (bigint), createdBy -> user, createdAt.
13. `agent_threads` - id (thr_), projectId -> projects, createdBy -> user,
    title, createdAt, updatedAt.
14. `agent_messages` - id (msg_), threadId -> agent_threads, role, contentJson
    (jsonb), runId (text, no FK), createdAt.
15. `agent_runs` - id (run_), threadId -> agent_threads, projectId ->
    projects, model, status (`RunStatus` = queued | running |
    awaiting_approval | completed | failed | cancelled; NOTE: uses
    "running", no "streaming"/"applying" - gap 7.6), planJson (jsonb),
    reservedCredits (int), committedCredits (int), baseVersionId,
    resultVersionId, errorCode, createdAt, completedAt.
16. `agent_steps` - id (stp_), runId -> agent_runs, seq (uniqueIndex with
    runId), tool, argsJson, resultJson, commandBatchJson (jsonb),
    status (`StepStatus` = pending | running | success | failed),
    durationMs.
17. `credit_ledger` - id (led_), workspaceId -> organization, kind
    (`LedgerKind` = grant | reserve | commit | refund | adjust), amount
    (int, signed), balanceAfter (int), runId, idempotencyKey (UNIQUE global),
    metadata (jsonb), createdAt. Append-only; writers serialize via
    pg_advisory_xact_lock (repos/ledger.ts).
18. `renders` - id (rdr_), projectId -> projects, compId, format, settingsJson
    (jsonb), status (`RenderStatus` = queued | running | completed | failed |
    cancelled; NOTE: "completed" vs contracts "succeeded" - gap 7.6),
    objectKey, error, credits (int), createdBy -> user, createdAt,
    completedAt.
19. `comments` - id (cmt_), projectId -> projects, compId, layerId, timeTicks
    (bigint), body, authorId -> user, resolvedAt, createdAt.
20. `audit_log` - id (aud_), workspaceId -> organization, actorId -> user
    (set null), action, targetType, targetId, metadata (jsonb), ip,
    createdAt.

Inferred types exported: User, Session, Organization, Member, Invitation,
ApiKey, Project, ProjectVersion, ProjectLease, Asset, AgentThread,
AgentMessage, AgentRun, AgentStep, LedgerEntry, Render, Comment,
AuditLogEntry. Migration: drizzle/0000_living_human_cannonball.sql (1
migration, forward-only). seed: scripts/seed.ts.

### 2.2 Repos (src/repos/, created via `createRepos(db) -> Repos`)

53 methods across 10 repos; every method takes workspaceId first
(tenant-scoped; cross-tenant reads as NOT_FOUND, 12.1). "Route" column =
gateway route file that calls it (grep-verified 2026-10-22).

projects.ts (`ProjectsRepo` + exported `lockProject`):
- create(workspaceId, input: ProjectCreateInput{name, slug?, description?,
  thumbnailUrl?, createdBy}) -> Promise<Project> | route: routes/projects.ts
- list(workspaceId, options?: ProjectListOptions{limit?, cursor?,
  includeDeleted?}) -> Promise<Page<Project>> | routes/projects.ts
- get(workspaceId, projectId, options?) -> Promise<Project> |
  routes/projects.ts, routes/activity.ts (tenancy precheck), routes/chat.ts
- patch(workspaceId, projectId, input: ProjectPatchInput) |
  routes/projects.ts
- softDelete(workspaceId, projectId) | routes/projects.ts
- manifest(workspaceId, projectId) -> ProjectManifest{project,
  currentVersion, assets: AssetManifestEntry[]} | routes/projects.ts
- lockProject(tx, workspaceId, projectId) -> Promise<Project>
  (SELECT ... FOR UPDATE; used by versions upload/restore)

versions.ts (`VersionsRepo`):
- upload(workspaceId, input: VersionUploadInput{projectId, expectedVersionId,
  objectKey, sha256, sizeBytes, label?, agentRunId?, createdBy}) ->
  {version, project}; transaction: lockProject -> assertExpectedVersion (409
  PROJECT_VERSION_CONFLICT) -> insert -> advance currentVersionId |
  routes/versions.ts, routes/runs.ts (apply.result path)
- restore(workspaceId, input: VersionRestoreInput{projectId, versionId,
  createdBy, expectedVersionId?, label?}) - creates NEW version with
  parentVersionId = restored one | routes/versions.ts
- list(workspaceId, projectId, options?) -> Page<ProjectVersion> |
  routes/versions.ts
- get(workspaceId, projectId, versionId) -> ProjectVersion | NO gateway
  caller yet

leases.ts (`LeasesRepo`):
- acquire(workspaceId, projectId, input: LeaseAcquireInput{userId,
  sessionId, ttlMs?}) -> LeaseAcquireResult{acquired, holderId, expiresAt};
  atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE (expired OR same holder)
  | routes/leases.ts (acquire-or-renew per 7.2)
- renew(...) -> LeaseRenewResult | NO direct gateway caller (acquire covers
  renew; contracts treat POST lease as acquire-or-renew)
- release(workspaceId, projectId, {userId, force?}) | routes/leases.ts
- get(workspaceId, projectId) -> LeaseSnapshot{lease, isHeld} | NO gateway
  caller yet

assets.ts (`AssetsRepo`):
- create(workspaceId, input: AssetCreateInput{projectId?, name, mime,
  sizeBytes, sha256, objectKey, width?, height?, durationTicks?, createdBy})
  | routes/assets.ts
- list(workspaceId, options?: AssetListOptions{projectId?, limit?, cursor?})
  | routes/assets.ts
- get(workspaceId, assetId) | routes/assets.ts
- bySha256(workspaceId, sha256) -> Asset | null (dedupe lookup, 9.2) | NO
  gateway caller yet (M2 dedupe not wired)
- quota(workspaceId) -> {count, totalBytes} | NO gateway caller yet (M2
  storage quotas not wired)

threads.ts (`ThreadsRepo`):
- create(workspaceId, input: ThreadCreateInput{projectId, createdBy,
  title?}) | routes/threads.ts, routes/chat.ts
- listByProject(workspaceId, projectId, options?) -> Page<AgentThread> |
  routes/threads.ts
- get(workspaceId, threadId) | routes/chat.ts
- addMessage(workspaceId, input: MessageInput{threadId, role
  (user|assistant|system|tool), contentJson, runId?}) | routes/chat.ts
- listMessages(workspaceId, threadId, options?) -> Page<AgentMessage> |
  routes/threads.ts

runs.ts (`RunsRepo`):
- create(workspaceId, input: RunCreateInput{threadId, projectId, model,
  baseVersionId?, reservedCredits?, planJson?}) | routes/chat.ts
- update(workspaceId, runId, input: RunUpdateInput{status?, planJson?,
  reservedCredits?, committedCredits?, resultVersionId?, errorCode?}) -
  enforces assertRunTransition | routes/chat.ts, routes/runs.ts
- addStep(workspaceId, input: StepCreateInput{runId, seq, tool, argsJson?,
  resultJson?, commandBatchJson?, status?, durationMs?}) | routes/chat.ts,
  routes/runs.ts
- get(workspaceId, runId) -> RunWithSteps{run, steps} | routes/runs.ts,
  routes/chat.ts
- listByThread(workspaceId, threadId, options?) -> Page<AgentRun> | NO
  gateway caller yet

ledger.ts (`LedgerRepo`, 10 methods; every mutation under
`pg_advisory_xact_lock(hashtext(workspaceId))`, global-UNIQUE idempotencyKey
with replay -> `{entry, replayed: true}`, wrong-workspace key = CONFLICT):
- grant | routes/billing.ts (pack/plan grant)
- reserve - throws DbError.insufficientCredits when balance < amount |
  routes/chat.ts
- commit (bounded by outstanding) | NO direct route caller (use settle)
- refund (bounded by outstanding) | NO direct route caller (use settle /
  refundAll)
- settle(workspaceId, {runId, actualCost, idempotencyKey, metadata?}) ->
  SettleResult{commit, refund, replayed} (commit = min(ceil(actualCost),
  outstanding); refund = rest) | routes/chat.ts, routes/runs.ts
- refundAll(workspaceId, {runId, idempotencyKey, metadata?}) ->
  RefundAllResult (failure/cancel path: full outstanding refunded) |
  routes/chat.ts, routes/runs.ts
- adjust (non-zero int; negative requires allowNegativeBalance) | NO
  gateway caller yet (admin/reconciliation path missing)
- balance(workspaceId) -> number (indexed SUM) | routes/me.ts,
  routes/chat.ts, routes/runs.ts, routes/credits.ts
- list(workspaceId, options?: LedgerListOptions{limit?, cursor?, kind?,
  runId?}) | routes/credits.ts
- getEntryByIdempotencyKey | NO gateway caller (webhook idempotency check
  does not reuse it)

comments.ts (`CommentsRepo`):
- create(workspaceId, input: CommentCreateInput{projectId, compId, layerId?,
  timeTicks?, body, authorId}) | routes/comments.ts
- list(workspaceId, projectId, options?: CommentListOptions{resolved?,
  limit?, cursor?}) | routes/comments.ts
- get(workspaceId, commentId) | NO direct route caller
- resolve(workspaceId, commentId) (idempotent) | NO route caller (M7
  resolve not wired)
- unresolve(workspaceId, commentId) | NO route caller

renders.ts (`RendersRepo`):
- create(workspaceId, input: RenderCreateInput{projectId, compId, format,
  settingsJson?, credits?, createdBy}) | routes/renders.ts
- markRunning / markCompleted({objectKey}) / markFailed({error}) /
  markCancelled - guarded by assertRenderTransition + optimistic status
  check | worker (M8) - NO caller exists yet (worker empty)
- get(workspaceId, renderId) | routes/renders.ts
- list(workspaceId, options?: RenderListOptions{projectId?, status?,
  limit?, cursor?}) | NO gateway caller (render history route missing)

audit.ts (`AuditRepo`):
- append(workspaceId, input: AuditAppendInput{actorId?, action, targetType?,
  targetId?, metadata?, ip?}) | routes/workspaces.ts, routes/invites.ts,
  routes/projects.ts
- list(workspaceId, options?: AuditListOptions{targetType?, targetId?,
  limit?, cursor?}) | routes/activity.ts

shared.ts: `WorkspaceId` (== organization id), re-export `Page`,
`isUniqueViolation(error)` (SQLSTATE 23505), `requireNonEmpty`,
`requireNonNegativeInt`, `requirePositiveInt`.

### 2.3 Logic modules (all pure, unit-tested)

- permissions.ts: ROLES (owner, admin, editor, viewer), `isRole()`,
  `atLeast(role, minimum)` (cumulative), `CAPABILITIES` (15: read, comment,
  openEditor, createProjects, takeLease, runAgent, uploadAssets, render,
  invite, removeMembers, manageBilling, manageApiKeys, manageWorkspace,
  deleteWorkspace, transferOwnership), `ROLE_CAPABILITIES` (viewer:
  read+comment+openEditor; editor: +createProjects/takeLease/runAgent/
  uploadAssets/render; admin: +invite/removeMembers/manageBilling/
  manageApiKeys/manageWorkspace; owner: +deleteWorkspace/transferOwnership),
  `capabilitiesFor(role)`, `can(role, capability)` + 15 named helpers
  (canCreateProjects, canRunAgent, ...). Matches 3.3 matrix exactly.
- lease-logic.ts: `DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000`, `LeaseState`,
  `leaseDecision(existing, requesterId, now)` -> acquire | refuse
  (held-by-other), `isLeaseHeld(existing, now)`
- ledger-math.ts: `computeReserveAmount(estimatedCredits)` = max(1,
  ceil(est * 1.2)) (INTEGER credits; vs contracts fractional reserveFor -
  gap 7.6), `foldBalance(entries)`, `outstandingReserve(entries)` (>= 0),
  `planSettlement(outstanding, actualCost)` -> {commit, refund},
  `deriveIdempotencyKey(...parts)`
- version-logic.ts: `assertExpectedVersion(currentVersionId,
  expectedVersionId)` (throws PROJECT_VERSION_CONFLICT), `nextVersionNumber`,
  `buildRestorePlan`
- statuses.ts: RUN_TRANSITIONS / RENDER_TRANSITIONS state machines,
  `assertRunTransition`, `assertRenderTransition`, `isTerminalRunStatus`,
  `isTerminalRenderStatus`
- cursor.ts: base64url keyset cursor {t: ISO, id},
  `encodeCursor`/`decodeCursor`, `Page<T>`, `DEFAULT_PAGE_SIZE = 20`,
  `MAX_PAGE_SIZE = 100`, `clampLimit`
- ids.ts: `createId(prefix)` = `${prefix}_${uuid no dashes}`
- slug.ts: `slugify(name)` (NFKD, ascii, max 64), `ensureUniqueSlug(base,
  taken)` (-2, -3, ...)
- errors-lite.ts: `ERROR_CODES` (18: NOT_FOUND, FORBIDDEN, UNAUTHORIZED,
  VALIDATION_FAILED, CONFLICT, RATE_LIMITED, PROJECT_VERSION_CONFLICT,
  INSUFFICIENT_CREDITS, QUOTA_EXCEEDED, RUN_MODEL_UNAVAILABLE,
  RUN_INVALID_TOOL, RUN_INVALID_COMMAND, RUN_BATCH_ROLLED_BACK,
  EDITOR_DISCONNECTED, RENDER_TIMEOUT), `DbError` (code, status, retryable,
  hint, details; factory: notFound, validation, conflict, forbidden,
  versionConflict, insufficientCredits, quotaExceeded), `isDbError`,
  `toErrorPayload`
- auth.ts: `createAuth(env: AuthEnv)` -> Better Auth instance with
  organization (creatorRole "owner"; roles spread of defaultRoles + editor +
  viewer so owner/admin keep built-in statements), apiKey, admin plugins;
  drizzleAdapter over the 8 better-auth tables; emailAndPassword + Google +
  GitHub social providers; `Auth`, `AuthEnv`, `AuthHandler` (Hono mount
  `app.all("/auth/{*any}", ...)`)
- db.ts: `createDb(databaseUrl)` -> StudioDb (postgres.js max 10),
  `StudioTx`, `Executor`; migrate.ts: `migrateDatabase(db, folder)` +
  CLI main (DATABASE_URL)

### 2.4 DB tests

permissions.test.ts, ledger-math.test.ts, logic.test.ts, version-logic.test.ts,
schema.test.ts, integration/repos.test.ts (real Postgres).

### 2.5 DB vs BUILD_PLAN

Fulfills: M1 task 1 (Better Auth + roles, no custom auth tables), M1 task 2
(invites audited), M1 task 3 (tenant-scoped repos), M2 tasks 1/3/4/6
(projects CRUD + soft delete, immutable versions + 409, lease, manifest),
M2 task 5 partially (quota()/bySha256() exist but no route enforces quotas),
M4 (threads/messages/runs/steps persistence), M5 (plan_json,
command_batch_json, base/result version ids), M6 task 3 (append-only
credit_ledger + reserve/commit/refund + idempotency + advisory lock),
M7 (comments, audit_log + activity view), M8 rows (renders table).
Missing: subscription/plan-state tables (Stripe customer id, subscription
status, plan, renewsAt, seat count - nothing persists plan state; M6),
presence table (M7), share-token table (M7), render outputs retention
metadata, API-key scope enforcement helpers beyond better-auth defaults.

---

## 3. CONFIG (`packages/config`, @studio/config v0.2.0, zod ^4.6.7)

### 3.1 Full env var table (34 vars; ENV_VAR_SPECS is the single source of truth)

| # | Name | Type (zod) | Required? | Default | Consumer |
|---|------|------------|-----------|---------|---------|
| 1 | APP_URL | http(s) URL | required | - | web/gateway: auth redirects, OAuth callbacks, signed URLs, CORS |
| 2 | APP_ENV | enum local\|staging\|production | required | - | all: gates dev flags + billing requirements |
| 3 | LOG_LEVEL | enum debug\|info\|warn\|error | optional | "info" | gateway/worker structured logs |
| 4 | MOCK_MODEL | envBool | optional | false | gateway chat runner (rejected when APP_ENV=production) |
| 5 | DATABASE_URL | postgres:// URL (secret) | required | - | @studio/db (auth + repos) |
| 6 | VALKEY_URL | redis:// URL (secret) | optional | - | gateway/worker queues + rate limits (degrade when unset) |
| 7 | S3_ENDPOINT | http(s) URL | optional (required when APP_ENV != local) | - | object storage (gateway storage.ts, worker) |
| 8 | S3_REGION | string | optional (non-local: required) | - | storage |
| 9 | S3_ACCESS_KEY_ID | string (secret) | optional (non-local: required) | - | storage |
| 10 | S3_SECRET_ACCESS_KEY | string (secret) | optional (non-local: required) | - | storage |
| 11 | S3_BUCKET | S3 bucket name | optional (non-local: required) | - | storage |
| 12 | ASSET_MAX_BYTES | whole number >= 1 | required | - | gateway assets upload cap |
| 13 | PROJECT_MAX_BYTES | whole number >= 1 | required | - | gateway versions upload cap |
| 14 | STRIPE_SECRET_KEY | string (secret) | optional (required when APP_ENV != local) | - | gateway billing route |
| 15 | STRIPE_WEBHOOK_SECRET | string (secret) | required | - | gateway stripe webhook verification |
| 16 | STRIPE_PRICE_IDS | JSON map plan -> price id | required | - | billing checkout |
| 17 | AUTH_SECRET | string >= 32 chars (secret) | required | - | Better Auth session signing |
| 18 | AUTH_GOOGLE_ID | string | required | - | Google OAuth |
| 19 | AUTH_GOOGLE_SECRET | string (secret) | required | - | Google OAuth |
| 20 | AUTH_GITHUB_ID | string | required | - | GitHub OAuth |
| 21 | AUTH_GITHUB_SECRET | string (secret) | required | - | GitHub OAuth |
| 22 | LITELLM_BASE_URL | http(s) URL | required | - | gateway chat (studio-fast/smart/vision aliases) |
| 23 | LITELLM_API_KEY | string (secret) | required | - | gateway chat |
| 24 | LITELLM_VIRTUAL_KEY | string (secret) | optional (v1 platform keys only) | - | per-tenant budgets/spend logs |
| 25 | EDITOR_PUBLIC_PATH | absolute path, no trailing slash | optional | "/editor" | web/gateway editor serving + iframe src |
| 26 | EDITOR_DEV_SERVER_URL | http(s) URL | optional (dev only; rejected in production) | - | web dev proxy (cargo xtask web server) |
| 27 | EDITOR_WASM_MAX_MB | whole number >= 1 | optional | 18 | wasm size budget (CI + serving) |
| 28 | CHAT_MAX_STEPS | whole number >= 1 | required | - | gateway chat runner step limit |
| 29 | AGENT_BATCH_MAX_STEPS | whole number >= 1 | optional | 100 | chat apply path (matches contracts MAX_BATCH_STEPS) |
| 30 | AGENT_BATCH_MAX_BYTES | whole number >= 1 | optional | 2097152 (2 MB) | chat apply path |
| 31 | AGENT_BATCH_TIMEOUT_MS | whole number >= 1 | optional | 60000 | chat apply path |
| 32 | LEASE_HEARTBEAT_MS | whole number >= 1 | optional | 120000 (2 min) | lease client heartbeat |
| 33 | LEASE_TTL_MS | whole number >= 1 | optional | 300000 (5 min) | lease repo expiry (must exceed heartbeat) |
| 34 | OTEL_EXPORTER_OTLP_ENDPOINT | http(s) URL | optional (telemetry off when unset) | - | observability (OTLP traces/metrics) |

Cross-field rules (crossCheckProblems, kind "rejected"): S3 group + bucket +
STRIPE_SECRET_KEY required when APP_ENV != "local"; MOCK_MODEL must be off in
production; EDITOR_DEV_SERVER_URL must be unset in production;
LEASE_TTL_MS must exceed LEASE_HEARTBEAT_MS.

Public API: `parseEnv(source)` / `getEnv(source)` -> frozen grouped
`StudioEnv` (groups: app, db, queue, storage, stripe, auth, litellm, editor,
agent, lease, obs), `EnvFatalError` (lists EVERY problem + purpose; values
never echoed; `redact()` belt-and-braces), `ENV_VAR_NAMES`,
`SECRET_ENV_VARS`, `renderEnvExample()` / `writeEnvExample(path)` (generates
.env.example; root .env.example committed).

Not env-schema vars yet (storage package requests them - W2-Q TODO in
packages/storage/src/index.ts): STORAGE_DRIVER (local|s3, required, no
silent default), STORAGE_LOCAL_DIR, STORAGE_SIGNING_SECRET (>= 16),
STORAGE_PUBLIC_BASE_URL, S3_PREFIX, S3_FORCE_R2_COMPAT. Gap 7.4.

Other config exports:
- errors.ts: `ERROR_CATALOG` (23 codes: PROJECT_VERSION_CONFLICT,
  INSUFFICIENT_CREDITS, LEASE_HELD, LEASE_EXPIRED, RUN_MODEL_UNAVAILABLE,
  RUN_INVALID_TOOL, RUN_INVALID_COMMAND, RUN_BATCH_ROLLED_BACK,
  RUN_CANCELLED, EDITOR_DISCONNECTED, RENDER_TIMEOUT, RENDER_FAILED,
  ASSET_TOO_LARGE, ASSET_REJECTED, QUOTA_EXCEEDED, WORKSPACE_NOT_FOUND,
  PROJECT_NOT_FOUND, VERSION_NOT_FOUND, THREAD_NOT_FOUND, RUN_NOT_FOUND,
  RATE_LIMITED, AUTH_REQUIRED, FORBIDDEN, VALIDATION_FAILED, INTERNAL) with
  message/hint/retryable defaults; `StudioError` (toEnvelope/toJSON, never
  leaks cause), `okEnvelope()`, `fromUnknown()` (ZodError ->
  VALIDATION_FAILED), `isStudioError`, `isErrEnvelope`. NOTE: db
  errors-lite.ts is a "lite" local copy to be unified (W1-e).
- ids.ts: `ID_PREFIXES` (project prj, version ver, asset ast, thread thr,
  run run, render rnd, request req), `newId(kind)`, `idSchema(kind)`,
  `isNewId`, newProjectId/newVersionId/newAssetId/newThreadId/newRunId/
  newRenderId/newRequestId. NOTE: render prefix `rnd` but db renders rows
  use `rdr` (two id conventions coexist - cosmetic inconsistency).
- brand.ts: `Brand` (codename "Studio", productName "Studio", titleTag,
  tagline "Motion, directed by you", heroSubline, forbiddenNames
  [EffectCraft, ArtCraft, PhotoCraft, Photoshop, Cursor], domains, contact,
  social), `brandViolations(text)`, `assertBrandSafe(text)` (CI lint gate).

Tests: brand.test.ts, env.test.ts, errors.test.ts, ids.test.ts.

### 3.2 Config vs BUILD_PLAN

Fulfills: M0 task 5 (.env.example with every variable + fail-fast startup
check), M1 (auth vars), M3 (editor vars + wasm budget), M4 (litellm vars +
CHAT_MAX_STEPS), M6 (stripe vars), M10 (OTEL endpoint). PARTIAL: storage
vars not unified (STORAGE_* missing from the schema; gateway passes storage
env separately via StorageEnvInput).

---

## 4. BRIDGE (`packages/editor-bridge`, @studio/editor-bridge v0.1.0; deps: @studio/contracts, zod; exports "." and "./fake")

### 4.1 EditorBridge public API (19 methods, src/types.ts `EditorBridge`)

| Method | Return | Notes |
|--------|--------|-------|
| ready() | Promise<void> | resolves when effectcraftLoad.readyMs set (re-resolves after editor reload) |
| inspect() | Promise<UiInspect> | ui.inspect; UiInspectSchema: window, pixelsPerPoint, fps, playing, time, activeComp, selectedLayers, selectedKeys, focusedPanel (derived from ui.focused), dialog, renderMs |
| commands(filter?) | Promise<CommandInfo[]> | engine.commands (CommandInfoSchema: id, label, menu[], shortcut, params, enabled, why) |
| describe(command) | Promise<CommandSchema> | command.describe (id, label, menu, shortcut, params doc, schema (JSON Schema), undoable, enabled, why) |
| query<T>(command, params?) | Promise<T> | read-only engine queries: project.summary, comp.info, layer.tree, prop.get, editor.state, edit.history.list, ... |
| execute<T>(command, params?) | Promise<T> | journaled engine commands (edit.undo, layer.newSolid, ...) |
| request<T>(method, params?) | Promise<T> | low-level control-method passthrough (ui.click, ui.key, ui.menu.invoke, render.frame, engine.execute, ...) |
| batch(batch: AgentBatchInput) | Promise<BatchResult> | normalizeAgentBatch (contracts 8.5 bounds) then execute("engine.batch", {label, atomic: true, steps}); timeout min(input.timeoutMs or 15 s, 60 s); BatchResult {steps, results} |
| renderFrame(params: RenderFrameParams) | Promise<RenderFrameResult> | RenderFrameParams {comp?, time?, max_side?, path?, transparent?}; result {comp, time, width, height, pngBase64} |
| addFile(file: Blob\|File\|string, name?) | Promise<string> | resolves with the editor-assigned table path |
| addAsset(asset: CloudAsset) | Promise<string> | virtual path `/assets/<assetId>/<sanitizedName>`; fetches signed url in PARENT frame; returns path the editor actually assigned (upstream keeps last path segment) |
| saveToBrowser(path) | Promise<SaveResult{path, bytes}> | SaveResultSchema |
| readFile(path) | Promise<Uint8Array> | throws EDITOR_CALL_FAILED when absent |
| screenshot(params?: ScreenshotParams) | Promise<ScreenshotResult> | ScreenshotParams {path?, panel?, id?}; result {path?, width?, height?, pngBase64} |
| on(event, cb) | () => void | event bus: "ready" (sticky), "focus", "resize", "error" - NO DOM polling |
| version() | string | sync from effectcraft.info() |
| info() | EditorInfo | {version, load {wasmMs, readyMs, error?}} |
| capabilities() | Promise<AppCapabilities> | app.capabilities: version, commands, effects, export[], import, expressions, scripting, gpu, parity |
| dispose() | void | removes listeners; later calls throw EDITOR_DISCONNECTED |

Non-bridge exports:
- `attachEditorBridge(iframe, opts: AttachOptions)` -> Promise<EditorBridge>;
  AttachOptions {callTimeoutMs (default 15_000), readyTimeoutMs (default
  60_000), version (expected prefix; mismatch emits "error" event),
  onEvent}; handshake polls effectcraftLoad.readyMs every 100 ms (the only
  poll), one retry on "not running yet" rejections, BridgeError
  normalization (codes: EDITOR_TIMEOUT, EDITOR_CALL_FAILED,
  EDITOR_NOT_READY, EDITOR_DISCONNECTED)
- `forwardShortcut(iframe, handlers: ShortcutHandlers)` -> detach fn; chat
  shortcuts forwarded from the iframe: toggleChat (Cmd/Ctrl+L), inlineEdit
  (Cmd/Ctrl+K), agent (Cmd/Ctrl+I), stop (Cmd/Ctrl+.), send
  (Cmd/Ctrl+Enter), newChat (Cmd/Ctrl+Shift+L), undoAgentRun
  (Cmd/Ctrl+Shift+U), escape; handler returning false declines (editor sees
  the key)
- `sameOrigin(iframe)` -> boolean
- batch.ts: `AgentBatchInputSchema` (label defaults "Agent batch",
  atomic omitted-only-true, params default {}, timeoutMs), `AgentBatchInput`,
  `normalizeAgentBatch` = `validateAgentBatch` (re-exports contracts
  AGENT_BATCH_SCHEMA as AgentBatchSchema, MAX_BATCH_STEPS,
  MAX_BATCH_TIMEOUT_MS, MAX_BATCH_PAYLOAD_BYTES, AgentBatchStep)
- errors.ts: `BridgeError` {code, retryable, cause}, `isBridgeError`,
  `isBridgeErrorCode`, `messageOf` (upstream rejects with plain strings)
- types.ts schemas: UiInspectSchema, ProjectSummarySchema,
  ProjectItemSummarySchema, PropNodeSchema, PropKeyframeInfoSchema,
  LayerNodeSchema, CommandInfoSchema, CommandSchemaSchema, BatchResultSchema,
  RenderFrameResultSchema, ScreenshotResultSchema, EditorInfoSchema,
  EffectcraftLoadInfoSchema, AppCapabilitiesSchema, SaveResultSchema;
  EffectcraftGlobal (the verified window.effectcraft v0.13.0 surface:
  request, execute, commands, inspect, screenshot, renderFrame, files,
  readFile, addFile, info, saveToBrowser, listStored, removeStored, flush,
  workerFrameCheck), EffectcraftLoad, EffectcraftWindow

### 4.2 Fake editor (`createFakeEditor`, subpath @studio/editor-bridge/fake) vs BUILD_PLAN M0 required surface

M0 task 3 required surface - ALL present on FakeEditor:
- execute -> yes (`execute(command, params)`)
- request -> yes (`request(method, params)`; supports ui.inspect,
  ui.screenshot, render.frame, engine.commands, engine.execute,
  ui.playback; other methods rejected with "unknown method `x`" - matches
  upstream)
- inspect -> yes
- renderFrame -> yes (sets base64: true; returns {comp, time, width,
  height, png} - constant 1x1 transparent PNG stub, FAKE_PNG_BASE64)
- addFile -> yes (keeps last path segment, `fakePathFor`; parses
  "studio-fake-ecproj" .ecproj JSON and loads it)
- readFile -> yes (Uint8Array | undefined)
- saveToBrowser -> yes ({path, bytes}; marks dirty = false)
- screenshot -> yes (inline png or files[path])
- ui.inspect -> yes (request "ui.inspect"; focused panel override)
- project.summary -> yes (querySummary: path, dirty, bitDepth, renderer,
  items (comps with size/duration/layers/frameRate), activeComp, time,
  selectedLayers, undo labels)
- layer.tree -> yes (queryLayerTree: layer json + properties prop-node
  children; seeds transform/anchor, transform/position, transform/scale,
  transform/rotation, transform/opacity)
- prop.get -> yes (queryPropGet: value, animated, keys[], expression)
- render.frame -> yes (renderFrameResult; max_side scaling honored)
- edit.history.list -> yes (queryHistoryList: {states: [{index, id s0..,
  label, parent, depth, current, line, future}], current, branches: 0};
  labels = step that made each state, oldest "Original")
- edit.undo / edit.redo -> yes ({undone: label} / {redone: label}; guard
  errors "nothing to undo" / "nothing to redo")
- engine.batch with $N refs + atomic rollback -> yes (cmdBatch: $N.key
  substitution via reference()/substitute() incl. array index paths,
  NOT_IN_BATCH guard (engine.batch, file.runScript, script.run), atomic
  default true, failing step -> restore(pre-snapshot) + "the batch was
  rolled back (nothing changed)", batch folds into ONE undo entry named by
  `label` (suppressedJournals -> fold()), upstream error strings:
  "step N (`id`): ...")

Registry (17 commands copied from upstream registrations): comp.new,
layer.newSolid, layer.newText, layer.rename, prop.set, prop.get,
engine.batch, edit.undo, edit.redo, edit.history.list, command.list,
command.describe, app.capabilities, project.summary, comp.info, layer.tree,
editor.state. Enabled guards mirror upstream: has_comp ("no composition is
open"), has_layers ("select a layer first"), can_undo/can_redo.

Fake-only affordances: `state` (FakeEditorStateView: version, project,
windowSize, activeComp, selectedLayers, playhead, playing, focusedPanel,
windowFocused, projectPath, dirty, history {undo[], redo[]}, fileTable),
`script(steps, opts)` (batch runner, continueOnError), `reset()`,
overrides {version, windowSize, focusedPanel, playhead, playing, comps,
failOn (per-command error injection - atomicity test tool), latencyMs}.

`attachFakeBridge(fake, opts)` -> EditorBridge synchronously (no DOM);
same typed surface + same Zod validation as the real bridge; addAsset
requires bytes (the fake does not fetch). Tests: bridge.test.ts,
fake.test.ts (jsdom).

Documented fake divergences (in-file): renderFrame returns a constant 1x1
PNG; editor.state.times is comp seconds (upstream serializes ticks);
project.summary items are comps only; no ui.click/ui.key; history ids are
positional (s0, s1, ...) not content-keyed hex; no branches.

### 4.3 Bridge vs BUILD_PLAN

Fulfills: M0 task 3 verification surface (via the fake; the REAL editor
surface verification is blocked - no built editor dist exists, see
editor.md W-R5), M3 task 2 (typed wrapper, timeout/retry/error
normalization, readiness handshake, version check, event bus, no DOM
polling), M3 task 6 (shortcut forwarding incl. Cmd/Ctrl+L/K/I), M5 task 4
apply path (`batch()` -> engine.batch atomic, one undo step). MET at the
package level.
Missing: nothing inside the package scope; the real-iframe integration
(apps/web editor page, asset load sequence, autosave loop calling
saveToBrowser/readFile + versions.upload) is NOT wired anywhere in
apps/web (no file under apps/web imports @studio/editor-bridge).

---

## 5. UI (`packages/ui`, @studio/ui v0.1.0; radix primitives, cva, clsx, tailwind-merge, lucide-react; peer: react ^19)

### 5.1 Component inventory (24 source files under src/components/, all exported from src/index.ts)

Primitives: Button (+ buttonVariants), Input (+ SearchInput, inputVariants),
Textarea (+ useAutoGrow), Select (SelectTrigger, SelectValue, SelectContent,
SelectItem, SelectGroup, SelectLabel, SelectSeparator), Field (+
FieldControlProps), Kbd, Spinner.
Overlays: Dialog (DialogTrigger, DialogContent, DialogTitle,
DialogDescription, DialogClose, DialogActions, ConfirmDialog), Menu
(MenuTrigger, MenuContent, MenuItem, MenuCheckboxItem, MenuRadioGroup,
MenuRadioItem, MenuItemIndicator, MenuItemShortcut, MenuLabel, MenuGroup,
MenuSeparator), Popover (PopoverTrigger, PopoverAnchor, PopoverContent),
Tooltip (TooltipProvider, TooltipTrigger, TooltipContent,
TOOLTIP_DELAY_MS), CommandPalette (+ CommandItem, CommandGroup).
Data display: Card (CardHeader, CardTitle, CardDescription, CardContent,
CardFooter, ProjectCard), Table (TableHeader, TableBody, TableRow, TableHead,
TableCell, TableEmpty), Badge (+ RiskBadge, StatusDot, badgeVariants,
RiskLevel, StatusTone), Avatar, Skeleton, Slate, FrameLine, EmptyState,
CreditMeter (+ CreditState).
Feedback: Toast (ToastProvider, ToastViewport, Toast, ToastTitle,
ToastDescription, ToastAction, ToastClose, toastVariants,
TOAST_DURATION_MS).
Utilities: `cn`, `typeScaleTokens` (lib/utils.ts).

Styles (exports map `css`): tokens.css (154 lines: 3.1 core palette
--ink-0..4/--line-subtle/--line-strong/--paper/--ash/--signal/--ice/
--success/--warning/--danger/--violet; 3.2 semantic tokens --bg-page/
--bg-app/--bg-panel/--bg-elevated/--bg-input/--text-*/--border*/
--focus-ring/--overlay; 4.1 font stacks Instrument Serif/Instrument Sans/
JetBrains Mono via next/font override; 4.2 type scale --text-display-xl
(72px/0.95) ... --text-body; 5.1 spacing, 5.3 radii, 5.4 elevations, 6
motion, 9 chat overlay measurements), theme.css (208 lines: tailwind
mapping via @theme), utilities.css (212 lines). Dark-only; semantic-token
rule; status never colour-only.

Tests (9): badge, button, command-palette, credit-meter, dialog, input,
table, tabs, toast (all *.test.tsx, vitest + testing-library).

### 5.2 UI vs BUILD_PLAN M9 task 1 primitives list

M9 list: buttons -> Button; inputs -> Input/Textarea/Select/Field; dialogs
-> Dialog + ConfirmDialog; menus -> Menu; tabs -> Tabs; tables -> Table;
toasts -> Toast; badges -> Badge/RiskBadge/StatusDot; skeletons ->
Skeleton; command palette -> CommandPalette. VERDICT: MET - every named
primitive exists, plus extras (tooltip, popover, card, avatar, empty-state,
credit-meter, slate, frame-line, kbd, spinner).
M9 task 1 remainder: "Storybook/examples; axe tests" -> MISSING (no
storybook, no axe tests; component tests only). Fonts are stacks + README
wiring (apps side). Tailwind mapping -> MET (theme.css).

---

## 6. API-CLIENT (`packages/api-client`, @studio/api-client v0.1.0; deps: @studio/config, @studio/contracts; exports "." and "./fixtures")

### 6.1 Every method -> gateway route (34 methods, `createApiClient(options) -> ApiClient`)

| Method | Route | Envelope schema (response-schemas.ts) |
|--------|-------|------------------------|
| me.get | GET /v1/me | ME_RESPONSE_SCHEMA |
| workspaces.list | GET /v1/workspaces | PAGE_WORKSPACES_SCHEMA |
| workspaces.create | POST /v1/workspaces | WORKSPACE_SCHEMA |
| workspaces.patch | PATCH /v1/workspaces/:id | WORKSPACE_SCHEMA |
| invites.create | POST /v1/workspaces/:id/invites | INVITE_SCHEMA |
| invites.accept | POST /v1/invites/:token/accept | ACCEPTED_INVITE_SCHEMA |
| projects.list | GET /v1/projects | PAGE_PROJECTS_SCHEMA |
| projects.create | POST /v1/projects | PROJECT_SCHEMA |
| projects.get | GET /v1/projects/:id | PROJECT_SCHEMA |
| projects.patch | PATCH /v1/projects/:id | PROJECT_SCHEMA |
| projects.delete | DELETE /v1/projects/:id (soft) | none (null) |
| projects.manifest | GET /v1/projects/:id/manifest | PROJECT_MANIFEST_SCHEMA |
| versions.list | GET /v1/projects/:id/versions | PAGE_VERSIONS_SCHEMA |
| versions.upload | POST /v1/projects/:id/versions + PUT bytes to signed url (two-phase; UPLOAD_VERSION_RESPONSE_SCHEMA; non-envelope PUT checked by status only) | PROJECT_VERSION_SCHEMA |
| versions.restore | POST /v1/projects/:id/versions/:version/restore | PROJECT_VERSION_SCHEMA |
| leases.acquire | POST /v1/projects/:id/lease | PROJECT_LEASE_SCHEMA |
| leases.release | DELETE /v1/projects/:id/lease | none (null) |
| assets.list | GET /v1/assets | PAGE_ASSETS_SCHEMA |
| assets.createDescriptor | POST /v1/assets | CREATE_ASSET_RESPONSE_SCHEMA |
| assets.getUrl | GET /v1/assets/:id/url | SIGNED_URL_RESPONSE_SCHEMA |
| threads.list | GET /v1/projects/:id/threads | PAGE_THREADS_SCHEMA |
| threads.create | POST /v1/projects/:id/threads | THREAD_SCHEMA |
| threads.messages | GET /v1/threads/:id/messages | PAGE_MESSAGES_SCHEMA |
| chat.stream | POST /v1/threads/:id/chat (SSE; delegates to sse.ts) | n/a (events) |
| runs.get | GET /v1/runs/:id | RUN_RECORD_SCHEMA |
| runs.cancel | POST /v1/runs/:id/cancel | none (null) |
| runs.postEvent | POST /v1/runs/:id/events (tool.result / apply.result) | none (null) |
| credits.get | GET /v1/credits | CREDITS_SUMMARY_SCHEMA |
| credits.ledger | GET /v1/credits/ledger | PAGE_LEDGER_SCHEMA |
| billing.checkout | POST /v1/billing/checkout | CHECKOUT_RESPONSE_SCHEMA |
| billing.portal | POST /v1/billing/portal | PORTAL_RESPONSE_SCHEMA |
| renders.create | POST /v1/renders | RENDER_JOB_SCHEMA |
| renders.get | GET /v1/renders/:id | RENDER_JOB_SCHEMA |
| comments.list | GET /v1/projects/:id/comments | PAGE_COMMENTS_SCHEMA |
| comments.create | POST /v1/projects/:id/comments | COMMENT_SCHEMA |
| activity.list | GET /v1/projects/:id/activity | PAGE_ACTIVITY_SCHEMA |

(33 rows above; with chat.stream counted as 1, total distinct call
signatures = 34.)

Client guarantees: 7.3 envelope unwrap (Ok -> data, Err -> ApiError), Zod
runtime validation of data (strip unknown), client-side body validation with
contracts schemas before sending, `Idempotency-Key` header on every
mutation (explicit or crypto.randomUUID; explicit keys validated against
IDEMPOTENCY_KEY_SCHEMA), AbortSignal everywhere, GET-only retry with
RETRY_DELAYS_MS = [250, 500, 1000] on network error / 408 / 429 / retryable
5xx. ApiError (api-error.ts): wire codes + client-local codes
NETWORK_ERROR, MALFORMED_RESPONSE, UPLOAD_FAILED, VALIDATION_FAILED
(status 0), safe toJSON, fromResponse, isApiError.

### 6.2 SSE reader semantics (sse.ts)

- WHATWG parser `createSseParser(onMessage)` (SseMessage {event, id, data,
  retryMs}); CRLF/LF/CR, multi-line data, comments, streaming UTF-8;
  documented deviation: trailing block without blank-line terminator still
  dispatched.
- Dual payload normalization: native AI SDK UI parts (text-delta,
  tool-input-start, tool-input-delta, tool-call, tool-output-available,
  tool-output-error, tool-result, error; v4 names accepted) and Studio
  data parts (direct or `{"type":"data-*","data":{...}}` wrapped) -> all
  normalized to StudioStreamEvent and folded through contracts
  applyEvents. STREAM_ERROR_CODE = "STREAM_ERROR" for SDK error parts.
- Seq model: server seq dedup (`seq <= lastServerSeq` dropped -> Last-Event-ID
  replay idempotent), strictly-increasing LOCAL seq to the reducer,
  pre-run SDK parts counted in ignoredParts (never guessed).
- Reconnect (8.4): re-POSTs the SAME body with the SAME idempotency key
  (never duplicates a run) + `Last-Event-ID` = highest server seq seen (or
  raw SSE id: when opaque); RECONNECT_SCHEDULE_MS = [1000, 2000, 4000,
  8000], RECONNECT_MAX_DELAY_MS = 30_000, RECONNECT_MAX_AUTO_ATTEMPTS = 3,
  then paused (onPause; "Run paused") with manual controller.reconnect().
  User aborts (signal / abort() / cancel()) never auto-reconnect.
- Controller (ChatStreamController): state, runId, status, text, toolCalls,
  plan, credits, preview, error, versionId, lastServerSeq, lastEventId,
  paused, fatalError, cancelError, ignoredParts, cancel() (POSTs
  /v1/runs/:id/cancel best-effort + aborts), abort(), reconnect(), done
  promise (resolves once per segment; reasons: terminal | aborted | paused |
  closed | error).
- 2xx JSON envelope where a stream was expected -> Err body mapped to
  ApiError, else MALFORMED_RESPONSE.

Tests: client.test.ts, sse.test.ts, retry.test.ts, api-error.test.ts,
_smoke.test.ts, helpers.ts. Fixtures (`./fixtures`): deterministic demo
dataset (demo user, 2 workspaces, 6 projects x 4 versions, assets, threads
with applied + undone runs, ledger balancing to 3200, comments, activity,
renders, SETTINGS_FIXTURES, prj_demo_ ids, studio.example.com urls),
`validateFixtures()` runs everything through the response schemas +
EDIT_PLAN_SCHEMA + STUDIO_STREAM_EVENT_SCHEMA + CHAT_REQUEST_SCHEMA.

### 6.3 api-client vs BUILD_PLAN

Fulfills: typed client for every 7.2 route domain (M1-M8), SSE + reconnect +
Last-Event-ID (M4 task 7 "SSE contract; reconnect; cancel"), idempotency
(M1 task 3), two-phase version upload (M2 task 3). PARTIAL vs contracts:
no comments.resolve/unresolve method (schema exists), no renders.list
method (repo supports it, no route), no asset delete, no plan catalog, no
presence/share (M7). NOT YET CONSUMED: apps/web does not import
@api-client (no dependency in apps/web/package.json) - the loop is not
wired on the client side.

---

## 7. Storage + Billing (legacy) and the consolidated gap list

### 7.1 Wiring gaps (packages not consumed)

- apps/web deps: @studio/config, @studio/contracts, @studio/ui only.
  @studio/api-client and @studio/editor-bridge are NOT dependencies and no
  app file imports them. The editor page (M3), chat overlay consumption of
  the reducer (M4), and apply path (M5) have no client wiring yet.
- services/worker exists but is EMPTY (no package.json; W-R4 confirms) ->
  renders repo markRunning/markCompleted/markFailed/markCancelled and
  storage/renders outputs have no consumer (M8 MISSING).
- services/gateway consumes @studio/config + @studio/contracts + @studio/db
  (all 17 route files incl. health + local-storage).

### 7.2 STORAGE (`packages/storage` v0.1.0; zod ^3.24.1, optional aws4fetch)

- Structural `Storage` seam (types.ts): put(key, data, PutOptions) ->
  StorageObject {key, bytes, contentType, sha256}; get; delete (idempotent);
  sign(key, SignOptions) -> SignedUrl (MAX_SIGN_TTL_SECONDS = 900, 15.1);
  list(prefix) async iterable.
- Typed failure envelope: STORAGE_ERROR_CODES (storage_invalid_key,
  cross_tenant_key, storage_config_invalid, storage_invalid_ttl,
  storage_invalid_argument, storage_driver_unavailable, storage_io_error,
  storage_checksum_mismatch), StorageResult<T>, StorageError/StorageFailure,
  isStorageError/isStorageFailure, storageFailure.
- Drivers: LocalFsStorage (dev/single-box; HMAC-signed local URLs,
  LOCAL_SIGNED_URL_PATH = "/v1/storage/local-object" - gateway
  routes/local-storage.ts verifies) and S3Storage (AWS S3 / Cloudflare R2
  only; MinIO/Garage are AGPL and forbidden; SigV4 presign in
  drivers/sigv4.ts: presignS3Get, s3RequestHost, s3ObjectUrl; R2 compat
  flag), plus createStorageFromEnv(env) fail-fast factory
  (STORAGE_DRIVER=local|s3, no silent default).
- keys.ts: tenant-scoped key space `organizations/<orgId>/...`
  (validateStorageKey, extractTenant, assertTenant, validateStoragePrefix,
  parseStorageKey) + builders assetKey, previewKey, exportKey,
  documentKey, checkpointKey.
- validate.ts (photo-era, NOT re-exported from the barrel): sniffMime,
  pngDimensions, jpegDimensions, dimensions, hasExif, stripExifPlan,
  validateUpload, checksum (ImageMime png/jpeg/webp; DEFAULT_MAX_UPLOAD_BYTES
  25 MB, DEFAULT_MAX_UPLOAD_MEGAPIXELS 60).
- Tests: keys, local-fs, s3, s3-sign, validate + fuzz corpus.

VERDICT: PARTIAL / LEGACY-LEANING. The driver + key-validation + signing
core is sound and reused by the gateway, but the key NAMESPACES and
EXPORT_FORMATS ("pcraft", "png", "jpg", "psd"), `documents`/`sessions`
segments and the photo upload validators belong to the superseded
PhotoCraft product. The EffectCraft product needs `.ecproj` version blobs,
render outputs (mp4/prores/png-seq/gif/wav) and asset virtual paths
`/assets/<assetId>/<name>` (bridge CloudAsset). BUILD_PLAN M0 task 2 said
"keep/adapt: packages/storage (validation, S3)" - the adaptation has not
happened: no `versions/` or `renders/` key builders; MIME sniffing is
image-only (no video/audio/font/LUT/SVG/PDF sniffers required by 12.3).

### 7.3 BILLING (`packages/billing` v0.1.0 - PhotoCraft legacy)

- ledger.ts: LedgerStore seam + reserve/commit/refund/adjustment with
  one-append-per-phase and derived idempotency keys `${runId}:reserve` etc.;
  CREDIT_LEDGER_KINDS = reserve | commit | refund | adjustment | grant |
  pack (mismatch with the landed db kinds grant|reserve|commit|refund|
  adjust - "pack" and "adjustment" do not exist in schema.ts, and the seam
  is organizationId-based while @studio/db is workspaceId-based).
- plans.ts (PLAN_IDS, PLANS, PLAN_LIMITS, CREDIT_PACK, TRIAL_CREDITS,
  planView, PLAN_CATALOG, canRunTier, seatPlanLimits, dailySpendPolicy,
  trialGrantKey), policy.ts (free retry, partial-failure charge caps),
  limits/ (PlanLimitsService, RUN_INTAKE_SCHEMA, TRIAL_PLAN_LIMITS,
  TRIAL_MAX_RUN_CREDITS = 2, TRIAL_ALLOWED_RUN_TIERS, TRIAL_MAX_ASSETS =
  25), guardrails/ (DailySpendGuard, DemoWorkspaceGuard, ProviderHealthPolicy
  with PROVIDER_CIRCUIT_CLASSES text|image_draft|image_final -
  PhotoCraft image-provider concepts, not the Studio studio-fast/smart/
  vision model ids).
- Extensive tests (ledger, plans, policy, barrel, edge/ concurrency +
  grace-and-partial + dunning notes + expiry display).

VERDICT: PARTIAL / LEGACY. Money-math semantics (reserve -> commit |
refund, exactly-once keys, never-negative) carried over into
@studio/db/src/repos/ledger.ts + ledger-math.ts, which is the version the
gateway actually uses. The @studio/billing package itself is unwired
(nothing depends on it; gateway does not import it), keeps PhotoCraft
kinds/ids, and M6 entitlements (seats, storage, render minutes, model
gating) for the EffectCraft product live only in contracts models.ts +
gateway code - there is no plan-state table or entitlements service yet.

### 7.4 Config gaps

- STORAGE_* env vars absent from the config env schema (storage requests
  6 more; see 3.1). The .env.example generator therefore cannot emit
  them; gateway local-storage route depends on vars outside the schema.
- Two id schemes: config ids.ts render prefix `rnd_` vs db renders rows
  `rdr_` (harmless but should be unified before public ids appear).
- errors-lite (db) vs config errors: two catalogs, unification (W1-e)
  still open; db has QUOTA_EXCEEDED, config has ASSET_TOO_LARGE /
  ASSET_REJECTED etc. - gateway must pick per-route.

### 7.5 Cross-package contract mismatches (builders must reconcile)

- Run status enums: contracts SERVER_RUN_STATUSES = queued | streaming |
  awaiting_approval | applying | completed | failed | cancelled vs db
  RunStatus = queued | running | awaiting_approval | completed | failed |
  cancelled. The gateway maps between them today; a shared enum would remove
  the drift risk.
- Render statuses: contracts RENDER_STATUSES uses "succeeded"; db
  RenderStatus uses "completed". Same drift.
- Credit granularity: contracts estimateCredits/reserveFor return
  fractional credits rounded to 2 decimals (CREDIT_RESERVE_MULTIPLIER 1.2);
  db credit_ledger.amount is INTEGER and computeReserveAmount uses ceil.
  Fractional model rates (MODEL_CATALOG creditsPer1kInput 0.01) cannot be
  committed to the integer ledger as-is; commit path must round or the
  ledger column must become numeric.
- Lease TTL defaults agree (LEASE_TTL_MS 300000 = DEFAULT_LEASE_TTL_MS) -
  OK.
- Comments: RESOLVE_COMMENT_SCHEMA + CommentsRepo.resolve/unresolve exist;
  no gateway route and no api-client method (M7 task 1 "resolve" PARTIAL).
- Versions: VersionsRepo.get + AssetsRepo.bySha256 + quota + LeasesRepo.get
  + RunsRepo.listByThread + LedgerRepo.commit/refund/adjust/
  getEntryByIdempotencyKey are implemented but unreachable through the
  current API surface (dead until M2 dedupe/quota, M6 reconciliation and
  run-history routes land).

### 7.6 Milestone scorecard for packages/**

| Package | Fulfills | Gaps |
|---------|----------|------|
| contracts | M1 wire, M2, M4 chat+events+tools, M5 EditPlan/batch/apply, M6 route shapes, M7 comments/activity, M8 renders | share-link + presence + render-list + plan-catalog contracts; run/render status enum drift |
| db | M1 auth/roles/repos, M2 projects/versions/leases/assets, M4 threads/runs, M5 run persistence, M6 credit ledger, M7 comments/audit, M8 renders rows | subscription/plan-state tables, presence, share tokens, quota enforcement wiring, unused repo surface |
| config | M0 env + .env.example generator, M1/M3/M4/M6/M10 vars | STORAGE_* unification, id prefix drift, error-catalog unification |
| editor-bridge | M0 surface (fake), M3 bridge/handshake/events/shortcuts, M5 batch apply | real-editor verification blocked (no dist); no app consumer |
| ui | M9 task 1 primitives + tokens COMPLETE (all 10 named primitives + 14 extras) | Storybook, axe tests; M9 tasks 2-6 are apps-side |
| api-client | all 7.2 route domains typed, SSE reconnect/Last-Event-ID (M4), idempotent mutations, two-phase uploads (M2) | resolve/render-list methods, presence/share, not consumed by apps/web |
| storage | M0 "keep/adapt" partially kept: drivers, keys, signing, tests | PhotoCraft namespaces/formats/validators; no .ecproj/render key builders; env vars split |
| billing | M0 "keep/adapt" kept as reference: reserve/commit/refund math + tests | legacy kinds/orgId/provider classes; unwired; Studio entitlements live only in gateway code |

### 7.7 Recommended next actions (packages layer)

1. Wire apps/web to @studio/api-client + @studio/editor-bridge (editor page,
   autosave loop -> versions.upload, chat overlay reducer), which unblocks
   M3/M4/M5 exit criteria.
2. Add subscriptions/plan-state table + entitlements route (M6), then wire
   LedgerRepo.adjust for reconciliation.
3. Expose the implemented-but-unrouted repo surface: renders list,
   comments resolve/unresolve, assets bySha256 dedupe + quota, run history
   (GET /v1/threads/:id/runs or similar), lease GET.
4. Unify enums (run/render statuses) and credit granularity between
   contracts and db before any external consumer locks onto them.
5. Port storage key builders to the Studio world (versions/renders/assets
   namespaces, .ecproj, render formats) and fold STORAGE_* into the config
   env schema.
6. Add Storybook + axe to @studio/ui to finish M9 task 1's tail.
