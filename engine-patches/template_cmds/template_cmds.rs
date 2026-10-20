//! `template.*`: the template catalog — `.pcraft` documents with a JSON manifest beside each
//! (see `manifest.rs`), served as listable, inspectable, applicable structure, so a caller
//! chooses words and the file provides geometry.
//!
//! The templates directory is engine configuration, read at run time like the other engine-wide
//! folder settings: `PHOTOCRAFT_TEMPLATES_DIR` names a folder holding one `<name>.json` +
//! `<name>.pcraft` pair per template (`<id>.json`, `<id>@<version>.json` by convention; the id
//! and version come from the manifest's content, never the file name). Every reply pins the
//! template it used as `id@version`, so the command log always says which version ran.
//!
//! `template.fill` and `template.validate` (slot values against an applied copy, the rules
//! check) live in `fill.rs` and `validate.rs` beside this file and register their own `specs()`
//! at the same site this module's does; see the note in [`specs`].

mod manifest;

use std::path::{Path, PathBuf};

use photocraft_doc::{Document, Layer, LayerId};
use serde_json::{Value, json};

use crate::commands::CommandSpec;
use crate::file_cmds::{self, read_file, str_param};
use crate::{EngineError, Result, Session};
use manifest::TemplateManifest;

// ---------- limits (the directory is untrusted input) ----------

/// A directory serves at most this many templates: catalogs are curated, and a runaway folder
/// must not become a slow scan or a huge reply.
pub(crate) const MAX_TEMPLATES: usize = 256;
/// A manifest bigger than this is not a manifest (a 64-slot catalog is a few kilobytes).
pub(crate) const MAX_MANIFEST_BYTES: u64 = 4 << 20;
/// `"tags"` filters are short lists, not haystacks.
const MAX_QUERY_TAGS: usize = 32;
/// How many `id@version` pins an error lists before "…".
const SHOWN_PINS: usize = 8;

// ---------- errors ----------

fn bad(cmd: &str, msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: cmd.into(), msg: msg.into() }
}

fn no_dir() -> EngineError {
    EngineError::Other(
        "no templates directory is configured: set PHOTOCRAFT_TEMPLATES_DIR to the folder that holds the templates (each is a JSON manifest with its .pcraft document beside it)".into(),
    )
}

// ---------- the catalog on disk ----------

/// One template on disk: its parsed manifest and the `.pcraft` document beside it.
#[derive(Clone)]
pub(crate) struct TemplateFile {
    pub manifest: TemplateManifest,
    /// The manifest's file, as errors and messages name it.
    pub file: String,
    /// The `.pcraft` beside the manifest (same stem).
    pub doc: String,
}

impl TemplateFile {
    /// `id@version`, the pin replies and logs use.
    pub(crate) fn pin(&self) -> String {
        self.manifest.pin()
    }
}

/// What a scan of the directory found: the servable templates, sorted by (id, version), and the
/// files that cannot serve — kept with their reason so a lookup for one of them can explain
/// what is wrong instead of claiming it does not exist.
pub(crate) struct Catalog {
    pub templates: Vec<TemplateFile>,
    /// (manifest file stem, "file: why it cannot serve")
    pub skipped: Vec<(String, String)>,
}

/// The templates directory: `PHOTOCRAFT_TEMPLATES_DIR`. Deployment configuration read at run
/// time, like the other engine-wide folder settings — not session state.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn templates_dir() -> Option<PathBuf> {
    std::env::var_os("PHOTOCRAFT_TEMPLATES_DIR").filter(|v| !v.is_empty()).map(PathBuf::from)
}
#[cfg(target_arch = "wasm32")]
pub(crate) fn templates_dir() -> Option<PathBuf> {
    None
}

/// Every template in `dir` (the layout the module comment describes). Malformed manifests,
/// oversized files and manifests without their `.pcraft` are skipped and remembered, as
/// installed profiles are: one broken template must not hide the rest of the catalog.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn scan(dir: &Path) -> Result<Catalog> {
    let listed = std::fs::read_dir(dir).map_err(|e| EngineError::Other(format!("{}: {e}", dir.display())))?;
    let mut cat = Catalog { templates: Vec::new(), skipped: Vec::new() };
    for entry in listed {
        let entry = entry.map_err(|e| EngineError::Other(format!("{}: {e}", dir.display())))?;
        if cat.templates.len() >= MAX_TEMPLATES {
            break;
        }
        let path = entry.path();
        let is_plain_file = entry.file_type().map_or(false, |t| t.is_file());
        let is_json = path.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("json"));
        if !is_plain_file || !is_json {
            continue;
        }
        let file = path.to_string_lossy().into_owned();
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if std::fs::metadata(&path).map_or(true, |m| m.len() > MAX_MANIFEST_BYTES) {
            cat.skipped.push((stem, format!("{file}: the manifest is unreadable or larger than {} bytes", MAX_MANIFEST_BYTES)));
            continue;
        }
        let bytes = match read_file(&file) {
            Ok(b) => b,
            Err(e) => {
                cat.skipped.push((stem, e.to_string()));
                continue;
            }
        };
        let manifest = match TemplateManifest::from_slice(&bytes) {
            Ok(m) => m,
            Err(e) => {
                cat.skipped.push((stem, e.at(file.as_str()).to_string()));
                continue;
            }
        };
        let doc = path.with_extension("pcraft").to_string_lossy().into_owned();
        if !Path::new(&doc).is_file() {
            cat.skipped.push((stem, format!("{file}: no .pcraft document beside the manifest")));
            continue;
        }
        cat.templates.push(TemplateFile { manifest, file, doc });
    }
    cat.templates.sort_by(|a, b| (&a.manifest.id, a.manifest.version).cmp(&(&b.manifest.id, b.manifest.version)));
    Ok(cat)
}
#[cfg(target_arch = "wasm32")]
pub(crate) fn scan(dir: &Path) -> Result<Catalog> {
    Err(EngineError::Other(format!("cannot read {}: no file system on the web", dir.display())))
}

/// The `id@version` pins of the catalog, for an error that says what there is to choose from.
fn pins(cat: &Catalog) -> String {
    if cat.templates.is_empty() {
        return "no templates at all".into();
    }
    let mut v: Vec<String> = cat.templates.iter().take(SHOWN_PINS).map(|t| t.pin()).collect();
    if cat.templates.len() > SHOWN_PINS {
        v.push("…".into());
    }
    v.join(", ")
}

/// The template `id` at `version` — the newest when `None` — with typed errors that list the
/// candidates, explain broken files, and never panic.
pub(crate) fn resolve(dir: &Path, id: &str, version: Option<u64>) -> Result<TemplateFile> {
    let cat = scan(dir)?;
    let mine: Vec<&TemplateFile> = cat.templates.iter().filter(|t| t.manifest.id == id).collect();
    if mine.is_empty() {
        // A manifest that failed to parse or lost its document still explains itself when its
        // file name is the id asked for (the id lives inside the manifest, which is broken).
        if let Some((_, why)) = cat.skipped.iter().find(|(stem, _)| stem == id || stem.rsplit_once('@').is_some_and(|(base, _)| base == id)) {
            return Err(EngineError::Other(why.clone()));
        }
        return Err(EngineError::Other(format!("no template `{}` in {}; have {}", id, dir.display(), pins(&cat))));
    }
    match version {
        Some(v) => mine
            .into_iter()
            .find(|t| t.manifest.version == v)
            .cloned()
            .ok_or_else(|| {
                let have: Vec<String> = cat
                    .templates
                    .iter()
                    .filter(|t| t.manifest.id == id)
                    .map(|t| format!("@{}", t.manifest.version))
                    .collect();
                EngineError::Other(format!("no version {v} of template `{id}`; have {}", have.join(", ")))
            }),
        None => mine
            .into_iter()
            .max_by_key(|t| t.manifest.version)
            .cloned()
            .ok_or_else(|| EngineError::Other(format!("template `{id}` has no versions"))),
    }
}

// ---------- param helpers ----------

/// `"version"`: absent or `null` (the pin's, or the newest); otherwise a whole number from 1 to
/// 2^53 (JSON floats are honoured only when they are exact whole numbers).
pub(crate) fn version_param(p: &Value, cmd: &str) -> Result<Option<u64>> {
    match p.get("version") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let exact = 2u64.pow(53);
            let n = v.as_u64().or_else(|| {
                let f = v.as_f64()?;
                (f.is_finite() && f >= 1.0 && f.fract() == 0.0 && f <= exact as f64).then_some(f as u64)
            });
            n.map(Some).ok_or_else(|| bad(cmd, format!("`version` must be a whole number from 1 up, got {v}")))
        }
    }
}

/// `"tags"`: a non-empty array of non-empty strings when given (a template matches when it
/// carries every one of them).
fn tag_param(p: &Value, cmd: &str) -> Result<Vec<String>> {
    match p.get("tags") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(a)) => {
            if a.is_empty() {
                return Err(bad(cmd, "pass at least one tag in `tags`, or leave it out to list every template"));
            }
            if a.len() > MAX_QUERY_TAGS {
                return Err(bad(cmd, format!("`tags` lists more than {MAX_QUERY_TAGS} tags")));
            }
            let tags: Option<Vec<String>> =
                a.iter().map(|v| v.as_str().filter(|t| !t.is_empty()).map(str::to_string)).collect();
            tags.ok_or_else(|| bad(cmd, "`tags` must be an array of non-empty strings"))
        }
        Some(_) => Err(bad(cmd, "`tags` must be an array of non-empty strings")),
    }
}

/// The template id and version a command acts on: `"id"` (a plain id, or `id@version`), with an
/// explicit `"version"` overriding the pin.
fn id_param(p: &Value, cmd: &str) -> Result<(String, Option<u64>)> {
    let id = str_param(p, "id", cmd)?;
    let (base, pinned) = manifest::parse_pin(id).map_err(|e| bad(cmd, format!("`id`: {e}")))?;
    Ok((base, version_param(p, cmd)?.or(pinned)))
}

// ---------- layer helpers ----------

/// The topmost layer named `name` — exact, then case-insensitively — as commands resolve
/// `"layer"` params by name.
pub(crate) fn layer_by_name(doc: &Document, name: &str) -> Option<LayerId> {
    let walk = doc.walk();
    let found = walk
        .iter()
        .rev()
        .find(|(_, _, l)| l.name == name)
        .or_else(|| walk.iter().rev().find(|(_, _, l)| l.name.eq_ignore_ascii_case(name)));
    found.map(|(_, _, l)| l.id)
}

/// Every slot's layer id in `doc` (missing entries are the slot names whose layer the document
/// does not have), in the manifest's slot order.
pub(crate) fn slot_ids(doc: &Document, m: &TemplateManifest) -> (Vec<(String, LayerId)>, Vec<String>) {
    let mut ids = Vec::new();
    let mut missing = Vec::new();
    for (name, slot) in &m.slots {
        match layer_by_name(doc, slot.layer()) {
            Some(id) => ids.push((name.clone(), id)),
            None => missing.push(name.clone()),
        }
    }
    (ids, missing)
}

/// Fresh copies of `layers` — ids re-assigned recursively, as Duplicate Layer does, so the
/// copies never collide with ids already in the destination — with the old→new id pairs they
/// carry, in `walk()` order.
fn fresh_copies(layers: &[Layer]) -> Result<(Vec<Layer>, std::collections::BTreeMap<u64, u64>)> {
    let mut map = std::collections::BTreeMap::new();
    let mut out = Vec::with_capacity(layers.len());
    for l in layers {
        let copy = l.duplicate();
        zip_ids(l, &copy, 0, &mut map)?;
        out.push(copy);
    }
    Ok((out, map))
}

/// Record the old→new id pair of `orig` and its (recursively identical) copy `copy`, bounded by
/// the document group limit.
fn zip_ids(orig: &Layer, copy: &Layer, depth: usize, map: &mut std::collections::BTreeMap<u64, u64>) -> Result<()> {
    if depth > photocraft_doc::MAX_GROUP_DEPTH {
        return Err(EngineError::Other(format!("the template nests deeper than {} groups", photocraft_doc::MAX_GROUP_DEPTH)));
    }
    map.insert(orig.id.0, copy.id.0);
    match (orig.children(), copy.children()) {
        (Some(a), Some(b)) if a.len() == b.len() => {
            for (a, b) in a.iter().zip(b) {
                zip_ids(a, b, depth + 1, map)?;
            }
            Ok(())
        }
        (None, None) => Ok(()),
        // Unreachable while duplicate() keeps the tree shape; a typed error, never a panic.
        _ => Err(EngineError::Other("the template's layers changed shape while copying".into())),
    }
}

/// The canvas-mismatch warning both `template.inspect` and `template.apply` report.
fn canvas_warnings(m: &TemplateManifest, doc: &Document) -> Vec<String> {
    let (mw, mh) = (m.canvas.width, m.canvas.height);
    let (dw, dh) = (doc.size.width, doc.size.height);
    (mw != dw || mh != dh).then(|| format!("the manifest's canvas is {mw}×{mh} but the document is {dw}×{dh}")).into_iter().collect()
}

// ---------- template.list ----------

/// `template.list`'s core: the catalog rows of `dir`, filtered by tags (all of them) and a
/// case-insensitive substring over id, name and description.
pub(crate) fn list_from(dir: &Path, tags: &[String], query: Option<&str>) -> Result<Value> {
    let cat = scan(dir)?;
    let q = query.map(str::to_lowercase);
    let rows: Vec<Value> = cat
        .templates
        .iter()
        .filter(|t| tags.iter().all(|tag| t.manifest.tags.iter().any(|own| own.eq_ignore_ascii_case(tag))))
        .filter(|t| {
            q.as_ref().is_none_or(|q| {
                let hay = format!("{} {} {}", t.manifest.id, t.manifest.name, t.manifest.description.as_deref().unwrap_or_default()).to_lowercase();
                hay.contains(q)
            })
        })
        .map(|t| {
            json!({
                "id": t.manifest.id,
                "name": t.manifest.name,
                "version": t.manifest.version,
                "tags": t.manifest.tags,
                "canvas": {"width": t.manifest.canvas.width, "height": t.manifest.canvas.height},
                "slots": t.manifest.slots.keys().collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({"templates": rows}))
}

fn list(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "template.list";
    let tags = tag_param(p, CMD)?;
    let query = match p.get("query") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let q = v.as_str().ok_or_else(|| bad(CMD, "`query` must be a string"))?;
            if q.is_empty() {
                return Err(bad(CMD, "`query` must not be empty (leave it out to list every template)"));
            }
            Some(q)
        }
    };
    let dir = templates_dir().ok_or_else(no_dir)?;
    list_from(&dir, &tags, query)
}

// ---------- template.inspect ----------

/// `template.inspect`'s core: the full manifest plus what its document actually holds.
pub(crate) fn inspect_from(dir: &Path, id: &str, version: Option<u64>) -> Result<Value> {
    let t = resolve(dir, id, version)?;
    let manifest_json = serde_json::to_value(&t.manifest)
        .map_err(|e| EngineError::Other(format!("{}: the manifest cannot be re-serialised: {e}", t.file)))?;
    let bytes = read_file(&t.doc)?;
    let doc = file_cmds::import(&t.doc, &bytes)?;
    let (ids, missing) = slot_ids(&doc, &t.manifest);
    let slot_layers: serde_json::Map<String, Value> = ids
        .into_iter()
        .map(|(name, id)| {
            let slot = t.manifest.slots.get(&name);
            (
                name,
                json!({
                    "layer": id.0,
                    "kind": slot.map(|s| s.kind()),
                    "optional": slot.map(|s| s.optional()),
                }),
            )
        })
        .collect();
    let mut warnings = canvas_warnings(&t.manifest, &doc);
    for l in &t.manifest.rules.must_layers {
        if layer_by_name(&doc, l).is_none() {
            warnings.push(format!("rules.mustLayers: the template document has no layer named \"{l}\""));
        }
    }
    Ok(json!({
        "id": t.pin(),
        "manifest": manifest_json,
        "document": {"name": doc.name, "width": doc.size.width, "height": doc.size.height, "layers": doc.walk().len()},
        "slotLayers": Value::Object(slot_layers),
        "missing": missing,
        "warnings": warnings,
    }))
}

fn inspect(_s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "template.inspect";
    let (id, version) = id_param(p, CMD)?;
    let dir = templates_dir().ok_or_else(no_dir)?;
    inspect_from(&dir, &id, version)
}

// ---------- template.apply ----------

/// `template.apply`'s core. Without an open document the copy becomes a new untitled one (as
/// opening a template file does); with one, the copy's layers land above the active layer —
/// in one group with `as_group` — converted to the document's colour and bit depth exactly as a
/// layer copy between documents is. One undoable history step either way.
pub(crate) fn apply_from(s: &mut Session, dir: &Path, id: &str, version: Option<u64>, name: Option<&str>, as_group: bool) -> Result<Value> {
    const LABEL: &str = "Apply Template";
    let t = resolve(dir, id, version)?;
    let bytes = read_file(&t.doc)?;
    let mut tpl = file_cmds::import(&t.doc, &bytes)?;
    if tpl.layers.is_empty() {
        return Err(EngineError::Other(format!("{}: the template document has no layers", t.doc)));
    }
    let mut warnings = canvas_warnings(&t.manifest, &tpl);
    let name = name.filter(|n| !n.trim().is_empty());

    // No document open: the copy itself becomes a new, untitled document (never holding the
    // template's path, so a save cannot write over the template).
    if s.active().is_none() {
        tpl.name = name.map(str::to_string).unwrap_or_else(|| t.manifest.name.clone());
        let (index, _) = s.open_document(tpl, None);
        let d = s.documents().get(index).ok_or(EngineError::NoDocument)?;
        let (slots, missing) = slot_ids(&d.doc, &t.manifest);
        let slots: serde_json::Map<String, Value> = slots.into_iter().map(|(name, id)| (name, json!(id.0))).collect();
        return Ok(json!({
            "document": index,
            "document_revision": d.revision,
            "group_id": null,
            "slots": Value::Object(slots),
            "missing": missing,
            "warnings": warnings,
        }));
    }

    // Into the open document. Templates are layered documents, like the ones layers copy
    // between; anything else cannot take part.
    if !crate::layer_copy_cmds::layered(tpl.mode) {
        return Err(EngineError::Other(format!("{}: the template document is a {:?} document, whose layers cannot be copied", t.doc, tpl.mode)));
    }
    let dest = s.active().ok_or(EngineError::NoDocument)?.doc.clone();
    if !crate::layer_copy_cmds::layered(dest.mode) {
        return Err(EngineError::Other(format!("the open document is a {:?} document, whose layers cannot take the template's", dest.mode)));
    }
    crate::layer_copy_cmds::adapt_copies(s, &mut tpl, &dest)?;
    let (template_slots, mut missing) = slot_ids(&tpl, &t.manifest);
    let (mut copies, id_map) = fresh_copies(&tpl.layers)?;
    let mut slots = serde_json::Map::new();
    for (name, old) in template_slots {
        match id_map.get(&old.0) {
            Some(&new) => {
                slots.insert(name, json!(new));
            }
            // The layer was part of the copy; unreachable unless the tree changed shape.
            None => missing.push(name),
        }
    }
    let patterns: Vec<_> = tpl.patterns.iter().filter(|pat| !dest.patterns.iter().any(|d| d.id == pat.id)).cloned().collect();

    let group_id = if as_group {
        let group_name = name.map(str::to_string).unwrap_or_else(|| t.manifest.name.clone());
        let group = Layer::group(group_name, copies);
        let gid = s.edit(LABEL, |doc, active| {
            let gid = doc.insert_above(*active, group);
            crate::layer_multi_cmds::check_group_depth(doc, LABEL)?;
            *active = Some(gid);
            Ok(gid)
        })?;
        crate::layer_multi_cmds::reselect(s, vec![gid], Some(gid));
        Some(gid.0)
    } else {
        // A lone copy takes the given name, as Duplicate Layer does.
        if let (Some(n), 1) = (name, copies.len()) {
            if let Some(l) = copies.first_mut() {
                l.name = n.to_string();
            }
        }
        let made = s.edit(LABEL, |doc, active| {
            let mut above = *active;
            let mut made = Vec::with_capacity(copies.len());
            for l in copies.drain(..) {
                let id = doc.insert_above(above, l);
                above = Some(id);
                made.push(id);
            }
            *active = above;
            Ok(made)
        })?;
        let last = made.last().copied();
        crate::layer_multi_cmds::reselect(s, made, last);
        last.map(|id| id.0)
    };

    let revision = s.active().ok_or(EngineError::NoDocument)?.revision;
    Ok(json!({
        "document_revision": revision,
        "group_id": group_id,
        "slots": Value::Object(slots),
        "missing": missing,
        "warnings": warnings,
    }))
}

fn apply(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "template.apply";
    let (id, version) = id_param(p, CMD)?;
    let name = p.get("name").and_then(Value::as_str);
    let as_group = match p.get("asGroup") {
        None | Some(Value::Null) => false,
        Some(v) => v.as_bool().ok_or_else(|| bad(CMD, "`asGroup` must be true or false"))?,
    };
    let dir = templates_dir().ok_or_else(no_dir)?;
    apply_from(s, &dir, &id, version, name, as_group)
}

// ---------- the commands ----------

pub fn specs() -> Vec<CommandSpec> {
    // `template.fill` and `template.validate` are the slot-value engine over an applied copy:
    // they live in fill.rs and validate.rs beside this file, with their own `specs()` registered
    // at the same site this one is (the registry patch), so the catalog stays separate from the
    // filler. Nothing of theirs is stubbed here.
    vec![
        CommandSpec {
            id: "template.list",
            label: "List Templates",
            menu: &[],
            shortcut: None,
            params: r##"{"tags":[str]?,"query":str?} → {"templates":[{"id","name","version","tags","canvas":{"width","height"},"slots":[slot]}]} (a template matches when it carries every tag in "tags"; "query" matches its id, name or description, both case-insensitive; the directory is PHOTOCRAFT_TEMPLATES_DIR, one JSON manifest and its .pcraft per template)"##,
            enabled: crate::file_cmds::native,
            run: list,
            journal: false,
        },
        CommandSpec {
            id: "template.inspect",
            label: "Inspect Template",
            menu: &[],
            shortcut: None,
            params: r##"{"id":str (a template id, or "id@version" to pin one),"version":n? (the pin's version, else the newest)} → {"id":"id@version","manifest":the manifest,"document":{"name","width","height","layers"},"slotLayers":{slot:{"layer","kind","optional"}},"missing":[slot],"warnings":[str]}"##,
            enabled: crate::file_cmds::native,
            run: inspect,
            journal: false,
        },
        CommandSpec {
            id: "template.apply",
            label: "Apply Template",
            menu: &[],
            shortcut: None,
            params: r##"{"id":str,"version":n?,"name":str? (the new group's, layer's or document's name),"asGroup":bool=false (the copy's layers in one group)} → {"document_revision":n,"group_id":layerId?,"slots":{slot:layerId},"missing":[slot],"warnings":[str]} (no document open: the copy becomes one, named by the manifest or "name"; with one open: the copy's layers land above the active layer, converted as a layer copy between documents)"##,
            enabled: crate::file_cmds::native,
            run: apply,
            journal: true,
        },
    ]
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    /// A template manifest of the documented shape, with the five slots the fixture document
    /// below carries (the same example `manifest.rs`'s tests parse).
    const MANIFEST: &str = r#"{
        "id": "instagram-post", "version": 3, "name": "Instagram Post — Promo",
        "description": "A bold product or offer post with a photo, headline, subhead and optional logo.",
        "tags": ["social", "promo", "square"],
        "canvas": { "width": 1080, "height": 1080, "background": "#F4E7D3" },
        "slots": {
            "photo":    { "kind": "image", "layer": "Photo",    "bounds": [0, 0, 1080, 700],
                          "fit": "cover", "minPixels": [1080, 700], "optional": false },
            "headline": { "kind": "text",  "layer": "Headline", "bounds": [72, 732, 936, 176],
                          "font": "display", "weight": "bold", "size": 96, "lineHeight": 1.05,
                          "maxLines": 2, "maxChars": 42, "align": "left",
                          "color": "#3B2A20", "autoFit": { "minSize": 56, "maxSize": 110 } },
            "subhead":  { "kind": "text",  "layer": "Subhead",  "bounds": [72, 924, 936, 56],
                          "font": "sans", "size": 36, "maxLines": 1, "maxChars": 60, "color": "#6B5748" },
            "badge":    { "kind": "component", "component": "offer-badge@2", "layer": "Badge",
                          "bounds": [828, 72, 180, 180], "optional": true,
                          "vars": { "label": "20% OFF" } },
            "logo":     { "kind": "image", "layer": "Logo", "bounds": [888, 984, 120, 40],
                          "fit": "contain", "optional": true }
        },
        "rules": {
            "safeArea": 48, "minContrast": 4.5,
            "mustLayers": ["Background", "Photo", "Headline"],
            "maxTextLayers": 6,
            "palette": ["#F4E7D3", "#3B2A20", "#D96C3B"]
        },
        "layerMap": {
            "Background": { "role": "background", "fill": "#F4E7D3" },
            "Photo":      { "role": "image", "mask": "rounded", "maskRadius": 0 },
            "Headline":   { "role": "headline" },
            "Subhead":    { "role": "supporting-text" },
            "Badge":      { "role": "component", "component": "offer-badge@2" },
            "Logo":       { "role": "logo" }
        },
        "thumbnail": "thumbnails/instagram-post@3.png",
        "license": "workspace",
        "author": "templates"
    }"#;

    /// The same manifest at version 2 (what resolve finds when a version is not pinned).
    const MANIFEST_V2: &str = r#"{
        "id": "instagram-post", "version": 2, "name": "Instagram Post — Promo (v2)",
        "canvas": { "width": 1080, "height": 1080 },
        "slots": {
            "photo": { "kind": "image", "layer": "Photo", "bounds": [0, 0, 1080, 700], "fit": "cover" },
            "ghost": { "kind": "visibility", "layer": "Ghost", "optional": true }
        },
        "rules": { "mustLayers": ["Photo"] }
    }"#;

    /// A manifest with no `.pcraft` beside it.
    const MANIFEST_LOST: &str = r#"{ "id": "lost", "version": 1, "name": "Lost", "canvas": { "width": 8, "height": 8 } }"#;

    /// The template document both fixtures describe: the manifest's slots and mustLayers by name.
    fn template_doc() -> Document {
        let mut doc = Document::new("Instagram Post", photocraft_doc::Size::new(1080, 1080), photocraft_color::ColorMode::Rgb, photocraft_color::SampleType::U8);
        for name in ["Background", "Photo", "Headline", "Subhead", "Badge", "Logo"] {
            doc.layers.push(Layer::raster(name, doc.pixel_format()));
        }
        doc
    }

    /// A document of a different size than the templates (the canvas-mismatch warning path).
    fn small_doc() -> Document {
        Document::new("scratch", photocraft_doc::Size::new(64, 48), photocraft_color::ColorMode::Rgb, photocraft_color::SampleType::U8)
    }

    /// The error of `r`, or the test fails with `why` (an `Err` result — no `unwrap` here).
    fn must_err<T: std::fmt::Debug, E: std::fmt::Debug>(
        r: std::result::Result<T, E>,
        why: impl std::fmt::Display,
    ) -> std::result::Result<E, Box<dyn std::error::Error>> {
        match r {
            Err(e) => Ok(e),
            Ok(v) => Err(format!("{why}: expected Err, got Ok({v:?})").into()),
        }
    }

    fn rows(v: &Value) -> std::result::Result<&Vec<Value>, Box<dyn std::error::Error>> {
        v.get("templates").and_then(Value::as_array).ok_or_else(|| "no templates array".into())
    }

    fn u64_of(v: &Value, key: &str) -> std::result::Result<u64, Box<dyn std::error::Error>> {
        v.get(key).and_then(Value::as_u64).ok_or_else(|| format!("no {key}").into())
    }

    #[test]
    fn specs_cover_the_catalog_and_only_it() {
        let specs = specs();
        let ids: Vec<&str> = specs.iter().map(|s| s.id).collect();
        assert_eq!(ids, ["template.list", "template.inspect", "template.apply"]);
        // Queries never journal; the edit does.
        assert!(!specs[0].journal);
        assert!(!specs[1].journal);
        assert!(specs[2].journal);
        // Every param the commands read is documented (strict-param hygiene).
        assert!(specs[0].params.contains("\"tags\"") && specs[0].params.contains("\"query\""));
        assert!(specs[1].params.contains("\"id\"") && specs[1].params.contains("\"version\""));
        assert!(specs[2].params.contains("\"id\"") && specs[2].params.contains("\"version\"") && specs[2].params.contains("\"asGroup\""));
    }

    #[test]
    fn params_are_validated_before_anything_touches_disk_or_env() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let mut s = Session::new();
        // list
        for p in [
            json!({"tags": "social"}),
            json!({"tags": []}),
            json!({"tags": [""]}),
            json!({"tags": ["social", ""]}),
            json!({"tags": (0..MAX_QUERY_TAGS + 1).map(|i| i.to_string()).collect::<Vec<_>>()}),
            json!({"query": ""}),
            json!({"query": 42}),
            json!({"tags": {"a": "b"}}),
        ] {
            assert!(list(&mut s, &p).is_err_and(|e| e.to_string().contains("template.list")), "{p}");
        }
        // inspect / apply: the id and the version.
        for p in [
            json!({}),
            json!({"id": ""}),
            json!({"id": 42}),
            json!({"id": "../escape"}),
            json!({"id": "x@", "version": 1}),
            json!({"id": "x", "version": 0}),
            json!({"id": "x", "version": -1}),
            json!({"id": "x", "version": 2.5}),
            json!({"id": "x", "version": "3"}),
            json!({"id": "x", "version": [3]}),
        ] {
            assert!(inspect(&mut s, &p).is_err_and(|e| e.to_string().contains("template.inspect")), "{p}");
            assert!(apply(&mut s, &p).is_err_and(|e| e.to_string().contains("template.apply")), "{p}");
        }
        assert!(apply(&mut s, &json!({"id": "x", "asGroup": "yes"})).is_err_and(|e| e.to_string().contains("asGroup")));
        assert!(apply(&mut s, &json!({"id": "x", "asGroup": 1})).is_err_and(|e| e.to_string().contains("asGroup")));
        // With no directory configured, well-formed params are the env error, not a panic.
        for cmd in ["template.list", "template.inspect", "template.apply"] {
            let e = match cmd {
                "template.list" => list(&mut s, &json!({})),
                "template.inspect" => inspect(&mut s, &json!({"id": "x"})),
                _ => apply(&mut s, &json!({"id": "x"})),
            };
            let e = must_err(e, format!("{cmd} ran without a directory"))?;
            assert!(e.to_string().contains("PHOTOCRAFT_TEMPLATES_DIR"), "{cmd}: {e}");
        }
        Ok(())
    }

    #[test]
    fn versions_accept_whole_floats_and_refuse_the_rest() -> std::result::Result<(), Box<dyn std::error::Error>> {
        assert_eq!(version_param(&json!({}), "t")?, None);
        assert_eq!(version_param(&json!({"version": null}), "t")?, None);
        assert_eq!(version_param(&json!({"version": 2}), "t")?, Some(2));
        // A JSON `2.0` is the whole number 2 (UIs send floats); fractions are not versions.
        assert_eq!(version_param(&json!({"version": 2.0}), "t")?, Some(2));
        assert_eq!(version_param(&serde_json::from_str::<Value>(r#"{"version":1e3}"#)?, "t")?, Some(1000));
        for p in [
            json!({"version": 0}),
            json!({"version": -1}),
            json!({"version": 2.5}),
            json!({"version": "3"}),
            json!({"version": 1e30}),
            json!({"version": [1]}),
        ] {
            let e = must_err(version_param(&p, "t"), format!("accepted {p}"))?;
            assert!(e.to_string().contains("version"), "{p}: {e}");
        }
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn fixture_dir() -> std::result::Result<tempfile::TempDir, Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        std::fs::write(dir.path().join("instagram-post.json"), MANIFEST.as_bytes())?;
        std::fs::write(dir.path().join("instagram-post@2.json"), MANIFEST_V2.as_bytes())?;
        std::fs::write(dir.path().join("instagram-post.pcraft"), &photocraft_format::save_to_bytes(&template_doc(), &Default::default())?)?;
        std::fs::write(dir.path().join("instagram-post@2.pcraft"), &photocraft_format::save_to_bytes(&template_doc(), &Default::default())?)?;
        std::fs::write(dir.path().join("broken.json"), b"{")?;
        std::fs::write(dir.path().join("lost.json"), MANIFEST_LOST.as_bytes())?;
        Ok(dir)
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn list_scans_and_filters_the_catalog() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = fixture_dir()?;
        // The broken and lost manifests are skipped, not fatal.
        let all = list_from(dir.path(), &[], None)?;
        assert_eq!(rows(&all)?.len(), 2);
        let row = rows(&all)?.first().ok_or("no row")?;
        assert_eq!(row.get("id").and_then(Value::as_str), Some("instagram-post"));
        assert_eq!(u64_of(row, "version")?, 2);
        assert_eq!(row.get("name").and_then(Value::as_str), Some("Instagram Post — Promo (v2)"));
        assert_eq!(row.get("canvas").and_then(|c| c.get("width")).and_then(Value::as_u64), Some(1080));
        let slots = row.get("slots").and_then(Value::as_array).ok_or("no slots")?;
        assert_eq!(slots.len(), 2, "{row}");
        assert_eq!(slots.iter().map(|s| s.as_str()).collect::<Vec<_>>(), [Some("ghost"), Some("photo")]);
        // Tags: all of them, case-insensitively.
        let social = list_from(dir.path(), &["SOCIAL".into()], None)?;
        assert_eq!(rows(&social)?.len(), 2);
        let none = list_from(dir.path(), &["nonsense".into()], None)?;
        assert!(rows(&none)?.is_empty());
        // Query: substring over id, name and description, case-insensitively.
        let promo = list_from(dir.path(), &[], Some("PROMO"))?;
        assert_eq!(rows(&promo)?.len(), 2);
        let youtube = list_from(dir.path(), &[], Some("youtube"))?;
        assert!(rows(&youtube)?.is_empty());
        let astral = list_from(dir.path(), &[], Some("🫩🫩"))?;
        assert!(rows(&astral)?.is_empty());
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn resolve_pins_versions_and_explains_what_is_wrong() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = fixture_dir()?;
        let newest = resolve(dir.path(), "instagram-post", None)?;
        assert_eq!(newest.manifest.version, 3);
        let pinned = resolve(dir.path(), "instagram-post", Some(2))?;
        assert_eq!(pinned.manifest.version, 2);
        assert_eq!(pinned.pin(), "instagram-post@2");
        let e = must_err(resolve(dir.path(), "instagram-post", Some(99)), "served a missing version")?;
        assert!(e.to_string().contains("no version 99"), "{e}");
        assert!(e.to_string().contains("@2, @3"), "{e}");
        let e = must_err(resolve(dir.path(), "youtube-thumb", None), "served a missing template")?;
        assert!(e.to_string().contains("no template `youtube-thumb`"), "{e}");
        assert!(e.to_string().contains("instagram-post@2, instagram-post@3"), "{e}");
        // A broken manifest explains itself when asked for by its file name.
        let e = must_err(resolve(dir.path(), "broken", None), "served a broken manifest")?;
        assert!(e.to_string().contains("not valid JSON"), "{e}");
        // A manifest without its document says so.
        let e = must_err(resolve(dir.path(), "lost", None), "served a manifest without a document")?;
        assert!(e.to_string().contains("no .pcraft document"), "{e}");
        // A missing directory is a typed error.
        let missing = std::env::temp_dir().join(format!("templates-absent-{}", std::process::id()));
        let e = must_err(list_from(&missing, &[], None), "listed a missing directory")?;
        assert!(e.to_string().contains("templates-absent"), "{e}");
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn inspect_reports_the_manifest_and_what_its_document_holds() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = fixture_dir()?;
        let r = inspect_from(dir.path(), "instagram-post", Some(3))?;
        assert_eq!(r.get("id").and_then(Value::as_str), Some("instagram-post@3"));
        assert_eq!(r.get("manifest").and_then(|m| m.get("version")).and_then(Value::as_u64), Some(3));
        let document = r.get("document").ok_or("no document info")?;
        assert_eq!(document.get("width").and_then(Value::as_u64), Some(1080));
        assert_eq!(document.get("layers").and_then(Value::as_u64), Some(6));
        let slots = r.get("slotLayers").and_then(Value::as_object).ok_or("no slotLayers")?;
        assert_eq!(slots.len(), 5);
        let photo = slots.get("photo").ok_or("no photo")?;
        assert_eq!(photo.get("kind").and_then(Value::as_str), Some("image"));
        assert_eq!(photo.get("optional").and_then(Value::as_bool), Some(false));
        assert!(photo.get("layer").and_then(Value::as_u64).is_some());
        assert!(r.get("missing").and_then(Value::as_array).is_some_and(|m| m.is_empty()), "{r}");
        // The v2 manifest's Ghost slot is not in the document, and it is reported.
        let r = inspect_from(dir.path(), "instagram-post", Some(2))?;
        let missing = r.get("missing").and_then(Value::as_array).ok_or("no missing")?;
        assert_eq!(missing.iter().map(|m| m.as_str()).collect::<Vec<_>>(), [Some("ghost")]);
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn apply_into_a_document_groups_and_maps_slots() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = fixture_dir()?;
        let mut s = Session::new();
        s.add_document(small_doc(), None);
        let before = s.active().ok_or("no doc")?.doc.layers.len();
        let revision = s.active().ok_or("no doc")?.revision;
        let r = apply_from(&mut s, dir.path(), "instagram-post", Some(3), Some("Promo group"), true)?;
        let gid = u64_of(&r, "group_id")?;
        assert_eq!(u64_of(&r, "document_revision")?, revision + 1);
        let group = s.active().ok_or("no doc")?.doc.layer(LayerId(gid)).ok_or("no group layer")?;
        let children = group.children().ok_or("the copy is not a group")?;
        assert_eq!(children.len(), 6);
        assert_eq!(group.name, "Promo group");
        let slots = r.get("slots").and_then(Value::as_object).ok_or("no slots")?;
        assert_eq!(slots.len(), 5, "{r}");
        assert!(r.get("missing").and_then(Value::as_array).is_some_and(|m| m.is_empty()), "{r}");
        // Every slot's layer id is inside the copied group.
        let doc = &s.active().ok_or("no doc")?.doc;
        for id in slots.values().filter_map(Value::as_u64) {
            assert!(doc.layer(LayerId(id)).is_some(), "slot layer {id} is not in the document");
        }
        // The template's canvas differs from the document's: the warning says so.
        let warnings = r.get("warnings").and_then(Value::as_array).ok_or("no warnings")?;
        assert!(warnings.iter().any(|w| w.as_str().is_some_and(|w| w.contains("1080×1080"))), "{r}");
        // One history step, undone in one go.
        assert!(s.undo());
        assert_eq!(s.active().ok_or("no doc")?.doc.layers.len(), before);
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn apply_without_a_document_opens_a_copy() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = fixture_dir()?;
        let mut s = Session::new();
        let r = apply_from(&mut s, dir.path(), "instagram-post", Some(3), Some("My copy"), false)?;
        assert_eq!(r.get("document").and_then(Value::as_u64), Some(0));
        assert_eq!(u64_of(&r, "document_revision")?, 1);
        assert!(r.get("group_id").and_then(Value::as_u64).is_none(), "{r}");
        let d = s.documents().first().ok_or("no document was opened")?;
        assert_eq!(d.doc.name, "My copy");
        assert!(d.doc.layers.len() >= 6);
        assert!(d.path.is_none(), "the copy must not adopt the template's file");
        let slots = r.get("slots").and_then(Value::as_object).ok_or("no slots")?;
        for id in slots.values().filter_map(Value::as_u64) {
            assert!(d.doc.layer(LayerId(id)).is_some(), "slot layer {id} is not in the copy");
        }
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn apply_without_as_group_lands_the_layers_loose() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = fixture_dir()?;
        let mut s = Session::new();
        s.add_document(template_doc(), None);
        let before = s.active().ok_or("no doc")?.doc.layers.len();
        let r = apply_from(&mut s, dir.path(), "instagram-post", Some(3), None, false)?;
        assert!(r.get("group_id").and_then(Value::as_u64).is_none(), "{r}");
        assert_eq!(s.active().ok_or("no doc")?.doc.layers.len(), before + 6);
        // No version pinned: the newest applies — v3, whose slots all resolve, not @2's ghost.
        let r = apply_from(&mut s, dir.path(), "instagram-post", None, None, true)?;
        let missing = r.get("missing").and_then(Value::as_array).ok_or("no missing")?;
        assert!(missing.is_empty(), "the newest version was not the default: {r}");
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn apply_reports_missing_slot_layers_and_bad_documents() -> std::result::Result<(), Box<dyn std::error::Error>> {
        // v2's Ghost slot is in no document.
        let dir = fixture_dir()?;
        let mut s = Session::new();
        let r = apply_from(&mut s, dir.path(), "instagram-post", Some(2), None, false)?;
        let missing = r.get("missing").and_then(Value::as_array).ok_or("no missing")?;
        assert_eq!(missing.iter().map(|m| m.as_str()).collect::<Vec<_>>(), [Some("ghost")]);
        let slots = r.get("slots").and_then(Value::as_object).ok_or("no slots")?;
        assert_eq!(slots.len(), 1);

        // A corrupt .pcraft is a typed error with the file in it.
        let bad = tempfile::tempdir()?;
        std::fs::write(bad.path().join("corrupt.json"), MANIFEST.as_bytes())?;
        std::fs::write(bad.path().join("corrupt.pcraft"), b"not a pcraft at all")?;
        let mut s = Session::new();
        let e = must_err(apply_from(&mut s, bad.path(), "instagram-post", None, None, false), "applied a corrupt document")?;
        assert!(e.to_string().contains("corrupt.pcraft"), "{e}");
        // A manifest whose document went missing.
        let e = must_err(apply_from(&mut s, dir.path(), "lost", None, None, false), "applied without a document file")?;
        assert!(e.to_string().contains("no .pcraft document"), "{e}");
        Ok(())
    }

    /// The whole command path, driven through `Session::execute` in a child process (the
    /// directory is process-wide configuration, so the env var is set there; the child runs the
    /// body, the parent starts it and checks it passed).
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn list_serves_the_configured_directory() -> std::result::Result<(), Box<dyn std::error::Error>> {
        const CHILD: &str = "PHOTOCRAFT_TEST_TEMPLATES_CHILD";
        const TEST: &str = "template_cmds::tests::list_serves_the_configured_directory";
        if std::env::var_os(CHILD).is_some() {
            let dir = std::env::var_os("PHOTOCRAFT_TEMPLATES_DIR")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .ok_or("the child was spawned without a templates directory")?;
            let mut s = Session::new();
            let r = s.execute("template.list", json!({}))?;
            let n = rows(&r)?.len();
            assert_eq!(n, 2, "expected the two fixture templates of {dir:?}");
            assert!(s.journal.is_empty(), "a query must not journal: {:?}", s.journal);
            return Ok(());
        }
        let dir = fixture_dir()?;
        let status = std::process::Command::new(std::env::current_exe()?)
            .args(["--exact", TEST, "--nocapture"])
            .env(CHILD, "1")
            .env("PHOTOCRAFT_TEMPLATES_DIR", dir.path())
            .status()?;
        assert!(status.success(), "the child listing failed: {status}");
        Ok(())
    }
}

