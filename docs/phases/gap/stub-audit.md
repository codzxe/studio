# Stub / Hardcode Audit - W3-C (read-only)

> **SUPERSEDED / EXECUTED (W5-08 note, 2026-10-23):** this audit's Top-10 kill
> list was executed by W4-KILL (see its worklog entry: landing pricing from
> PLAN_CATALOG, sign-up metadata neutral, real Share dialog, honest changelog,
> the @studio/storage dependency seam, 18 stray artifacts, Slate deletion) and
> follow-through waves. What remains unexecuted is tracked in the fleet
> `worklog.md` hand-forwards. Treat all findings below as historical; kept for
> the paper trail.


Date: 2026-10-23. Auditor: W3-C (stub-auditor). Scope per task: `apps/web/src`,
`services/gateway/src`, `services/worker/src`, `packages/*/src`. NOT audited:
`editor/` (vendored upstream), tests/fixtures (legitimate by definition).

SNAPSHOT WARNING: this audit ran against working tree `bdf50aa` + in-flight
uncommitted edits from parallel W3 agents (verified mid-audit): the shell
route-group move (`(app)/w/page.tsx` -> `(app)/w/(shell)/page.tsx`), the
onboarding flow (`components/onboarding/*` created, `sign-up-form.tsx:69` now
pushes `/onboarding`), `capability-gate.tsx` landed, chat letter-fixes in
flight, and `scripts/captures/` (marketing-capture production) just starting.
Every file:line below was READ in this tree; re-verify before deleting --
parallel agents own some of these paths right now.

Method: ripgrep sweeps for stub|placeholder|hardcod|fake|mock|TODO|FIXME|
temporary|Wave 2|Wave 3|not implemented|coming soon|captureOwed|for now|demo|
honest across the scope; every hit classified KILL / REPLACE / KEEP-LEGIT
with file:line evidence. Doc claims were NOT trusted; code was read.

Headline: the product core is REAL, not stubbed. The LiteLLM runner, plan
compiler + command registry, render worker + effectcraft-cli pipeline, Stripe
billing, share tokens, presence, comments, versions/leases and the editor host
are all real implementations. The genuine stub/hardcode residue is small and
concentrated in (1) one route stub (`/w` dashboard), (2) one placeholder
button (editor Share), (3) one hardcoded pricing block that CONTRADICTS the
catalog, (4) one misleading changelog page, (5) 17 stray compiled artifacts
committed into `src/`, and (6) honest-but-still-owed marketing captures.
The biggest user-visible problem is not fake features -- it is DRIFT (two
different price sets on the same marketing site).

## 1. Executive table (counts are ITEMS, not files)

| Package          | KILL | REPLACE | KEEP-LEGIT | Notes |
|------------------|------|---------|------------|-------|
| apps/web         | 0    | 6       | 7          | stub route, Share button, pricing hardcode, sign-up copy, changelog content, raw radius |
| services/gateway | 0    | 3       | 5          | storage vendor seam, stale comments, in-memory->Valkey W4 |
| services/worker  | 0    | 0       | 1          | "placeholder" comments document CLI behavior, not stubs |
| packages/editor-bridge | 1 (14 files) | 0 | 1     | stray compiled artifacts KILL; fake.ts is a test seam |
| packages/storage | 1 (2-3 files) | 0 | 1        | validate.js.map/.d.ts junk; validate.js load-bearing until seam fix |
| packages/ui      | 1    | 0       | 4          | Slate unconsumed; palette/meter/toast/ProjectCard have scheduled consumers |
| packages/config  | 0    | 0       | 3          | BUSINESS-PENDING prices, placeholder domains, MOCK_MODEL env def |
| packages/contracts | 0  | 1       | 2          | comment wording only ("Args stub") |
| packages/api-client | 0 | 1       | 1          | fixtures on the main barrel (move to subpath) |
| packages/db      | 0    | 0       | 1          | trial placeholder row documented |
| TOTAL            | 4    | 11      | 26         | KILL = 19 files, ~154 KB |

## 2. KILL LIST (safe to delete; zero-consumer proof included)

KILL-1. Stray compiled artifacts in packages/editor-bridge/src (14 files)
- Files: batch.js, bridge.js, errors.js, index.js, types.js + the five
  matching .js.map + the five .d.ts (all under packages/editor-bridge/src/).
- What: tsc emit output committed into src/ by the `git add -A` sweep
  (first appears in commit 1989de5, W1-05, whose worklog admits add -A swept
  peers' files; tsconfig is `"noEmit": true` so these are not pipeline
  output).
- Zero-consumer proof: package.json exports point at the .ts sources only
  (`"."`:"./src/index.ts", `"./fake"`:"./src/fake.ts"); all .ts sources
  import siblings EXTENSIONLESS (`editor-bridge/src/bridge.ts:26-27` imports
  `"./batch"`, `"./errors"`) so the .js files are never resolved; repo-wide
  grep for these .js paths finds no importer.
- Why dangerous, not just clutter: if a resolver ever picks the literal .js
  (some do for `.js`-suffixed specifiers), the gateway/worker would silently
  run a stale compiled copy instead of the source.
- Action: `git rm` the 14 files; add a gitignore rule (e.g.
  `packages/*/src/**/*.js` + `packages/*/src/**/*.js.map` +
  `packages/*/src/**/*.d.ts`) with a comment referencing this audit so
  git-sync add -A can never sweep them back.

KILL-2. Stray compiled artifacts in packages/storage/src (2 files now, 3rd after seam fix)
- Files: validate.js.map and validate.d.ts now; validate.js is
  LOAD-BEARING today (see REPLACE-6) and dies with the same commit once the
  gateway dependency seam lands.
- What: same tsc-emit sweep as KILL-1 (same commit 1989de5 lineage).
- Zero-consumer proof for .map/.d.ts: devtools maps are never imported;
  the .d.ts is bypassed because TypeScript resolves the gateway's
  `.js`-suffixed relative import to validate.ts via extension substitution,
  and every other consumer imports the .ts.
- Special case (validate.js): services/gateway/src/routes/assets.ts:66-70
  imports `"../../../../packages/storage/src/validate.js"` -- under tsx/node
  the literal .js file wins, so the gateway's MIME sniffing RUNS THE
  COMPILED SNAPSHOT. Deleting it before fixing the import breaks upload
  validation. Fix order: REPLACE-6 first, then delete all three.
- Action: delete .js.map + .d.ts now; delete validate.js in the same commit
  as REPLACE-6; same gitignore rule as KILL-1.

KILL-3. packages/ui/src/components/slate.tsx (+ slate.example.tsx + barrel line)
- File: packages/ui/src/components/slate.tsx (whole file),
  packages/ui/src/components/slate.example.tsx (whole file),
  packages/ui/src/index.ts:159 (`export { Slate, type SlateProps } ...`).
- What: the "Slate" signature component (project header strip). ZERO product
  consumers: grep for Slate imports across apps/web/src + services finds only
  the word "Slate" inside comments (editor-frame.tsx:59 "Slate corner") and
  card.tsx's SEPARATE internal SlatePlaceholder (card.tsx:86). No Wave-2/W3
  manifest task lists it (worklog grep for Slate: zero hits in the W1-08
  manifest).
- Why safe: git history retains it; the design system documents it, but a
  component with no consumer and no scheduled consumer is exactly the
  "exists for later" file the user is angry about. If the design system
  wants it back, it is one `git revert` away.
- Action: delete the two files + the barrel export + the README/gallery row
  (packages/ui/README.md documents 23 primitives -> becomes 22).
- Priority: LOW (it is a finished, tested component, not a fake feature).

KILL-4 (conditional). apps/web/src/components/system/system-states.tsx -> PermissionState only
- File: system-states.tsx:41-55 exports PermissionState; ZERO importers as
  of this snapshot (OfflineState is used by auth-offline-notice.tsx:3;
  UnsupportedGpuState is used by capability-gate.tsx which just landed).
- NOT a kill today: the hub task (W1-08 manifest, "hub-overview.tsx ...
  viewer role -> PermissionState 'You're a viewer in this workspace.'")
  names it as its first consumer and that task has not landed yet.
- Action: DO NOT DELETE during this wave. If the hub task lands without
  wiring it, delete PermissionState (not the whole file) in the next audit.

Explicit non-kills (checked and cleared): `apps/web/src/components/onboarding/
slug.ts` was a zero-importer orphan in HEAD but the in-flight onboarding wave
NOW imports it (components/onboarding/workspace-step.tsx:22 `import { slugify
} from "./slug"`) -- keep. `packages/ui` command-palette.tsx, credit-meter.tsx,
toast.tsx, ProjectCard (card.tsx:66+): zero product consumers today, but the
shell/dashboard tasks in the active manifest name each as its consumer
(palette -> shell-command-palette; CreditMeter -> top bar; ToastProvider ->
shell toast; ProjectCard -> dashboard recent grid). Keep; re-audit after the
shell lands.

## 3. REPLACE LIST (legitimate need, stubbed/hardcoded today)

REPLACE-1. The /w dashboard stub [HIGH VISIBILITY]
- File: apps/web/src/app/(app)/w/(shell)/page.tsx:10-25 (moved this wave from
  (app)/w/page.tsx; content unchanged).
- Current: `WorkspaceStubPage` renders EmptyState "The workspace is loading."
  with data-testid="workspace-stub"; header comment says "TEMPORARY stub
  (Wave 3 replaces this with the real dashboard, 8.4)". CONFIRMED still the
  stub (check (a) answered: yes).
- Real implementation: the manifest's dashboard task (dashboard-view with
  greeting, New project + Import .ecproj actions, recent ProjectCard grid,
  empty/loading/error states) behind the shell layout. The copy "The
  workspace is loading." reads like a loading state -- worst possible
  placeholder wording for the #1 post-login page.
- Effort: M (task already specified in the W1-08 manifest).

REPLACE-2. Editor Share button is a "coming soon" placeholder [HIGH VISIBILITY]
- File: apps/web/src/components/editor-host/project-bar.tsx:60-82 (button
  block; aria-label "Share (coming soon)", data-testid
  "editor-share-placeholder", tooltip "Coming soon", comment "M7 placeholder:
  a real ... button that activates nothing yet").
- Current: an inert, aria-disabled button in the editor chrome that says
  "Coming soon" on hover.
- Real implementation: the share API is fully live -- POST
  /v1/projects/:id/share-links mints (routes/share.ts:413, editor role),
  GET lists (:451), DELETE revokes (:462); api-client exposes share.issueLink
  / listLinks / revokeLink (packages/api-client/src/client.ts:919-963). Wire
  the button to an issue-link dialog (show-once token + copy), same pattern
  the hub's share-links-card task specifies.
- Effort: S-M (dialog + show-once flow; API work zero).

REPLACE-3. Landing pricing block hardcodes prices that CONTRADICT the catalog [HIGH VISIBILITY]
- File: apps/web/src/app/(marketing)/page.tsx:106-131 (PLANS const:
  "$29"/"$79"/"$199", "1,000/3,000/8,000 credits/mo", "1/3/10 seats")
  rendered at :401-441; pinned by apps/web/tests/landing.test.tsx:132-134.
- Current: the landing page says Starter=$29/1 seat/1,000 credits while
  /pricing (components/marketing/pricing-cards.tsx, derived from
  PLAN_CATALOG) says Starter=$12/2 seats/500 credits
  (packages/config/src/plans.ts:246-262). Two different price sets on the
  same marketing site -- this is the single worst "hardcoded thing" in the
  repo because both pages are user-visible and they disagree.
- Real implementation: derive the landing cards from PLAN_CATALOG exactly as
  pricing-cards.tsx does (or render PricingCards directly); update the three
  test pins.
- Effort: S.

REPLACE-4. Sign-up metadata hardcodes "$29/mo"
- File: apps/web/src/app/(auth)/sign-up/page.tsx:7 (description: "Create your
  Studio workspace -- 14 days free with card, then $29/mo. Cancel anytime.").
- Current: third occurrence of the phantom $29 number (it is also an SEO/OG
  description string).
- Real implementation: compute from `PLAN_CATALOG.starter.monthlyPriceCents`
  via the existing page-format helper at module scope.
- Effort: XS.

REPLACE-5. /changelog presents the deleted pre-pivot product as this product's history [HIGH VISIBILITY]
- File: apps/web/src/app/(marketing)/changelog/page.tsx:43-190 (hardcoded
  RELEASES array) mirroring root CHANGELOG.md [0.1.0-beta.0] -- 2026-10-21.
- Current: the only release entry describes the pre-pivot PhotoCraft build:
  "template-driven design editor ... engine pinned 872748fb, ADR-0001,
  additions live in engine-patches/", template catalogs, "PSD experimental",
  Dockerfiles/compose/prometheus, W0-W10 waves -- all of which was DELETED by
  user order on 2026-10-23 (W1-01) and none of which describes the shipped
  EffectCraft-based product (ADR-0006, pin 9db7f3b2). The page's own note
  admits only "the pre-pivot domain word is mapped to today's 'projects'
  vocabulary" (page.tsx:14-17). A visitor reading /changelog today believes
  the product shipped templates, PSD import and i18n -- features that do not
  exist post-pivot.
- Real implementation: append a pivot/reset entry to CHANGELOG.md (product
  reset to the EffectCraft editor, archive purged) and mirror it here; or trim
  the pre-pivot entry to a short historical note. The mirror mechanism itself
  is fine (page.tsx:192-196 "no invented future releases").
- Effort: S (editorial, one entry + one section).

REPLACE-6. Gateway imports the storage validator through a relative source path into a compiled .js
- File: services/gateway/src/routes/assets.ts:57-70 -- `import { ...
  sniffMime } from "../../../../packages/storage/src/validate.js"` with a
  comment admitting the vendor seam ("@studio/storage is not yet a declared
  dependency of @studio/gateway ... convert to the bare
  '@studio/storage/validate' specifier when the package graph owns the edge").
- Current: cross-package relative import + the load-bearing stale .js of
  KILL-2 (runtime executes the committed compiled snapshot; any future edit
  to validate.ts silently does not reach the gateway until someone re-runs
  tsc by hand -- exactly the drift class this audit exists to kill).
- Real implementation: (1) add `"@studio/storage": "workspace:*"` to
  services/gateway/package.json deps, (2) add a `"./validate":
  "./src/validate.ts"` subpath export to packages/storage/package.json,
  (3) rewrite the import to `@studio/storage/validate`, (4) delete the
  validate.{js,js.map,d.ts} trio (completes KILL-2).
- Effort: XS (four mechanical edits; the worklog has owed this one-liner
  since W1-RECON).

REPLACE-7. Marketing capture placeholders (owned by the parallel captures agent -- DO NOT DUPLICATE)
- Files: apps/web/src/lib/demo.ts:14-22 (DEMO_FILM.captureOwed: true),
  components/marketing/film-slot.tsx (slate poster, no video),
  components/marketing/editor-frame.tsx (construction-grid diagram, not a
  screenshot), components/marketing/agent-story.tsx (hand-composed cards).
- Current: honest placeholders with a documented flip condition (check (b)
  answered; see KEEP-LEGIT-1 for why they are honest). `apps/web/public/
  marketing/` does not exist yet; `scripts/captures/` (boot-stack.sh,
  build-fixture.mjs) appeared in the working tree THIS HOUR -- the capture
  task is actively running.
- Real implementation: real 16:9 captures of the real editor + chat; flip
  captureOwed to false ONLY when the asset lands (per the manifest's capture
  task). The stub-killer must not touch these four files.
- Effort: H (already assigned).

REPLACE-8. agent-story.tsx raw radius
- File: apps/web/src/components/marketing/agent-story.tsx:41
  (`rounded-[8px]` -- the one raw-radius violation vs the --radius-md token).
- Real implementation: rounded-md. NOTE: the captures agent also edits this
  file (real captures replace the hand-composed cards); fold the token fix
  into that task or land it after theirs rebases.
- Effort: XS.

REPLACE-9. Stale "stub"/"Wave 3" comment sweep (comment-only, zero behavior)
- Files: apps/web/src/proxy.ts:8 ("that is the gateway's job (Wave 3)" -- the
  gateway does it today), apps/web/src/lib/auth-client.ts:6 (stale Wave-3
  note), services/gateway/src/plan-compiler.ts:164 ("their stubs are
  intentionally empty/passthrough today" -- false now: defaultCompileDeps at
  :1218-1230 wires the REAL registry + REAL write-tools catalog),
  services/gateway/src/litellm/runner.ts:149 ("M5-J's registry stub" --
  registry is real), packages/contracts/src/tools.ts:62 ("Args stub the
  gateway validates" -- it is a zod schema, say schema).
- Real implementation: reword to describe today's reality. Zero code change.
- Effort: XS.

REPLACE-10. Single-instance in-memory stores (documented scale-out seam, NOT fake)
- Files: services/gateway/src/rate-limit.ts:4-7 (TODO(W4) Valkey),
  context.ts:33-44 (ChatReplayStore), runner.ts RunRegistry, idempotency.ts.
- Current: real, working implementations with an honest single-instance
  posture and a named W4 follow-up. Only matters when >1 gateway replica.
- Effort: M-L, defer to W4 (keep the TODOs; they are the flip condition).

REPLACE-11. api-client fixtures ride the main barrel
- File: packages/api-client/src/index.ts:14 (`export * from "./fixtures"`).
- Current: the 1,300-line demo fixture object is exported from the root
  entry every production import pulls through (bundle bloat risk; the
  "./fixtures" subpath export already exists in package.json).
- Real implementation: move test imports to "@studio/api-client/fixtures"
  (3 test files: apps/web/src/lib/chat/chat-controller.test.ts:16,
  run-state.test.ts:10, packages/api-client/tests/_smoke.test.ts:5) and drop
  the barrel re-export.
- Effort: XS.

## 4. Top-10 ranked (kill/fix FIRST for maximum user-visible cleanup)

1. REPLACE-3 landing pricing hardcode -- two contradictory price sets on the
   public site; the fastest high-credibility fix in the repo (S).
2. REPLACE-1 /w dashboard stub -- the first page every signed-in user lands
   on says "The workspace is loading." forever.
3. REPLACE-2 Share "coming soon" button -- dead UI in the editor chrome
   while the share API is fully live; wire it.
4. REPLACE-4 sign-up "$29/mo" metadata -- same phantom price in SEO copy.
5. REPLACE-5 changelog pre-pivot record -- public page advertises deleted
   features (templates/PSD/i18n) as shipped.
6. KILL-1 + KILL-2 + REPLACE-6 as ONE commit -- declare the storage dep,
   fix the import, delete 17 stray artifacts + gitignore them (removes the
   silent-drift hazard AND ~154 KB of committed junk).
7. REPLACE-7 marketing captures (in flight by a parallel agent -- verify
   the captureOwed flips land only with real assets).
8. REPLACE-8 agent-story radius token (ride along with the captures task).
9. REPLACE-9 stale comment sweep (cheap truthfulness).
10. KILL-3 Slate component (the only truly unconsumed component; delete only
    after confirming the hub/shell wave finished without wanting it).

## 5. Specific checks requested by the user

(a) apps/web/src/app/(app)/w/page.tsx -- CONFIRMED still the "Wave 3 replaces
    this" temporary stub (now at (app)/w/(shell)/page.tsx after this wave's
    route-group move; WorkspaceStubPage, testid workspace-stub, copy "The
    workspace is loading."). It is REPLACE, not KILL: sign-up -> /onboarding
    and the invite flow still need a /w landing, and the dashboard task is
    specified in the active manifest.

(b) Marketing placeholder visuals -- film-slot.tsx (honest slate poster, no
    video, aria says "Capture in progress"), editor-frame.tsx:47-79
    (construction-grid DIAGRAM, aria "A real capture lands here at launch"),
    agent-story.tsx (presentational cards from real ui primitives, no
    handlers -- the doc comment says so), lib/demo.ts:21 captureOwed:true.
    All four are honest placeholders WITH a flip condition and an owner (the
    captures task running now; scripts/captures/ exists, no assets yet).
    KEEP-LEGIT until the real captures land; the flip must not happen early.

(c) Gateway runner MOCK_MODEL path -- LEGITIMATE dev seam, confirmed. Real
    LiteLLM runner exists and is the non-mock default
    (services/gateway/src/runner.ts:408-417 createRunnerForEnv: mock only
    when env.app.mockModel, else createLiteLLMRunner with real baseUrl/key;
    litellm/{runner,openai,prompt}.ts are real implementations). No
    production default: schema default is FALSE
    (packages/config/src/env.ts:609 `MOCK_MODEL: envBool.default(false)`)
    and APP_ENV=production + MOCK_MODEL is a hard env error
    (env.ts:881-885, message "the offline mock bypasses real model routing
    and billing"). MockRunner itself (runner.ts:306-396) is clearly fenced
    as "(MOCK_MODEL=true)". D-16 satisfied.

(d) Hardcoded IDs/strings/pricing/URLs in UI -- found exactly three real
    offenders, all pricing, all listed: landing PLANS (page.tsx:106-131),
    sign-up metadata "$29/mo" (sign-up/page.tsx:7), and the top-up pack ids
    pinned in pricing-cards.tsx:92-96 (documented pin with a stated reason --
    runtime import of the contracts barrel is forbidden from apps/web; drift
    risk noted but low). Everything else checked clean: /pricing derives
    every number from PLAN_CATALOG (pricing-cards.tsx:103-161); brand
    domains/contacts are single-swap tokens (config/src/brand.ts:62-82);
    licences URLs are attribution; PermissionState's mailto uses
    Brand.contact.support; the caniuse link in UnsupportedGpuState is
    legitimate. The PLAN_CATALOG prices themselves ($12/$39/$99) are
    BUSINESS-PENDING placeholders -- single source of truth, documented flip
    condition (plans.ts:188-192), KEEP.

(e) Unused components with zero importers -- re-verified TODAY:
    system-states.tsx: OfflineState USED (auth-offline-notice.tsx:3 <- auth
    layout); UnsupportedGpuState NOW USED (capability-gate.tsx, landed this
    wave); PermissionState still zero importers (scheduled hub consumer --
    conditional KILL-4). onboarding/slug.ts was the flagged orphan; the
    in-flight onboarding wave just wired it (workspace-step.tsx:22).
    packages/ui zero-product-consumer primitives with SCHEDULED consumers:
    command-palette, credit-meter, toast, ProjectCard. Zero-consumer with NO
    scheduled consumer: Slate only (KILL-3). The web component tree
    otherwise imports cleanly (basename sweep: no other zero-importer).

(f) Unnecessary wrapper/indirection files -- two candidates examined:
    apps/web/src/vendor/studio-config.ts is REQUIRED (Turbopack cannot
    resolve the NodeNext .js barrels; it is the tsconfig `@studio/config`
    target -- apps/web/tsconfig.json:24 -- with self-destruct instructions
    in its header). KEEP. The gateway's relative-path storage import
    (assets.ts:70) is the one true unnecessary indirection -> REPLACE-6.
    editor-session/index.ts barrel is actively imported (10 files via
    "@/lib/editor-session").

## 6. KEEP-LEGIT registry (verified honest; flip conditions noted)

1. MOCK_MODEL + MockRunner (see 5c). Flip: none (permanent dev seam).
2. lib/demo.ts + film-slot.tsx (captureOwed). Flip: captures task.
3. editor-frame.tsx diagram. Flip: captures task.
4. agent-story.tsx cards. Flip: captures task.
5. packages/editor-bridge fake.ts + attachFake.ts -- deterministic test
   editor; imports only from tests (apply-harness.ts:52, unit tests); the
   production entry (index.ts:6) documents the split. Flip: none.
6. packages/api-client fixtures.ts -- deterministic dev/demo data (clearly
   demo ids prj_demo_..., RFC2606 domain, FIXTURES_DEMO_NOTICE banner),
   schema-validated; consumed by 3 test files + smoke. Barrel note REPLACE-11.
7. apps/web/src/lib/editor-session/testing.ts -- fake session client, tests.
8. Gateway "stub boot" guards (me.ts:33-40, plan.ts:31-45, billing.ts:185,
   chat.ts:103, routes/renders.ts fixtures usage) -- graceful degradation
   when TEST harnesses omit billing repos; production paths read the real
   subscription row (me.ts:81-90, plan.ts effectivePlan). Not stubs.
9. services/gateway/src/routes/local-storage.ts -- LocalFS-only signed-URL
   target, returns 404 when the local driver is absent (local-storage.ts:18);
   APP_ENV=local gated per header. Dev infra, honest.
10. Worker "placeholder" language (pipeline.ts:10, hydrate.ts:14-18) --
    documents the effectcraft CLI's real behavior (missing footage renders a
    placeholder frame and exits 0) and the worker's honest pre-validation
    that FAILS the job before spawn. Real pipeline: claims via SKIP LOCKED,
    spawns the real CLI, uploads, settles D-20/D-26.
11. In-memory rate limiter / replay / registry / idempotency stores --
    working single-instance implementations with TODO(W4) flip (REPLACE-10).
12. packages/config plans.ts BUSINESS-PENDING prices -- one source of truth,
    documented. packages/config brand.ts placeholder domains -- single swap
    point. MOCK_MODEL env definition (env.ts:100-105) -- documented.
13. packages/db schema.ts:696 trial plan_id "pre-checkout placeholder" --
    documented subscription state (subscriptions.ts:36), real semantics.
14. packages/ui *.example.tsx (20 files) -- M9-A "documentation-as-code"
    galleries beside each primitive (README section 5), no runtime surface.
    Cheap to keep; kill only if the user wants the tree leaner.
15. scripts/dev-sqlite.sh demo seed (demo@studio.test) -- dev tooling, never
    shipped.
16. reconciliation.ts -- real, report-only by design (M6-I).
17. tool-executor.ts:524 / lease-banner.tsx:202 "stubbed fetch in tests"
    comments -- defensive client arms, not stubs.
18. The changelog MIRROR MECHANISM (page reads a hardcoded copy of
    CHANGELOG.md) -- legit; the CONTENT problem is REPLACE-5.

## 7. What is NOT in the kill list (audited and clean)

The following were suspected from older gap docs and verified REAL in code
today: LiteLLM runner + 13-tool prompt (litellm/*), plan compiler with the
real AGENT_COMMAND_REGISTRY + WRITE_TOOLS (plan-compiler.ts:1218-1230),
renders v2 queue/estimate/cancel (routes/renders.ts), the worker service
(pipeline/hydrate/sweeps/zip), share tokens + public review surface
(routes/share.ts), presence heartbeats (routes/presence.ts), members/
api-keys/settings/audit routes, Stripe checkout/portal/webhooks, the editor
host + capability gate, autosave, chat apply/undo machinery, and the
billing pages (catalog-derived). None of these is a stub.
