# cases/expanded — W7-D golden-brief growth wave (§21 → 50+ total)

This directory owns the **W7-D expansion** of the golden-brief suite: 40 NEW cases
joining the 15 Wave-1 seeds in `cases/*.yaml` → **55 total**, clearing the §19
Phase 2 exit gate ("eval suite ≥ 50 briefs with ≥ 85% pass"). Format is identical
to the Wave-1 files: `vars` (brief / snapshot / catalog / plan / run) + the §21
assertion surface (plan validity, intent, template pins, tier cost per §5.2,
tool-call caps, validator verdicts, layer names, slot contents).

## Case map (40 cases across 7 files)

| File | Cases | Coverage |
|---|---|---|
| `creates.yaml` | 14 | create_post ×14 — happy paths for **every ACTUAL template** (`instagram-post@3`, `youtube-thumbnail@1`, `presentation-slide@1`), all **10 ACTUAL components**, complex-tier generated-hero case, non-English (DE) brief |
| `freeform.yaml` | 2 | freeform create_post ×2 — `template: null` + planner flags freeform + `notes_for_user` (§23.2, §24.3 family) |
| `edits.yaml` | 8 | edit_layers ×8 on prepared docs — **6 quick-tier §24.2-style targeted edits** (component.setVars families) + 2 standard-tier multi-target/asset-swap edits |
| `operations.yaml` | 10 | resize ×3 (reapply / declarative refit / A5 print), variant ×4 (DE+FR+ES languages, sizes, dark comp + JA dataset, single-language quick), export ×3 (300-dpi print, variant bundle, PSD + fidelity) |
| `clarify.yaml` | 2 | clarification policy ×2 (asset ambiguity, contradictory canvas) — ask_user FIRST, zero mutation (§23.2) |
| `injection.yaml` | 2 | prompt-injection corpus ×2 (§5.7) — **sanitize-not-block**: hostile text lands as inert data / is cut by ordinary slot caps, plan + run stay normal |
| `budget.yaml` | 2 | budget-cap clean stops ×2 (§5.2) — `succeeded_with_warnings`, partial credits (3 of 5 / 1 of 2), tool_calls exactly at cap, cut named for the user, one committed transaction |

### Intent matrix across the expanded set (≥ the required rows)

| Intent | Wave-1 | W7-D | total |
|---|---|---|---|
| create_post | 3 | 16 (14 creates + 2 freeform; + clarify #1, injection #1, budget ×2) | 22 |
| edit_layers | 7 | 9 (8 edits + injection #2) | 16 |
| resize | 1 | 3 | 4 |
| variant | 1 | 5 (4 operations + clarify #2) | 6 |
| export | 1 | 3 | 4 |

Tier spread (credits per §5.2: quick 1 / standard 2 / complex 5): 18 quick,
18 standard, 4 complex.

### Component coverage (every ACTUAL `evals/components/*` in ≥1 brief)

avatar-circle@1 (create-ig-testimonial, create-ig-review-spotlight, edit-quick-avatar-brand) ·
button-cta@1 (create-ig-flash-sale, create-slide-webinar-cta, create-menu-teaser-complex, edit-quick-cta-label, budget-stop-standard-icons) ·
logo-lockup@1 (create-slide-webinar-cta, create-ig-grand-opening) ·
offer-badge@2 (create-thumb-yt-episode, create-ig-friday-special, create-thumb-recipe-easy, edit-quick-badge-relabel) ·
price-tag@1 (create-ig-flash-sale, create-thumb-deal-price, create-menu-teaser-complex, edit-quick-price-eur, budget-stop-standard-icons) ·
quote-block@1 (create-ig-testimonial, create-slide-keynote-quote, create-menu-teaser-complex, edit-quick-quote-swap) ·
ribbon-banner@1 (create-ig-trainer-ribbon, edit-std-ribbon-restyle) ·
social-handle@1 (create-ig-trainer-ribbon, create-slide-webinar-cta, create-ig-grand-opening, edit-quick-stars-handle) ·
star-rating@1 (create-ig-testimonial, create-ig-review-spotlight, edit-quick-stars-handle) ·
wave-divider@1 (create-ig-grand-opening, edit-std-ribbon-restyle)

### Template coverage note (W7-A/B/C coordination)

The three templates shipped in `evals/templates/` at authoring time
(`instagram-post@3`, `youtube-thumbnail@1`, `presentation-slide@1`) each have
multiple happy-path briefs here. **When W7-A/B/C land additional template
manifests**, add one happy-path brief per new template to `creates.yaml` following
the same recipe (pin `id@version` from the manifest, fill its actual slots within
their caps, assert its layerMap roles + §7.2 rules + tier credits) — the §21
"every template gets ≥1 happy-path brief" bar is then re-checked by the gate.

## Registration (one-line change for the `promptfoo.config.yaml` owner)

`promptfoo.config.yaml` lists case files explicitly under `tests:`. To bring these
40 cases into the suite (the §19 50-brief gate counts them), append:

```yaml
tests:
  - cases/creates.yaml
  - cases/edits.yaml
  - cases/operations.yaml
  - cases/failures.yaml
  - cases/expanded/creates.yaml
  - cases/expanded/freeform.yaml
  - cases/expanded/edits.yaml
  - cases/expanded/operations.yaml
  - cases/expanded/clarify.yaml
  - cases/expanded/injection.yaml
  - cases/expanded/budget.yaml
```

(If the pinned promptfoo accepts globs in `tests:`, `cases/expanded/*.yaml` is the
compact equivalent; the explicit list is the safe form. `scripts/eval-gate.mjs`
then enforces the ≥0.85 pass rate over all 55.)

## Render similarity — TODO (§11.4 / §21)

As in Wave 1, deliberately **no fuzzy image assertions** in this wave: perceptual
similarity (SSIM/DISTS thresholds vs golden renders under `evals/fixtures/`)
waits on headless engine rendering in CI (see the TODO(W7) note in
`promptfoo.config.yaml`). Every case here pins the deterministic surrogate
instead: exact slots, layer names, validator counts and command-level evidence.
