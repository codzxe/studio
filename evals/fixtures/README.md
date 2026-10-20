# evals/fixtures — test & eval fixture policy

Fixtures for the eval suite (`packages/evals`) and unit/integration tests. **Spec §21
test-data policy, enforced here:**

## Rules

1. **Synthetic only.** Every fixture in this repo is generated or placeholder content.
   Real customer content NEVER enters fixtures or evals (§21) — not screenshots, not
   briefs, not documents, not "anonymized" copies.
2. **No PII.** No real names, emails, addresses, logos or photos of identifiable people.
   Demo identity data uses RFC 2606 safe domains (`*.example`) and obviously fake names
   (`Main Street Coffee`, `asset_812`). Synthetic briefs live inline in
   `packages/evals/cases/*.yaml` (Wave 1); shared fixture files land here as the
   template/asset programs grow.
3. **Public-domain demo assets only, with ATTRIBUTION rows.** Any image placed in
   `assets/` must be public-domain (or CC0/MIT-class) and ships with a row in the
   repo-root `ATTRIBUTION.md` (path, title, author/source, license) **in the same
   change that adds it** (§1.5 constraint 9). Never commit font files (§1.5-9;
   fonts come from `CRAFT_FONTS_DIR` at build time).
4. **Deterministic.** Fixtures must make tests reproducible: fixed ids (`asset_812`),
   fixed palettes, no randomness, no network fetches at test time.

## Directory structure (placeholder — Wave 1)

```
evals/fixtures/
  assets/       synthetic demo assets used by golden briefs (placeholder photos, logos,
                marks). Empty in Wave 1 — cases reference asset ids symbolically.
                First real asset lands with the Wave 2 template program, WITH an
                ATTRIBUTION.md row in the same change.
  catalogs/     template + component manifest snapshots per version
                (e.g. catalogs/instagram-post@3.yaml), captured from the template
                registry so evals detect manifest drift. TODO Wave 2.
  snapshots/    document snapshots (layer trees / workspace_snapshot summaries) per
                scenario, shared across cases. Wave 1 keeps snapshots inline in
                packages/evals/cases/*.yaml; extract here when they start repeating.
  renders/      golden renders per template, for the §11.4 render-similarity gate:
                renders/<template-slug>@<version>/<case-id>.png, downscaled <= 1024 px
                (§5.4 context discipline). TODO Wave 7 together with SSIM/DISTS
                threshold assertions in packages/evals (no fuzzy image assertions in
                Wave 1 — placeholder structure only).
```

Golden renders are per **template@version** (not per case): a template bump rerenders
its goldens in one batch, and the similarity threshold lives with the case assertions
in `packages/evals/cases/` (§11.4: perceptual distance, never pixel equality).
