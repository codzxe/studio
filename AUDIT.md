# studio — Full-Stack Deep Audit (2026-10-30)

**Scope:** the entire monorepo — `apps/web`, `services/gateway`, `services/worker`, `packages/*`, the vendored EffectCraft engine (`apps/editor/`, moved in this branch from `editor/`), the 51.4 MB editor wasm, billing/credits, git history, and repo structure.
**Method:** six independent parallel audit agents (gateway security, billing/credits, editor engine algorithms, web/worker performance & cost, wasm size forensics, repo hygiene & git history), followed by first-party verification of every critical claim, then fixes + a restructure — all gated by the repo's own test suites.
**Verification status:** ✅ typecheck 10/10 packages · ✅ **4,181 tests passing** (gateway 1,133 on the sqlite dialect incl. a new regression pin; web 1,725; the 89 Postgres-only tests skip in this sandbox and run in CI) · ✅ worker sqlite pipeline smoke PASS · ✅ purpose-built sweep-verification script PASS (later removed) · ✅ biome clean on all new code. **Wave 2 (same day, follow-up ledger):** ✅ typecheck 10/10 · ✅ **3,399 tests** on the sqlite dialect (gateway 1,164 · web 1,725 · worker 62 · db 175 · contracts 273) · ✅ gateway bundle rebuilt + smoke PASS · ✅ biome clean on every touched file (see worklog 2026-10-30 wave 2).

---

## 0. Read this first — owner actions required outside this PR

1. **🔴 ROTATE the GitHub PAT `ghp_Wylj…` (scopes include `delete_repo`) — it is recoverable from git history by ANY cloner** (blob at commits `84eb698`/`91d356c`, file `.github-token`). The repo's own round-13 audit flagged this as "AWAITING USER" — it is still live. Rotate first, then optionally scrub history (§6.3). *Also rotate any other token ever pasted in chat.*
2. **Audit your ledgers for the ×10⁶ over-grant (BIL-01, fixed here):** any production workspace that paid and received `invoice.paid` since commit `0b355cd` was over-granted by 10⁶ (e.g. Starter: 500,000,000 credits instead of 500). Query: `SELECT * FROM credit_ledger WHERE kind='grant' AND amount > 10000000000;` — true-up via the staff reconcile tool.
3. **Decide the negative-balance posture (BIL-08)** and the version-retention policy (PERF-10) — both are product decisions documented in §5.

---

## 1. Executive summary

| Domain | Verdict |
|---|---|
| Gateway source code | **Strong.** Tenant isolation is repo-wide, the ledger is append-only with advisory-lock serialization, share links are 256-bit/scrypt/timing-safe. Zero IDOR found. |
| Gateway *deployable artifact* | **Was shipping pre-fix vulnerabilities** — the committed 6.9 MB `api/gateway.mjs` predates the last 3 security commits (SEC-01, fixed here). |
| Billing | **One direct money-printing bug (BIL-01, fixed)** + two crash paths that strand user credit holds forever (BIL-02/BIL-03, fixed) + fail-open webhook status (BIL-05, fixed). |
| Editor engine (Rust) | **Exceptionally well engineered.** COW documents, budgeted LRU caches everywhere, binary-search keyframes, panic guards. 2 HIGH + 6 MEDIUM hot-path/crash findings, all with patch-ready fixes (§5.2). |
| WASM / egress | **51.4 MB single wasm — 84.5% is pure code** (encoders!). Measured: brotli-11 → **11.05 MB**. Phase 0 applied in this branch; phased plan to ≤ 9 MB in §4. |
| Web/worker cost design | Bounded turn protocol and disciplined repos — but O(account-age) ledger reads, 1s busy-poll, per-request org fetch ×N, worker asset re-downloads, RAM zips, and a **51 MB prewarm on every authenticated page** (fixed). |
| Repo hygiene | Root was contaminated by a z.ai-sandbox scaffold commit; `.git` = 175 MB from re-committed build output; a **live PAT in history**. Restructured in this branch (nothing deleted — `archive/2026-10-30/`). |

**Findings: 3 CRITICAL · 12 HIGH · 14 MEDIUM · 13 LOW** (details per domain below).

---

## 2. Security & auth findings (Task 2-a)

Previous "22 fixes, prod-verified" claims: **verified real in source** (18 of 22 re-confirmed by file:line; the table below lists the rest). The exceptions:

| ID | Sev | Finding | Status |
|---|---|---|---|
| SEC-01 | **CRITICAL** | Committed gateway bundle `apps/web/api/gateway.mjs` (imported by the `/v1` route) predates all three security commits — ships spoofable first-hop `X-Forwarded-For`, unscoped idempotency replay, no API-key surface blocks, no body limit, no share redaction, no uncapped settles. | **FIXED**: rebuilt from source (verified: all post-fix symbols present), smoke script de-hardcoded (SEC-12). Follow-up: CI artifact-freshness gate (§5.1). |
| SEC-02 | **CRITICAL** | Live GitHub PAT (`delete_repo` scope) recoverable from git history. | **OWNER ACTION** (§0). |
| SEC-03 | HIGH | API-key scopes are stored/displayed but never enforced — a `projects:read` key can spend credits, delete projects, and mint public share links (data plane = full power). | **FIXED** (wave 2): `apiKeyRouteAccess` capability table enforced in `requireAuth` (any-key introspection / scope-gated data plane / cookie-only admin·money·share-minting; unmapped routes fail closed) + the `metadata.workspaceId` binding gate (§12.1 404, one workspace per key, forever). Tests: rule table + middleware pins + 5 real-plugin flows. |
| SEC-04 | MED | Open redirect after sign-in: raw `?next=` → `router.push()` (password arm only; OAuth arm was safe). | **FIXED** (`sanitizeNextPath`). |
| SEC-05 | MED | Rate-limit keys: no IPv6 /64 normalization (scrypt share-password gate brute-forceable at scale by a /64 owner); all limiters are per-instance in-memory maps (×N on serverless); no trusted-proxy config for `x-real-ip`. | **PARTIAL FIX** (wave 2): /64 normalization in `clientIp` (every limiter + the share gate; IPv4/junk untouched, 10 pins). Identity keys + Valkey backend remain (PERF-09). |
| SEC-06 | MED | Stripe portal `returnUrl` accepted any absolute URL (redirect off-site on portal exit). | **FIXED** (same-origin only). |
| SEC-07 | MED | Vercel serving path had no HSTS / X-Frame-Options / CSP (only the self-hosted Caddy edge did); editor iframe unsandboxed by design (bridge needs same-origin access). | **PARTIAL FIX** (HSTS + XFO added; CSP drafted in §5.1 — needs a QA pass for editor blob:/data: origins). |
| SEC-08 | LOW | Root-level dead Next.js scaffold (`ignoreBuildErrors: true`, Prisma client) — one confused `next build` away from shipping an unconfigured app. | **FIXED** (archived to `archive/2026-10-30/sandbox/`). |
| SEC-09 | LOW | Ledger `settle`/`refundAll` replay arms didn't cross-check `workspaceId` (grant/reserve always did) — inconsistent invariant, unreachable today. | **FIXED** (typed CONFLICT, verified by script). |
| SEC-10 | LOW | Stale int32 `MAX_LEDGER_AMOUNT` comment/constant vs the bigint column. | **FIXED** (1e15 µc ceiling, applied to the allowance arm too). |
| SEC-11 | LOW | `countPendingInvites` fails open on auth errors (seat gate under-counts transiently). | **FIXED** (wave 2): fails CLOSED — typed retryable 503, the seat-gated mutation is refused until the count is knowable. |
| SEC-12 | LOW | `scripts/gateway-bundle-smoke.mjs` imported the bundle via an absolute `/home/z/…` path — unrunnable from a fresh clone (why SEC-01 went unnoticed). | **FIXED** (repo-relative). |

**Done well:** every repo method filters by `workspaceId` (uniform typed-404 doctrine — zero IDOR); share tokens are 256-bit random, sha256-stored, scrypt + `timingSafeEqual` password gates; no `dangerouslySetInnerHTML` anywhere; chat markdown builds typed React nodes; uploads are content-addressed with magic-byte sniffing, dimension probing, 60 MP bomb ceiling, and traversal-rejecting keys; editor `postMessage` checks `event.origin` **and** `event.source`.

---

## 3. Billing, credits & entitlements (Task 2-b)

The ledger core (append-only, `pg_advisory_xact_lock` per workspace, globally-unique idempotency keys, bigint µc, exact rational pricing) is genuinely careful. The money bugs live one layer up:

| ID | Sev | Finding | Status |
|---|---|---|---|
| BIL-01 | **CRITICAL** | Monthly allowance grant double-converted an already-µc catalog value: **Starter buyers got 500,000,000 credits for $12** (trial 50M, pro 2B, studio 10B intended); the studio tier threw `RangeError` → 500 → **Stripe retry poison loop**. Introduced by the very commit that claimed "verified in prod". | **FIXED** (`amount: allowance`) + **regression test pinning the exact grant** (`billing-routes.test.ts` "BIL-01 regression…"). |
| BIL-02 | HIGH | The stale-sweep's terminal branch failed renders **without releasing the credit hold** — a render killed past `maxAttempts` locked the user's µc forever (no user-facing refund path; reconciliation explicitly refuses zombies). | **FIXED**: `requeueStale` now reports failed rows (id + workspace); the sweep refunds via the pipeline's own `render:refund:<id>` key (idempotent replay). Verified end-to-end on sqlite. |
| BIL-03 | HIGH | Worker crash between `markCompleted` and `ledger.settle` (or a settle failure — deliberately never rolled back) strands the **full hold on a COMPLETED render**. | **FIXED**: new `outstandingRenderScopes()` ledger query + sweep settle-replay after a 10-min grace (same key → true replay; second sweep releases nothing — verified). |
| BIL-04 | HIGH | Card-required trial is unreachable in production: the card fingerprint is only ever written by the test fake's checkout metadata — `POST /v1/billing/trial` always 400s in prod. | **FIXED** (wave 2): new seam member `checkoutSessionCardFingerprint` resolves the card from the completed Checkout session's payment chain; `recordCustomer` persists it (metadata/fake still wins). Real-Stripe-shape + cardless-session tests. |
| BIL-05 | MED | Top-up grant failed OPEN when `payment_status` was absent (`!== "" && !== "paid"`). | **FIXED** (fail closed; two test fixtures corrected to carry the field real Stripe always sends). |
| BIL-06 | MED | Render pricing ignores content complexity; `frameRate` unbounded; minutes quota counts only *completed* renders → **zero-net-credit CPU farm**: a hostile comp burns up to 2×30 min worker CPU per row and refunds fully. | **PARTIAL FIX** (wave 2): `frameRate` capped 1–240 in the schema, effective rate (comp-native included) clamped in the gateway quote AND the worker spawn, per-job frame ceiling `MAX_RENDER_FRAMES = 1.5M` enforced typed at queue/estimate/spawn. Frame-based pricing + attempt budgets remain product decisions. |
| BIL-07 | MED | No DB CHECK constraints on the money table (no `balance_after ≥ 0`, no per-kind sign/ceiling). | **FIXED** (wave 2): migration `0009` + sqlite twin — kind vocabulary, per-kind signs (grant>0, refund>0, reserve<0, commit≤0, adjust ±), ±1e15 µc ceiling. `balance_after` stays unfloored BY DESIGN (BIL-08: uncapped settles may go negative; a floor would 500 that path). |
| BIL-08 | MED | Uncapped settles can drive balances negative with no floor/dunning story. | Product decision (document or clamp). |
| BIL-09–13 | LOW | 500-entry `reserved` display scan; last-XFF-hop trust; int32 ceiling (fixed); invoice amount not cross-validated vs price map; turn precheck 1 µc vs actual hold. | BIL-11 fixed with BIL-01; rest follow-ups. |

**Reserve→settle lifecycle** (traced end-to-end): turns reserve `ceil(est×1.2) ≤ 15 cr` → advisory lock → uncapped settle of actual usage → abort-with-output still bills; renders quote from the **server-pinned version head** (client never supplies pricing inputs); claims are `FOR UPDATE SKIP LOCKED`. The free-turn exploit class is dead **in source** (it was alive in the committed bundle — SEC-01).

---

## 4. WASM size & egress (Tasks 2-c/2-c-r2) — why it's 51.4 MB and how to fix it

**Forensics (measured, not estimated):**

- `studio_web_bg.wasm` = 51,420,252 B · **code section 84.5%** (34,571 function bodies) · data 15.2% · **no debug/name sections** (already stripped — this is NOT a debug build).
- Crate markers in the binary prove what's linked in: **AV1, H.264, HEVC, VP9, ProRes, DNx, MPEG-2, AC-3, AAC, Opus encoders + MXF/MPEG-TS/Matroska/ISOBMFF muxers + PSD/PDF/SVG/Lottie importers + the boa JS engine (167 path hits) + the full WebGPU stack (naga/wgpu-core)** — a complete professional video suite compiled into the browser.
- **All of it is unconditional**: the only cargo feature gate in the whole workspace is `studio-plugin`'s wasmi (correctly native-only). No WebCodecs path exists.
- **Compression (measured on this exact file):** gzip -9 → 17.44 MB · **brotli-11 → 11.05 MB (21.5%)** · the repo's own perf baseline recorded 17.9 MB wire (on-the-fly gzip of the older 49.35 MB build) and showed warm runs **re-transferring the full body**; Caddy serves on-the-fly brotli q~6 = 13.7 MB.
- **The multiplier nobody knew:** `<EditorPrewarm />` was mounted on **every authenticated page** (billing, settings, onboarding…) — fetching + compiling the wasm for users who never open the editor.
- `EDITOR_WASM_MAX_MB=18` was documented as "enforced at serving time and in CI" — **no enforcement code existed anywhere**.

**Phase 0 — applied in this branch (config-only, hours):**

1. ✅ brotli-11 precompressed sidecar committed (`studio_web_bg.wasm.br`, 11.05 MB) + Caddy `file_server { precompressed zstd br gzip }` → **wire size 17.9 → 11.05 MB (−38%)** and zero per-request compression CPU.
2. ✅ `build-editor-dist.sh` stage 4: brotli-11 precompression + **hard `EDITOR_WASM_MAX_MB` gate** (build fails if the `.br` exceeds budget).
3. ✅ Prewarm gated to editor-intent surfaces (`/w/<slug>…` only — `isEditorIntentPath`) and **Save-Data honored** — non-editor sessions no longer download 51 MB.
4. Follow-up (needs one reviewed change): content-hash the wasm filename + `immutable` cache-control (kills the per-load 304s and the revalidate storm; the stable-name + `must-revalidate` choice was an anti-poisoning workaround — the hash is the real fix).

**Phase 1 — feature-gating (days, M):** gate `crates/export` encoders (`filmcraft-h264enc/prores/aac/isobmff`, `studio-opusenc/vp9enc/hevcenc/av1enc`), `interchange`, and evaluate `studio-script` (boa, ~200 KLOC-class) behind cargo features; `studio-web` builds `default-features = false`. The render worker keeps defaults (it runs the native CLI — encoders belong there). Est. **~8–9.5 MB wire** (encoder cluster ≈ 20 KLOC studio-side + 3 filmcraft encoder crates; attribution uncertainty acknowledged — only 1.9% of functions are name-attributable).

**Phase 2 — structural (1–2 weeks, L):** wasm-bindgen is single-module (no code-splitting); either a second tiny `studio-export-web` wasm fetched on Render-Queue open, or skip to Phase 3. Streaming compile is already implemented.

**Phase 3 — strategy (L, low risk):** all exports server-side by design (worker + `studio-cli` already exist) → browser bundle permanently encoder-free; dist shipped as version-pinned Release artifacts instead of git blobs. Est. **≤ 7 MB wire**.

| Phase | Wire size | Saving | Effort | Risk |
|---|---|---|---|---|
| today (on-the-fly gzip, measured) | 17.86 MB | — | — | — |
| **0 (this branch)** | **11.05 MB (measured)** | −38% | S | low |
| 1 feature-gates | ~8–9.5 MB (est.) | −47–55% | M | medium |
| 2 on-demand export module | ~7.5–8.5 MB (est.) | −52–58% | L | med-high |
| 3 server-side export | ~6.5–7 MB (est.) | −60–64% | L | low |

Small-device note: wasm compile time scales with raw code size (and the engine's rayon is inert on wasm — single-threaded compile), so Phases 1–3 cut first-open time roughly proportionally to the raw-size reduction, on top of the 4.6:1 download reduction from Phase 0. **Cloudflare caveat:** Workers static assets cap at 25 MB/file — the raw 51.4 MB wasm exceeds it; Phase 1 slimming is a prerequisite if you ever move there.

---

## 5. Performance, algorithms & cost (Tasks 2-d/2-e)

### 5.1 Web app / worker / packages

| ID | Sev | Finding | Status |
|---|---|---|---|
| PERF-01 | **CRITICAL** (dup of SEC-01) | 6.9 MB committed gateway bundle provably 3 commits stale. | **FIXED** (rebuilt; wave 2 added the CI `gateway-bundle-drift` gate + `bundle:gateway` script so it cannot recur while the artifact stays committed). |
| PERF-02 | HIGH | Ledger balance = `SUM(amount)` over full history, **3× per turn, inside the advisory lock** — O(account age); every customer gets slower every month. | Follow-up (needs a monotonic column/balances row — the ledger `id` is non-monotonic text, so "latest balanceAfter" is NOT safe today; design sketched in §5.3). |
| PERF-03 | HIGH | Worker re-downloads **every project asset per render job, sequentially, no cache** (50 assets × 10 MB = 500 MB + 2.5–10 s latency per render). | **FIXED** (wave 2): sha-keyed cross-job cache `.local/asset-cache/<sha256>` (atomic publish; write failures never fail a render) + bounded-parallel (×4) hydration — warm renders read zero objects. |
| PERF-04 | HIGH | PNG-sequence renders zipped **entirely in RAM** then single PUT — OOM territory at 300 frames ×2 concurrent jobs (and an OOM is exactly the BIL-02 crash path). | Follow-up (streaming zip + multipart). |
| PERF-05 | HIGH | (= BIL-02) Crash-failed renders never refund. | **FIXED**. |
| PERF-06 | HIGH | 1 s busy-poll queue ≈ **112k idle DB queries/day/worker**. | **FIXED** (geometric backoff to 10 s while idle; snaps back on any claim/job). |
| PERF-07 | MED | Full Better-Auth session + **entire-organization-with-all-members fetch on every request**, multiplied by 15 s lease polls and 3 s render polls (≈600 authenticated GETs per render for progress the worker already heartbeats). | Follow-up (5–10 s request cache; lease state on the presence beat; age-scaled render poll). |
| PERF-08 | MED | `plan_edit` side call resent the **full conversation on the same (possibly premium) model** — +50–100% input tokens on plan-bearing turns. | **FIXED** (routed to `studio-fast`, permitted on every plan). Prompt-caching follow-up. |
| PERF-09 | MED | In-memory rate limiter/idempotency on serverless = limits ×N instances. | Follow-up (Valkey — seam exists, `VALKEY_URL` parsed). |
| PERF-10 | MED | Immutable version snapshots, 30 s autosave, **no retention** — ~100–800 GB/month of never-deleted storage per 1k users (compounding). | Product decision (§0). |
| PERF-11 | MED | 175 MB git pack (9× gateway.mjs ≈ 62 MB, 4 wasm builds ≈ 64 MB, purged skills 37 MB, e2e traces 36 MB); dead root scaffold still linted by CI. | Scaffold **FIXED** (archived); history purge options §6.3. |
| PERF-12 | LOW | 107 KB marketing PNG where 16 KB WebP does. | **FIXED** (−85%; original archived). |
| PERF-13 | LOW | Per-turn minimum 1 credit rounds fast turns up ~3× (user-visible pricing granularity). | Product decision (µc ledger already supports 0.1 cr). |
| PERF-14 | LOW | Dead code in hot packages (unmounted `chat.ts` route, legacy SSE client, `RunRegistry`). | `chat.ts` + its test **archived**; rest follow-up. |

**Bill model per 1,000 users/month** (1,000 signups, 200 active editors, 20 runs/user, 50 renders/day):

| Driver | Pre-fix | After this branch | Remaining lever |
|---|---|---|---|
| Model input tokens | ~600–900M ≈ $100–700 | −40–60% on plan turns (PERF-08) | prompt caching (stable run prefix) |
| Object storage growth | +100–800 GB/mo, unbounded | unchanged | PERF-10 retention tiering |
| Render-pipeline I/O | 50–250 GB/day object reads at 500 jobs/day (S3 ≈ $4.5–22/day) | unchanged | PERF-03 sha cache |
| Postgres | 3–5M queries/mo, growing with account age | −112k/day/worker (PERF-06) | PERF-02, PERF-07 |
| Editor egress | ~72 GB/mo (17.9 MB × ~4,000 loads incl. prewarm-every-page) | **~24 GB/mo** (11.05 MB, prewarm gated) | Phase 1–3 |
| Stuck credit holds | every double-crash strands a reserve (support cost) | **auto-refunded / auto-settled** | — |
| Starter-pack value leak | **$25M sellable credits per $12 purchase** | **grants the catalog value, test-pinned** | — |

**Hosting comparison at ~1k users/mo (pre-launch estimate):** self-hosted VPS (Hetzner-class, ~$15–40/mo + R2/S3) — egress usually unmetered, main costs are LLM tokens + storage growth; Vercel Pro ($20/mo + included bandwidth) — fits, but needs the Valkey limiter (PERF-09) before multi-instance and 60 s function caps reviewed for SSE; Cloudflare — near-zero egress fees **but the 25 MB static-asset cap blocks the raw wasm until Phase 1**.

### 5.2 Editor engine (Rust/WGSL) — patch-ready follow-ups

The engine is above typical commercial quality (COW `Arc<Comp>`, capped branching undo, budgeted LRU at every layer, `partition_point` keyframes, hardened boa runtime, depth caps, `catch_unwind` guards, `#![deny(unwrap)]`). The real risks, in priority order (fix locations follow the D-17 single-repo patch policy — land in `apps/editor/` + patch artifact):

1. **ENG-02 (HIGH):** expression wall-clock budget is `false` on wasm — a crafted expression loops up to ~2×10¹⁰ interpreted iterations ⇒ minutes-to-forever frozen tab (agent-written expressions are user data here!). **FIXED** (wave 2): `std::time::Instant` → `web_time::Instant` (1.1.0, already locked via boa; zero-cost std re-export on native); the `false`-on-wasm arm is deleted and the budget runs on BOTH targets. No Rust toolchain in this sandbox — CI `editor-cargo` is the compile gate.
2. **ENG-01 (HIGH):** frame-worker replica sync re-serializes + re-parses the **whole project per edit per worker** (`remote.rs:226/339`) — the biggest per-edit jank on low-end devices. Fix: diff at the model level keyed by `Arc` identity.
3. **ENG-05 (MED):** comp duration unbounded ⇒ unbounded export frame counts (worker-bill DoS — pairs with BIL-06). **HOST-SIDE GUARD FIXED** (wave 2): the gateway refuses `seconds × fps > 1.5M` frames at queue/estimate time and the worker re-guards at spawn (BIL-06). The engine-side cap in `limits.rs` remains owed (needs a Rust build).
4. **ENG-03 (MED):** `comp_contains` is exponential on diamond-nested precomps, called per precomp layer per frame. Fix: visited-set + depth cap.
5. **ENG-04 (MED):** timeline hit-testing O(visible×selected) per frame (Select-All on a 10k-key comp = 2×10⁷ comparisons/frame). Fix: per-frame `HashSet`.
6. ENG-06 GPU bind-group/uniform churn per dispatch; ENG-07 cache-key `Debug`-formatting + effects-group deep clone per read; ENG-08 `sync_related_times` walks all items per time change (default ON); ENG-09 spatial-keyframe arc-table rebuilds; ENG-10 timeline row model per frame; ENG-11 CPU compositor fresh 33 MB buffers per layer.

### 5.3 Deferred-fix implementation sketches

- **SEC-03 scope middleware:** ✅ **DONE (wave 2)** — implemented as a full capability table (`apiKeyRouteAccess`) rather than route-class mapping: any-key introspection, scope-gated data plane (projects:read/write, renders:queue, chat:run, billing:read), cookie-only admin/money/share-minting, unmapped routes fail closed; plus the `metadata.workspaceId` binding gate in `resolveWorkspaceContext`.
- **PERF-02 O(1) balance:** add a monotonic `seq bigint` (or a `credit_balances` row updated in the same lock) → read latest `balanceAfter` O(1); keep `SUM` as a periodic audit. *Not safe today* — `id` is `createId("led")` text (non-monotonic), and `createdAt` ties are possible.
- **PERF-03 asset cache:** ✅ **DONE (wave 2)** — `.local/asset-cache/<sha256>` (the render-jobs precedent won over `~/.cache`: one `rm -rf .local` reclaims it; assets immutable + `assets_workspace_sha_idx` exists) + bounded-parallel (×4) hydration with atomic temp+rename publish.
- **CI drift gate (SEC-01 recurrence):** ✅ **DONE (wave 2)** — `gateway-bundle-drift` CI job: rebuild via `pnpm --filter @studio/web bundle:gateway`, fail on `git diff --exit-code apps/web/api/gateway.mjs`, then boot the rebuilt bundle through the (now self-sufficient) smoke script.

---

## 6. Repo restructure (Task 2-f) — executed in this branch

### 6.1 Before → after

```
 BEFORE (root)                                AFTER (root)
 ├ src/ public/ next.config.ts  ← scaffold    ├ apps/web          (Next.js 16 — unchanged serve path /editor/)
 ├ prisma/ core/ core.tgz       ← dead        ├ apps/editor        ← vendored EffectCraft (moved from /editor)
 ├ editor/                                    ├ services/gateway · services/worker
 ├ .zscripts/ mini-services/                  ├ packages/ (ui contracts editor-bridge api-client config db storage)
 ├ examples/ tests/ ci-staging/               ├ archive/2026-10-30/  ← NOTHING DELETED; see index below
 ├ research/ army/ worklog.md (1.2 MB)        ├ docs/ (+ research/ moved in as docs/research — cited by ~10 source files)
 └ …                                          ├ scripts/ infra/ deploy/ evals/ db/ + root configs only
```

`apps/editor` is a **plain directory move** (no `package.json` → pnpm workspace untouched, lockfile byte-identical, still exactly 10 members). 17 load-bearing reference sites updated, including the two traps: `services/worker/src/cli.ts:42` (every render's binary resolution — would have silently fallen back to PATH) and `apps/editor/crates/brand/build.rs` (repo-root `brand.json` path — **no build error when wrong**, silently falls back to compiled-in brand defaults; recorded as patch `0002-brand-path-apps-editor.patch` in the ADR-0006 ledger). Also fixed en route: stale `effectcraft-cli` crate name in root scripts (real crate: `studio-cli`), `EFFECTCRAFT_CLI_PATH` env-doc drift, `build-editor.sh`'s hardcoded `/home/z/...` paths, CI rust-cache/fonts/working-dir/fixture paths, `packages/contracts` engine-registry extractor + tests, ~40 docs files, `.gitignore`/`biome.json`/`knip.json`/`.dockerignore`.

### 6.2 archive/2026-10-30/ index

| Path | What it is |
|---|---|
| `sandbox/` | The z.ai-scaffold contamination (`cd24d1d`): root `src/`, `public/`, root configs, `prisma/`, `core/` + `core.tgz`, `.zscripts/`, `mini-services/`, `examples/`, root `tests/`, `ci-staging/` |
| `sandbox/gateway-scratch/` | `probe-tmp.mjs`, `scratch-w1-07.ts`, unmounted `chat.ts` route + its test |
| `army/` | wave-1 audit ledger (process evidence) |
| `scripts/` | one-shot sandbox tooling (docx generators, army bootstrap, hardcoded `/home/z` paths) |
| `assets/editor-frame.png` | replaced by the 16 KB WebP (PERF-12) |
| `worklog-through-2026-10-30.md` | the full 1.2 MB fleet log; a fresh `worklog.md` starts today |

`research/` → `docs/research/` (kept **live** — round-12 design docs cited as provenance by ~10 source files; all citations updated). `evals/` stays live (standalone harness). De-committed from git (still on disk, now ignored): `scripts/captures/.raw/` webm probes + probe PNGs.

### 6.3 Git history (175 MB pack) — options for after token rotation

- **Option A (recommended, pre-launch): `git filter-repo`** purge of `.github-token`, `skills/`, `tool-results/`, `archive/` (old), `upload/`, `download/`, `agent-ctx/`, `apps/web/e2e/.results`, `scripts/captures/.raw`, `apps/web/public/editor`, `apps/web/api/gateway.mjs` + de-commit the dist/bundle via CI artifacts → est. pack **~25–30 MiB** (vs 175). Rewrites all SHAs — coordinate (delete/recreate the 5 dependabot + 2 vercel remote branches; worklog SHA citations refer to pre-rewrite history).
- **Option B (conservative):** same purge minus the live dist/bundle, keep them committed → ~50 MiB.
- **Option C:** stop the bleeding only (gitignore + CI artifacts); history stays 175 MB and the leaked PAT stays recoverable — acceptable **only** paired with rotation.
- Root cause fix included in this branch's spirit: `scripts/git-sync.sh`'s `git add -A` is what swept sandbox files in — switch it to an explicit pathspec allowlist before the next fleet run.

---

## 7. Everything changed in this branch

**Money-path fixes:** BIL-01 (+regression test), BIL-02, BIL-03, BIL-05, BIL-07-partial, SEC-09 — `billing.ts`, `ledger.ts`, `renders.ts`, `sweeps.ts`, `index.ts`, tests.
**Security fixes:** SEC-01 (bundle rebuild), SEC-04, SEC-06, SEC-07-partial, SEC-12 — `sign-in-form.tsx`, `billing.ts`, `next.config.ts`, smoke script.
**Cost/perf fixes:** PERF-06, PERF-08, PERF-12, prewarm gating + Save-Data, WASM Phase 0 (`.wasm.br` + Caddy precompressed + build budget gate).
**Hygiene:** storage's missing `zod` dep (typecheck now passes from a fresh clone), dead code archived, root `postcss.config.mjs` removed (it was breaking **every gateway vitest boot** on fresh clones — the suite went from unbootable to 1,133 passing).
**Restructure:** editor → `apps/editor` (17 reference sites + patch 0002), archive of all deprecated trees, docs sweep, `.env.example` regen.

**Verification:** typecheck 10/10 · 4,181 tests green (89 pg-only skipped here; CI runs them) · worker sqlite smoke PASS · BIL-02/BIL-03/SEC-09 purpose-built verification PASS · lockfile frozen-clean · exactly 10 workspace members.

**Wave 2 (2026-10-30, follow-up ledger — see worklog):** SEC-03 (scope enforcement + workspace binding), SEC-11 (fail-closed seat count), SEC-05-partial (IPv6 /64), BIL-04 (checkout-session card fingerprint), BIL-06-partial (fps cap + 1.5M frame ceiling at queue/estimate/spawn), BIL-07 (migration 0009 CHECK constraints + sqlite twin), PERF-03 (sha-keyed asset cache + ×4 parallel hydration), ENG-02 (web_time budget), CI `gateway-bundle-drift` gate, `bundle:gateway` script, rebuilt + smoke-verified `api/gateway.mjs`. Verification: 3,399 tests green on sqlite (gateway 1,164 · web 1,725 · worker 62 · db 175 · contracts 273), typecheck 10/10, biome clean on touched files. ENG-02's compile gate is CI `editor-cargo` (no Rust toolchain in the sandbox).

*Historical note: `docs/phases/*.md` intentionally retain their original `editor/` prose — they are point-in-time evidence records, not current docs.*
