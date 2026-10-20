# ADR 0001 — Editor pin and vendor policy

Date: 2026-10-20 · Status: accepted

## Context

The SaaS wraps the open-source Rust image editor (upstream `storytold/photocraft`, MIT OR
Apache-2.0) through its JSON control protocol (`photocraft-cli serve`). Spec §16.1 requires
pinned git clones — never ad-hoc folder snapshots — and forbids in-place edits of the
vendored copy.

## Decision

1. The engine is a shallow git clone OUTSIDE this repo at `/home/z/my-project/vendor/photocraft`,
   pinned to commit `872748fb5b2a53e09dd4e385e31968d985c0515b` (recorded in `ATTRIBUTION.md`).
2. Engine additions required by the SaaS (spec §2.3: `template_cmds.rs`, `component_cmds.rs`,
   `layout_cmds.rs`, `agent_cmds.rs` + registry registration) are authored in THIS repo under
   `engine-patches/` as standalone new modules with `specs()` functions, shaped to be
   upstreamable PRs. They are never applied to the vendored copy in place.
3. Fonts come from the pinned `craft-fonts` clone via `CRAFT_FONTS_DIR` at build time.
   Font files are never committed to this repo.
4. Bumps are deliberate: re-pin only after the upstream's own gates (tests, clippy, parity,
   scorecard) pass at the new commit; update this ADR + `ATTRIBUTION.md` in the same change.

## Vendor pins (2026-10-20, shallow clones)

| Repo | Pin |
|---|---|
| storytold/photocraft | `872748fb5b2a53e09dd4e385e31968d985c0515b` |
| storytold/craft-fonts | `bfcbf714e45a3ea8e98f88ab2b7971372a576414` |
| storytold/photocraft-corpus | `98c60c9d10883dda7c4a948109d28e5bcab5fc03` |
| storytold/craft-libs | `e36f1890186558e0a2195750e798d641f5983b0f` |
| mickasmt/next-saas-stripe-starter (reference) | `c6df229ae73c207e87356d5e592779c511a9b56d` |
| onwidget/astrowind (reference) | `14e1a691f80548dcc36370847b1a02c0d0b12821` |
| magicuidesign/magicui (reference) | `efe76fc5755eca1142dd4f74c1d6f0ace2887e3c` |

## Consequences

- `engine-patches/` must compile against the pinned commit only; a re-pin may require
  refreshing patches (tracked in `engine-patches/README.md`).
- CI runs Rust checks on the patch series in a dedicated job, not in the TS pipeline.
