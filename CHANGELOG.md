# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dates are ISO 8601 (`YYYY-MM-DD`).

## [Unreleased]

### Changed

- Product pivot (ADR-0006, 2026-10-21): the product is an agentic
  motion-graphics SaaS built on the EffectCraft editor, vendored at `editor/`
  (pinned `9db7f3b2`, v0.13.0, per `editor/UPSTREAM.md`). The editor UI is
  frozen — the chat is an additive overlay, never a redesign — and the domain
  language is projects & compositions. The 0.1.0-beta.0 baseline below
  describes the pre-pivot product and stays for the historical record only:
  none of it (templates, PSD import, i18n, the `872748fb` engine pin) exists
  in this product.
- Post-pivot rebuild (in progress, unreleased): Better Auth workspaces with
  roles and invites, Drizzle + Postgres, projects/versions behind a
  single-writer edit lease, comments and presence, share links with show-once
  tokens, uploads and cloud renders through an append-only credit ledger,
  Stripe billing, and the agent chat — a curated tool surface routed through
  the self-hosted model gateway and compiled server-side into atomic
  `engine.batch` edits. Ships when it ships; no date is promised here.

### Removed

- Repo purge by user order (2026-10-23): deleted the tracked `archive/` tree (the
  pre-pivot PhotoCraft legacy code — preserved in git history), the `agent-ctx/`
  subagent handoff files and the regenerating `tool-results/` session scratch;
  `.gitignore` hardened so none of them can be committed again.

## [0.1.0-beta.0] — 2026-10-21

First beta baseline of the studio SaaS: an agent-first, template-driven design editor
built as a pnpm + Turborepo monorepo around a shallow-cloned open-source Rust engine
(pinned `872748fb`, ADR-0001; additions live in `engine-patches/` as upstreamable new
modules — never in-place vendor edits). This cut aggregates 147 commits from the
parallel build waves W0–W10. Highlights are curated by wave below; see
[Known Limitations](#known-limitations) for what still requires CI enablement and a
live environment.

### Added

#### Foundations (W0–W1)

- Monorepo shell: pnpm workspaces + Turborepo, TypeScript strict + ESM, Biome, shared
  tsconfig base; ADR-0001 engine pin + attribution; ADRs 0002–0005 (env matrix, engine
  transport, etc.); agent-fleet git-sync protocol.
- Service skeletons: gateway (Hono app, middleware, health, error mapping), worker
  (BullMQ queues, injectable processors, graceful shutdown), engine-pool (session
  registry, token allocation, watchdog, injectable spawner).
- Data model: three Drizzle schemas — content (documents, versions, command-log WAL,
  assets, comments), billing (append-only ledger, reservations, plans, subscriptions,
  idempotency, audit log), runs (agent_runs/steps/run_events with idempotency keys +
  monotonic seq); db client, seed, forward-only migration docs.
- Billing domain: idempotent reserve/commit/refund ledger, plans, retry grace.
- Agent core: run state machine, plan schema, event types, budgets, model routes.
- Tools kit: `defineTool`, ToolContext, registry, contract enforcement.
- UI kit (tokens, button/input/dialog/panel/tabs/badge/skeleton/tooltip) and web shell
  (Next.js layout, gateway client, SSE helper).
- Infra baseline: compose stack, TLS reverse-proxy config, backup/restore/deploy scripts;
  runbooks RB-01..08; LICENSES texts, license checker + manifest, font/secret scan;
  CI definitions (staged — see Known Limitations).

#### Engine integration (W2)

- Engine transport: TCP framing, auth-first connection, correlation ids, reconnect.
- Engine auth: 256-bit session tokens, capability roots, reply budgets.
- Typed protocol layer mirroring the vendored engine's `rpc.rs` (doc/engine/batch/jobs
  methods) plus a commands registry and engine-client barrel.
- `photocraft-serve` spawner per the upstream CLI contract: readiness, cleanup.
- Durability: checkpoint/attach/health (WAL replay decisions, idle saves, health
  probes); WAL cursor + recovery coordinator — resume-once, fail-clean.
- Protocol-faithful mock engine with fault hooks; Phase-0 spine: mock E2E + crash
  recovery + demo script.
- `@studio/storage`: S3/R2 + local drivers, key space, presigning.
- Upload validation: magic-byte sniff, dimension parsing, EXIF strip planning, polyglot
  guards.
- Preview pipeline + export job processor (native format/png/jpg; PSD experimental).
- Durable run event bus: monotonic seq, backfill + live, redaction at the sink.

#### Engine patches (W2–W3, ADR-0001 policy)

- Scaffolding: one-dir-per-module layout mirroring the engine crate, per-module READMEs
  with golden-rules checklists, pin-exact apply script (`--check` dry-run, already-applied
  detection, refuses on pin mismatch).
- `agent_cmds`: begin/commit/rollback transactions with single-undo.
- `template_cmds`: manifest types + list/inspect/apply; `layout_cmds` parent module +
  specs aggregator; `document.diff` (layer-level add/remove/change/move);
  `template.validate` + `fill_specs` registration.
- Registration patch refresh + panic-hunt obligation table; golden-rules review of all
  patches with violations fixed.
- New-command docs + upstream PR guide: one PR per module, stacking order,
  merge-blocker checklist, parity regeneration.

#### Gateway (W4, W10-G)

- Auth-context + request-context middleware, role gate, correlation ids.
- RBAC roles/permissions matrix + cross-tenant guard.
- Rate limiter (Valkey seam) + per-tier upload/run caps middleware.
- Runs API: reserve → queue → idempotent create, status, cancel.
- SSE run events: backfill + live + resume + resync.
- Credits + usage routes: ledger pages, daily rollups; exports enqueue + cached
  previews; manual command exec (allowlisted) + undo/redo routes + WAL.
- Catalog routes + service (template/component manifests).
- Deep health probes + append-only, redacted audit service (degraded vs down, cursor
  pages).
- OpenAPI 3.1 spec, final §13 audit: 47 endpoints inventoried (21 mounted /
  19 awaiting-mount / 3 partial / 4 not-implemented) with contract doc + test gate.

#### Tools (W5)

- Tool suite: `workspace_snapshot` (compact one-call context), `template_apply`
  (§7.4 apply contract, pin schema, engine error mapping, idempotency), `style_apply`
  (7 styles + adjustments), `text_set` (create/rewrite with fitText), `layer_ops`
  (7 ops mapped to engine commands), `component_set_vars` (opt-in updates),
  `component_list` + `component_place` (52-test suite), `render_preview` (≤1024px
  model-facing), `validate_document` (deterministic lint), `ask_user`, `variant_create`
  (comps/data sets/sizes/languages).
- Default tool registry + tools barrel; tool contract + coverage docs.
- TextMeasurer implementation bridging `fit_text` ↔ `layout_apply`.

#### Agent runtime (W6–W7)

- Executor loop: tool walk, budgets, deviation tracking, clean stop.
- Run state machine + cooperative cancellation; run validator service + pipeline gate.
- Transaction manager: begin/commit/rollback + WAL + checkpoints.
- Observer: stable, cacheable context assembly + deltas.
- Critic service with 2-cycle repair gate; repair planner (narrow fixes, §23.4 rules).
- Model router: tier routing, circuit breakers, failover; budget factory +
  partial-charge settlement.
- Injection guards + tool call gate; worker recovery wiring (replay, resume-once,
  retry glue).
- Chat-edit classifier: cheapest-action routing.
- `demo:coffee` + `demo:spine` npm aliases — end-to-end Phase-0 demo vs mock engine,
  4 artifacts + determinism assert.

#### Templates & evals (W3, W7)

- Seed templates: `instagram@3` (verbatim), `youtube-thumbnail@1`,
  `presentation-slide@1`; 10 component manifests (badge/logo/rating/price/button/
  quote/avatar/divider/ribbon/handle).
- Digital template set ×4 (email/hero/blog/quote) + print set ×4 (flyer/poster/card/
  menu); +12 template happy-path briefs (suite 15 → 67 cases).
- Brand tokens service: palette/fonts/logo + fallbacks; template authoring guide
  (manifest field table, catalog validation, thumbnails, versioning, registry).
- Synthetic fixture generator (12 specs → PNGs + golden stub).
- Golden briefs expanded to 55 cases: component coverage, intent matrix, freeform,
  injection ×2, budget, clarify, quick-edits ×6.
- Chat-edit eval set ×20 behind a 0.90 curated gate; eval config wiring: full-suite
  (0.85) + chat-edits (0.90) dual-gate runner with offline self-test.

#### Web app (W8)

- App shell: sidebar, topbar, dashboard.
- Marketing landing: hero with layers-panel mock + capture placeholder, proof strip,
  gallery/before-after, honest pricing (§14 exact + truthfulness block), FAQ, security,
  changelog, CTA/footer.
- Billing pages: plans, credits, ledger, checkout + retry sync.
- Comments panel + canvas pins; undo/redo + export flows.
- API client reorg (core/endpoints/sse/hooks); i18n scaffold + a11y utilities; web unit
  tests (api, tiers, timeline).

#### Billing & observability (W9–W10)

- Billing completion: wiring audit, webhook idempotency harness, ledger bridge.
- Plan limits service: seats/sessions/canvas/runs gates.
- Metering: cost model, usage accumulator, daily attribution.
- Cost guardrails: daily caps, demo policy, provider killswitch.
- Observability: Grafana dashboards + alert rules wired to runbooks RB-01..08; compose
  obs profile + Prometheus config + Caddy hardening; metrics auth (Basic).
- Coherent `studio_` metric prefix across agent/worker/gateway emitters and
  dashboards; gateway `/metrics` mounted internal-only, fail-closed auth.
- Ledger hardening: concurrency + retry-grace + partial-clamp edge cases (70 new
  tests; billing suite 305/305); Phase-4 specs (credit expiry display, dunning ladder).

#### Infra & QA (W9–W10)

- 5 multi-stage Dockerfiles (non-root, healthchecks) + per-app dockerignores + root
  `.dockerignore`; compose coherence (repo-root build contexts, engine bind-mount,
  `${IMAGE_TAG}` interpolation).
- Deploy v2: deploy/rollback/migrate/smoke scripts + environments doc (three-env
  table, secret provisioning).
- Backup v2 + verify + quarterly restore-drill scripts; load + chaos drill scripts.
- Upload fuzzing: 39-attack corpus with pinned truth table, 888-mutant deterministic
  sweep, §21 coverage matrix.
- Acceptance matrix final (15 §20 criteria: 7 evidenced-build / 8 build-only) + devlog
  totals + phase-exit audits.
- Front-door docs: README, repo map, CONTRIBUTING; license manifest complete
  (56 rows, 0 TODO-verify) + §16 license audit.

### Known Limitations

- **CI workflows staged pending token scope**: `ci.yml`, `license-check.yml` and
  `engine-patches.yml` live in `infra/ci-staged/`; moving them to `.github/workflows/`
  requires a PAT with `workflow` scope (human action). No CI run has gated this tree
  yet — the release checklist on the exact tag commit is the compensating gate.
- **Runtime criteria need a live environment**: 8 of 15 §20 acceptance criteria are
  build-only (compose up, real engine round-trip, kill-engine-mid-run wall clock,
  Stripe test mode, live-model eval thresholds). Exact live commands are listed per
  row in `docs/phases/acceptance-matrix.md`.
- **pnpm-lock generated on first install**: `pnpm-lock.yaml` is not committed; CI
  installs with `--no-frozen-lockfile` (to be flipped once the lockfile lands).
- **TS1205 sweep owed**: `packages/tools/src/index.ts` re-exports types without
  `export type` under `verbatimModuleSyntax` (~158 errors), plus scattered pre-existing
  tsc errors in tools/agent files — blocks whole-package typecheck until swept.

### Security

- **Trial-only, no free tier**: beta is trial-gated; no free LLM tiers process
  customer data (§1.5), paid providers only, and OpenRouter is banned in production.
- **Rate limits**: per-tier upload/run caps + Valkey-seam limiter at the gateway;
  engine sessions are additionally bounded by capability roots, reply budgets and
  256-bit tokens.
- **Redaction**: run/SSE events, audit logs and error envelopes are redacted by
  construction — no stack traces, absolute paths or internal ids cross the API
  boundary; errors are typed result envelopes, never thrown strings.
- **Upload hardening**: magic-byte sniff, EXIF strip planning, polyglot/zip-bomb
  guards (60 MP ceiling), all fuzzed by a 39-case adversarial corpus with pinned
  verdicts.

<!-- Link references for release compare URLs are added when the GitHub remote
     owner/org is finalized; tags are created by the release captain. -->
