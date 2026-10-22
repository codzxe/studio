# editor/patches — product patches over the vendored pin

**Single-repo policy (user directive, 2026-10-22; DECISIONS.md D-17): the vendored
source in `editor/` is the canonical source of truth.** There is no fork workflow —
patches are made directly in this tree and recorded here as diff artifacts for
provenance against the pin `9db7f3b21700fd821f215782ed1c82afe077880f` (see
`../UPSTREAM.md`). A local reference clone of upstream may exist at
`/home/z/my-project/effectcraft-upstream` (excluded from the repo) purely for
diffing/re-pinning — never as the place where product changes live.

Workflow for a new patch (DECISIONS.md D-17):

1. make the change directly in `editor/` (this tree, committed to `codzxe/studio`),
2. generate the artifact against the pin, e.g. from the reference clone:
   `git -C effectcraft-upstream diff <pin> -- <files> > patches/NNNN-subject.patch`
   (for patch 0001 the equivalent artifact was produced from the since-deprecated
   fork branch `studio` @ `0afc18e`),
3. update the patch table in `../UPSTREAM.md`.

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
