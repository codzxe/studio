# @studio/evals — golden-brief eval suite (promptfoo)

Evals are **CI for prompts** (spec §11.4): golden briefs asserting plan validity,
validator results, layer names, slot contents, tier cost and tool-call budgets on every
change to prompts, models, tools, templates or the critic — with a merge-blocking
regression gate. The suite lives here (`packages/evals` = promptfoo configs + briefs);
fixture assets/golden renders live in the repo-root `evals/fixtures/` (see its README).

## Layout

```
packages/evals/
  promptfoo.config.yaml   suite config: providers (mocked planner for CI), prompts pointer,
                          defaultTest (envelope schema + shared vars), tests, eval settings
  prompts/                promptfoo-facing STARTER mirrors of spec §23.1–§23.3
                          (template vars {{brief}}/{{snapshot}}/{{catalog}}/…).
                          The canonical, versioned prompts land in packages/agent/prompts
                          in Wave 6 — these files mirror them for eval use.
    planner.system.txt    §23.2 planner  (used by the W1 suite)
    executor.system.txt   §23.1 executor (joins the suite in W6)
    critic.system.txt     §23.3 critic    (joins the suite in W7 with renders)
  providers/
    mock-planner.mjs      deterministic CI provider: answers each brief with the case's
                          golden {plan, run} envelope — zero model calls, zero cost
  cases/                  golden briefs (YAML): §24.1–§24.4 verbatim seeds + 11 invented
  schemas/
    plan.schema.json      the {plan, run} envelope contract (§5.5/§23.2 + §24 trace fields);
                          the eval-binding copy is inlined in promptfoo.config.yaml — keep in sync
  scripts/
    eval-gate.mjs         suite pass-rate gate: exit 1 below threshold (§19 Phase 2: 0.85)
```

## The envelope contract

The mocked provider (and, from Wave 6, the real runtime wrapper) returns:

```
{ "plan": <§5.5 planner JSON>, "run": <run-outcome envelope> }
```

`run` carries the worker-side outcome: `status`, `credits_charged` (§5.2 exact: quick 1 /
standard 2 / complex 5), `tool_calls` (§5.2 caps: 6/12/24), `revisions`, `validator`
(§11.1 blockers/majors/minors or null), `layers` (§23.1 role names), `undo_entries`
(§1.5-10: one transaction per run), `rolled_back`/`reservation_released` (§5.6, §14.2),
`code`/`retryable`/`retry_grace` (§24.4). Every case asserts on both halves; the full
schema is enforced once in `defaultTest` (`is-json`), so a case's inline compact
`is-json` + javascript assertions stay short.

## Run locally

```bash
# once, from the repo root (this box never installs during agent waves — CI installs):
pnpm install

# deterministic suite — no LLM keys, no engine, no network (§21: deterministic tests):
pnpm --filter @studio/evals eval

# browse the local run matrix / scoreboard:
pnpm --filter @studio/evals eval:view
```

### Real-model runs (optional; local only)

CI always uses the deterministic mock. To try a real planner against the same cases:

```bash
ANTHROPIC_API_KEY=… pnpm --filter @studio/evals eval -- \
  --providers anthropic:claude-sonnet-5-5 --no-cache
```

**Hard rules (§1.5 constraint 6):** paid API keys only, from the §5.3 routing table
(Vertex AI / Anthropic / OpenAI / DeepSeek — see `.env.example` for the exact env vars).
**Never** free/training tiers (e.g. Gemini free tier) — eval fixtures are synthetic today,
but the rule holds regardless. No OpenRouter in production (AGENTS.md). Real-model
outputs must be wrapped by the runtime into the same `{plan, run}` envelope or the
assertions will reject them — that wrapper is Wave 6 work (`packages/agent`), at which
point the config gains an env-gated real provider row alongside the mock.

## CI + threshold policy

- `pnpm --filter @studio/evals eval:ci` = `promptfoo eval --no-cache --output results/eval.json`
  followed by `node scripts/eval-gate.mjs results/eval.json 0.85`.
- **Gate: suite pass-rate ≥ 0.85** (§19 Phase 2 exit: "eval suite ≥ 50 briefs with
  ≥ 85% pass"). Below threshold the gate exits 1 and the build is red — that is the
  §11.4 "block merge on regression beyond threshold" rule.
- Note for the CI owner (`.github/workflows/ci.yml` is not owned by this package): add
  `pnpm --filter @studio/evals eval:ci` as a step once Wave 6 wires the real planner;
  the mocked suite is green-by-construction today, so wiring it now is also fine.
- **Critic-drift human review (§21 evals row / §11.4):** sample 10 runs/week and score
  them with the §11.2 rubric; a monthly review compares human scores to the critic to
  detect drift and gaming. TODO(W7): critic eval cases + scoreboard page under `docs/`.

## Case map — §24 seeds and coverage (15 cases today)

| Case | Seed | Tier / credits (§5.2) | Intent |
|---|---|---|---|
| `coffee-promo-standard` | **§24.1 verbatim** | standard / 2 | create_post (template path) |
| `chat-edit-subhead-badge` | **§24.2 verbatim** | quick / 1 | edit_layers (chat edit) |
| `freeform-announcement-complex` | **§24.3 verbatim** | complex / 5 | create_post (freeform, template=null) |
| `refund-image-provider-failure` | **§24.4** | standard / 0 charged | edit_layers (failed run, retry_grace=1) |
| `clarify-ambiguous-platform` | invented | quick / 1 | create_post (ask_user first, §23.2) |
| `injection-guard-flatten` | invented | quick / 1 | edit_layers (§5.7 stance, no destructive tools) |
| `quick-swap-headline` | invented | quick / 1 | edit_layers (text swap) |
| `palette-warm-up` | invented | quick / 1 | edit_layers (brand-token recolour) |
| `recolor-brand-tokens` | invented | quick / 1 | edit_layers (restyle + shadow removal) |
| `logo-swap` | invented | quick / 1 | edit_layers (asset-id discipline) |
| `template-swap-flyer` | invented | standard / 2 | edit_layers (template reapply) |
| `resize-story` | invented | quick / 1 | resize |
| `variant-three-sizes` | invented | standard / 2 | variant |
| `export-bundle-png-pcraft` | invented | quick / 1 | export |
| `budget-cap-complex-carousel` | invented | complex / 5 | create_post (24-call budget discipline) |

Every case asserts: `plan_valid` (schema), intent match, template chosen when expected,
tier cost exact per §5.2, expected checks present, max tool calls respected — plus
validator results and layer/slot assertions where the seed demands them. **Render
similarity (SSIM/DISTS vs golden renders, §11.4) is TODO Wave 7** — deliberately no
fuzzy image assertions in this scaffold.

**Growth plan (§19 Phase 2 gate):** 15 seeds now → ≥50 before Phase 2 exit (add
thumbnail, slide, invitation and simple-ad briefs per §11.4; a batch of non-English
briefs; more failure paths). Copy an existing case file, keep the assertion categories.

## Hardening notes (pinned promptfoo ^0.103)

This scaffold was authored offline (no installs on agent boxes, per AGENTS.md). Three
promptfoo behaviors should be confirmed on the first CI run and hardened if needed:

1. **`javascript` assertion style** — every value is a single `return (<expression>)`
   statement (multi-value checks use an inline IIFE, e.g.
   `return ((v) => v.ok === true && v.blockers === 0)(JSON.parse(output).run.validator)`).
   If the pin treats values as bare expressions (docs' table example
   `output.length > 10 ? 1.0 : 0.0`), strip the leading `return ` across `cases/`
   (`sed -i 's/\\breturn (/(/' cases/*.yaml`) — the remaining IIFE is a valid
   expression, so nothing else changes.
2. **Provider loading** — `file://providers/mock-planner.mjs` with a named `callApi`
   export plus a default object. If the pin expects a different export shape, adjust
   the export in that one file.
3. **`is-json` inline `validate`** — the envelope schema is inlined in `defaultTest`
   (and a compact per-case copy in every case) so no file-path resolution is involved;
   the standalone `schemas/plan.schema.json` is the human/codegen mirror — keep in sync
   (TODO W6: extract both to one shared source).

## Fleet flags (for Wave 6 / other owners)

- Tool-name style is inconsistent in the spec (`template_apply` in §23.2 vs
  `template.apply` in §5.5/§24 traces). Cases use the dotted §5.5 style; the tool
  registry (packages/tools) should canonicalize once and the prompts/cases follow.
- The run-outcome envelope (`run`) asserted here should be produced by the worker as a
  typed result (packages/agent + apps/worker contract, Wave 6) — the eval schema in
  `defaultTest` is the contract reference.
- Repair (§23.4) and chat-classifier (§23.5) starter prompts belong in
  `packages/agent/prompts` (Wave 6) and get promptfoo mirrors here when their evals land.
