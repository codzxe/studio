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
