# @studio/evals — Final Review (W10-P)

Final audit of the golden-brief eval program against the §19 Phase 2 exit gates
and the §21 "Evals" row. Evidence collected on-box: every case file parsed
(PyYAML duplicate-key-safe loader), per-case intent/tier/template/status
extracted from the golden fixtures, registry inventories globed from
`evals/templates/` + `evals/components/`, gate script read in full and executed
(`--dry`, plus a negative wiring test), and the new classifier gate loop
simulated offline end-to-end (20/20). No installs, no network, no model calls,
vendor untouched.

Spec refs: §19 Phase 2 exit ("eval suite ≥ 50 briefs with ≥ 85% pass; chat edits
correct ≥ 90% on the curated set"), §21 Testing-and-evals table, §11.4 (evals are
CI for prompts; block merge on regression), §1.5 constraint 6 (no free/training
LLM tiers), §5.2 (tier budgets), §14.1 (tier credits), §23.2/§23.5 (planner /
chat-edit classifier contracts), §24.1–§24.4 (seed scenarios).

---

## 1. Brief count — §19 "≥ 50 briefs" bar

| Set | Files | Briefs | Config / gate |
|---|---|---|---|
| Wave-1 seeds (`cases/*.yaml`) | 4 | 15 (creates 4, edits 6, operations 3, failures 2) | suite |
| W7-D expanded (`cases/expanded/*.yaml`) | 8 | 52 (creates 14, templates 12, edits 8, operations 10, freeform 2, clarify 2, injection 2, budget 2) | suite |
| **Suite total (GATE 1)** | **12** | **67** | `promptfoo.config.yaml`, ≥ 0.85 |
| Curated planner chat edits | 2 | 14 (`cases/edits.yaml` 6 + `cases/expanded/edits.yaml` 8) | `chat-edits.config.yaml`, ≥ 0.90 |
| §23.5 classifier curated set (`cases/chat-edits/`) | 5 | 20 (quick-edits 6, composites 4, clarify 4, reapply 3, downgrades 3) | `promptfoo.chat-edit.config.yaml`, ≥ 0.90 |
| **Graded briefs total** | **19** | **87** (67 + 20; the 14 chat briefs re-run a suite subset) | |

**Verdict: the ≥ 50 bar is CLEARED by the suite alone (67 ≥ 50)** — 2 briefs are
§24.1–§24.4 verbatim seeds, 13 invented Wave-1 cases, 52 expanded, 20 classifier
cases. §11.4's longer-term 200-brief ambition remains open (documented, not a
gate).

## 2. Coverage map

### 2.1 Intent × tier matrix (67 suite briefs)

Parsed from each case's golden `plan` fixture (`intent`, `model_tier`):

| Intent | quick | standard | complex | Σ |
|---|---|---|---|---|
| create_post | 2 | 28 | 6 | 36 |
| edit_layers | 13 | 4 | — | 17 |
| resize | 3 | 1 | — | 4 |
| variant | 1 | 5 | — | 6 |
| export | 4 | — | — | 4 |
| **Σ** | **24** | **37** | **6** | **67** |

All five §5.5 intent enum values are covered; all three tiers appear (tier
pricing asserted per §5.2/§14.1 in every case: quick 1 / standard 2 / complex 5).
Status coverage: 64 `succeeded` + 2 `succeeded_with_warnings` (budget clean
stops) + 1 `failed` (§24.4 provider failure → refund, retry_grace=1). The
§23.5 classifier set deliberately has no complex-tier case (a >12-call "chat
edit" is a regeneration, §23.5 forbids): 17 quick + 3 standard across its 20.

### 2.2 Template coverage — 15/16 have a happy path

16 template manifests exist at `evals/templates/`. Happy `create_post` case per
template:

| Template | Happy case | Other cases |
|---|---|---|
| instagram-post@3 | `coffee-promo-standard` (§24.1 verbatim) | 20+ across creates/edits/operations/injection/budget |
| youtube-thumbnail@1 | `create-thumb-yt-episode` | recipe-easy, deal-price, freeform ×2 references, ops |
| presentation-slide@1 | `create-slide-quarterly-results` | webinar-cta, keynote-quote, variant-sizes-slide-3, ops |
| event-flyer@1 | `create-event-flyer` | classifier set ×4 |
| business-card@1 | `create-business-card` | classifier set ×4 |
| facebook-cover@1 | `create-facebook-cover` | classifier trap `ce-trap-rebrand-cover` |
| blog-cover@1 / email-header@1 / instagram-story@1 / linkedin-banner@1 / pinterest-pin@1 / presentation-quote@1 / product-poster@1 / web-hero-banner@1 / x-post@1 | one happy path each in `cases/expanded/templates.yaml` | ops/classifier references |
| **cafe-menu@1** | **NONE — GAP-1** | none |

**GAP-1 (open):** `evals/templates/cafe-menu@1/manifest.json` exists but has ZERO
eval cases. `cases/expanded/templates.yaml` carries a W7-D note ("empty dir at
authoring time; add its happy path here when the manifest lands") — it has
landed; nobody added the case. Next action for the next case author: copy the
`create-event-flyer` recipe, pin cafe-menu@1's real slots/layerMap, register it
in `templates.yaml` (already in the suite config — no config change needed).

### 2.3 Component coverage — 10/10 appear

All ten components shipped in `evals/components/` appear in at least one golden:
offer-badge@2 (heavily: §24.2 badge, templates happy paths, classifier cases),
avatar-circle@1, button-cta@1, logo-lockup@1, price-tag@1, quote-block@1,
ribbon-banner@1, social-handle@1, star-rating@1, wave-divider@1 (expanded
creates/edits/budget/injection + templates happy paths). Two notes:

- `qr-code@1` appears ONLY inside a `templates.yaml` negative assert ("the
  unfilled optional slot is never placed") and **does not exist on disk** — a
  registry gap flagged since W7-B, outside evals ownership. Phase 2 targets 15
  components; 10 are shipped (registry gap, not an evals gap).
- Wave-1 seed cases use synthetic SNAPSHOT catalogs containing ids that are NOT
  in the shipped registry: `carousel-launch@1`, `divider@1`, `icon-bullet@1`
  (template/components) and `event-flyer@3` (disk pin is `@1`). Deterministic CI
  is unaffected (the mock echoes goldens), but **real-model wiring must
  regenerate SNAPSHOT/CATALOG vars from the live registry** (GAP-2, owner: the
  Wave-6 real-provider wrapper) or the planner will be shown a fictional catalog.

### 2.4 Required-risk coverage — present ✓

- **Prompt injection (§5.7 sanitize-not-block):** 3 suite cases —
  `injection-guard-flatten` (Wave-1 seed: brief asks to flatten, plan must not
  use destructive tools), `injection-headline-as-data`,
  `injection-tool-syntax-in-label` (payloads ride user content as data).
- **Budget (§5.2):** 3 dedicated cases — `budget-cap-complex-carousel` (24-call
  cap discipline), `budget-stop-complex-carousel` and
  `budget-stop-standard-icons` (clean stops, `succeeded_with_warnings`, partial
  credits, cut named for the user) — plus the envelope schema caps
  (`tool_calls ≤ 24`, `revisions ≤ 3`, credits ≤ 20) asserted on every case and
  per-case tool-call pins (`≤ 12` standard).
- **Clarify (§23.2 ask_user-first):** 2 suite (`clarify-ambiguous-platform`,
  `clarify-product-choice`, `clarify-contradictory-canvas`) + 4 classifier
  clarify cases (candidates = real layers, ONE question ≤ 300 chars).
- **Freeform (§24.3, template=null):** 3 complex cases
  (`freeform-announcement-complex`, `freeform-gig-poster`, `freeform-quote-card`).
- **Failure/refund (§24.4):** `refund-image-provider-failure` (failed run, 0
  charged, reservation released, retry_grace=1).
- **Non-English briefs:** `create-de-post-kaffee`, `variant-languages-de-fr-es`,
  `variant-dark-jp`.
- **Tier-inflation traps:** 3 classifier downgrade cases pin exact target sets +
  resolved quick tier (raw-proposal providers fail them — teeth for the guard).

## 3. Gate config verification (thresholds 0.85 / 0.90)

Thresholds live in `scripts/eval-gate.mjs` as §19 law:
`SUITE_THRESHOLD_DEFAULT = 0.85`, `CHAT_THRESHOLD_DEFAULT = 0.9`,
`CLASSIFIER_THRESHOLD_DEFAULT = 0.9` (CLI-overridable for local experiments
only). One promptfoo eval emits one pass rate, so one config per gate; the
script reads all results files and exits with the strictest failure (0/1/2).

| Config | tests: entries | Briefs | Threshold | Wiring check |
|---|---|---|---|---|
| `promptfoo.config.yaml` | 12 files = everything in `cases/` + `cases/expanded/` | 67 | 0.85 (`--suite`) | ✓ complete, no orphans |
| `chat-edits.config.yaml` | 2 files (`cases/edits.yaml`, `cases/expanded/edits.yaml`) | 14 | 0.90 (`--chat`) | ✓ subset of suite |
| `promptfoo.chat-edit.config.yaml` | 5 files = everything in `cases/chat-edits/` | 20 | 0.90 (`--classifier`) | ✓ complete, no orphans |

**Finding (fixed this pass):** the five `cases/chat-edits/*.yaml` files (20
briefs, W7-H) were on disk but registered in NO config — W7-H flagged the
registration for the evals owner and it never landed. This review registered
them via the pinned recipe (a dedicated config, because the §23.5 output
contract intentionally violates the suite's `{plan, run}` defaultTest —
appending them to an existing config would have failed every classifier case
and broken both gates), and closed the eval-gate blind spot (its wiring check
previously did not scan `cases/chat-edits/` at all, which is exactly why this
gap survived).

**`--dry` self-check (post-fix, exit 0):** 23/23 checks ok, including the
boundary math at the real set sizes (57/67 ≥ 0.85 passes, 56/67 fails;
13/14 ≥ 0.90 passes, 12/14 fails; 18/20 ≥ 0.90 passes, 17/20 fails) and:

```
eval-gate[config-sanity]: PASS — suite config registers 12 case files
  (12 on disk, none orphaned); chat gate registers 2 (subset of suite);
  classifier gate registers 5 of 5 on disk; all exist
```

Negative test performed: removing one registered file flips config-sanity to
FAIL (exit 1) and names the file. All three configs parse as clean YAML
(keys/tests/providers verified structurally). No broken YAML indentation was
found anywhere in `cases/` (all 17 case files parse under a duplicate-key-safe
loader; 87 case ids unique). Offline loop simulation of the new classifier
gate (prompt render → mock provider → per-case asserts): **20/20 pass**.

## 4. Determinism notes (§21 / §1.5-6)

- **Mock-planner contract** (`providers/mock-planner.mjs`, CI default for the
  suite + chat gates): answers each brief with the case's own golden
  `{plan, run}` envelope — zero model calls, zero cost (`cost: 0`), no engine
  process, no network. Loud guards: a case missing golden fixtures is an error,
  never a silent pass; `{{brief}}` must actually render into the prompt.
- **Mock-chat-edit contract** (`providers/mock-chat-edit.mjs`, CI default for
  the classifier gate): same pattern — echoes the golden §23.5 classification,
  guards the golden fixture + `{{userRequest}}` rendering.
- Consequences: the full three-gate pipeline is green-by-construction in CI
  **while the asserts hold the real contracts** (schema, intent, tier credits,
  caps, never-invented layers, resolved tier). The moment a real-model provider
  is wired, the SAME cases/asserts measure live quality. No real keys are ever
  needed in CI; no key material exists in this package.
- `evaluate.maxConcurrency: 4` in all three configs (2-CPU box, AGENTS.md);
  test data is synthetic per §21; nothing here trains on or ships customer
  content.

## 5. Human-review sampling plan (§21 / §11.4 — critic drift)

Pinned in `packages/evals/README.md` ("Critic-drift human review"): sample **10
runs/week**, score them with the same §11.2 rubric the critic uses; the
**monthly review compares human scores to critic verdicts** to detect drift
and gaming (a critic that passes everything would still look green to the
gates — the human sample is the backstop). Still TODO(W7): critic eval cases +
a scoreboard page under `docs/`; at Phase 2 exit the sampled-runs evidence must
exist alongside the 0.85/0.90 gate numbers (§20 criterion 14's "human-reviewed
sample confirms the critic is not gaming").

## 6. Real-model wiring notes (paid keys only — never free)

- **Policy (§1.5 constraint 6, AGENTS.md):** customer content must never flow
  through free/training LLM tiers (e.g. Gemini free tier). Real-model runs are
  opt-in, local-only, via CLI provider override; paid API keys only, from the
  §5.3 routing table (Vertex AI / Anthropic / OpenAI / DeepSeek); never
  OpenRouter in production; keys never committed (no key material in this
  package today). Eval fixtures are synthetic, but the rule is enforced by
  policy regardless.
- **Envelope requirement:** real outputs must be wrapped by the runtime into
  the same `{plan, run}` envelope or the suite/chat asserts reject them (W6
  wrapper, `packages/agent`). The classifier provider must emit the §23.5
  classification JSON itself with `cost_tier` = the RESOLVED tier
  (post-`resolveCostTier`) — that is what gives the downgrade traps their
  production-faithful teeth.
- **Prompt sync:** the promptfoo-facing prompt files are STARTER mirrors; before
  real-model runs the §23.5 mirror (`prompts/chat-edit-classifier.system.txt`)
  must be synced verbatim from `packages/agent/prompts/v1/chat-edit-classifier.md`
  (TODO noted in the file).

## 7. Fixes shipped in this pass

1. `promptfoo.chat-edit.config.yaml` (new) — registers the orphaned 20-case
   §23.5 classifier set; gate ≥ 0.90.
2. `providers/mock-chat-edit.mjs` (new) — deterministic CI provider per the
   W7-H-documented contract.
3. `prompts/chat-edit-classifier.system.txt` (new) — §23.5 starter mirror
   ({{userRequest}}/{{doc.layerSummary}}/{{catalog}} labeled sections).
4. `scripts/eval-gate.mjs` — third gate (`--classifier`, default 0.90),
   config-sanity now scans `cases/chat-edits/` and checks the classifier config
   (orphan + existence + duplicate checks), usage/header/self-test updated.
5. `package.json` — `eval:classifier` script; `eval:ci` runs all three configs
   + the triple `--suite/--chat/--classifier` gate.
6. `README.md` + `cases/chat-edits/README.md` — three-gate policy tables,
   registration marked LANDED, growth-plan routing rules.

## 8. Gaps and next actions

| # | Gap | Owner | Action |
|---|---|---|---|
| GAP-1 | `cafe-menu@1` has zero eval cases | next case author | add happy path to `cases/expanded/templates.yaml` per its own note |
| GAP-2 | Wave-1 SNAPSHOT catalogs cite registry-absent ids (`carousel-launch@1`, `divider@1`, `icon-bullet@1`, `event-flyer@3`) | Wave-6 real-provider wrapper | regenerate catalog vars from the live registry (or regenerate the fixtures) before real-model runs |
| GAP-3 | `qr-code@1` referenced by a negative assert but not shipped (10/15 components) | template/component registry owner | ship it or drop the optional-slot reference |
| GAP-4 | Render similarity (SSIM/DISTS vs golden renders, §11.4) still TODO | W7 engine-render CI | add fuzzy image asserts once headless render works |
| GAP-5 | CI workflow has no eval step yet | infra/ci-staged owner | add `pnpm --filter @studio/evals eval:ci` (three-gate pipeline is ready) |
| GAP-6 | Envelope schema duplicated (2 configs + `schemas/plan.schema.json`) | W6 | extract to one shared source |
| GAP-7 | Critic eval cases + scoreboard page for the monthly drift review | W7 | see §5 above |

**Bottom line:** 87 graded briefs across three wired gates (67-suite 0.85 +
two chat gates at 0.90), coverage map verified with two honest gaps (GAP-1
cafe-menu, GAP-2 synthetic catalogs), determinism holds by construction, and
the last unregistered case set is now gated. The eval program meets §19's
count/threshold gates as written; the remaining work is the real-model wrapper,
the CI step, and the two coverage gaps.
