import { MarketingPage, MarketingSection } from "@/components/marketing/marketing-page";
import { pageMetadata } from "@/lib/seo";
import { Brand } from "@studio/config";

export const metadata = pageMetadata({
  title: "Changelog",
  description: `Every notable change to ${Brand.productName}, newest first — the engineering record of the beta, lightly edited for public reading.`,
  path: "/changelog",
});

/**
 * /changelog — renders the REAL repository changelog (M9-E, AUD-5). The entry
 * below is the engineering record from CHANGELOG.md ([0.1.0-beta.0] —
 * 2026-10-21), reproduced faithfully with two public-reading edits:
 * internal codenames are generalised per the naming policy (ADR-0006) and
 * the pre-pivot domain word is mapped to today's "projects" vocabulary.
 * NOTHING is added; no future entries exist until the work ships.
 */

/** §14 date format: ISO → "Oct 21, 2026". */
function formatReleaseDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface ReleaseSection {
  readonly title: string;
  readonly entries: readonly string[];
}

interface Release {
  readonly version: string;
  readonly date: string;
  readonly summary: readonly string[];
  readonly sections: readonly ReleaseSection[];
}

/** The repo's real changelog content (see the module header). */
const RELEASES: readonly Release[] = [
  {
    version: "0.1.0-beta.0",
    date: "2026-10-21",
    summary: [
      "First beta baseline of the studio SaaS: an agent-first, template-driven design editor built as a pnpm + Turborepo monorepo around a shallow-cloned open-source Rust engine (pinned 872748fb, ADR-0001; additions live in engine-patches/ as upstreamable new modules — never in-place vendor edits).",
      "This cut aggregates 147 commits from the parallel build waves W0–W10. Highlights are curated by wave below; see Known Limitations for what still required CI enablement and a live environment at that date.",
    ],
    sections: [
      {
        title: "Added — Foundations (W0–W1)",
        entries: [
          "Monorepo shell: pnpm workspaces + Turborepo, TypeScript strict + ESM, Biome, shared tsconfig base; ADR-0001 engine pin + attribution; ADRs 0002–0005 (env matrix, engine transport, etc.); agent-fleet git-sync protocol.",
          "Service skeletons: gateway (Hono app, middleware, health, error mapping), worker (BullMQ queues, injectable processors, graceful shutdown), engine-pool (session registry, token allocation, watchdog, injectable spawner).",
          "Data model: three Drizzle schemas — content (projects, versions, command-log WAL, assets, comments), billing (append-only ledger, reservations, plans, subscriptions, idempotency, audit log), runs (agent runs/steps/events with idempotency keys + monotonic seq); db client, seed, forward-only migration docs.",
          "Billing domain: idempotent reserve/commit/refund ledger, plans, retry grace.",
          "Agent core: run state machine, plan schema, event types, budgets, model routes.",
          "Tools kit: defineTool, ToolContext, registry, contract enforcement.",
          "UI kit (tokens, button/input/dialog/panel/tabs/badge/skeleton/tooltip) and web shell (Next.js layout, gateway client, SSE helper).",
          "Infra baseline: compose stack, TLS reverse-proxy config, backup/restore/deploy scripts; runbooks RB-01..08; licences texts, licence checker + manifest, font/secret scan; CI definitions (staged — see Known Limitations).",
        ],
      },
      {
        title: "Added — Engine integration (W2)",
        entries: [
          "Engine transport: TCP framing, auth-first connection, correlation ids, reconnect.",
          "Engine auth: 256-bit session tokens, capability roots, reply budgets.",
          "Typed protocol layer mirroring the vendored engine's rpc surface (project, batch and jobs methods) plus a commands registry and engine-client barrel.",
          "A spawner for the engine's serve CLI per the upstream contract: readiness, cleanup.",
          "Durability: checkpoint/attach/health (WAL replay decisions, idle saves, health probes); WAL cursor + recovery coordinator — resume-once, fail-clean.",
          "Protocol-faithful mock engine with fault hooks; Phase-0 spine: mock E2E + crash recovery + demo script.",
          "Storage package: S3/R2 + local drivers, key space, presigning.",
          "Upload validation: magic-byte sniff, dimension parsing, EXIF strip planning, polyglot guards.",
          "Preview pipeline + export job processor (native format/png/jpg; PSD experimental).",
          "Durable run event bus: monotonic seq, backfill + live, redaction at the sink.",
        ],
      },
      {
        title: "Added — Engine patches (W2–W3, ADR-0001 policy)",
        entries: [
          "Scaffolding: one-dir-per-module layout mirroring the engine crate, per-module READMEs with golden-rules checklists, pin-exact apply script (--check dry-run, already-applied detection, refuses on pin mismatch).",
          "agent_cmds: begin/commit/rollback transactions with single-undo.",
          "template_cmds: manifest types + list/inspect/apply; layout_cmds parent module + specs aggregator; a layer-level diff command (add/remove/change/move); template.validate + fill_specs registration.",
          "Registration patch refresh + panic-hunt obligation table; golden-rules review of all patches with violations fixed.",
          "New-command docs + upstream PR guide: one PR per module, stacking order, merge-blocker checklist, parity regeneration.",
        ],
      },
      {
        title: "Added — Gateway (W4, W10-G)",
        entries: [
          "Auth-context + request-context middleware, role gate, correlation ids.",
          "RBAC roles/permissions matrix + cross-tenant guard.",
          "Rate limiter (Valkey seam) + per-tier upload/run caps middleware.",
          "Runs API: reserve → queue → idempotent create, status, cancel.",
          "SSE run events: backfill + live + resume + resync.",
          "Credits + usage routes: ledger pages, daily rollups; exports enqueue + cached previews; manual command exec (allowlisted) + undo/redo routes + WAL.",
          "Catalog routes + service (template/component manifests).",
          "Deep health probes + append-only, redacted audit service (degraded vs down, cursor pages).",
          "OpenAPI 3.1 spec, final audit: 47 endpoints inventoried (21 mounted / 19 awaiting-mount / 3 partial / 4 not-implemented) with contract doc + test gate.",
        ],
      },
      {
        title: "Added — Tools (W5)",
        entries: [
          "Tool suite: workspace_snapshot (compact one-call context), template_apply (apply contract, pin schema, engine error mapping, idempotency), style_apply (7 styles + adjustments), text_set (create/rewrite with fitText), layer_ops (7 ops mapped to engine commands), component_set_vars (opt-in updates), component_list + component_place (52-test suite), render_preview (≤1024px model-facing), a deterministic project-validation lint tool, ask_user, variant_create (comps/data sets/sizes/languages).",
          "Default tool registry + tools barrel; tool contract + coverage docs.",
          "TextMeasurer implementation bridging fit_text ↔ layout_apply.",
        ],
      },
      {
        title: "Added — Agent runtime (W6–W7)",
        entries: [
          "Executor loop: tool walk, budgets, deviation tracking, clean stop.",
          "Run state machine + cooperative cancellation; run validator service + pipeline gate.",
          "Transaction manager: begin/commit/rollback + WAL + checkpoints.",
          "Observer: stable, cacheable context assembly + deltas.",
          "Critic service with 2-cycle repair gate; repair planner (narrow fixes).",
          "Model router: tier routing, circuit breakers, failover; budget factory + partial-charge settlement.",
          "Injection guards + tool call gate; worker recovery wiring (replay, resume-once, retry glue).",
          "Chat-edit classifier: cheapest-action routing.",
          "Demo aliases — end-to-end Phase-0 demo vs mock engine, 4 artifacts + determinism assert.",
        ],
      },
      {
        title: "Added — Templates & evals (W3, W7)",
        entries: [
          "Seed templates: instagram@3 (verbatim), youtube-thumbnail@1, presentation-slide@1; 10 component manifests (badge/logo/rating/price/button/quote/avatar/divider/ribbon/handle).",
          "Digital template set ×4 (email/hero/blog/quote) + print set ×4 (flyer/poster/card/menu); +12 template happy-path briefs (suite 15 → 67 cases).",
          "Brand tokens service: palette/fonts/logo + fallbacks; template authoring guide (manifest field table, catalog validation, thumbnails, versioning, registry).",
          "Synthetic fixture generator (12 specs → PNGs + golden stub).",
          "Golden briefs expanded to 55 cases: component coverage, intent matrix, freeform, injection ×2, budget, clarify, quick-edits ×6.",
          "Chat-edit eval set ×20 behind a 0.90 curated gate; eval config wiring: full-suite (0.85) + chat-edits (0.90) dual-gate runner with offline self-test.",
        ],
      },
      {
        title: "Added — Web app (W8)",
        entries: [
          "App shell: sidebar, topbar, dashboard.",
          "Marketing landing: hero with layers-panel mock + capture placeholder, proof strip, gallery/before-after, honest pricing, FAQ, security, changelog, CTA/footer.",
          "Billing pages: plans, credits, ledger, checkout + retry sync.",
          "Comments panel + canvas pins; undo/redo + export flows.",
          "API client reorg (core/endpoints/sse/hooks); i18n scaffold + a11y utilities; web unit tests (api, tiers, timeline).",
        ],
      },
      {
        title: "Added — Billing & observability (W9–W10)",
        entries: [
          "Billing completion: wiring audit, webhook idempotency harness, ledger bridge.",
          "Plan limits service: seats/sessions/canvas/runs gates.",
          "Metering: cost model, usage accumulator, daily attribution.",
          "Cost guardrails: daily caps, demo policy, provider killswitch.",
          "Observability: dashboards + alert rules wired to runbooks RB-01..08; compose observability profile + Prometheus config + reverse-proxy hardening; metrics auth (Basic).",
          "Coherent studio_ metric prefix across agent/worker/gateway emitters and dashboards; gateway /metrics mounted internal-only, fail-closed auth.",
          "Ledger hardening: concurrency + retry-grace + partial-clamp edge cases (70 new tests; billing suite 305/305); Phase-4 specs (credit expiry display, dunning ladder).",
        ],
      },
      {
        title: "Added — Infra & QA (W9–W10)",
        entries: [
          "5 multi-stage Dockerfiles (non-root, healthchecks) + per-app dockerignores + root .dockerignore; compose coherence (repo-root build contexts, engine bind-mount, image-tag interpolation).",
          "Deploy v2: deploy/rollback/migrate/smoke scripts + environments doc (three-env table, secret provisioning).",
          "Backup v2 + verify + quarterly restore-drill scripts; load + chaos drill scripts.",
          "Upload fuzzing: 39-attack corpus with pinned truth table, 888-mutant deterministic sweep.",
          "Acceptance matrix final (15 criteria: 7 evidenced-build / 8 build-only) + devlog totals + phase-exit audits.",
          "Front-door docs: README, repo map, contributing guide; licence manifest complete (56 rows, 0 to verify) + licence audit.",
        ],
      },
      {
        title: "Known Limitations",
        entries: [
          "CI workflows staged pending token scope: ci.yml, licence-check.yml and engine-patches.yml live in infra/ci-staged/; moving them to the live workflows directory required a PAT with workflow scope (human action). No CI run had gated this tree yet — the release checklist on the exact tag commit was the compensating gate.",
          "Runtime criteria needed a live environment: 8 of 15 acceptance criteria were build-only (compose up, real engine round-trip, kill-engine-mid-run wall clock, Stripe test mode, live-model eval thresholds).",
          "pnpm-lock generated on first install: the lockfile was not committed yet; CI installed with --no-frozen-lockfile (to be flipped once the lockfile landed).",
          "TypeScript sweep owed: one package re-exported types without export type (about 158 errors) plus scattered pre-existing errors — blocked the whole-package typecheck until swept.",
        ],
      },
      {
        title: "Security",
        entries: [
          "Trial-only, no free tier: the beta was trial-gated; no free LLM tiers processed customer data, paid providers only, and one bargain router was banned in production.",
          "Rate limits: per-tier upload/run caps + a Redis-seam limiter at the gateway; engine sessions were additionally bounded by capability roots, reply budgets and 256-bit tokens.",
          "Redaction: run/SSE events, audit logs and error envelopes were redacted by construction — no stack traces, absolute paths or internal ids crossed the API boundary; errors were typed result envelopes, never thrown strings.",
          "Upload hardening: magic-byte sniff, EXIF strip planning, polyglot/zip-bomb guards (60 MP ceiling), all fuzzed by a 39-case adversarial corpus with pinned verdicts.",
        ],
      },
    ],
  },
] as const;

/**
 * /changelog — the engineering record as an editorial page (M9-E): one
 * FrameLine per release (§2.3), entries faithful to CHANGELOG.md, and an
 * honest note about the light public-reading edits. No invented future
 * releases — when the repo changelog grows, this data grows with it.
 */
export default function ChangelogPage() {
  return (
    <MarketingPage
      testid="changelog-page"
      kicker={`${Brand.productName} — Changelog`}
      title="What changed, and when."
      intro="The engineering record of every notable change, newest first — edited only to generalise internal codenames. One release so far: the beta baseline."
    >
      {RELEASES.map((release, index) => (
        <MarketingSection
          key={release.version}
          label={`00:00:${String(index + 1).padStart(2, "0")} — RELEASE ${release.version}`}
        >
          <article
            data-testid={`changelog-release-${release.version}`}
            className="flex flex-col gap-8"
          >
            <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-4">
              <h2 className="font-display text-title-l tabular text-primary">{release.version}</h2>
              <p className="tabular text-mono text-muted">{formatReleaseDate(release.date)}</p>
            </header>
            {release.summary.map((paragraph) => (
              <p key={paragraph} className="max-w-[80ch] text-body leading-relaxed text-secondary">
                {paragraph}
              </p>
            ))}
            {release.sections.map((section) => (
              <section key={section.title} className="flex flex-col gap-3">
                <h3 className="text-label uppercase tracking-[0.06em] text-muted">
                  {section.title}
                </h3>
                <ul className="flex flex-col gap-2">
                  {section.entries.map((entry) => (
                    <li
                      key={entry}
                      className="flex max-w-[80ch] gap-3 text-body-s leading-relaxed text-secondary"
                    >
                      <span aria-hidden="true" className="mt-0.5 text-disabled">
                        —
                      </span>
                      <span>{entry}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </article>
        </MarketingSection>
      ))}

      <MarketingSection label="END — CHANGELOG">
        <p className="max-w-[68ch] text-body-s leading-relaxed text-secondary">
          This page mirrors the changelog kept at the repository root: internal codenames are
          generalised per the naming policy and a few engineering-only details are trimmed — nothing
          is added, and nothing ships here before it ships in the product.
        </p>
      </MarketingSection>
    </MarketingPage>
  );
}
