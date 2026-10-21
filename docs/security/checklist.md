# Security Checklist — OWASP-aligned audit

Task owner: **W10-Q** (owns `docs/security/**`). Audit basis: `docs/BUILD_PROMPT.md` §15
(security & multi-tenancy; the §15.2 RBAC matrix is restated in §4 below), §5.7
(prompt-injection stance), §21 Security row, §20 #11 (beta gate); and
`docs/adr/0003-auth-and-orgs.md` (auth decision + RBAC matrix).

This is a **documentation audit of what the codebase enforces today**, written from the
spec plus verified file pointers and the landed test evidence. It is deliberately honest
about gaps; anything marked ⏳ or ⬜ must be closed (or formally accepted in
`pentest-prep.md` §7) before the §20 beta gate is claimed live.

Status vocabulary per control:

| Marker | Meaning |
|---|---|
| ✅ | Implemented + test-evidenced in-repo |
| 🟡 | Implemented, test coverage partial or wiring incomplete |
| ⏳ | Owed by an in-flight task (owner named) |
| ⬜ | Planned / not started (spec requirement) |

---

## 1. Test evidence inventory (state as of this audit)

| Suite | Path | State |
|---|---|---|
| Cross-tenant isolation suite (**§20 #11**) | `apps/gateway/tests/integration/cross-tenant.test.ts` (+ `harness.ts`, `README.md`) | ✅ landed — an org-A attacker (holding the *owner* role in their own org) cannot read/list/command/stream org-B documents, assets, runs or workspaces; probed both directions; unauthenticated probes 401 before the tenant gate |
| RBAC matrix suite | `apps/gateway/tests/integration/rbac-matrix.test.ts` | ✅ landed — walks the ADR-0003 capability matrix |
| Signup/invite + ledger flows | `apps/gateway/tests/integration/{signup-flow,ledger-flow}.test.ts` | ✅ landed (§20 #1, §20 #10 evidence) |
| Gateway unit security tests | `apps/gateway/tests/{authz,auth,middleware,rate-limit,limiter,uploads,runs-events,billing,command-exec,audit-routes,health-audit}.test.ts` | ✅ landed |
| Webhook signature/idempotency | `apps/gateway/src/services/billing-complete/tests/{webhook-idempotency,wiring-check,ledger-bridge}.test.ts` | ✅ landed (real HMAC verification, no network) |
| Upload fuzzing (§21 row: polyglot files, zip bombs, EXIF payloads) | `packages/storage/tests/fuzz/{corpus.mjs,corpus.d.mts,fuzz-validate.test.ts,README.md}` | ✅ landed (W10-A) — 39 pinned attack fixtures + 888-mutant deterministic sweep |
| Storage key/validate/S3 signing units | `packages/storage/tests/{keys,validate,s3,s3-sign,local-fs}.test.ts` | ✅ landed |
| Agent guard tests | `packages/agent/tests/guards/{tool-gate,injection}.test.ts` | ✅ landed |
| Engine-client auth/budget/capability units | `packages/engine-client/tests/{auth,budgets,capabilities}.test.ts` | ✅ landed — 59 auth cases (token-file trust, redaction, no-echo), traversal/ambient/tenant-id attack tables |
| **OWASP/§21 gateway suite (W10-B)** | `tests/security/` (repo-root suite) | ⏳ **NOT LANDED** — the directory does not exist on `origin/main` as of this audit (the `W10-B/D/F sweep` commit `e978d94` contains no security-suite files; no W10-B worklog entry yet). Treated as in flight. |
| Agent-side security suite | `packages/agent/tests/security/` | ⏳ empty placeholder directory (untracked) — reserved for W10-B |

**What this means:** the core isolation, RBAC, upload-fuzz and injection controls have
landed evidence; the dedicated §21 "Security" test layer (CSRF, session replay,
rate-limit bypass, SSRF probes as an organized suite) is owed by W10-B and should be
reconciled against this checklist when it lands (§5 G6).

---

## 2. OWASP Top-10 (2021) cross-reference

| OWASP category | Controls (§3) | Primary enforcement files |
|---|---|---|
| A01 Broken Access Control | C1, C2, C3, C4 | `apps/gateway/src/middleware/auth-context.ts`, `apps/gateway/src/authz/{guard,matrix}.ts`, `apps/gateway/src/services/workspaces.ts`, `packages/storage/src/keys.ts` |
| A02 Cryptographic Failures | C4, C5, C8 | `apps/gateway/src/auth/{api-keys,server}.ts`, `packages/engine-client/src/auth.ts`, `apps/gateway/src/services/stripe.ts`, `packages/storage/src/s3-sign.ts` |
| A03 Injection | C6, C10, C11 | `packages/storage/src/validate.ts`, `packages/agent/src/guards/{injection,tool-gate}.ts` |
| A04 Insecure Design | C3, C9, C11 | §15.1 architecture (C3), `packages/billing/src/guardrails/*`, `packages/agent/src/validator/gate.ts` |
| A05 Security Misconfiguration | C5, C12 | `packages/config/src/env/*`, `apps/web/next.config.ts`, `apps/gateway/src/middleware/error-mapper.ts`, `infra/compose/docker-compose.yml` |
| A06 Vulnerable & Outdated Components | §5 gap G4 | `scripts/check-licenses.mjs`, `licenses.overrides.json`, `infra/ci-staged/license-check.yml` |
| A07 Identification & Authentication Failures | C1, C4, C9 | `apps/gateway/src/auth/{server,session}.ts`, `apps/gateway/src/middleware/rate-limit.ts`, `apps/gateway/src/services/limiter.ts` |
| A08 Software & Data Integrity Failures | C8, C9 | `apps/gateway/src/services/billing-complete/webhook-idempotency.ts`, `packages/billing/src/ledger.ts`, `apps/engine-pool/src/wal.ts` |
| A09 Logging & Monitoring Failures | C12 | `apps/gateway/src/services/audit.ts`, `apps/gateway/src/middleware/{request-id,request-context,logger}.ts`, `packages/db/src/schema/audit.ts` |
| A10 SSRF | C11, §5 gap G7 | `packages/engine-client/src/transport/socket.ts` (loopback-only), §5.7 no-network stance |

---

## 3. Controls

### C1 — Session authentication & the indistinguishable 401 ✅

- **Spec:** §15.2 (Better Auth sessions: httpOnly, secure, sameSite cookies), §13 auth
  model (session cookie for the web app, API keys otherwise), ADR-0003.
- **Enforced where:** `apps/gateway/src/middleware/auth-context.ts` —
  `requireAuth(provider)` resolves the caller via the injected `AuthProvider`
  (`createDefaultAuthProvider`) or rejects **401 `unauthorized` before any tenant or
  role check runs**; `extractBearerToken` handles API-key auth. Session machinery lives
  in `apps/gateway/src/auth/{server,session,client-config}.ts` on the Better Auth
  Drizzle adapter (identity tables: `packages/db/src/schema/auth.ts`).
- **401 indistinguishability:** authentication is always the first gate — e.g.
  `apps/gateway/src/routes/runs-events.ts`: "Gate 1 — auth (§13). Unauthenticated
  requests never reach the tenant check." The same typed envelope is returned whether
  or not the target exists, so no oracle confirms resource existence.
- **CSRF on cookie-auth mutations:** origin allowlist — `apps/gateway/src/auth/server.ts`
  pins Better Auth `trustedOrigins` to the web app + auth origin ("§15.2:
  CSRF-allowed origins"); `apps/gateway/src/auth/client-config.ts` documents "the
  gateway trusts only APP_URL".
- **Tests:** `apps/gateway/tests/{auth,middleware}.test.ts`; unauthenticated probes in
  `apps/gateway/tests/integration/cross-tenant.test.ts`.

### C2 — Server-side RBAC & role gates ✅

- **Spec:** §15.2 "RBAC enforced server-side on every endpoint … UI hiding is not
  enforcement"; matrix restated in §4 below.
- **Enforced where:**
  - `apps/gateway/src/middleware/auth-context.ts` — `requireRole(...roles)` route gate.
  - `apps/gateway/src/authz/roles.ts` — `ROLES` (`viewer ⊂ editor ⊂ admin ⊂ owner`,
    cumulative), `ROLE_RANK`, `can(role, permission)`, `MIN_ROLE_FOR_PERMISSION`.
  - `apps/gateway/src/authz/matrix.ts` — `ADR_RBAC_TABLE` (the ADR-0003 matrix as
    data, `ADR_ROW_COUNT = 11`), `PERMISSION_MATRIX`, and
    **`assertMatrixMatchesAdr()`** — CI fails if code and ADR drift.
  - `apps/gateway/src/authz/guard.ts` — `createResourceGuard()` typed resource guard;
    denials are typed `ForbiddenError` / `CrossTenantDeniedError`, logged with
    `request_id`, and never leak ids in envelopes.
- **Tests:** `apps/gateway/tests/authz.test.ts`,
  `apps/gateway/tests/integration/rbac-matrix.test.ts`.

### C3 — Tenant isolation (the non-negotiable core, §15.1) ✅

- **Spec:** §15.1 composite-key tenant scoping, storage-path prefixes, and ADR-0003's
  "cross-tenant lookups return 404, not 403".
- **Enforced where — three layers:**
  1. **DB composite scoping** — every content lookup is org+id composite:
     `apps/gateway/src/services/{documents,runs,exports}.ts` each carry the rule as a
     code comment: "§12.2 composite org+id lookup: a foreign document is
     indistinguishable from a missing one — never confirm existence across tenants
     (§15.1)" → typed **404 `not_found`**, never 403, never data.
  2. **Membership assertion seam** — `apps/gateway/src/services/workspaces.ts`
     `assertTenant(userId, workspaceId)` resolves membership first;
     `apps/gateway/src/authz/guard.ts` `TypedResourceGuard.assertTenant()` answers
     typed **403 `cross_tenant_denied`**. Both semantics are deliberate and pinned in
     `apps/gateway/tests/integration/README.md`: *lookups* hide existence (404),
     *assertions* state denial (403) — and never a 2xx carrying another org's data.
  3. **Storage key-space guard** — `packages/storage/src/keys.ts`:
     `validateStorageKey` (relative path, known namespace, id/filename char policy,
     `MAX_KEY_BYTES`), `extractTenant`, **`assertTenant(key, organizationId)`**
     enforced across all five `KEY_NAMESPACES`, plus `validateStoragePrefix`,
     `isSafeId`, `isSafeFilename`, `isWindowsDeviceName`. Object keys are
     `organizations/<org>/…`-shaped, so a foreign-org key is a typed rejection.
- **Engine sessions (§15.1):** one engine process per tenant session, per-process
  256-bit token, capability roots scoped to the workspace working directory; the token
  never reaches the browser (see C11).
- **Tests:** `apps/gateway/tests/integration/cross-tenant.test.ts` (both directions,
  attacker is *owner* in their own org; the keys.ts `assertTenant` table covers all
  five storage namespaces, including preview/export object spaces that have no HTTP
  route yet); `packages/storage/tests/keys.test.ts`; `apps/gateway/tests/authz.test.ts`.

### C4 — API keys ✅

- **Spec:** §15.2 + ADR-0003 plugin 2 — hashed at rest (SHA-256 + pepper), scoped
  (`documents:read`, `documents:write`, `runs:create`, `exports:create`), revocable,
  last-used metadata, per-key rate limits; a key's role never exceeds its creator's.
- **Enforced where:** `apps/gateway/src/auth/api-keys.ts` ("hashed at rest (SHA-256,
  never disabled), revocable (`enabled=false`)"), wired through the Better Auth apiKey
  plugin in `apps/gateway/src/auth/server.ts`; bearer extraction in
  `apps/gateway/src/middleware/auth-context.ts`.
- **Tests:** `apps/gateway/tests/auth.test.ts`; scope/role ceiling rules exercised in
  `apps/gateway/tests/integration/rbac-matrix.test.ts`.

### C5 — Secrets handling ⏳ (W10-N policy pointer)

- **Spec:** §15.2 "Secrets: environment only; never in the repo, never in logs; rotate
  on schedule and on suspicion; separate keys per environment. Fail fast when a
  required secret is missing."
- **Policy pointer:** the dedicated secrets-handling policy is owed by task **W10-N**
  (in flight at audit time — no W10-N entry in the worklog; update this section with a
  direct link when it lands). **Current enforcement to point at:**
  - Fail-fast env parsing per app: `packages/config/src/env/{shared,gateway,worker,web,engine-pool}.ts`
    — a missing required secret refuses startup (`docs/AGENTS.md` code-style law).
  - `.env.example` (repo root) is the only committed env shape; no `.env` in git; the
    root `.dockerignore` keeps `.env*` out of image layers.
  - Never-in-logs: engine control tokens are structurally unloggable —
    `packages/engine-client/src/auth.ts` `redactToken`/`redactEngineAuth` return a
    constant `[redacted engine control token]` and error messages never echo tokens
    (59-case table in `packages/engine-client/tests/auth.test.ts`).
  - Request-log redaction: `apps/gateway/src/middleware/request-context.ts`
    (`REDACTED_MARKER`, `PROMPTISH_KEYS`, `redactPromptish`) and
    `apps/gateway/src/middleware/logger.ts` (`REQUEST_LOG_REDACT_PATHS`).
  - `docs/AGENTS.md` Forbidden: "No secrets or tokens in code/docs."

### C6 — Upload pipeline (validate.ts guards) 🟡

- **Spec:** §15.2 uploads — MIME sniffing (not just headers), size caps (25 MB/image,
  10 files/request default), image decode validation, EXIF stripping (except color
  profile), filename sanitising, reject unsanitised SVG — plus §21 upload fuzzing.
- **What exists:** `packages/storage/src/validate.ts` — `sniffMime` (magic bytes; the
  MIME allowlist is exactly `image/png | image/jpeg | image/webp`, so **SVG is rejected
  outright** — stricter than "reject unless sanitised"), `dimensions()` with
  `DEFAULT_MAX_UPLOAD_MEGAPIXELS = 60` (plan ceilings narrow further per §14.1),
  `validateUpload` with `DEFAULT_MAX_UPLOAD_BYTES = 25 MB` (size gate runs before
  sniffing), `hasExif` + `stripExifPlan` (drops only APP1/APP2/COM segments; keeps
  ICC/XMP color data per §15.2), `checksum` (sha256, the §12.1 dedupe key).
- **Gateway layer:** `apps/gateway/src/middleware/caps.ts` (`checkUploadSize`,
  `uploadCap`), `apps/gateway/src/routes/uploads.ts`,
  `apps/gateway/src/services/assets.ts`.
- **Fuzz evidence:** `packages/storage/tests/fuzz/` (W10-A) — 39 attack fixtures with
  pinned verdicts (polyglots, zip-bomb-as-image claims, EXIF payloads, corrupt
  chunks, renamed GIF/ZIP/MZ, extension-vs-magic mismatches) + an 888-mutant
  deterministic sweep; every case must yield the typed §1.5 envelope, never a crash,
  never a path/stack leak. Coverage matrix and explicit deferrals:
  `packages/storage/tests/fuzz/README.md`.
- **Honest gaps (§5):** filename policy (traversal/NUL/oversize/RTLO) is carried as
  corpus metadata and must be enforced by the gateway upload route before storage keys
  are minted (G2); the EXIF re-slice (rewriting stripped bytes in the live path) is
  planned-but-unwired (G1); AV scan (ClamAV) + quarantine bucket are ⬜ (§15.2
  optional).

### C7 — SSE authentication ✅

- **Spec:** §13.1 `GET /runs/:id/events`, §13.2 SSE event types, §15.2.
- **Enforced where:** `apps/gateway/src/routes/runs-events.ts` — "Gate 1 — auth
  (§13)": the injected `auth.authenticate(request)` seam resolves the caller from the
  session cookie or API key; **unauthenticated ⇒ 401 `unauthorized` before the tenant
  check**; the run's organization must then match the caller's (same two-semantics
  rule as C3). `Last-Event-ID` is schema-validated (`^[0-9]{1,15}$` ⇒ 400
  `validation_failed` on garbage) and replays only from the durable event store
  (`apps/gateway/src/services/event-store.ts`).
- **Stance for testers:** SSE is **authed, not public** — there is no unauthenticated
  event stream in the product. This is a documented, accepted position (see
  `pentest-prep.md` §7) so pentesters don't re-litigate it.
- **Tests:** `apps/gateway/tests/runs-events.test.ts`;
  `apps/gateway/tests/integration/cross-tenant.test.ts` includes SSE probes in both
  directions.

### C8 — Webhook signature verification ✅

- **Spec:** §15.2 webhooks — Stripe signature verification, idempotent processing by
  event id, no business logic in the request path beyond enqueueing.
- **Enforced where:**
  - `apps/gateway/src/services/stripe.ts` — HMAC-SHA256 verification in Stripe's
    scheme, computed over the **raw body**.
  - `apps/gateway/src/services/billing-complete/webhook-idempotency.ts` — "signature
    over the raw body; idempotent by event id"; `invalid_signature` maps to the same
    400 the route emits; replays by event id never double-settle (append-only ledger,
    §12.2). Ledger effects: `apps/gateway/src/services/billing-complete/ledger-bridge.ts`.
- **Tests:** `apps/gateway/src/services/billing-complete/tests/webhook-idempotency.test.ts`
  (raw-body signature path + race cases), `wiring-check.test.ts`, `ledger-bridge.test.ts`.

### C9 — Rate limits, caps & budget guardrails ✅

- **Spec:** §15.2 (rate limits per IP/user/workspace on auth, uploads, runs, exports;
  per-key limits), §15.1 quota isolation, §18.4 free/demo budget guardrails.
- **Enforced where:**
  - `apps/gateway/src/middleware/rate-limit.ts` — `rateLimit()` middleware, `clientIp()`,
    standard `X-RateLimit-*` headers (`RATE_LIMIT_HEADERS`), skip-path allowlist.
  - `apps/gateway/src/services/limiter.ts` — the limiter service behind the middleware.
  - `apps/gateway/src/middleware/caps.ts` — upload size caps (`uploadCap`,
    `checkUploadSize`).
  - `packages/billing/src/guardrails/demo-workspace.ts` — `DEMO_ORG_ID`,
    `isDemoWorkspace`, `DEMO_RUNS_PER_DAY = 10`, `exportWatermarkFor` (demo exports
    watermarked), `DEMO_ENABLED` kill switch, `DemoWorkspacePolicy`.
  - `packages/billing/src/guardrails/daily-caps.ts` — daily spend caps (§18.4).
  - `packages/billing/src/guardrails/provider-killswitch.ts` — `ProviderHealthPolicy`
    + `PROVIDERS_DISABLED` env circuit-breaker with per-class failover.
- **Tests:** `apps/gateway/tests/{rate-limit,limiter,uploads}.test.ts`;
  `packages/billing/src/guardrails/tests/{daily-caps,demo-workspace,provider-killswitch}.test.ts`.

### C10 — Prompt-injection stance (§5.7: data, not instructions) ✅

- **Spec:** §5.7 — user content (prompts, layer text, file names, OCR text, comment
  bodies) is **data, never instructions**; treat every model-proposed tool name and
  argument as untrusted input.
- **Enforced where:** `packages/agent/src/guards/injection.ts` —
  `USER_CONTENT_KINDS = ["prompt","layerText","filename","comment"]`, per-kind
  `USER_CONTENT_MAX_CHARS`, `stripUnsafeControls` (control-character stripping),
  `normalizeHomoglyphs` (defeats lookalike smuggling), `INJECTION_FLAG_PATTERNS` +
  `scanForInjectionFlags` (detection/telemetry), and **`wrapAsDataBlock` /
  `escapeForDataBlock`** — every user string enters model context inside an escaped,
  kind-labelled quoted data block, so it cannot be parsed as an instruction.
  `sanitizeUserContent` is the single entry point.
- **The gate:** `packages/agent/src/guards/tool-gate.ts` — `ToolCallGate` verdicts:
  `unknown_tool` (allowlist — reject anything not in the registry), `args_cap`
  (`GATE_MAX_ARG_STRING_CHARS`, `GATE_MAX_ARG_ARRAY_ITEMS = 50`,
  `GATE_MAX_ARG_RECORD_ENTRIES = 50`, `GATE_MAX_ARG_DEPTH = 8`), `invalid_args` (Zod
  schema validation), and `mutating_budget` (`mutatingCommandCapFromTier(tier)` caps
  mutating commands per run, §5.2 tiers).
- **Output safety (§15.3):** the validator gate (`packages/agent/src/validator/gate.ts`,
  service in `packages/agent/src/validator/service.ts`) rejects absolute paths,
  out-of-workspace ids and oversized strings before anything reaches the engine.
- **Tests:** `packages/agent/tests/guards/{injection,tool-gate}.test.ts`;
  `packages/agent/tests/validator/{gate,service}.test.ts`. (The dedicated
  `packages/agent/tests/security/` injection corpus suite is W10-B, in flight — §1.)

### C11 — No-shell / no-fetch tool surface ✅

- **Spec:** §5.7 "Tools are an allowlist; there is no shell, no network fetch, no
  arbitrary file read, no code execution tool for the agent"; §15.3 "Engine commands
  are the only side effects, and they are allowlisted per plan and per tool."
- **What exists:** `packages/tools/src/registry.ts` + `registry-defaults.ts` — the 15
  semantic tools of §6 (`template.*`, `component.*`, `layer.*`, `text.set`,
  `asset.*`, `image.generate`, `render.preview`, `export.document`,
  `validate.document`, `workspace.snapshot`, `ask-user`). **No tool shells out, no
  tool fetches a URL, no tool reads arbitrary files.** Engine side effects flow through
  `apps/gateway/src/services/command-exec.ts` against the allowlisted command ids.
- **Engine trust boundary (§15.1 — the engine's own layer is the second line):**
  - `packages/engine-client/src/auth.ts` — `generateControlToken` (32 random bytes,
    64-hex), `resolveEngineToken` (inline or **owner-only 0600 token file**; both is a
    typed conflict; fail-closed), `redactToken` (constant — token never logged/echoed),
    `parseEngineAuth` (Zod boundary).
  - `packages/engine-client/src/transport/socket.ts` — **loopback-only** TCP
    transport enforcement.
  - `packages/engine-client/src/budgets.ts` + `capabilities.ts` — frame ceilings
    (1 MiB request / 8 MiB reply / 5 MiB PNG / 64 MP canvas) and the ambient-path +
    tenant-id attack tables (engine refuses ambient paths in automation mode, §5.7).
  - No engine port exposure: `infra/compose/docker-compose.yml` keeps engine traffic
    on the private compose network; `infra/caddy/Caddyfile` 404s internal routes at
    the edge.
- **Tests:** `packages/engine-client/tests/{auth,capabilities,budgets}.test.ts`,
  `apps/gateway/tests/command-exec.test.ts`.

### C12 — Headers, error hygiene, audit logging ✅ (CSP nonce 🟡)

- **Headers (§15.2):** `apps/web/next.config.ts` sets `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
  `Strict-Transport-Security: max-age=15552000` on every path. **CSP with nonces is a
  documented TODO** (§5 G3).
- **Error hygiene (§13.3 + `docs/AGENTS.md`):**
  `apps/gateway/src/middleware/error-mapper.ts` (`errorMapper`, `notFoundHandler`) —
  typed envelopes `{ok:false, code, message, hint?, retryable?}`; never stack traces,
  absolute paths or internal ids.
- **Audit log (§15.4 / §22):** `apps/gateway/src/services/audit.ts` +
  `apps/gateway/src/routes/audit.ts` + `packages/db/src/schema/audit.ts` — append-only,
  actor/IP/timestamp for destructive actions, role changes, API-key events and credit
  adjustments; exportable per workspace.
- **Correlation & redaction:** `apps/gateway/src/middleware/request-id.ts`
  (`x-request-id`), `request-context.ts` (prompt redaction unless the workspace opts
  in), per §22.
- **Internal metrics:** `/metrics` is mounted at the app root (never under `/v1`),
  fail-closed 401 without `METRICS_TOKEN`, and 404'd at the Caddy edge
  (`apps/gateway/src/routes/metrics.ts`, `apps/gateway/src/app.ts`).
- **Tests:** `apps/gateway/tests/{middleware,health-audit,audit-routes,metrics}.test.ts`.

---

## 4. The §15 RBAC matrix, restated (ADR-0003)

Better Auth org roles are the single source of truth; the gateway maps them to
permissions (`viewer ⊂ editor ⊂ admin ⊂ owner`, cumulative). This exact table is
encoded in `apps/gateway/src/authz/matrix.ts` (`ADR_RBAC_TABLE`, `ADR_ROW_COUNT = 11`)
and **CI fails if the code drifts from it** (`assertMatrixMatchesAdr`).

| Capability | viewer | editor | admin | owner |
| --- | :---: | :---: | :---: | :---: |
| Read documents/assets/runs/versions | ✅ | ✅ | ✅ | ✅ |
| Comment (with position) | ✅ | ✅ | ✅ | ✅ |
| Create runs (`POST /runs`, tiers) | ❌ | ✅ | ✅ | ✅ |
| Manual commands / undo / redo / restore | ❌ | ✅ | ✅ | ✅ |
| Exports (`exports:create`) | ❌ | ✅ | ✅ | ✅ |
| Upload assets / register templates | ❌ | ✅ | ✅ | ✅ |
| Manage members + invites | ❌ | ❌ | ✅ | ✅ |
| Billing (checkout/portal, credit packs) | ❌ | ❌ | ✅ | ✅ |
| API key management | ❌ | ❌ | ✅ | ✅ |
| Delete workspace | ❌ | ❌ | ❌ | ✅ |
| Transfer ownership / dissolve | ❌ | ❌ | ❌ | ✅ |

API keys get a role no greater than the creating member's (an editor's key may hold
`runs:create`; a viewer's cannot) and are additionally constrained by scope (C4).
Enforcement is server-side on every endpoint — UI hiding is never enforcement.

---

## 5. Gap register (open items, with owners)

| # | Gap | Control | Owner / next action |
|---|---|---|---|
| G1 | EXIF strip is planned (`stripExifPlan`) but the live re-slice/rewrite step is unwired in the upload path | C6 | upload-route owner (flagged in `docs/phases/acceptance-matrix.md`); the fuzz corpus already pins that reassembled plans re-validate clean + EXIF-free |
| G2 | Filename policy (traversal, NUL bytes, oversized names, RTLO) must be enforced by the gateway upload route before storage keys are minted; `validate.ts` is deliberately bytes-only | C6 | gateway upload route; payloads already carried in `packages/storage/tests/fuzz/corpus.mjs` metadata (W10-A flag) |
| G3 | CSP with nonces (§15.2 "no inline scripts except nonce'd") is a TODO in the web app | C12 | web owner |
| G4 | `pnpm-lock.yaml` not committed; `pnpm audit` + Dependabot unconfigured until CI is enabled (workflows staged in `infra/ci-staged/`) | §2 A06 | CI owner; `license-check.yml` already staged |
| G5 | AV scan (ClamAV) + quarantine bucket (§15.2 optional) not implemented | C6 | ⬜ accept-or-implement decision at the beta gate |
| G6 | W10-B §21 security suite (`tests/security/`, `packages/agent/tests/security/`) not landed — CSRF, session-replay, rate-limit-bypass and SSRF probes not yet organized | §1 | W10-B; reconcile against this checklist on landing |
| G7 | Outbound SSRF surface (S3 endpoint/presign, provider calls) has no dedicated fuzz suite | §2 A10 | gateway/storage driver owner (deferral documented in `packages/storage/tests/fuzz/README.md`) |
| G8 | Secrets-handling policy document owed by W10-N | C5 | W10-N; link it here on landing |

**Retained stance:** engine internals (`vendor/photocraft`) are out of this audit's
scope by policy — the engine's own token auth, 16-connection cap and timeouts are the
documented second line (§15.1); our first line is everything in §3. Never edit
`vendor/*` (`docs/AGENTS.md`).
