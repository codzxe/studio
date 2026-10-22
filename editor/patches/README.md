# editor/patches — product patches over the vendored pin

Every patch is a git format-patch artifact generated from the fork
**`codzxe/effectcraft`, branch `studio`** (which carries the pin `9db7f3b2` plus our
commits; its `upstream` remote is `storytold/effectcraft`). Per
`docs/DECISIONS.md` D-17 the workflow is:

1. apply the change in the fork checkout (`/home/z/my-project/effectcraft-upstream`),
2. commit on `studio`, push to `codzxe/effectcraft`,
3. `git format-patch -1 --stdout > patches/NNNN-subject.patch`,
4. `git diff --name-only` in the fork and copy exactly those files into `editor/`,
5. update the patch table in `../UPSTREAM.md`.

Rules (ADR-0006 "Upstream policy"):

- `crates/ui-egui` may only be touched when a binding rule forces it (e.g. the
  ADR-0006 decision-10 branding removal, a bridge/API gap). Never for visual taste.
- Build/integration changes (`xtask`, web shell, icons) are preferred over UI changes.
- Attribution is never renamed or removed: `.attribution` sidecars, `ATTRIBUTION.md`,
  `LICENSE-*` and `NOTICE` move with every patch.
- Technical identifiers are stable across patches: `window.effectcraft` (the bridge
  contract, ADR-0006 §4), the `.ecproj` XML root `<EffectCraftProject>`, lowercase
  crate/module/cache names.

## Applied patches

| Patch | Subject | Fork commit | Date |
|---|---|---|---|
| [0001-debrand.patch](0001-debrand.patch) | De-brand the editor for the commercial product (ADR-0006 decision 10): rename user-visible EffectCraft/ArtCraft to Studio, feature-gate the upstream promo chrome off via empty `links.rs` constants, swap the mark for the original Studio keyframe diamond | `0afc18e` | 2026-10-22 |
