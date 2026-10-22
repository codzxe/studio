# Web UI Gap Report - apps/web (agent W-R1, read-only audit)

Scope: apps/web/** (Next.js 16 App Router app). Compared against
docs/BUILD_PLAN.md milestones M1-M9 (UI-relevant tasks). Audited 2026; every
file under apps/web/src was read. Companion evidence: services/gateway (auth
mount), packages/ui (primitives), packages/billing (plan catalog).

Headline: apps/web today is a MARKETING + AUTH surface only (Wave 2-a build,
commit 58d8d2f). The entire signed-in product - shell, project hub, editor
host, chat, plan/apply, billing, settings, share - has no UI yet. The old
pre-pivot shell/billing/chat UI (W8-era commits 78ed0a2, fa986f8, 554c983) was
archived in W0 (9e9192d) and is NOT in the current tree; do not resurrect it.

## 1. FILE INVENTORY (every file under apps/web)

### Root configs (10)

| File | Purpose |
|---|---|
| package.json | @studio/web deps: next 16, react 19, better-auth ^1.7.12, lucide-react, @studio/{config,contracts,ui}; no editor-bridge, no api-client |
| next.config.ts | COOP/COEP + immutable cache headers for /editor/*, dev-only rewrites to EDITOR_DEV_SERVER_URL, skipTrailingSlashRedirect, nosniff/referrer headers |
| tsconfig.json | Strict, path aliases incl. @studio/* source-mapped; @studio/config -> src/vendor shim |
| vitest.config.ts | jsdom + RTL + @vitejs/plugin-react, tests/** only |
| vitest.setup.ts | jsdom shims (matchMedia, ResizeObserver, scrollIntoView) + global next/navigation mock |
| postcss.config.mjs | Tailwind v4 via @tailwindcss/postcss |
| next-env.d.ts, README.md, .gitignore | Boilerplate / dev+font docs / ignore |

### src/app (15 files)

| File | Purpose |
|---|---|
| layout.tsx | Root layout: 3 next/font faces (Instrument Serif/Sans, JetBrains Mono), metadata from Brand tokens, skip link, dark themeColor |
| globals.css | Tailwind + @studio/ui theme import, font-stack variable mapping, skip-link CSS, editor-grid + callout-line marketing helpers |
| not-found.tsx | Global 404 "This frame doesn't exist." (EmptyState, links to /w and /) |
| error.tsx | Global error boundary "Something broke on our side." + digest request id + retry |
| (app)/w/page.tsx | TEMPORARY workspace stub: EmptyState "The workspace is loading." - the only (app) route |
| (auth)/layout.tsx | Auth split layout: 55% form / 45% cinematic panel with FrameLine + serif pull-quote; terms/privacy footer |
| (auth)/sign-in/page.tsx | Sign-in page (Suspense + SignInForm) |
| (auth)/sign-up/page.tsx | Sign-up page ("Create your workspace", trial copy) |
| (auth)/forgot-password/page.tsx | Password reset request page (ForgotPasswordForm) |
| (auth)/invite/[token]/page.tsx | Invite acceptance page (InviteCard, token from params) |
| (marketing)/layout.tsx | Marketing chrome: SiteHeader + #main + SiteFooter |
| (marketing)/page.tsx | Landing page: all 11 sections (hero, proof, agent story, editor frame, workflow, collaboration, performance, pricing, FAQ, final CTA; footer in layout) |
| (marketing)/legal/terms/page.tsx | Terms of Service (7 numbered sections, real copy) |
| (marketing)/legal/privacy/page.tsx | Privacy Policy (6 sections, real copy) |
| (marketing)/legal/licences/page.tsx | OSS attribution page (EffectCraft pin 9db7f3b, fonts, license links) |

### src/components (13 files)

| File | Purpose |
|---|---|
| auth/sign-in-form.tsx | OAuth row + email/password, inline errors, ?next round-trip, calls authClient.signIn.email |
| auth/sign-up-form.tsx | Name/email/password + unchecked-by-default terms checkbox, trial copy, calls authClient.signUp.email, pushes /w |
| auth/forgot-password-form.tsx | Email -> requestPasswordReset; honest sent state (no account enumeration); redirectTo /reset-password (MISSING route) |
| auth/invite-card.tsx | 4-phase card (loading/needs-auth/invalid/ready): getInvitation -> accept/reject; inline errors |
| auth/oauth-buttons.tsx | Google + GitHub monochrome marks -> authClient.signIn.social full-page redirect |
| auth/password-field.tsx | Password input + accessible show/hide toggle over @studio/ui Field |
| marketing/site-header.tsx | Sticky marketing header: signal dot + serif wordmark, anchor nav, sign-in/trial CTAs |
| marketing/site-footer.tsx | 4-column footer (product/resources/legal), changelog+status links via Brand placeholder domains |
| marketing/film-slot.tsx | Hero film slot: honest slate placeholder, no video yet (DEMO_FILM.captureOwed) |
| marketing/editor-frame.tsx | Editor section: annotated construction-grid viewport diagram (NOT a fake screenshot), 3 callouts |
| marketing/agent-story.tsx | Marketing 3-step story Ask/Plan/Applied - STATIC mock cards (no handlers), previews the future plan card |
| marketing/legal-page.tsx | Shared legal shell (LegalPage/LegalSection/LegalCrossLinks) |
| system/system-states.tsx | OfflineState / PermissionState / UnsupportedGpuState - defined, never imported by any route yet |

### src/lib, src/proxy.ts, src/vendor (5 files)

| File | Purpose |
|---|---|
| lib/auth-client.ts | better-auth browser client, baseURL ${NEXT_PUBLIC_APP_URL}/v1/auth, organization plugin; exports SESSION_COOKIE_NAME |
| lib/seo.ts | pageMetadata helper (canonical + OG from Brand tokens), SITE_URL from env |
| lib/demo.ts | DEMO_FILM metadata: anchor, runtime label, caption, captureOwed=true (the one owed marketing capture) |
| proxy.ts | Next 16 proxy (renamed middleware): cookie-PRESENCE-only guard for /w/:path* -> redirect /sign-in?next=...; stamps x-pathname; explicitly NOT an auth oracle |
| vendor/studio-config.ts | Turbopack shim re-exporting packages/config/src/brand only (NodeNext .js barrels unsupported); delete when upstream fixes resolution |

### tests (3 files)

| File | Purpose |
|---|---|
| tests/auth.test.tsx | Form behaviour: inline validation, password toggle, terms gate, honest reset state (better-auth mocked) |
| tests/landing.test.tsx | 11 section markers in order, honest copy assertions, brand-safety (no forbidden names), no fake metrics |
| tests/legal.test.tsx | Legal pages real copy, licences attribution rows (EffectCraft pin), 404 copy |

Counts: 10 routes + 404 + error boundary = 12 renderable surfaces; 25
components; 33 files under src; 3 test files. No /reset-password, no
/w/[project], no /editor host route, no /s/:token, no billing/settings routes.

## 2. MILESTONE TABLE (BUILD_PLAN task -> status -> evidence -> missing)

Legend: DONE / PARTIAL (exists+missing listed) / MISSING (nothing).

| Task | Status | Evidence | What is missing |
|---|---|---|---|
| M1.1 auth pages (email+OAuth, roles) | PARTIAL | sign-in-form.tsx:44, sign-up-form.tsx:50, oauth-buttons.tsx:48, invite-card.tsx:36-94 | /reset-password landing route (redirectTo referenced forgot-password-form.tsx:31 -> 404 today), email-verification page, role-gated UI |
| M1.2 workspace lifecycle UI | MISSING | only stub (app)/w/page.tsx:15 | create workspace, slug check, switcher, members, remove, transfer ownership, audit views |
| M1.4 app shell + route groups + middleware | PARTIAL | groups: (marketing)/layout.tsx, (auth)/layout.tsx, (app)/w/page.tsx; guard proxy.ts:21-34; error boundary error.tsx; 404 not-found.tsx | left rail, top bar, workspace switcher, command palette (primitive exists packages/ui, unused), toasts (primitive exists, unused) - /w stub is not a shell |
| M1.5 onboarding (create ws -> use case -> trial) | MISSING | sign-up-form.tsx:61 pushes /w stub | entire flow; trial start UI (M6 stub entitlement) |
| M1.6 tests (auth flows, roles, Playwright) | PARTIAL | tests/auth.test.tsx (unit, mocked client) | Playwright flows, role matrix / cross-tenant UI tests |
| M2.6 project hub UI (overview/versions/comments/renders/activity) | MISSING | none under (app) | everything: projects grid, project detail, tabs, upload, delete/restore, thumbnail stub; ProjectCard primitive exists in packages/ui unused |
| M3.1 editor build pipeline (serve /editor) | PARTIAL (config only) | next.config.ts:36-57 COOP/COEP+immutable cache; rewrites next.config.ts:59-75 (dev only); scripts/serve-editor.py + docs in next.config comments | production serving is Caddy's job (infra); no dist committed, no wasm load/retry logic in web |
| M3.2 editor-bridge host page | MISSING | no route/component; @studio/editor-bridge NOT in web package.json deps (tsconfig path exists only) | iframe host page, readiness handshake usage, event bus wiring |
| M3.3 load sequence (manifest->assets->upload->open) | MISSING | none | fetch-manifest flow, asset placeholders + non-blocking banner |
| M3.4 autosave + conflict UI | MISSING | none | dirty tracking, debounce, 30s save, Cmd+S, 409 compare/restore UI |
| M3.5 editor page chrome (floating bar, presence, Share, read-only badge) | MISSING | none | all chrome; no persistent-top-nav rule not yet applicable |
| M3.6 keyboard/focus forwarding (Cmd+L/K/I) | MISSING | none | same-origin listener bridge to chat (no chat exists) |
| M3.7 failure handling (GPU/wasm/crash/unsaved guard) | PARTIAL | system-states.tsx:12 (OfflineState), :47 (UnsupportedGpuState) - defined but never imported | wasm load retry, crash recovery to last version, unsaved-changes guard; wire the 3 existing states |
| M4.1 chat overlay (panel/cards/composer/context strip/streaming) | MISSING | marketing mock only: agent-story.tsx:37-111 (static, no handlers) | floating/docked panel, collapsed pill, resize/drag, virtualized thread, markdown, streaming caret, stop, reconnect, error banners |
| M4.2 chat route consumption (SSE) | MISSING | no EventSource/fetch in src (grep: only auth-client references /v1) | UI message stream client, Last-Event-ID replay, model picker; packages/api-client/src/sse.ts exists UNUSED by web |
| M4.4/M4.5 context strip + tool cards | MISSING | none | context popover, attach/detach, token estimates, expandable tool cards |
| M5.3 plan/preview UI | MISSING | marketing PlanCard mock agent-story.tsx:58-92 | real plan card (risk, affected layers, credit estimate), before/after preview, high-risk confirm, cancel |
| M5.5 undo/redo card UX + M5.7 agent polish (Cmd+K inline, diff cards) | MISSING | none | undo card state, re-apply explanation, diff cards, error/clarify cards; EditPlan schema exists packages/contracts/src/edit-plan.ts UNUSED by web |
| M6.4 billing UI (plan/credits/usage/invoices/cancel, low-credit banner, ledger table, chat footer estimate) | MISSING | landing pricing is static marketing (marketing)/page.tsx:105-130,386-443 | all billing routes; CreditMeter primitive in packages/ui unused; gateway billing routes exist (services/gateway/src/routes/billing.ts) with no consumer |
| M7.1 comments UI | MISSING | none | create/reply/resolve, filters, guest comments; gateway comments route exists, no UI |
| M7.2/M7.3 presence + lease UX | MISSING | marketing mock card (marketing)/page.tsx:333-353 | "X is editing" banner, request edit, read-only enforcement UI |
| M7.4 versions timeline / activity feed UI | MISSING | none | timeline, labels, restore confirm, diff summary, audit export |
| M7.5 share/review page /s/:token | MISSING | none | player, frame step, comments, password, request access |
| M9.1 tokens + primitives | DONE (package level) | packages/ui full kit (button..command-palette, credit-meter, risk badge); web wiring app/layout.tsx:13-32, globals.css:1-16 | Storybook/examples + axe tests (M9.1 second half) not present |
| M9.2 marketing (landing, legal, changelog, status, 404/500) | PARTIAL | landing all 11 sections (marketing)/page.tsx:163-494 + tests/landing.test.tsx; legal 3 pages; not-found.tsx; error.tsx | changelog page + status page (footer links point to placeholder Brand domains, site-footer.tsx:17,25); real demo capture owed (lib/demo.ts:21 captureOwed=true, film-slot.tsx placeholder) |
| M9.3 auth + onboarding | PARTIAL | see M1.1/M1.5 | reset-password, verify-email, workspace creation, trial start |
| M9.4 dashboard + project hub | MISSING | stub (app)/w/page.tsx | project grid, empty/loading/error, versions, activity |
| M9.5 billing/settings pages | MISSING | none | plan, credits, usage, invoices, members, roles, API keys, models, audit, licences UI |
| M9.6 chat visual pass | MISSING (n/a) | no chat UI exists | - |
| M9.7 visual QA (390..1920, 200% zoom, axe, editor diff) | MISSING | none | screenshot suites, axe runs, editor-vs-upstream diff harness |

Milestone roll-up: M1 PARTIAL (auth pages real, shell/onboarding absent);
M2 MISSING (UI); M3 PARTIAL-config-only (headers/rewrites, zero host page);
M4 MISSING; M5 MISSING; M6 MISSING; M7 MISSING; M9 PARTIAL (design system +
landing done; dashboard/billing/QA absent). M0/M8 have no apps/web tasks.

## 3. INTEGRATION STATE

Auth (the ONLY live web<->gateway wiring):
- Web: lib/auth-client.ts:26-29 creates the better-auth client against
  `${NEXT_PUBLIC_APP_URL}/v1/auth` (org plugin for invites). All five auth
  forms call it (sign-in/sign-up/social/requestPasswordReset/getInvitation/
  acceptInvitation/rejectInvitation).
- Gateway: services/gateway/src/env.ts:16 `AUTH_MOUNT_PATH = "/v1/auth"`;
  app.ts:104 mounts the better-auth handler - path matches the client.
- Cookie: better-auth default `better-auth.session_token`
  (lib/auth-client.ts:36) matches proxy.ts:16; proxy checks PRESENCE ONLY by
  design (proxy.ts:7-14 comment: "never an auth oracle; validation is the
  gateway's job").

Gateway REST API: web consumes NOTHING of it. Zero fetch/EventSource outside
the better-auth client (grep across src). packages/api-client (client.ts,
sse.ts, retry, response-schemas, fixtures) is built and tested but UNUSED by
apps/web - @studio/api-client is not even in web's package.json.
@studio/contracts IS declared in package.json:17 + tsconfig.json:25 but has
ZERO imports in src - dead dependency wiring kept for Wave 3.

Demo mode: none in web. lib/demo.ts is marketing copy metadata (film slot),
not a fake-data layer. The /w stub is static copy, no mock API.

proxy.ts: Next 16's renamed middleware convention. Matches `/w/:path*` only
(proxy.ts:34). No session validation, no role checks, stamps x-pathname for
logging. It is NOT an editor proxy: editor dev proxying lives in
next.config.ts rewrites (`/editor` and `/editor/:path*` ->
EDITOR_DEV_SERVER_URL); production editor serving is Caddy's (documented in
next.config.ts:3-22 and apps/web/README.md "Serving the editor").

vendor/ (apps/web/src/vendor): NOT third-party code. Single file
studio-config.ts, a Turbopack shim re-exporting
`../../../../packages/config/src/brand` (NodeNext ".js" barrel re-exports that
Turbopack cannot resolve). Brand-only scope; self-destruct instructions in
the file header and README.

Editor bridge: packages/editor-bridge (bridge/fake/batch/errors, tested)
exists but web neither depends on it nor imports it. tsconfig path mapping
`@studio/editor-bridge` is pre-wired for the future host page.

## 4. RISKS

1. Dead reset link: forgot-password-form.tsx:31 sends users to /reset-password
   which has NO route - password-reset emails will land on the 404. Highest-
   severity functional gap in shipped UI.
2. /w stub copy "The workspace is loading." (app)/w/page.tsx:20 reads like a
   loading state but is a placeholder page; M9 exit "no placeholder copy"
   fails for /w today. Sign-up dumps new users onto it (sign-up-form.tsx:61).
3. Pricing drift: landing hardcodes $29/$79/$199 + 1000/3000/8000 credits
   ((marketing)/page.tsx:105-130). This matches post-pivot
   PRODUCT_ARCHITECTURE.md:724-726, but packages/billing/src/plans.ts imports
   PLANS/PLAN_LIMITS from @studio/config which does NOT export them
   (packages/config/src/index.ts = brand/env/errors/ids only) and its header
   comment cites the stale pre-pivot catalog ($30/$60/$120). When billing UI
   lands, landing prices, @studio/config catalog and packages/billing must be
   unified (owner: config/billing agents).
4. Unused-but-built primitives invite drift: command palette, toast, credit
   meter, ProjectCard, skeleton, RiskBadge (packages/ui) and system-states
   (OfflineState/PermissionState/UnsupportedGpuState) are all unwired; the
   three system states have zero importers (grep). M9's "every page has
   empty/loading/error/offline/permission states" cannot be met until routes
   compose them.
5. Stale docs mislead: docs/AGENTS.md still describes the pre-pivot PhotoCraft
   repo (vendor/photocraft, engine-patches, BUILD_PROMPT as law);
   docs/phases/phase-exit-audit.md + acceptance-matrix.md reference deleted
   artifacts (apps/gateway, engine-patches, photocraft-cli, demo-coffee,
   "web shell" fc6fac2 W1-K) - their UI-status rows do NOT describe current
   apps/web (rebuilt in W2-a, commit 58d8d2f). Use BUILD_PLAN.md + this file.
6. Scope of guard: proxy matcher covers only /w/:path*; every new (app) route
   group (projects, billing, settings) must be added or refactored to a layout
   matcher, or it will be public by default. Cookie-presence-only is safe only
   because the gateway revalidates - keep that invariant when adding data
   fetching.
7. Test blind spots: vitest.setup.ts globally mocks next/navigation (can hide
   routing bugs); no tests for proxy.ts, seo.ts, error.tsx; no Playwright, no
   axe, no breakpoint/visual QA anywhere (BUILD_PLAN M1.6/M3.8/M4.7/M9.7 all
   require it).
8. @studio/contracts + tsconfig paths for editor-bridge/db/billing/storage are
   pre-wired but unused; if package layouts move, web's tsconfig breaks
   silently (paths bypass node resolution).
