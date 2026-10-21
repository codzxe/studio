# cases/chat-edits — the curated chat-edit classifier eval set (20 cases)

This directory is the **§19 Phase 2 exit gate target**: *"chat edits correct
≥ 90% on the curated set."* It grades the §23.5 chat-edit classifier
(`packages/agent/src/classifier/`) — NOT the run planner. The golden-brief
suite in `cases/*.yaml` + `cases/expanded/` carries the other §19 gate
(≥ 50 briefs, ≥ 85%); this set is a separate, stricter per-subset gate over
the classification contract itself.

## The 20 cases (6 + 4 + 4 + 3 + 3)

| # | id | file | request (gist) | action | target_layers | tier / credits §14.1 | reapply |
|---|---|---|---|---|---|---|---|
| 01 | `ce-quick-subhead-smaller` | quick-edits.yaml | "Make the subhead smaller." | `restyle` | `[Subhead]` | quick / 1 | false |
| 02 | `ce-quick-add-badge` | quick-edits.yaml | "Add a 20% OFF badge…" | `add_component` | `[]` | quick / 1 | false |
| 03 | `ce-quick-recolor-headline` | quick-edits.yaml | "Make the headline terracotta." | `recolor` | `[Headline]` | quick / 1 | false |
| 04 | `ce-quick-swap-photo` | quick-edits.yaml | "Swap the photo for the newer shot" | `replace_field` | `[Photo]` | quick / 1 | false |
| 05 | `ce-quick-move-logo` | quick-edits.yaml | "Move the logo to the top-left." | `move` | `[Logo]` | quick / 1 | false |
| 06 | `ce-quick-fix-typo` | quick-edits.yaml | "Fix the typo in the subhead" | `set_text` | `[Subhead]` | quick / 1 | false |
| 07 | `ce-comp-subhead-badge` | composites.yaml | §24.2 verbatim | `restyle+add_component` | `[Subhead]` | quick / 1 | false |
| 08 | `ce-comp-headline-text-color` | composites.yaml | new copy + brand color | `set_text+recolor` | `[Headline]` | quick / 1 | false |
| 09 | `ce-comp-remove-move` | composites.yaml | delete badge + nudge subhead | `remove_layer+move` | `[Badge, Subhead]` | standard / 2 | false |
| 10 | `ce-comp-recolor-badge` | composites.yaml | flyer 4-text recolor + badge | `recolor+add_component` | 4 flyer text layers | standard / 2 | false |
| 11 | `ce-clarify-pop` | clarify.yaml | "Make it pop." | `clarify` | `[]` (candidates) | quick / 1 | false |
| 12 | `ce-clarify-move-it` | clarify.yaml | "Move it up a bit." | `clarify` | `[]` (candidates) | quick / 1 | false |
| 13 | `ce-clarify-change-text` | clarify.yaml | "Change the text." | `clarify` | `[]` (candidates) | quick / 1 | false |
| 14 | `ce-clarify-swap-image` | clarify.yaml | "Swap the image…" (two images) | `clarify` | `[]` (candidates) | quick / 1 | false |
| 15 | `ce-reapply-layout-swap` | reapply.yaml | rebuild on event-flyer layout | `replace_field` | `[Headline, Subhead, Photo]` | standard / 2 | **true** |
| 16 | `ce-reapply-accent-color` | reapply.yaml | accent color-slot change | `replace_field` | `[Accent Band]` | quick / 1 | **true** |
| 17 | `ce-reapply-photo-fit` | reapply.yaml | photo slot fit change | `replace_field` | `[Photo]` | quick / 1 | **true** |
| 18 | `ce-trap-full-redo` | downgrades.yaml | "Completely redo this promo…" | `set_text` | `[Headline]` exact | quick / 1 | false |
| 19 | `ce-trap-date-everywhere` | downgrades.yaml | "…everywhere it appears" | `set_text` | `['Subhead — Date']` exact | quick / 1 | false |
| 20 | `ce-trap-rebrand-cover` | downgrades.yaml | "Rebrand the whole cover…" | `recolor` | `[Headline]` exact | quick / 1 | false |

Doc fixtures pin REAL templates (`evals/templates/`): `instagram-post@3`
(the §24.1/§24.2 coffee promo document), `event-flyer@1`, `business-card@1`,
`facebook-cover@1` — every layer name asserted exists in that template's
manifest/layerMap, and every component ref (`offer-badge@2`) is a real
catalog component.

## Case shape

```yaml
- id: ce-…
  vars:
    userRequest: "…"            # the chat message being classified (§23.5 input)
    doc:                        # starting doc state (§5.4 context)
      template: instagram-post@3    # the template pin the doc was created from
      canvas: { w: 1080, h: 1080 }
      layerSummary: [ { name: Background, kind: fill, … }, … ]   # fixture rows
      palette: […]              # brand tokens (§23.2 rules)
      fonts: […]
    catalog:                    # §6.1 names-only catalog (templates/components/assets)
      …
    classification:              # golden §23.5 output — the mock provider echoes this
      { action, target_layers, args, cost_tier, needs_template_reapply }
    expected:                   # machine-readable grading key (mirrors the asserts)
      { action, target_layers, cost_tier, credits, needs_template_reapply }
    trap: { naive_cost_tier: complex, reason: … }   # downgrade traps only (docs, not graded)
  assert: [ … ]                 # the exact assert surface (below)
```

## The exact assert surface (what "correct" means per case)

Every case carries these five core asserts (+ case-specific pins):

1. **`is-json`** — the output is the §23.5 classification with the STRICT key
   set `{action, target_layers, args, cost_tier, needs_template_reapply}`
   (mirrors `chatEditClassificationSchema`'s `strictObject` — no extra keys,
   action ≤ 120 chars, ≤ 10 targets, tier enum).
2. **action match** — the parsed atom set equals the expected atoms
   (`action.split('+')`, trimmed; §24.2 composites and spacing tolerated;
   duplicates/unknown atoms fail, exactly like `parseActionExpr`).
3. **target_layers subset** — the expected targets are a SUBSET of the
   classification's `target_layers`, AND every actual target is a REAL layer
   in that case's `layerSummary` (the §23.5 never-invented rule). The three
   downgrade traps pin the EXACT set (both directions) — over-broad sprays fail.
4. **tier match** — `credits(cost_tier) === expected` with the §14.1 table
   quick 1 / standard 2 / complex 5. The graded `cost_tier` is the RESOLVED
   tier (see "Provider contract" below).
5. **needs_template_reapply match** — the §23.5 reapply flag, exact.

Case-specific pins: §24.2 payloads (30pt, `offer-badge@2` + `label:"20% OFF"`),
palette-token colours, catalog asset ids, corrected copy within slot caps,
clarify candidates (required subset + real-layer check + ONE question ≤ 300
chars — the `ask_user` budget).

## The 90% threshold — how CI counts it

- **Correct case** = ALL of its asserts pass (promptfoo marks the case's
  `success: true`). One failing assert fails the case.
- **Gate**: `correct / 20 ≥ 0.90` → **at least 18 of 20** cases correct.
- **Enforcement**: the same gate script as the main suite, with the chat-edit
  threshold —
  ```bash
  node scripts/eval-gate.mjs results/chat-edit-eval.json 0.90
  ```
  (exit 0 = gate passed; exit 1 = red build, offending case ids listed;
  `scripts/eval-gate.mjs` already accepts the threshold argument — no code
  change needed for this set.)
- §19's 90% is a **per-subset** metric, so the chat-edit set must be evaluated
  as its OWN promptfoo run (its own config; see registration below), not
  blended into the ≥ 50-brief ≥ 85% gate. A blended run would need a subset
  filter in eval-gate — owner's call; the separate-run form is the pinned
  recommendation.

### Determinism today (green-by-construction, §1.5-6 / §21)

The CI provider echoes each case's golden `classification` var — zero model
calls, zero cost, no engine process (the `mock-planner.mjs` pattern). The
suite is therefore green in CI while the asserts hold the real contract: the
moment a real-model classifier provider is wired (Wave 6/7), the SAME cases
and asserts measure live classification quality against the 90% gate.

### Provider contract (for the `packages/evals` owner — exact code to paste)

**Mock (CI default)** — `providers/mock-chat-edit.mjs`:

```js
// Deterministic CI provider for cases/chat-edits/** (mock-planner precedent).
export async function callApi(prompt, context) {
  const vars = context?.vars ?? {};
  if (!vars.classification) {
    return { error: 'mock-chat-edit: case is missing the golden `classification` var' };
  }
  if (typeof vars.userRequest === 'string' && !String(prompt).includes(vars.userRequest)) {
    return { error: 'mock-chat-edit: {{userRequest}} did not render into the prompt' };
  }
  return { output: JSON.stringify(vars.classification), cost: 0, latencyMs: 0 };
}
export default { callApi };
```

**Real classifier (Wave 6/7 wiring)** — wrap `ChatEditClassifier` from
`@studio/agent` and emit the classification with the **resolved** tier:

```js
const result = await classifier.classify({ userRequest, layerSummary, catalog, signal });
if (!result.ok) return { error: `[${result.code}] ${result.message}` };
return { output: JSON.stringify({ ...result.classification, cost_tier: result.costTier }) };
```

The provider's output MUST be the §23.5 classification JSON itself (no
envelope) with `cost_tier` = `result.costTier` — the tier AFTER the
deterministic §23.5 cheapest-action guard (`resolveCostTier`), which is what
the run charges (§14.1 credits). This is what gives the downgrade traps their
production-faithful teeth: a model that proposes `complex` on case 18–20
still passes **iff** the guard downgrades it to `quick` (1 credit) — exactly
as production would charge — and a raw-proposal provider (no guard) fails
those cases, catching tier inflation either way.

**Prompt**: mirror `buildChatEditPrompt` (packages/agent/src/classifier/
prompt.ts) — labeled `{{userRequest}}` / `{{doc.layerSummary}}` /
`{{catalog}}` sections, the composite/clarify output conventions, then the
§23.5 block VERBATIM (already pinned in `packages/agent/prompts/v1/
chat-edit-classifier.md`). The mock only requires `{{userRequest}}` to render.

### Registration — LANDED (W10-P final-review pass)

Because the 90% gate is per-subset, this set is registered under its own config,
`promptfoo.chat-edit.config.yaml` (the block below, now committed), with the
chat-edit provider and prompt, tests = the five files, gated at `0.90` by
`scripts/eval-gate.mjs` (`--classifier <results> [--classifier-threshold 0.90]`,
or the legacy positional form). Appending the files to the MAIN config instead
would blend the gates and fail the suite's `{plan, run}` defaultTest on every
classifier case — that is why registration needed this third config.

```yaml
# promptfoo.chat-edit.config.yaml
description: "studio chat-edit classifier evals — §23.5 curated set (§19 Phase 2: ≥ 90%)"
prompts: [prompts/chat-edit-classifier.system.txt]   # mirror per README above
providers:
  - file://providers/mock-chat-edit.mjs               # CI default
tests:
  - cases/chat-edits/quick-edits.yaml
  - cases/chat-edits/composites.yaml
  - cases/chat-edits/clarify.yaml
  - cases/chat-edits/reapply.yaml
  - cases/chat-edits/downgrades.yaml
evaluate: { maxConcurrency: 4 }
```

CI step (workflows owner): `pnpm --filter @studio/evals eval:ci` runs all three
gates (suite 0.85, chat-edits 0.90, classifier 0.90) in one strictest-failure
pipeline; `eval:classifier` runs this gate standalone.

`scripts/eval-gate.mjs --dry` now scans `cases/chat-edits/` as part of its
config-wiring sanity check: a classifier case file on disk that is not
registered in `promptfoo.chat-edit.config.yaml` fails the self-test loudly.

## Tier math the goldens must honor (future case authors)

Every golden `cost_tier` is the RESOLVED tier of
`resolveCostTier` (`packages/agent/src/classifier/classifier.ts`) — keep new
cases self-consistent or a real classifier will legitimately disagree:

```
estimatedCalls = Σ_atoms [ layer-targeted atoms & resize: max(1, |target_layers|)
                            otherwise: 1 ]
                + (clarify ? 0 : 3)          # render + validate + commit tail
                + (needs_template_reapply ? 2 : 0)   # template.apply + template.fill
resolved = cheapest tier with §5.2 cap ≥ estimatedCalls   (quick 6 / standard 12 / complex 24)
credits  = quick 1 / standard 2 / complex 5 (§14.1)
```

Worked examples in this set: #07 `restyle+add_component` [Subhead] → 1+1+3 =
5 ≤ 6 → **quick**; #09 `remove_layer+move` [Badge, Subhead] → 2+2+3 = 7 →
**standard** (the guard RAISES a quick proposal that would stop mid-edit,
§5.2); #15 `replace_field` ×3 + reapply → 3+3+2 = 8 → **standard**;
#16/#17 single slot + reapply → 6 → **quick** (reapply does NOT imply
standard).

There is deliberately **no complex-tier case**: a chat edit whose workload
needs > 12 calls is a regeneration, and §23.5 forbids proposing one when a
targeted edit works — complex-tier coverage lives in the freeform golden
briefs (`cases/expanded/freeform.yaml`).

## Fleet flags (owners beyond cases/chat-edits/**)

- `promptfoo.config.yaml` / CI owner: **RESOLVED (W10-P)** — the third config
  `promptfoo.chat-edit.config.yaml`, `providers/mock-chat-edit.mjs` and the
  `prompts/chat-edit-classifier.system.txt` mirror landed with the classifier
  gate; `package.json` gained `eval:classifier` and a three-gate `eval:ci`.
  Remaining for the agent-prompts owner: sync the VERBATIM §23.5 block into the
  prompt mirror before real-model runs (TODO noted in the file).
- `packages/agent` owner: the classifier's `resolveCostTier`,
  `parseActionExpr`, clarify payload and never-invented rules are the graded
  surface — changes there must keep these 20 goldens passing (or update the
  goldens in the same change, with the tier math above).
- `scripts/eval-gate.mjs` takes the classifier gate via `--classifier`
  (threshold default 0.90); the legacy `node scripts/eval-gate.mjs <file> 0.90`
  form still works.
