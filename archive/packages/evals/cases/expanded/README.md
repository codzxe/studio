# cases/expanded — W7-D golden-brief growth wave (§21 → 50+ total)

This directory owns the **W7-D expansion** of the golden-brief suite: 52 NEW cases
joining the 15 Wave-1 seeds in `cases/*.yaml` → **67 total**, clearing the §19
Phase 2 exit gate ("eval suite ≥ 50 briefs with ≥ 85% pass"). Format is identical
to the Wave-1 files: `vars` (brief / snapshot / catalog / plan / run) + the §21
assertion surface (plan validity, intent, template pins, tier cost per §5.2,
tool-call caps, validator verdicts, layer names, slot contents).

## Case map (52 cases across 8 files)

| File | Cases | Coverage |
|---|---|---|
| `creates.yaml` | 14 | create_post ×14 — happy paths for the Wave-1-era ACTUAL templates (`instagram-post@3`, `youtube-thumbnail@1`, `presentation-slide@1`), all **10 ACTUAL components**, complex-tier generated-hero case, non-English (DE) brief |
| `templates.yaml` | 12 | one happy path per **W7-A/B/C template manifest** (`blog-cover@1`, `business-card@1`, `email-header@1`, `event-flyer@1`, `facebook-cover@1`, `instagram-story@1`, `linkedin-banner@1`, `pinterest-pin@1`, `presentation-quote@1`, `product-poster@1`, `web-hero-banner@1`, `x-post@1`) — real slots/caps/layerMap asserted |
| `freeform.yaml` | 2 | freeform create_post ×2 — `template: null` + planner flags freeform + `notes_for_user` (§23.2, §24.3 family) |
| `edits.yaml` | 8 | edit_layers ×8 on prepared docs — **6 quick-tier §24.2-style targeted edits** (component.setVars families) + 2 standard-tier multi-target/asset-swap edits |
| `operations.yaml` | 10 | resize ×3 (reapply / declarative refit / A5 print), variant ×4 (DE+FR+ES languages, sizes, dark comp + JA dataset, single-language quick), export ×3 (300-dpi print, variant bundle, PSD + fidelity) |
| `clarify.yaml` | 2 | clarification policy ×2 (asset ambiguity, contradictory canvas) — ask_user FIRST, zero mutation (§23.2) |
| `injection.yaml` | 2 | prompt-injection corpus ×2 (§5.7) — **sanitize-not-block**: hostile text lands as inert data / is cut by ordinary slot caps, plan + run stay normal |
| `budget.yaml` | 2 | budget-cap clean stops ×2 (§5.2) — `succeeded_with_warnings`, partial credits (3 of 5 / 1 of 2), tool_calls exactly at cap, cut named for the user, one committed transaction |

### Intent matrix across the expanded set (≥ the required rows)

| Intent | Wave-1 | W7-D | total |
|---|---|---|---|
| create_post | 4 | 32 (14 creates + 12 template happy paths + 2 freeform + clarify #1, injection #1, budget ×2) | 36 |
| edit_layers | 8 | 9 (8 edits + injection #2) | 17 |
| resize | 1 | 3 | 4 |
| variant | 1 | 5 (4 operations + clarify #2) | 6 |
| export | 1 | 3 | 4 |

Tier spread (credits per §5.2: quick 1 / standard 2 / complex 5): 15 quick,
33 standard, 4 complex.

### Component coverage (every ACTUAL `evals/components/*` in ≥1 brief)

avatar-circle@1 (create-ig-testimonial, create-ig-review-spotlight, edit-quick-avatar-brand, create-blog-cover-og) ·
button-cta@1 (create-ig-flash-sale, create-slide-webinar-cta, create-menu-teaser-complex, edit-quick-cta-label, budget-stop-standard-icons, create-email-header, create-web-hero-banner) ·
logo-lockup@1 (create-slide-webinar-cta, create-ig-grand-opening) ·
offer-badge@2 (create-thumb-yt-episode, create-ig-friday-special, create-thumb-recipe-easy, edit-quick-badge-relabel, create-story-swipe-up) ·
price-tag@1 (create-ig-flash-sale, create-thumb-deal-price, create-menu-teaser-complex, edit-quick-price-eur, budget-stop-standard-icons, create-product-poster) ·
quote-block@1 (create-ig-testimonial, create-slide-keynote-quote, create-menu-teaser-complex, edit-quick-quote-swap) ·
ribbon-banner@1 (create-ig-trainer-ribbon, edit-std-ribbon-restyle, create-blog-cover-og) ·
social-handle@1 (create-ig-trainer-ribbon, create-slide-webinar-cta, create-ig-grand-opening, edit-quick-stars-handle, create-pinterest-pin) ·
star-rating@1 (create-ig-testimonial, create-ig-review-spotlight, edit-quick-stars-handle) ·
wave-divider@1 (create-ig-grand-opening, edit-std-ribbon-restyle, create-keynote-quote-slide)

Template-referenced components ride the same pins: `event-flyer@1` names `qr-code@1`
(optional, left hidden — asserted present-not-deleted, §7.3).

### Template coverage (every manifest-bearing template in ≥1 happy-path brief)

`instagram-post@3` ×15 pins, `youtube-thumbnail@1` ×3, `presentation-slide@1` ×4,
and one happy path each for `blog-cover@1`, `business-card@1`, `email-header@1`,
`event-flyer@1`, `facebook-cover@1`, `instagram-story@1`, `linkedin-banner@1`,
`pinterest-pin@1`, `presentation-quote@1`, `product-poster@1`, `web-hero-banner@1`,
`x-post@1` — **every template in `evals/templates/` that has a manifest** (15 of 16
dirs; `cafe-menu@1/` was still manifest-less/empty at authoring time — when its
manifest lands, add its happy path to `templates.yaml` with the same recipe: pin
`id@version`, fill its real slots within their caps, assert its layerMap roles +
§7.2 rules + standard-tier credits).

## Registration (one-line change for the `promptfoo.config.yaml` owner)

`promptfoo.config.yaml` lists case files explicitly under `tests:`. To bring these
52 cases into the suite (the §19 50-brief gate counts them), append:

```yaml
tests:
  - cases/creates.yaml
  - cases/edits.yaml
  - cases/operations.yaml
  - cases/failures.yaml
  - cases/expanded/creates.yaml
  - cases/expanded/templates.yaml
  - cases/expanded/freeform.yaml
  - cases/expanded/edits.yaml
  - cases/expanded/operations.yaml
  - cases/expanded/clarify.yaml
  - cases/expanded/injection.yaml
  - cases/expanded/budget.yaml
```

(If the pinned promptfoo accepts globs in `tests:`, `cases/expanded/*.yaml` is the
compact equivalent; the explicit list is the safe form. `scripts/eval-gate.mjs`
then enforces the ≥0.85 pass rate over all 67.)

## Render similarity — TODO (§11.4 / §21)

As in Wave 1, deliberately **no fuzzy image assertions** in this wave: perceptual
similarity (SSIM/DISTS thresholds vs golden renders under `evals/fixtures/`)
waits on headless engine rendering in CI (see the TODO(W7) note in
`promptfoo.config.yaml`). Every case here pins the deterministic surrogate
instead: exact slots, layer names, validator counts and command-level evidence.
