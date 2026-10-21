# Threat Model — STRIDE-lite

Prepared by **W10-Q** (`docs/security/**`). Method: STRIDE-lite per asset — for each of
the five product assets we enumerate Spoofing (S), Tampering (T), Repudiation (R),
Information disclosure (I), Denial of service (D), Elevation of privilege (E), and point
at the **implemented mitigation** in this repo. This is a mapping document, not a
narrative: every mitigation cites a file that exists today. Known-unmitigated items
appear only in the residual-risk register (§7) with owners, mirrored from
`checklist.md` §5.

Spec basis: `docs/BUILD_PROMPT.md` §15 (esp. §15.1 isolation, §15.2 appsec, §15.3
model safety), §5.7 (prompt-injection stance), §13 (API), §14.2 (money rules);
`docs/adr/0003-auth-and-orgs.md`.

## 0. Trust boundaries

```
browser ──(session cookie / API key)──> gateway ──(internal calls)──> worker
                                          │                            │
                                          │                            ├─ engine-pool ─(256-bit control token,
                                          │                            │   loopback TCP)─> engine process
                                          ├─ Postgres (composite org+id scoping)
                                          └─ object storage (tenant-prefixed keys, signed URLs)
```

- The browser never talks to anything but the gateway; engine tokens never reach it (§15.1).
- Worker + engine-pool never see cookies (ADR-0003); they authenticate via internal calls.
- The engine's own token auth / connection cap / timeouts are the **second** line;
  everything in this model is the **first** line (§15.1).

Assets: **documents** (+ versions), **assets** (uploads), **credits** (ledger/billing),
**tokens** (engine control tokens + API keys), **sessions** (user + engine sessions).

---

## 1. Documents (and versions)

| Threat | Scenario | Mitigation (implemented) |
|---|---|---|
| S | Attacker spoofs a user/org to read or edit another tenant's document | `requireAuth` + `createDefaultAuthProvider` (`apps/gateway/src/middleware/auth-context.ts`); membership via `services/workspaces.ts` `assertTenant`; hashed API keys (`apps/gateway/src/auth/api-keys.ts`) |
| T | Direct mutation of a foreign document (command injection via `POST /v1/commands`) | Editor-gated routes (`requireRole`, `middleware/auth-context.ts`); allowlisted command ids only (`apps/gateway/src/services/command-exec.ts`); per-run mutating-command budget (`packages/agent/src/guards/tool-gate.ts` `mutatingCommandCapFromTier`); validator gate rejects out-of-workspace ids, absolute paths, oversized strings (`packages/agent/src/validator/gate.ts`) |
| T | Concurrent edits corrupt a document | Transactions/replay + WAL/checkpoint (`apps/engine-pool/src/wal.ts`, `packages/engine-client/src/methods/*`); append-only versions (`packages/db/src/schema/content.ts`) |
| R | Editor denies making a destructive edit | Append-only `audit_log` with actor/IP/timestamp (`apps/gateway/src/services/audit.ts`, `packages/db/src/schema/audit.ts`); `x-request-id` correlation (`middleware/request-id.ts`) |
| I | Cross-tenant read (IDOR) — guessable ids | Composite org+id lookups → 404 `not_found`, indistinguishable from missing (`services/{documents,runs,exports}.ts`); storage keys tenant-prefixed + `assertTenant` (`packages/storage/src/keys.ts`); SSE authed then tenant-gated (`routes/runs-events.ts`) |
| I | Version history leaks prior prompts/renders | Per-workspace data only via membership; log redaction of promptish fields unless opted in (`middleware/request-context.ts` `redactPromptish`) |
| D | Run/document flooding by one tenant | Rate limits per IP/user/workspace (`middleware/rate-limit.ts`, `services/limiter.ts`); per-workspace concurrent-run + CPU/memory quotas (§15.1, engine-pool registry `apps/engine-pool/src/{pool,registry}.ts`); tier budgets (§5.2) |
| E | Viewer escalates to editor/owner capabilities | Server-side RBAC matrix (`authz/{roles,matrix}.ts`, `assertMatrixMatchesAdr`); role changes admin-gated + audited; API keys capped at creator's role (ADR-0003) |

**Test evidence:** `apps/gateway/tests/integration/cross-tenant.test.ts`,
`rbac-matrix.test.ts`, `apps/gateway/tests/{authz,command-exec}.test.ts`.

## 2. Assets (uploads)

| Threat | Scenario | Mitigation (implemented) |
|---|---|---|
| S | Upload attributed to another org | `assertTenant` membership resolution (`services/workspaces.ts`) before key minting; tenant-prefixed key-space (`packages/storage/src/keys.ts`) |
| T | Polyglot / renamed-binary upload smuggles executable content | Magic-byte `sniffMime`, allowlist exactly png/jpeg/webp — SVG rejected outright (`packages/storage/src/validate.ts`); sha256 `checksum` dedupe (§12.1); fuzz corpus 39 fixtures + 888 mutants (`packages/storage/tests/fuzz/`) |
| T | Filename carries traversal/NUL/RTLO into storage keys | `keys.ts` `isSafeId` / `isSafeFilename` / `isWindowsDeviceName` / `MAX_KEY_BYTES` / relative-path-only `validateStorageKey`; filename policy at the route (checklist G2, enforced before key minting) |
| R | Deny uploading a malicious file | Checksum recorded on upload (`services/assets.ts`); audit events for destructive asset actions (`services/audit.ts`) |
| I | EXIF GPS/data leaks from stored images | `stripExifPlan` drops APP1/APP2/COM, keeps ICC/XMP color (`packages/storage/src/validate.ts`); short-lived signed URLs, no public buckets (§15.1; `packages/storage/src/s3-sign.ts`) |
| I | Foreign asset readable via direct object URL | Per-workspace prefixes + signed URLs only (§15.1); `assertTenant` key guard (tested across all five namespaces in `cross-tenant.test.ts`) |
| D | Zip bomb / 60 MP decode bomb exhausts the box | 25 MB size gate **before** sniffing; 60 MP decode ceiling (plan ceilings narrower per §14.1); frame ceilings on the engine path (`packages/engine-client/src/budgets.ts`); upload caps middleware (`middleware/caps.ts` `uploadCap`) |
| E | Upload route used to mint keys outside the tenant namespace | `validateStoragePrefix` + namespace allowlist (`keys.ts`) |

**Test evidence:** `packages/storage/tests/fuzz/fuzz-validate.test.ts` (pinned verdicts:
61 MP rejected, boundary pinned), `packages/storage/tests/{keys,validate}.test.ts`,
`apps/gateway/tests/uploads.test.ts`.

## 3. Credits (ledger & billing)

| Threat | Scenario | Mitigation (implemented) |
|---|---|---|
| S | Forged Stripe webhook grants credits | Raw-body HMAC-SHA256 verification in Stripe's scheme (`apps/gateway/src/services/stripe.ts`); `invalid_signature` → 400 (`services/billing-complete/webhook-idempotency.ts`) |
| T | Double-charge / double-grant on replay or race | Idempotency keys on every money path (§14.2, `docs/AGENTS.md`); webhook idempotent by event id; append-only ledger (`packages/billing/src/ledger.ts`); concurrency race suites (`packages/billing/tests/edge/concurrency.test.ts` — exactly-one-settlement outcomes pinned) |
| T | Negative/fractional amounts or commit-above-hold | Typed validation in ledger + policy (`packages/billing/src/{ledger,policy}.ts`); clamps pinned in `packages/billing/tests/edge/grace-and-partial.test.ts` |
| R | Dispute a charge/adjustment | Ledger append-only + exportable per workspace (§22); credit adjustments audited with actor/IP (`services/audit.ts`) |
| I | Balance/ledger of another org | Credits routes behind membership + role gates; same 404-indistinguishable lookup semantics (checklist C3) |
| D | Drain credits or platform budget via run spam | Tier budgets (§5.2); rate limits on runs (§15.2); daily caps + demo-workspace caps + provider killswitch (`packages/billing/src/guardrails/{daily-caps,demo-workspace,provider-killswitch}.ts`) |
| E | Self-service credit grant via API | Billing capability admin-gated (matrix row 8); grants only via the webhook/seed paths; API keys additionally scope-constrained |

**Test evidence:** `apps/gateway/tests/integration/ledger-flow.test.ts` (§20 #10),
`apps/gateway/src/services/billing-complete/tests/webhook-idempotency.test.ts`,
`packages/billing/tests/**`.

## 4. Tokens (engine control tokens + API keys)

| Threat | Scenario | Mitigation (implemented) |
|---|---|---|
| S | Guess/replay an engine control token | 256-bit random (`CONTROL_TOKEN_BYTES = 32`, `generateControlToken`) with constant-time-style folding match (`packages/engine-client/src/auth.ts`); loopback-only transport (`packages/engine-client/src/transport/socket.ts`); engine's own token auth is the second line (§15.1) |
| S | Steal an API key | Hashed at rest, SHA-256 never disabled, shown once, revocable, last-used metadata (`apps/gateway/src/auth/api-keys.ts`) |
| T | Token swapped via env/file confusion | `resolveEngineToken`: inline XOR file (both = typed conflict), token file must be a **regular file, owner-only 0600**; Zod boundary `parseEngineAuth` (`packages/engine-client/src/auth.ts`); trust table pinned in `packages/engine-client/tests/auth.test.ts` |
| R | Token use cannot be traced | Requests carry `request_id` end-to-end (§22); engine auth denials logged without echo (`capabilities`/`auth` modules) |
| I | Token appears in logs or error text | `redactToken` / `redactEngineAuth` return a constant; messages never echo tokens or paths; 59-case no-echo table (`packages/engine-client/tests/auth.test.ts`); request-log redaction (`middleware/request-context.ts`) |
| I | Token reaches the browser | It never does — browser talks only to the gateway (§15.1; ADR-0003: worker/engine-pool never see cookies; engine RPC is internal-only) |
| D | Connection/frame flooding at the engine | Request ceilings 1 MiB / reply 8 MiB / PNG 5 MiB / 64 MP (`packages/engine-client/src/budgets.ts`); engine-side connection cap + timeouts (second line); session quotas via engine-pool registry (`apps/engine-pool/src/pool.ts`) |
| E | Token used to escape the workspace sandbox | Capability roots scoped to the workspace working directory; ambient paths refused in automation mode (§5.7); traversal/ambient/tenant-id attack tables (`packages/engine-client/src/capabilities.ts` + tests) |

**Test evidence:** `packages/engine-client/tests/{auth,budgets,capabilities}.test.ts`.

## 5. Sessions (user auth sessions + engine sessions)

| Threat | Scenario | Mitigation (implemented) |
|---|---|---|
| S | Session replay / fixation | Better Auth session store in our Postgres (ADR-0003); httpOnly + secure + sameSite cookies; API-key fallback is scope-limited; 401 indistinguishable before any tenant oracle (`middleware/auth-context.ts`, `routes/runs-events.ts` Gate 1) |
| S | Cross-site request with a stolen cookie | CSRF origin allowlist for cookie-auth mutations — Better Auth `trustedOrigins` = web app + auth origin (`apps/gateway/src/auth/server.ts`, §15.2) |
| T | Engine session hijacked across tenants | One engine process per tenant session, per-process token (§15.1); engine sessions never shared across orgs; presence/SSE scoped by run + org |
| R | Auth event denied (who signed in from where?) | Auth events in `audit_log` (§22: "auth events, role changes, API keys, exports, deletes"); `x-request-id` on every response (`middleware/request-id.ts`) |
| I | Session/user data in logs | `redactPromptish` + `REDACTED_MARKER` + `REQUEST_LOG_REDACT_PATHS` (`middleware/{request-context,logger}.ts`); error envelopes never leak ids (`middleware/error-mapper.ts`) |
| D | Credential-stuffing / auth-endpoint flooding | Rate limits per IP/user on auth (§15.2; `middleware/rate-limit.ts` + `services/limiter.ts`) |
| E | Invite-token abuse elevates role | `services/workspaces.ts` `assertTenant` on invite acceptance; role values validated (`authz/roles.ts` `isRole`); invite + role-change flows audited (`services/audit.ts`); §20 #1 invite flow pinned in `integration/signup-flow.test.ts` |

**Test evidence:** `apps/gateway/tests/{auth,middleware}.test.ts`,
`integration/signup-flow.test.ts`, `integration/cross-tenant.test.ts` (auth-before-tenant ordering).

## 6. Model-path threats (cross-cutting, §5.7/§15.3)

Not one of the five assets, but the agent path threatens all of them: a
prompt-injected model could attempt arbitrary tool calls, oversized args, or mutating
floods. Mitigations: every user string enters context inside an escaped, labelled data
block (`packages/agent/src/guards/injection.ts` `wrapAsDataBlock` — data, never
instructions, §5.7); `ToolCallGate` rejects unknown tools, caps args (strings/arrays/
records/depth), schema-validates everything, and caps mutating commands per tier
(`packages/agent/src/guards/tool-gate.ts`); the tool registry has **no shell, no
network fetch, no arbitrary file read, no code execution** (`packages/tools/src/registry.ts`,
§6 allowlist); engine side effects are allowlisted per plan and per tool (§15.3,
`apps/gateway/src/services/command-exec.ts`). Evidence:
`packages/agent/tests/guards/{injection,tool-gate}.test.ts`.

## 7. Residual-risk register

Mirrored from `checklist.md` §5 — the only known-open items at audit time:

| # | Risk | Asset | Owner |
|---|---|---|---|
| G1 | EXIF re-slice unwired in the live upload path (plan computes; rewrite not) | assets | upload-route owner |
| G2 | Filename policy enforcement at the gateway upload route (traversal/NUL/RTLO) | assets | gateway owner |
| G3 | CSP nonce TODO in web app | sessions/documents | web owner |
| G5 | AV scan + quarantine bucket (§15.2 optional) | assets | accept-or-implement at beta gate |
| G6 | W10-B §21 security suite (CSRF/session-replay/rate-limit-bypass/SSRF organization) | all | W10-B |
| G7 | Outbound SSRF fuzzing (S3 presign, provider calls) | tokens/credits | gateway/storage driver owner |
| G8 | Secrets-handling policy doc | tokens | W10-N |

Engine internals (`vendor/photocraft`) are excluded by policy — first-line mitigations
above are ours; the engine's own token auth / connection cap / timeouts are the
documented second line (§15.1).
