//! `layout.*`: the layout family's parent module (spec §9) — constraints, not coordinates.
//! The model supplies intent (stacks, rows, grids, anchors, fit modes, safe areas); the
//! submodules solve the geometry and commit it as undoable edits, so the two §9.5 hard rules
//! hold structurally: **transactional** (any invalid child ⇒ nothing moves) and
//! **deterministic** (same input + revision ⇒ byte-identical output).
//!
//! One module, one `specs()` (§2.3): the registry insert for this family is the single line
//! `v.extend(crate::layout_cmds::specs());` (registration/commands-registry.patch.txt), and
//! THIS function is the family's only registration site — the sanctioned "parent chains it"
//! merge shape (commands-registry.patch.md § "Submodule specs merges", option (a)):
//!
//! * [`layout_apply`] — the `layout.apply` parser, pure solver and transactional commit
//!   (§9.2/§9.5). Its `run` is [`layout_apply::apply`]; the `CommandSpec` itself lives here
//!   in the parent, exactly the way `template_cmds.rs` owns `template.list`/`inspect`/`apply`
//!   while its sibling file owns the slot-value commands.
//! * [`fit_text`] — the §9.3 fit and §9.4 measure math, pure and table-testable (no
//!   `Session`): measure, binary-search down to `minSize`, condensed tracking, ellipsis,
//!   exact-overflow reporting — never a silent clip.
//! * [`fit_specs`] — the `layout.fitText` + `layout.measure` `CommandSpec`s (§9.4), chained
//!   into [`specs`] below through their own single `specs()`.
//! * [`measure_impl`] — the engine-side `TextMeasurer` for [`layout_apply`]'s hug seam
//!   (§9.2): the bridge from a document's type layer to [`fit_text`]'s production measurer.
//!
//! All four are declared `pub` so the solver's pure seams (`parse_tree`, `solve`, the fit
//! math) stay reachable to callers and tests; registration never looks past the parent.
//! (The apply script copies `<sib>.rs` to `crates/engine/src/layout_cmds/<sib>.rs`, Rust
//! 2018 subdirectory layout — the same place a `#[path]` attribute would resolve to.)
//!
//! Golden rules (vendor AGENTS.md): nothing in this family panics on hostile numbers —
//! every integer/float is `is_finite()`-checked and range-capped before any math
//! (`layout_apply`'s §9.5 validators, `fit_text::validate`), recursion and child lists are
//! capped (`layout_apply::MAX_DEPTH`/`MAX_NODES`/`MAX_CHILDREN`), the fit's loops are
//! bounded (`fit_text::SEARCH_CAP`), and alignment is logical `start`/`end`, never bare
//! `left`/`right`.

pub mod layout_apply;
pub mod fit_text;
pub mod fit_specs;
pub mod measure_impl;

use crate::commands::CommandSpec;
use crate::Session;

const APPLY_PARAMS: &str = r##"{"root":{node} (the node tree to lay out),"options":{"coordinateSpace":"document"|"parent"="document","safeArea":px|[t,r,b,l] px?,"dir":"ltr"|"rtl"="ltr"}?} → {"moved":[{"layer":id,"from":[x,y,w,h],"to":[x,y,w,h]}],"warnings":[str]} — node: {"type":"stack"|"row"|"grid"|"absolute"|"center"|"spacer"|"text"|"image"|"component"|"divider",...}; containers take "children":[node...]; "stack" also "direction":"vertical"|"horizontal", "grid" also "columns":1–24; flow containers take "gap":0–256 px, "padding":px|[vh,lr]|[t,r,b,l] (0–2048), "align":"start"|"center"|"end"|"stretch" (logical — never left/right, §9.5); every node: "layer":id|name (all but spacer), "within":{"layer":id|name}|[x,y,w,h], "anchor":"topLeft".."bottomRight"|"baseline", sizing "width"/"height" px, "grow":true|n≥0, "hug":bool, "percent":1–100, "aspect":w/h, "minWidth"/"maxWidth"/"minHeight"/"maxHeight" px, "x"/"y" inside absolute, "dx"/"dy" inside center, "size" on spacer/divider, "fit":"contain"|"cover"|"fill" on image — solves the tree and moves/resizes the layers in ONE undoable edit; any invalid child ⇒ nothing moves; every placement is clamped to the canvas + safeArea (never out-of-bounds, §9.2); layers already in place are left alone"##;

/// `layout.apply`'s enabled gate: the solver needs a document (its canvas is the container
/// everything is placed and clamped into).
fn has_doc(s: &Session) -> std::result::Result<(), String> {
    s.active().map(|_| ()).ok_or_else(|| "no document open".into())
}

// ---------- the commands ----------

/// The `layout.*` commands this family owns, in one list (§2.3: one `specs()` per module).
/// `layout.apply`'s spec lives here in the parent with its run in [`layout_apply::apply`];
/// `layout.fitText` and `layout.measure` live in [`fit_specs`] and chain in below — the
/// registration patch carries exactly one line for this whole family:
/// `v.extend(crate::layout_cmds::specs());`.
pub fn specs() -> Vec<CommandSpec> {
    let mut v = vec![
        CommandSpec {
            id: "layout.apply",
            label: "Apply Layout",
            menu: &[],
            shortcut: None,
            params: APPLY_PARAMS,
            enabled: has_doc,
            run: layout_apply::apply,
            journal: true,
        },
    ];
    // The fit/measure commands chain in here (the parent-merges shape) — no second
    // registration line for this family in the patch, and no sibling registers itself.
    v.extend(fit_specs::specs());
    v
}

// ---------- compile shape (the submodule tests are the gate; CI owns cargo) ----------
//
// * The signature is exactly what registration/commands-registry.patch.txt registers:
//   `pub fn specs() -> Vec<CommandSpec>` behind `v.extend(crate::layout_cmds::specs());`.
// * apply-engine-patches.sh's pre-flight greps THIS file for a `mod <sib>;` line per
//   sibling `.rs` in this directory (all four declared above) and for the one child that
//   owns commands — `fit_specs::specs()`, chained above — so an undeclared sibling or an
//   unregistered child `specs()` refuses the apply before the vendor tree is touched.
// * The one family-wide measure seam, landed: `layout_apply::apply` coerces
//   `&layout_apply::EngineTextMeasurer` to `&dyn layout_apply::TextMeasurer`, and that
//   engine-side `impl` lives in `measure_impl.rs` (declared above; it delegates to
//   `fit_text`'s production measurer, so the measure modules stay the one home for
//   everything that calls the text stack), never in this parent.
