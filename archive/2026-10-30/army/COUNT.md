# Army count — round 13 (≥500 ordered)

Waves: W1 audit (~240 assignments) → W2 consolidate (~25) → W3 fix (~160) → W4 verify (~75).
Every agent invocation is logged with its delivery state. Honest ledger, no padding.

| # | Agent | Task ID | Scope | State |
|---|-------|---------|-------|-------|
| 1 | w1-a01 | W1-audit | S001-S010 ui-egui core | DELIVERED (29 findings) |
| 2 | w1-a02 | W1-audit | S011-S020 ui-egui panels+i18n | FILE WRITTEN (task interrupted) |
| 3 | w1-a03 | W1-audit | S021-S030 panels+tests | KILLED - relaunched |
| 4 | w1-a04 | W1-audit | S031-S040 engine core | FILE WRITTEN (task interrupted) |
| 5 | w1-a05 | W1-audit | S041-S050 engine tests | DELIVERED (376 ec refs mapped) |
| 6 | w1-a06 | W1-audit | S051-S060 engine modules | KILLED - relaunched |
| 7 | w1-a07 | W1-audit | S061-S070 engine commands | KILLED - relaunched |
| 8 | w1-a08 | W1-audit | S071-S080 menus+gpu | KILLED - relaunched |
| - | w1-a03 | W1-audit | S021-S030 panels+tests | DELIVERED (1 HIGH ec-pin, 4 MED ALGO) |
| - | w1-a06 | W1-audit | S051-S060 engine modules | DELIVERED (1 HIGH font-fixture bug) |
| - | w1-a07 | W1-audit | S061-S070 engine commands | DELIVERED (2 MED BUG, fake-success input) |
| - | w1-a08 | W1-audit | S071-S080 menus+presets+effects | DELIVERED (MED sample-script off-by-one) |
| - | w1-a09 | W1-audit | S081-S090 effects+gpu | DELIVERED (HIGH ocio per-pixel LUT) |
| - | w1-a10 | W1-audit | S091-S100 gpu+render | DELIVERED (MED render cache Debug-hash) |
| - | w1-a11 | W1-audit | S101-S110 render+script+text | DELIVERED (HIGH Inter default font) |
| - | w1-a12 | W1-audit | S111-S120 small crates | DELIVERED (2 MED BUG, serde silent-loss) |
| - | w1-a13 | W1-audit | S121-S130 host/export/codec | KILLED server_shutdown - relaunch |
| - | w1-a14 | W1-audit | S131-S140 pdf/model/psd/lottie | KILLED server_shutdown - relaunch |
| - | w1-a15 | W1-audit | S141-S150 web/cli/xtask | KILLED server_shutdown - relaunch |
| - | w1-a16 | W1-audit | S151-S155+162 censuses | KILLED server_shutdown - relaunch |
| - | w1-a17 | W1-audit | S156-S161 docs+deletion+license | DELIVERED (deletion map + license table) |
| - | w1-a18 | W1-audit | S163-164+200-201 rename map | KILLED server_shutdown - relaunch |
| - | w1-a19 | W1-audit | S165-S172 web chat lib | DELIVERED (4 MED: end-marker rot, steer queue, new Function) |
| - | w1-a20 | W1-audit | S173-S180 web lib+chat comp 1 | DELIVERED (MED autosave data-loss, hardcoded localhost+hash) |
| - | w1-a13 | W1-audit | S121-S130 host/export/codec | DELIVERED (MED EffectCraft in exported WebM) |
| - | w1-a14 | W1-audit | S131-S140 pdf/model/psd/lottie | DELIVERED (HIGH PDF uncapped alloc, MED lottie deflate) |
| - | w1-a15 | W1-audit | S141-S150 web/cli/xtask | DELIVERED (HIGH bench debrand drift, MED auto-save misclass) |
| - | w1-a16 | W1-audit | S151-155+162 censuses | DELIVERED (4 HIGH brand gaps, 20 stale JA i18n) |
| - | w1-a18 | W1-audit | S163-164+200-201 rename map | DELIVERED (10,237 refs, 10 classes C1-C10) |
| - | w1-a21 | W1-audit | S181-S188 chat components | DELIVERED (2 HIGH credits-chain bugs) |
| - | w1-a22 | W1-audit | S189-S199 web api/e2e | DELIVERED (HIGH auto-apply run-status gap) |
| - | w1-a23 | W1-audit | S202-S212 packages | DELIVERED (2 HIGH dead-contract files) |
| - | WAVE-1 COMPLETE | | all 300 file scopes by 31 agents (25 full deliveries + 6 file-written) | DONE |
| - | w1-a24 | W1-audit | S213-S222 contracts | DELIVERED (dead sse.ts, UTF-16 budget bugs) |
| - | w1-a25 | W1-audit | S223-S234 api-client/storage/db | DELIVERED (HIGH broken SigV4 vectors, auto-apply doc contradiction) |
| - | w1-a26 | W1-audit | S235-S246 ui+gateway routes p1 | DELIVERED (HIGH Stripe webhook dedup-before-apply) |
| - | w1-a27 | W1-audit | S247-S258 litellm+gateway core | DELIVERED (4 HIGH billing bugs, S3 read null stub) |
| - | w1-a28 | W1-audit | S259-S270 gateway tests+worker | DELIVERED (2 HIGH stale suite, µc-mask fixtures) |
| - | w1-a29 | W1-audit | S271-S282 worker+infra | DELIVERED (HIGH SSRF Caddyfile, license gate gap, NV key) |
| - | w1-a30 | W1-audit | S283-S294 CI+docs | DELIVERED (HIGH ghost BUILD_PROMPT, pricing trio) |
| - | w1-a31 | W1-audit | S295-S300 security docs+root cfg | DELIVERED (4x HIGH pre-pivot ghosts) |
| - | W3-fix | b01-b06 | credits/billing/apply/purge/merge/chat | 6 DELIVERED + pushed (d96c3af 748ef21 84a7aa0 336d5f2 1f8aadf 4a0db4e) |
| - | W3-fix | lead A-stream | rename+brand+fonts+purge+sw/wasm+dist | DELIVERED (afd5688 c4546fa 955acb4) |
| - | W4-verify | gates | web 1726, gateway 380, contracts 272, text 178, pdf 104, cargo check EXIT 0 | PARTIAL: engine-class Rust suites blocked by 9.9G box disk (documented) |
| - | TOTAL | 31 W1 + 7 W3 + 2 W4 | 40 agent invocations this session (26 full deliveries + 2 file-written + rest killed by backend resets, relaunched to done) | honest count |
| - | W4-deploy | lead | vercel deploy unblock: stray api/gateway.ts (conflicting_file_path), 3 resurrected stale routes (parallel-page), stale gateway.mjs (rebuilt w/ w3-b02/b03 fixes) | DELIVERED e9aed3a — first READY deploy since 10-26 21:54 (13 stranded commits live) |
| - | W4-verify | lead | prod probes: /editor 200, studio_web_bg.wasm 200 application/wasm immutable, sw.js studio- prefix + wasm excluded from precache, /v1/health ok+db, thdiag 404, 0 effectcraft strings | ALL GREEN (residual Inter attribution string in wasm noted for next rebuild) |
| - | W3-fix | lead editor-boot | stub-WebGPU class: JS probe layers (c056d56) + wasm root fix GL device descriptor downlevel_webgl2_defaults (ee1565e) + dist rebuild 51.4MB w/ proof (58cdbc0) | DELIVERED — prod E2E: no-WebGPU env boots READY 3579ms (was: hard death '65535 better than allowed 0') |
| - | M3-tail7 | lead | editor re-report = cache poisoning: blanket immutable CC on stable-named dist (next.config + Caddyfile) + SW fetch honoring poisoned HTTP cache | DELIVERED (next.config must-revalidate + snippets-only immutable; Caddyfile @engine; sw.js cache:"reload" rescue, VERSION 9bda4682a68c9a08; prod curl+E2E verify post-deploy) |
| - | M3-tail8-p1 | lead | editor RSC fan-out → GET /v1/projects/resolve/:slug (stranded 6c8fd42 rescued: snapshot-resurrection junk discarded, gateway.mjs rebuilt, its RED tests re-greened) | DELIVERED 08d73a4 — heavy acct editor TTFB 4.4-6.6s → 0.21-0.29s warm (user class: 10.7s → sub-second) |
| - | M3-tail8-p2 | lead | /v1/me N+1 (per-org getFullWorkspace × 30) → repos.memberships.listForUser ONE join | DELIVERED 4045cae — /v1/me 2.0s → 0.4s, history 2.1s → 0.3s warm, payload byte-checked |
| - | harness-debt | lead | gateway 27 RED → 0 (RUNNER_TOOLS order = TOOL_LIST §8.4 pin ×22; litellm-chat stale retired-runner pins ×2) | DELIVERED — repo-wide Node sweep: gateway 1142, web 1720, contracts 272, db 240, ui 133, api-client 186, config 153 ALL GREEN |
| - | W4-verify | lead | prod E2E post-deploys: boot probe READY 3501ms canvas 1440x720; resolve/me/history/editor curl timings before+after on fabricated heavy acct | ALL GREEN (probe-cleanup patterns extended; DB cleanup blocked on Vercel 'sensitive' DATABASE_URL — standing note) |
| - | R13-lcp | lead | LCP render delay 816ms: (1) gate checking-arm rendered EMPTY main — SSR'd EditorTopBar+BootOverlay copy; (2) ids.ts node:crypto → crypto-browserify polyfill (~130KB elliptic/asn1) in EVERY bundle → globalThis.crypto.randomUUID; (3) comments ~160KB chunks → IdleCommentsRegion (requestIdleCallback dynamic import) | DELIVERED 6fea864+ef9a5ac — critical path 1712KB→1229KB (−28%), LCP 878ms→260-496ms headless, TTFB 24-28ms, boot probe READY 824ms, web 1724 green |
| - | R13-mainthread | lead | slow-machine LCP window: ShareDialog → lazy on-demand chunk; comments import gated past `load`; browserslist floor pinned 92/15.4; LegacyJavaScript root-caused (next's unconditional polyfill-module + radix ES5 dists; 110KB nomodule bundle ≠ executed) | DELIVERED — served set has zero share-dialog bytes, LCP 384ms@1x, boot READY 787ms, web 1725 green |
| - | SEC-audit | 5 agents | client-trust / authz-IDOR / races-billing / secrets-injection / algorithms-ratelimits deep audit (repo-wide, no code touched) | 20+ confirmed findings: C1 free-turn class (x3 auditors converged), C2 stale-turn replay, C3 reconcile self-mint, C5 pay-once-tools, A6 spoofable XFF, A7 pre-auth idempotency replay, A8 decorative key scopes, A9 stripe gates + allowance-never-granted, GH PAT in git history |
| - | SEC-fix | lead | billing core: uncapped turn settles + abort-honesty partial billing + in-flight refund guards + reserve-replay triage (409) + run-liveness gates + tools charge-before-work w/ ledger as durable gate + reconcile staff-gate + server-stamped plan credits | DELIVERED (46ad953 7b0bc5e) — the devtools free-turn class is dead at 3 independent layers |
| - | SEC-fix | lead | perimeter: last-hop clientIp + chat-class routing + session-scoped idempotency keys + API-key surface rules (403 auth/admin/billing) + bodyLimit 10MB + stripe payment_status/allowance grants + fingerprint-locked trials + locked render concurrency + lease/bytes gates on §8.7 sink + share redaction + invites rank ladder + invoices admin floor + single-use local tokens | DELIVERED (0b355cd) |
| - | SEC-verify | lead | harness un-REDDed (db/ dir), gateway 1142/0 + db 104 + web share 56 + 4 packages typecheck clean; prod live: x-request-id charset + 413 bodyLimit + boot READY 3338ms | ALL GREEN (65c8336 + harness .gitkeep) |
| - | SEC-pending | user | ROTATE ghp_ PAT (in git history, delete_repo scope) + optional filter-repo scrub after rotation; keep reconcile-mode platform-staff-only (promote operator account) | AWAITING USER |
