# evals/ — golden agent prompts + scoring harness (BUILD_PLAN §7.2)

The §7.2 evals layer for the Studio agent: a corpus of **40 golden prompts**
(`prompts/manifest.json`) covering every §7.2 category plus six hardening
extras, and a **scoring harness** (`harness/`) with one stub per §7.2 scoring
dimension. The harness's schema-integrity suite runs green on-box with **zero
new dependencies** (vitest resolves from the repo root; vocabulary is
drift-checked against the real `@studio/contracts` sources via read-only
relative imports).

This directory is deliberately **NOT a pnpm workspace package**
(`pnpm-workspace.yaml` globs `apps/*`, `services/*`, `packages/*`), so
`turbo run test`, root `pnpm test` and root `pnpm install` are unaffected.

## How to run

```bash
# from this directory (corepack pnpm resolves vitest from the repo root):
cd evals
corepack pnpm exec vitest run            # hermetic: 20 schema-integrity tests, ~1s
corepack pnpm exec tsc --noEmit          # typecheck (strict) — optional hygiene
corepack pnpm test                       # same as `vitest run` (package.json script)

# live-model scoring — NOT wired yet (see "Current state"):
EVALS_LIVE=1 corepack pnpm exec vitest run
```

The hermetic suite never touches the network, a database, or a model. The
live path is skip-guarded behind `EVALS_LIVE=1` and requires a deployed
LiteLLM gateway (`MOCK_MODEL=false`, `LITELLM_BASE_URL` reachable — see
`docker-compose.litellm.yml` at the repo root).

## The corpus — `prompts/manifest.json`

One manifest, one entry per prompt, schema pinned by
`harness/manifest.test.ts`. Each entry carries:

| Field | Meaning |
|---|---|
| `id` | Unique `ev-NNN-kebab-case`. |
| `category` | One of 16 (the 10 §7.2 categories + 6 extras). |
| `prompt` | The user message, verbatim. |
| `expectedBehavior` | Golden outcome: `type` (`plan`/`clarify`/`confirm`/`explain`/`refuse`/`reject`/`contain`) + human-readable assertion + `expectedTools` (curated write tools, any-of) + `forbiddenTools` + `mayUseTools` (reads). |
| `risk` | Expected plan-card risk **after the server-side recompute** (tool/command floors + `estimateCredits`), never the model's self-declaration. |
| `requiresConfirmation` | `true` ⇒ the plan card gates on explicit approval. Always `true` for `risk: "high"`. |
| `fixtures` | The editor snapshot to stage: `project`, `activeComp`, `layers` (name+type+detail), `selection`, `playheadSeconds`, `creditBalance`. |

### Coverage (40 prompts)

| Category | §7.2? | Count | Golden flavor |
|---|---|---|---|
| `create-title-comp` | ✔ | 3 | create_composition + create_text (bg color, fps honored) |
| `animate-transform` | ✔ | 4 | set_keyframes scale/position/opacity w/ exact timings |
| `effect-add-tune` | ✔ | 3 | add_effect + set_properties on effect params, scope discipline |
| `brand-colors` | ✔ | 3 | set_properties across named layers (multi-value palettes) |
| `reorganize-rename` | ✔ | 2 | rename via set_properties path "name"; **z-order = explain** (no arrange tool) |
| `lower-third` | ✔ | 3 | create_text + slide-in keys; style matching; tuning |
| `camera-3d` | ✔ | 2 | z-position parallax (within engine support); **camera tool = explain** |
| `ambiguous-clarify` | ✔ | 3 | exactly ONE clarifying question, no speculative plan |
| `destructive-confirm` | ✔ | 3 | confirm + scope enumeration; delete = confirm **and** explain |
| `impossible-explain` | ✔ | 3 | export/8K, audio, bulk retime → explain, never hallucinate |
| `multi-layer-edit` | extra | 2 | N layers × M properties cross-product; named multi-layer preset |
| `keyframe-precision` | extra | 2 | frame→seconds conversion (§5.4), exact key times/holds |
| `undo-after-apply` | extra | 2 | undo_run (no args, law #6); undo + save_version annotation |
| `credits-refusal` | extra | 2 | balance 0 / below reserve (1.5 est × 1.2 = 1.8) → refuse, no plan |
| `oversized-plan` | extra | 1 | 200-layer grid → ≤20-step batches or reject (>100 cmds = fatal) |
| `injection-defense` | extra | 2 | adversarial layer names / payload-as-text: data, not instructions (§8.3) |

By golden type: 24 `plan` · 5 `explain` · 3 `clarify` · 3 `confirm` ·
2 `refuse` · 1 `reject` · 2 `contain`. Risk tiers: 28 low · 9 medium ·
3 high (all high ⇒ confirmation).

### Vocabulary (drift-checked, not frozen)

`expectedTools`/`forbiddenTools`/`mayUseTools` are validated against the
**real** contracts in `harness/manifest.ts`:

- tool ids ← `packages/contracts/src/tools.ts` `TOOL_IDS` (5 read + 8 write)
- write tools ← `packages/contracts/src/write-tools.ts` `WRITE_TOOL_IDS` (wire form `studio.*`)
- intents/risks ← `packages/contracts/src/edit-plan.ts` (§8.6)
- credit math ← `estimateCredits` / `reserveFor` (§8.8: 1-step low-risk plan = 1.5 credits, 1.8 reserved)

"Premise guards" in the suite pin the facts the `explain`/`refuse` entries
depend on (no camera/arrange/delete write tool exists; minimum plan cost), so
the day the curated surface widens, the corpus is re-authored instead of
rotting silently.

## Scoring rubric — the six §7.2 dimensions (`harness/score.ts`)

| Dimension | Stub checks | Target |
|---|---|---|
| **plan validity** | plan event emitted + `EDIT_PLAN_SCHEMA`-valid + compiled (no fatal) + semantically golden vs `expectedBehavior` | **≥ 90%** |
| **apply success** | the approved plan applies atomically (every compiled command in the batch succeeds; no partial edits) | **≥ 95% on valid plans** |
| **visual sanity** | rendered frame (`studio.render_preview`) matches the golden expectation (frame compare) | tracked (no hard target yet) |
| **undo success** | ONE undo step reverts the whole applied run (law #6: one apply = one batch = one undo step = one version) | tracked |
| **credits accuracy** | charged credits == server estimate ± 0.01 (§8.8; refuse-path runs charge nothing) | tracked |
| **latency** | chat first token ≤ 1500 ms; plan validation ≤ 100 ms (§6 budgets, p75) | tracked |

Not-applicable dimensions score `null` and drop out of the aggregate
(a refusal has no apply/undo; a clarify has no credits). The apply-rate
denominator is **valid plans only** (§7.2: "apply success on valid plans").

`scoreRun` / `aggregate` are pure functions over an `ObservedRun` transcript
(plan event, apply result, frame compare, undo result, credit delta,
timings) — see `harness/score.ts` for the shape a live transport must fill.

## Current state (honest)

- **Runs green on-box:** the 20-test schema-integrity suite — manifest
  parses, ids unique + well-formed, ≥30 prompts, all 10 §7.2 categories
  covered (+ extras all used), tool references resolve against the real
  contracts, write/read tool classes respected, risk-high ⇒ confirmation,
  fixture selections reference staged layers, premise guards hold, scoring
  stubs behave on synthetic transcripts, live runner skip-guard works.
- **Owed: live-model runs.** `runLiveSuite()` is a skeleton behind
  `EVALS_LIVE=1` and throws a typed not-implemented for the transport. The
  wiring (chat SSE → plan-event capture → compile → apply → frame compare →
  undo → credit ledger, per prompt, feeding `ObservedRun` + `aggregate`)
  requires a deployed LiteLLM gateway; the chat-loop harness technique in
  `services/gateway/tests/chat-loop.test.ts` (scripted fake OpenAI SSE) is
  the template, and the 12 gateway golden fixtures
  (`services/gateway/tests/golden-plans.ts`) already pin compiled-command
  goldens for a dozen prompts — the live corpus deliberately overlaps
  gp-05/gp-09/gp-11/gp-12 phrasing so the two suites can share expectations.
- **Visual sanity** needs golden frames per fixture; nothing staged yet.

## Adding a prompt

Append an entry to `prompts/manifest.json` (id `ev-NNN-…`, next free
number; pick a category or add one to `harness/types.ts` if it is a NEW
category — then update `ALL_CATEGORIES`). Run
`corepack pnpm exec vitest run` from `evals/`; the integrity suite will
complain about anything malformed. Keep prompts in real user phrasing and
put every assertion detail in `expectedBehavior.description` — that string
is what the live scorer implements.
