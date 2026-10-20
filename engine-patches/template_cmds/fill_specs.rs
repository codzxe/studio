//! The `specs()` registration for the template slot-value commands that live in this
//! module's sibling files (§7.4): `template.fill` (`fill.rs`) and `template.validate`
//! (`validate.rs`).
//!
//! # Why a separate file — the registration note
//!
//! `template_cmds.rs` (the catalog: `template.list`/`inspect`/`apply`) is a sibling
//! wave's file and its `specs()` deliberately stays catalog-only (see the note inside
//! it). BOTH of this module pair's commands register through THIS one `specs()`, so
//! the merge upstream is one line in one place, and neither command can end up
//! registered twice:
//!
//! - upstream, `crates/engine/src/template_cmds.rs` declares
//!   `mod fill; mod validate; mod fill_specs;` beside its existing `mod manifest;`
//!   (the Rust 2018 subdirectory layout the applier copies), and
//! - the registration is EITHER `v.extend(fill_specs::specs());` chained inside
//!   `template_cmds::specs()` OR the added line
//!   `v.extend(crate::template_cmds::fill_specs::specs());` in
//!   `registration/commands-registry.patch.txt` — the two sanctioned merge shapes
//!   (`registration/commands-registry.patch.md` § "Submodule specs merges"), and
//!   exactly what `apply-engine-patches.sh`'s pre-flight checks for.
//!
//! Until that declaration lands, this file is inert in the authoring tree (never dead
//! code upstream: the applier refuses to run while a sibling is undeclared, so it
//! cannot be copied into place silently unregistered).
//!
//! Journals: `template.fill` is one batched, coalesced, all-or-nothing mutation
//! (`fill.rs`), so it journals like `template.apply`; `template.validate` is a pure
//! query over the document and the catalog — `journal: false`, like `template.list`
//! and `template.inspect`.
//!
//! Panic-hunt obligations for both commands live in `../tests/README.md`; the
//! command-specific adversarial tests live in `fill.rs` and `validate.rs` — this file
//! owns only the registration, its parameter documentation and the enabled gates.

use crate::commands::CommandSpec;
use crate::file_cmds;
use crate::Session;

use super::fill;
use super::validate;

const FILL_PARAMS: &str = r##"{"slots":{slotName:value}} → {"applied":[slot],"warnings":[{"code","slot","message"}],"errors":[],"template":"id@version"} — one transactional batch over the active document's applied template: text slots take a string or {"text":str} (type.edit + type.setStyle: size clamped into autoFit, declared color/align/leading, trimmed at a user-visible boundary past maxChars); image slots take a path, {"path":str} or {"data":base64,"fileName"?,"focalPoint"?} (placed as a smart object, transformed into the slot bounds with fit/focal, the placeholder replaced); color slots take "#rrggbb"/[r,g,b,a?] (layer.fill.solidColor.set); visibility slots take true/false; component slots take "id@version"/{"id","version"?,"vars"?} (component.place). Unknown slot names and missing required slots are errors listing exactly what is needed (§7.3); unfilled optional slots stay present but hidden — template layers are never deleted"##;

const VALIDATE_PARAMS: &str = r##"{"template":str? (a template id, or "id@version" to pin one: the manifest whose rules are checked),"document":index? (an open document to check; default the active one, or the template's own .pcraft when no document is open)} → {"ok":bool (no blocker, no major),"issues":[{"level":"blocker"|"major"|"minor","code":snake_case,"layer":name?,"message":str,"fix":str}],"template":"id@version"?,"document":index?,"truncated":bool} — the deterministic §7.3/§11.1 rule pass: mustLayers, slot layers and their declared bounds, safeArea, contrast (WCAG hex→relative-luminance; rules.minContrast, else 4.5:1 body / 3:1 at ≥18 pt), maxTextLayers, palette adherence, §10.2 naming; minors never flip ok; pass "template" or "document" (at least one)"##;

/// `template.fill`'s gate: a document must be open. `fill.rs`'s own `enabled` additionally
/// asks the session for an applied template — that record is the one piece of shared
/// state still being reconciled between `manifest.rs` and `fill.rs` (see `fill.rs`'s
/// header contract), so until it lands the registry checks only the document and the
/// command itself refuses with its own "no template is applied to the active document"
/// message, which is the friendlier refusal.
fn has_doc(s: &Session) -> std::result::Result<(), String> {
    s.active().map(|_| ()).ok_or_else(|| "no document open".into())
}

/// The slot-value commands this module pair owns (§7.4's last two rows). Registered
/// exactly once through the merge documented above — the catalog's `specs()`
/// (`template_cmds.rs`) extends with this list; it does not duplicate it.
pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec {
            id: "template.fill",
            label: "Fill Template",
            menu: &[],
            shortcut: None,
            params: FILL_PARAMS,
            enabled: has_doc,
            // One coalesced, all-or-nothing history step (fill.rs restores the
            // document when any step fails) — a mutation, so it journals.
            journal: true,
            run: fill::run,
        },
        CommandSpec {
            id: "template.validate",
            label: "Validate Against Template",
            menu: &[],
            shortcut: None,
            params: VALIDATE_PARAMS,
            // Reads the catalog (PHOTOCRAFT_TEMPLATES_DIR) for the template arm; the
            // document-only arm runs without a directory, and with no document open the
            // template's own .pcraft is linted — so the gate is the filesystem, like
            // template.list/inspect/apply, not an open document.
            enabled: file_cmds::native,
            // Pure query: no document mutation, nothing to journal or undo.
            journal: false,
            run: validate::run,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn specs_cover_the_slot_value_commands_and_only_them() {
        let specs = specs();
        let ids: Vec<&str> = specs.iter().map(|s| s.id).collect();
        assert_eq!(ids, ["template.fill", "template.validate"]);
        // The batch mutates and journals; the validation is a pure query.
        assert!(specs[0].journal, "template.fill is a mutation");
        assert!(!specs[1].journal, "template.validate is a query");
        // Agent-facing: no menu placement, no shortcut (like the catalog's commands).
        for s in &specs {
            assert!(s.menu.is_empty(), "{} must not land in the menus", s.id);
            assert!(s.shortcut.is_none(), "{} must not claim a shortcut", s.id);
        }
    }

    #[test]
    fn params_document_every_argument_the_commands_read() {
        let specs = specs();
        // fill: slots in, applied/warnings/errors/template out (§7.4's row, plus the
        // pin the command log always carries).
        for needle in ["\"slots\"", "applied", "warnings", "errors", "id@version"] {
            assert!(specs[0].params.contains(needle), "template.fill's params lack {needle}");
        }
        // validate: template/document in (either one), ok/issues out.
        for needle in ["\"template\"", "\"document\"", "\"ok\"", "issues", "level", "code", "layer", "message", "fix"] {
            assert!(specs[1].params.contains(needle), "template.validate's params lack {needle}");
        }
    }

    #[test]
    fn enabled_gates_match_their_commands() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let specs = specs();
        let mut s = Session::new();
        // No document open: fill is disabled. Validate stays available — its
        // template-only arm lints the template's own document (author linting).
        assert!(specs[0].enabled(&s).is_err(), "template.fill without a document");
        if !cfg!(target_arch = "wasm32") {
            assert!(specs[1].enabled(&s).is_ok(), "template.validate lints templates without a document");
        }
        s.execute("file.new", json!({ "width": 8, "height": 8, "depth": 8 }))?;
        assert!(specs[0].enabled(&s).is_ok(), "template.fill with a document open");
        assert!(specs[1].enabled(&s).is_ok());
        Ok(())
    }
}
