//! Components (spec §8): named, versioned, variable-driven layer groups that can be
//! placed into documents and updated per instance.
//!
//! ## What is reused, not reinvented (§8.1)
//!
//! * Placing **copies the master's layer stack into the active document** with fresh
//!   layer ids. Smart-object layers keep their `SmartContentsId`, so every instance of
//!   a component shares the master's smart-object contents — the engine's own sharing
//!   primitive (`layer.smartObjects.newSmartObjectViaCopy` shows the split: duplicates
//!   share, fresh ids don't).
//! * Text and visibility variables ride the engine's variables/data-set model
//!   (`image.variables.define`'s `Variables.defs`, one data set per instance, applied
//!   through the public `image.applyDataSet` command — one history step, exactly like a
//!   template's variables).
//! * Colours are applied directly by this module: the engine's data sets have no
//!   colour kind, so a `color` variable recolours the bound layer's solid fill, shape
//!   fill or type colour itself (see [`recolor_layer`]) and the canonical hex is kept
//!   in the instance's variable state. Gradient/pattern fills and pixel layers are
//!   reported as warnings, never clobbered.
//! * Alternative states (`comps`) are the master document's layer comps (`layerComp.*`);
//!   `component.inspect` lists them, the instance carries the master's comps with it.
//!
//! ## Instances
//!
//! `component.place` wraps the copy in one group — the *instance* — tagged with a
//! `cmpn` PSD block (the lossless round-trip slot on `Layer::psd_blocks`), so the
//! instance survives save/load with its identity: component id, placed version, the
//! variable state, the variable → layer bindings and the placement transform (a scale
//! plus an offset; place never rotates). `component.setVars` and
//! `component.updateInstance` find instances by group id or name and never mistake an
//! ordinary group for one.
//!
//! ## The master is never mutated (§8.4)
//!
//! Master files are opened read-only, in memory, as the *source of a copy*; nothing in
//! this module writes to the components directory, and the master document is never
//! registered in the session, so it cannot be saved over. All five commands mutate only
//! the active document. Untrusted sessions additionally gate every master-file read
//! through `Session::authorize`, like the other file-reading commands.
//!
//! ## Updates are opt-in and never silent (§8.4)
//!
//! `component.updateInstance` is the per-instance opt-in. It re-bases the instance's
//! contents on the latest master version, keeping the instance's outer placement and
//! re-applying its variable state; edits the user made outside the declared variables
//! are *detected* against the placed version and reported in `userChanges` — the update
//! proceeds only because the user asked for it, and nothing it discards goes
//! unmentioned.
//!
//! ## `component.publish` (later phase)
//!
//! Returns a typed [`EngineError::Disabled`] "not yet available" that also spells out
//! the planned semantics, rather than a fake success shape clients would build on.
//!
//! ## Components directory
//!
//! `<root>/<id>/component.json` (the §8.2 manifest) plus
//! `<root>/<id>/<id>@<version>.pcraft` master documents, one per version. The root is
//! `PHOTOCRAFT_COMPONENTS_DIR` when set (the automation gateway points it at a
//! per-tenant directory), else `./components`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use photocraft_algo::transform::{Homography, Interp};
use photocraft_color::Color;
use photocraft_doc::variables::Value as VarValue;
use photocraft_doc::{DataSet, DataValue, Document, Fill, Layer, LayerContent, LayerId, Locks, VarKind, VariableDef, Variables};
use photocraft_geom::{Affine, Rect};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::commands::CommandSpec;
use crate::{EngineError, Result, Session};

/// The §8.2 manifest types, pure data + validation.
#[path = "component_cmds/component_manifest.rs"]
mod manifest;

// --------------------------------------------------------------------------- constants & errors

/// The components registry file name inside `<root>/<id>/`.
const MANIFEST_FILE: &str = "component.json";
/// The instance bookkeeping block: key + JSON bytes on the instance group's
/// `psd_blocks` (the slot PSD/`.pcraft` round-trips verbatim).
const BLOCK_KEY: [u8; 4] = *b"cmpn";
/// At most this many component directories are read per `component.list`.
const MAX_COMPONENTS: usize = 512;
/// Manifests larger than this refuse to parse (bounded reads, like the profile scan).
const MAX_MANIFEST_BYTES: u64 = 1 << 20;
/// Layer trees deeper than this refuse to place (recursion bound; import itself is bounded).
const MAX_TREE_DEPTH: usize = 64;
/// Per-side cap of a `bounds` placement.
const MAX_TARGET_SIDE: u32 = 16384;
/// 64 MP placement ceiling (spec §2.3 automation budgets).
const MAX_TARGET_PIXELS: u64 = 64_000_000;
/// At most this many user changes are reported per update (the count says the rest).
const MAX_USER_CHANGES: usize = 32;

fn bad(cmd: &str, msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: cmd.into(), msg: msg.into() }
}

fn has_doc(s: &Session) -> std::result::Result<(), String> {
    s.active().map(|_| ()).ok_or_else(|| "no document open".into())
}

/// The components registry root (see the module header for the layout).
pub fn components_root() -> PathBuf {
    std::env::var_os("PHOTOCRAFT_COMPONENTS_DIR").map_or_else(|| PathBuf::from("components"), PathBuf::from)
}

// --------------------------------------------------------------------------- instance records

/// How the master's design space was placed: a scale plus an offset (never a rotation).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct InstanceTransform {
    scale_x: f64,
    scale_y: f64,
    offset_x: f64,
    offset_y: f64,
}

impl Default for InstanceTransform {
    fn default() -> Self {
        Self { scale_x: 1.0, scale_y: 1.0, offset_x: 0.0, offset_y: 0.0 }
    }
}

impl InstanceTransform {
    /// A master-space point mapped into the document (rounds to whole pixels).
    fn maps(&self, x: i32, y: i32) -> (i64, i64) {
        (
            (f64::from(x) * self.scale_x + self.offset_x).round() as i64,
            (f64::from(y) * self.scale_y + self.offset_y).round() as i64,
        )
    }
}

/// The per-instance bookkeeping carried on the instance group's `cmpn` block.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct InstanceRecord {
    component: String,
    version: u32,
    /// Variable name → the canonical value applied to this instance.
    vars: BTreeMap<String, Value>,
    /// Variable name → the instance layer id it drives (layer ids persist in the file).
    layers: BTreeMap<String, u64>,
    /// How the master's design space was placed for this instance.
    transform: InstanceTransform,
}

impl Default for InstanceRecord {
    fn default() -> Self {
        Self {
            component: String::new(),
            version: 0,
            vars: BTreeMap::new(),
            layers: BTreeMap::new(),
            transform: InstanceTransform::default(),
        }
    }
}

fn write_record(l: &mut Layer, record: &InstanceRecord) -> Result<()> {
    let bytes = serde_json::to_vec(record)
        .map_err(|e| EngineError::Other(format!("the component instance record cannot be encoded: {e}")))?;
    l.psd_blocks.retain(|(k, _)| *k != BLOCK_KEY);
    l.psd_blocks.push((BLOCK_KEY, Arc::new(bytes)));
    Ok(())
}

/// The instance record on `l`, if any: `None` for an ordinary group, `Err` for a
/// corrupt one (which must not silently masquerade as "not an instance").
fn record_of(l: &Layer) -> std::result::Result<Option<InstanceRecord>, String> {
    let Some((_, bytes)) = l.psd_blocks.iter().find(|(k, _)| *k == BLOCK_KEY) else {
        return Ok(None);
    };
    serde_json::from_slice(bytes).map(Some).map_err(|e| format!("the instance record is unreadable: {e}"))
}

// --------------------------------------------------------------------------- components directory

/// `<root>/<id>`, with the id grammar validated first so no path can escape the root.
fn component_dir(root: &Path, id: &str, cmd: &str) -> Result<PathBuf> {
    manifest::validate_id(id).map_err(|e| bad(cmd, e.to_string()))?;
    Ok(root.join(id))
}

fn load_manifest(root: &Path, id: &str, cmd: &str) -> Result<manifest::ComponentManifest> {
    let path = component_dir(root, id, cmd)?.join(MANIFEST_FILE);
    let capped = std::fs::metadata(&path)
        .map_err(|_| bad(cmd, format!("unknown component `{id}`")))?;
    if capped.len() > MAX_MANIFEST_BYTES {
        return Err(bad(cmd, format!("the manifest for `{id}` is too large to read")));
    }
    let bytes = crate::file_cmds::read_file(&path.to_string_lossy())
        .map_err(|_| bad(cmd, format!("unknown component `{id}`")))?;
    manifest::parse(&bytes).map_err(|e| EngineError::Other(format!("component `{id}` has an invalid manifest: {e}")))
}

/// The master document of `m` at `version`, decoded in memory. Read-only by
/// construction: it is cloned from, never registered in the session, never saved.
fn load_master(s: &Session, cmd: &str, root: &Path, m: &manifest::ComponentManifest, version: u32) -> Result<Document> {
    let path = component_dir(root, &m.id, cmd)?.join(format!("{}@{version}.pcraft", m.id));
    // The path is registry-internal, but an untrusted session still gets to judge it,
    // as it judges every other file a command opens (variables' pixel paths, links).
    if let Some(gate) = s.authorize {
        gate(cmd, &json!({"path": path.to_string_lossy()}))?;
    }
    let name = path.to_string_lossy().into_owned();
    let bytes = crate::file_cmds::read_file(&name)
        .map_err(|e| EngineError::Other(format!("no master file for `{}` at version {version}: {e}", m.id)))?;
    crate::file_cmds::import(&name, &bytes)
}

// --------------------------------------------------------------------------- param helpers

fn id_param(p: &Value, cmd: &str) -> Result<&str> {
    p.get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| bad(cmd, "need `id` (a component id from component.list)"))
}

fn version_param(p: &Value, m: &manifest::ComponentManifest, cmd: &str) -> Result<u32> {
    match p.get("version") {
        None | Some(Value::Null) => Ok(m.version),
        Some(v) if v.is_number() => {
            let n = v
                .as_u64()
                .filter(|n| *n >= 1)
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| bad(cmd, "`version` must be a whole number 1 or greater"))?;
            Ok(n)
        }
        Some(_) => Err(bad(cmd, "`version` must be a whole number 1 or greater")),
    }
}

/// The anchor fractions: a name the manifest declares, or `[x, y]` fractions (finite,
/// clamped into [0, 1] per §8.4), defaulting to the centre.
fn anchor_param(m: &manifest::ComponentManifest, p: &Value, cmd: &str) -> Result<[f64; 2]> {
    match p.get("anchor") {
        None | Some(Value::Null) => Ok([0.5, 0.5]),
        Some(Value::String(name)) => {
            let names = m.anchor_names();
            m.anchor(name).ok_or_else(|| {
                let list = if names.is_empty() { "(none)".to_string() } else { names.join(", ") };
                bad(cmd, format!("unknown anchor `{name}`; the component declares: {list}"))
            })
        }
        Some(Value::Array(a)) if a.len() == 2 => {
            let mut f = [0.0f64; 2];
            for (i, v) in a.iter().enumerate() {
                f[i] = v
                    .as_f64()
                    .filter(|x| x.is_finite())
                    .ok_or_else(|| bad(cmd, "`anchor` must be a declared name or two finite [x, y] fractions in [0, 1]"))?;
            }
            Ok([f[0].clamp(0.0, 1.0), f[1].clamp(0.0, 1.0)])
        }
        Some(_) => Err(bad(cmd, "`anchor` must be a declared name or two finite [x, y] fractions in [0, 1]")),
    }
}

/// The 9-point default: the anchor point of the design box lands at the same relative
/// point of the canvas (`[1, 0]` = flush top-right; a design bigger than the canvas
/// overflows symmetrically, as any anchored box does).
fn anchored_rect(anchor: [f64; 2], design: [f64; 2], canvas: [f64; 2]) -> [f64; 4] {
    [anchor[0] * (canvas[0] - design[0]), anchor[1] * (canvas[1] - design[1]), design[0], design[1]]
}

fn target_rect(m: &manifest::ComponentManifest, p: &Value, anchor: [f64; 2], canvas: [f64; 2], cmd: &str) -> Result<[f64; 4]> {
    match p.get("bounds") {
        None | Some(Value::Null) => Ok(anchored_rect(
            anchor,
            [f64::from(m.default_size.width), f64::from(m.default_size.height)],
            canvas,
        )),
        Some(Value::Array(a)) if a.len() == 4 => {
            let mut n = [0.0f64; 4];
            for (i, v) in a.iter().enumerate() {
                n[i] = v
                    .as_f64()
                    .filter(|f| f.is_finite())
                    .ok_or_else(|| bad(cmd, "`bounds` must be four finite numbers [x, y, w, h]"))?;
            }
            if n[0] < 0.0 || n[1] < 0.0 {
                return Err(bad(cmd, "`bounds` x and y must place the component on the canvas; negative offsets are refused"));
            }
            if n[2] < 1.0 || n[3] < 1.0 {
                return Err(bad(cmd, "`bounds` width and height must be at least 1 pixel"));
            }
            if n[2] > f64::from(MAX_TARGET_SIDE)
                || n[3] > f64::from(MAX_TARGET_SIDE)
                || n[2] * n[3] > MAX_TARGET_PIXELS as f64
            {
                return Err(bad(cmd, "`bounds` exceeds the 64 MP placement ceiling (spec §2.3)"));
            }
            Ok(n)
        }
        Some(_) => Err(bad(cmd, "`bounds` must be [x, y, w, h]")),
    }
}

/// Validate a `vars` object against the manifest: unknown names are refused with the
/// allowed list (§8.4), kinds and `maxChars` are enforced, values are canonicalized.
fn vars_param(m: &manifest::ComponentManifest, p: &Value, cmd: &str, required: bool) -> Result<BTreeMap<String, Value>> {
    let mut out = BTreeMap::new();
    let obj = match p.get("vars") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_object()
                .ok_or_else(|| bad(cmd, "`vars` must be an object of variable names to values"))?,
        ),
    };
    let Some(obj) = obj else {
        if required {
            return Err(bad(cmd, "need `vars` (an object of variable names to values; unknown names are refused with the allowed list)"));
        }
        return Ok(out);
    };
    if required && obj.is_empty() {
        return Err(bad(cmd, "`vars` is empty; set at least one variable"));
    }
    if obj.len() > manifest::MAX_VARS {
        return Err(bad(cmd, format!("at most {} variables can be set at once", manifest::MAX_VARS)));
    }
    for (name, value) in obj {
        let canonical = m.check_var(name, value).map_err(|e| bad(cmd, e.to_string()))?;
        out.insert(name.clone(), canonical);
    }
    Ok(out)
}

fn names_to_ids(doc: &Document, name: &str) -> Vec<LayerId> {
    doc.walk()
        .into_iter()
        .filter(|(_, _, l)| l.name == name)
        .map(|(_, _, l)| l.id)
        .collect()
}

/// A layer reference: numeric id, or a name that must be unique (`§6.1` ambiguity is an
/// error with the candidates listed).
fn layer_ref(doc: &Document, v: &Value, key: &str, cmd: &str) -> Result<LayerId> {
    match v {
        Value::Number(n) => {
            let id = LayerId(n.as_u64().ok_or_else(|| bad(cmd, format!("`{key}` must be a layer id or name"))?)?);
            doc.layer(id).ok_or_else(|| bad(cmd, format!("no layer with id {} for `{key}`", id.0)))
        }
        Value::String(name) => {
            let matches = names_to_ids(doc, name);
            match matches.as_slice() {
                [one] => Ok(*one),
                [] => Err(bad(cmd, format!("no layer named \"{name}\" for `{key}`"))),
                many => {
                    let ids: Vec<String> = many.iter().map(|i| i.0.to_string()).collect();
                    Err(bad(cmd, format!("\"{name}\" is ambiguous for `{key}`: layers {} share the name; pass the id", ids.join(", "))))
                }
            }
        }
        _ => Err(bad(cmd, format!("`{key}` must be a layer id or name"))),
    }
}

fn parent_param(s: &Session, p: &Value, cmd: &str) -> Result<Option<LayerId>> {
    let doc = &s.active().ok_or(EngineError::NoDocument)?.doc;
    match p.get("parent") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let id = layer_ref(doc, v, "parent", cmd)?;
            let l = doc.layer(id).ok_or_else(|| bad(cmd, "the parent layer no longer exists"))?;
            if !l.is_group() {
                return Err(bad(cmd, format!("the parent layer \"{}\" is a {} layer, not a group", l.name, l.content.kind_name())));
            }
            Ok(Some(id))
        }
    }
}

/// The instance a command acts on: a group carrying a `cmpn` record.
fn resolve_instance(s: &Session, p: &Value, cmd: &str) -> Result<(LayerId, InstanceRecord)> {
    let doc = &s.active().ok_or(EngineError::NoDocument)?.doc;
    let v = p.get("instance").ok_or_else(|| bad(cmd, "need `instance` (the group layer id component.place returned, or its name)"))?;
    let id = layer_ref(doc, v, "instance", cmd)?;
    let Some(layer) = doc.layer(id) else { return Err(bad(cmd, format!("no layer with id {} for `instance`", id.0))) };
    match record_of(layer) {
        Ok(None) => Err(bad(cmd, format!("layer {} (\"{}\") is not a component instance; component.place creates one", id.0, layer.name))),
        Ok(Some(record)) => Ok((id, record)),
        Err(e) => Err(EngineError::Other(format!("layer {} (\"{}\"): {e}", id.0, layer.name))),
    }
}

// --------------------------------------------------------------------------- copying & geometry

/// A deep copy of `l`'s subtree with fresh layer ids, recording master-id → instance-id
/// so the master's variable bindings can follow the copy. Smart-object `contents_id`s
/// are preserved: instances share the master's smart contents (§8.1). Depth-capped.
fn clone_layer(l: &Layer, depth: usize, map: &mut HashMap<u64, u64>) -> Result<Layer> {
    if depth > MAX_TREE_DEPTH {
        return Err(EngineError::Other("the component's layer tree nests too deeply to place".into()));
    }
    let mut copy = l.clone();
    copy.id = LayerId::fresh();
    copy.psd_id = None;
    map.insert(l.id.0, copy.id.0);
    if let Some(src) = l.children() {
        let cloned: Result<Vec<Layer>> = src.iter().map(|c| clone_layer(c, depth + 1, map)).collect();
        if let Some(dst) = copy.children_mut() {
            *dst = cloned?;
        }
    }
    Ok(copy)
}

/// The instance-side layer with `id`, anywhere inside `l`'s subtree. Depth-capped.
fn layer_by_id_mut(l: &mut Layer, id: LayerId, depth: usize) -> Option<&mut Layer> {
    if depth > MAX_TREE_DEPTH {
        return None;
    }
    if l.id == id {
        return Some(l);
    }
    l.children_mut()?.iter_mut().find_map(|c| layer_by_id_mut(c, id, depth + 1))
}

/// The map from a master subtree onto its target rectangle: a scale plus an offset
/// (place never rotates). Equal sizes keep the lossless whole-pixel translate path.
struct Placement {
    scale: [f64; 2],
    offset: [f64; 2],
    pure_translate: Option<[i32; 2]>,
}

impl Placement {
    fn map(content: Rect, target: [f64; 4], cmd: &str) -> Result<Self> {
        let (bw, bh) = (f64::from(content.width()), f64::from(content.height()));
        if bw < 1.0 || bh < 1.0 {
            return Err(bad(cmd, "the component has no content to place"));
        }
        let (sx, sy) = (target[2] / bw, target[3] / bh);
        if !sx.is_finite() || !sy.is_finite() || sx <= 0.0 || sy <= 0.0 {
            return Err(bad(cmd, "the target rectangle collapses the component"));
        }
        let (ex, ey) = (target[0] - sx * f64::from(content.x0), target[1] - sy * f64::from(content.y0));
        // 1:1 places never resample (§25: editability is the product).
        let pure_translate = if (sx - 1.0).abs() < 1e-9 && (sy - 1.0).abs() < 1e-9 {
            Some([
                (target[0] - f64::from(content.x0)).round() as i32,
                (target[1] - f64::from(content.y0)).round() as i32,
            ])
        } else {
            None
        };
        Ok(Placement { scale: [sx, sy], offset: [ex, ey], pure_translate })
    }

    /// Apply to `l`'s subtree. `ctx` is only the refresh context for type layers
    /// without a rendered cache (the master document — the layer isn't in a document
    /// yet); the scaled path goes through the engine's own transform machinery with
    /// its budget checks.
    fn apply(&self, ctx: &Document, l: &mut Layer) -> Result<()> {
        if let Some([dx, dy]) = self.pure_translate {
            crate::commands::translate_layer(ctx, l, dx, dy);
            return Ok(());
        }
        let [sx, sy] = self.scale;
        let [ex, ey] = self.offset;
        // (x, y) → (sx·x + ex, sy·y + ey), in the Homography layout edit.transform uses.
        let h = Homography([sx, 0.0, ex, 0.0, sy, ey, 0.0, 0.0, 1.0]);
        if h.inverse().is_none() {
            return Err(EngineError::Other("the placement transform collapses the component".into()));
        }
        let affine = Affine { m: [sx, 0.0, 0.0, sy, ex, ey] };
        crate::transform_cmds::transform_layer(None, Locks::default(), l, &h, Some(affine), Interp::Bicubic)?;
        Ok(())
    }

    fn record(&self) -> InstanceTransform {
        InstanceTransform {
            scale_x: self.scale[0],
            scale_y: self.scale[1],
            offset_x: self.offset[0],
            offset_y: self.offset[1],
        }
    }
}

/// Set a layer's colour where it has a recolourable one: a solid fill layer, a shape
/// with a solid fill, or a type layer. Gradient/pattern fills and pixel layers are
/// refused (as a warning to the caller), never clobbered. `ctx` re-renders type and
/// shape caches.
fn recolor_layer(ctx: &Document, l: &mut Layer, c: Color) -> std::result::Result<(), String> {
    let c = c.in_mode(ctx.mode);
    match &mut l.content {
        LayerContent::Fill(Fill::Solid(s)) => {
            *s = c;
            // The compositor re-renders a fill layer from its model once the cache is gone.
            l.fill_cache = None;
            Ok(())
        }
        LayerContent::Shape(sh) => {
            if matches!(sh.fill, Some(Fill::Solid(_))) {
                sh.fill = Some(Fill::Solid(c));
                crate::vector_cmds::refresh_shape(ctx, sh);
                Ok(())
            } else {
                Err(format!("layer \"{}\" has a gradient or pattern fill, which a colour variable cannot replace", l.name))
            }
        }
        LayerContent::Text(t) => {
            t.color = c;
            for run in &mut t.runs {
                run.style.color = c;
            }
            crate::type_cmds::refresh(ctx, t);
            Ok(())
        }
        other => Err(format!("layer \"{}\" is a {} layer, which a colour variable cannot recolour", l.name, other.kind_name())),
    }
}

/// Apply every colour variable of `state` to the subtree `l` (usually the instance
/// group). Bindings that point outside it, or layers that cannot take the colour,
/// become warnings — never an error, never a clobber.
fn apply_colors(
    ctx: &Document,
    l: &mut Layer,
    m: &manifest::ComponentManifest,
    state: &BTreeMap<String, Value>,
    bindings: &BTreeMap<String, LayerId>,
    warnings: &mut Vec<Value>,
) {
    for (name, spec) in &m.variables {
        if !matches!(spec.kind, manifest::VarKind::Color) {
            continue;
        }
        let (Some(&lid), Some(hex)) = (bindings.get(name), state.get(name).and_then(Value::as_str)) else {
            continue;
        };
        let Some(color) = manifest::parse_hex(hex) else {
            continue;
        };
        let Some(target) = layer_by_id_mut(l, lid, 0) else {
            warnings.push(json!({"variable": name, "warning": "the layer this variable drives is no longer in the instance; component.updateInstance rebuilds the bindings"}));
            continue;
        };
        if let Err(why) = recolor_layer(ctx, target, color) {
            warnings.push(json!({"variable": name, "warning": why}));
        }
    }
}

/// The union of the content bounds of a stack of layers.
fn stack_bounds(layers: &[Layer]) -> Rect {
    layers
        .iter()
        .map(crate::transform_cmds::whole_layer_bounds)
        .fold(Rect::EMPTY, |a, b| a.union(&b))
}

// --------------------------------------------------------------------------- variables plumbing

/// The engine kind a manifest kind rides: text → TextReplacement, visibility →
/// Visibility. Colours are applied directly (the engine's data sets have no colour
/// kind) and never enter `defs`.
fn engine_kind(kind: manifest::VarKind) -> Option<VarKind> {
    match kind {
        manifest::VarKind::Text => Some(VarKind::TextReplacement),
        manifest::VarKind::Visibility => Some(VarKind::Visibility),
        manifest::VarKind::Color => None,
    }
}

/// Mirrors `variables_cmds::set_vars`: variables are configuration, so the change
/// bumps the revision without a history step — applying a data set is the visible
/// edit, exactly as in the variables commands.
fn set_variables(s: &mut Session, f: impl FnOnce(&mut Variables)) -> Result<()> {
    let st = s.active_mut().ok_or(EngineError::NoDocument)?;
    let mut doc = (*st.doc).clone();
    f(&mut doc.variables);
    st.doc = Arc::new(doc);
    st.revision += 1;
    Ok(())
}

/// Wire one instance's text/visibility variables into the document's variables:
/// instance-scoped defs (`<component>#<instance>.<var>`) and one data set per instance
/// (`<component>#<instance>`), replacing any previous row for this instance and leaving
/// every other variable and data set of the host document alone. Returns the data-set
/// name to apply, or `None` when the component drives nothing through data sets.
///
/// The merge happens on the data the public `image.variables.define` /
/// `image.variables.dataSets` commands manage because those commands replace their
/// whole lists — a naive call per instance would wipe the host document's own rows.
/// The values then apply through the public `image.applyDataSet` (one history step).
fn bind_instance_variables(
    s: &mut Session,
    cmd: &str,
    m: &manifest::ComponentManifest,
    instance: LayerId,
    state: &BTreeMap<String, Value>,
    bindings: &BTreeMap<String, LayerId>,
) -> Result<Option<String>> {
    // Rows: (def name, layer, engine kind, data-set value) — colours never ride data sets.
    let mut rows: Vec<(String, LayerId, VarKind, VarValue)> = Vec::new();
    let set_name = format!("{}#{}", m.id, instance.0);
    let prefix = format!("{set_name}.");
    for (name, spec) in &m.variables {
        let Some(kind) = engine_kind(spec.kind) else { continue };
        let (Some(&lid), Some(value)) = (bindings.get(name), state.get(name)) else {
            return Err(EngineError::Other(format!("variable `{name}` has no value or no bound layer for this instance")));
        };
        let full = format!("{prefix}{name}");
        let v = match (spec.kind, value) {
            (manifest::VarKind::Text, Value::String(t)) => VarValue::Text(t.clone()),
            (manifest::VarKind::Visibility, Value::Bool(b)) => VarValue::Visibility(*b),
            _ => return Err(EngineError::Other(format!("variable `{name}` holds a value its kind cannot apply"))),
        };
        rows.push((full, lid, kind, v));
    }
    if rows.is_empty() {
        return Ok(None);
    }
    let set = set_name.clone();
    set_variables(s, |vars| {
        vars.defs.retain(|d| !d.name.starts_with(&prefix));
        vars.data_sets.retain(|d| d.name != set);
        for (name, layer, kind, _) in &rows {
            vars.defs.push(VariableDef { name: name.clone(), layer: *layer, kind: kind.clone() });
        }
        // The instance's values ride ONLY its own data set (pushed below); writing them
        // into the host document's current last set would corrupt data that is not ours
        // (the doc contract: "leaving every other variable and data set of the host
        // document alone").
        vars.data_sets.push(DataSet {
            name: set,
            values: rows
                .iter()
                .map(|(name, _, _, value)| DataValue { variable: name.clone(), value: value.clone() })
                .collect(),
        });
    })?;
    let _ = cmd;
    Ok(Some(set_name))
}

/// The engine kind names `image.variables.define` parses (for `component.inspect`).
fn engine_kind_name(kind: &VarKind) -> &'static str {
    match kind {
        VarKind::Visibility => "visibility",
        VarKind::TextReplacement => "textReplacement",
        VarKind::PixelReplacement { .. } => "pixelReplacement",
    }
}

/// Bindings from the manifest's variables to the master's layers, remapped to the
/// instance copy. A manifest variable the master doesn't bind is a data error.
fn remapped_bindings(
    master: &Document,
    remap: &HashMap<u64, u64>,
    m: &manifest::ComponentManifest,
    cmd: &str,
) -> Result<BTreeMap<String, LayerId>> {
    let mut out = BTreeMap::new();
    for name in m.variables.keys() {
        let Some(def) = master.variables.def(name) else {
            return Err(bad(cmd, format!("the master document does not bind variable `{name}` to a layer")));
        };
        let Some(&now) = remap.get(&def.layer.0) else {
            return Err(bad(cmd, format!("the master binds variable `{name}` to a layer outside its stack")));
        };
        out.insert(name.clone(), LayerId(now));
    }
    Ok(out)
}

// --------------------------------------------------------------------------- component.list

fn list_core(root: &Path, p: &Value) -> Result<Value> {
    let cmd = "component.list";
    let tags = match p.get("tags") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => {
            let mut wanted: Vec<String> = Vec::with_capacity(a.len());
            if a.len() > manifest::MAX_TAGS {
                return Err(bad(cmd, format!("at most {} tags can be filtered on", manifest::MAX_TAGS)));
            }
            for t in a {
                let Some(t) = t.as_str().map(str::to_lowercase) else {
                    return Err(bad(cmd, "`tags` must be an array of strings"));
                };
                if t.trim().is_empty() {
                    return Err(bad(cmd, "`tags` entries must not be empty"));
                }
                wanted.push(t);
            }
            if wanted.is_empty() {
                return Err(bad(cmd, "`tags` must name at least one tag"));
            }
            Some(wanted)
        }
        Some(_) => return Err(bad(cmd, "`tags` must be an array of strings")),
    };
    let query = match p.get("query") {
        None | Some(Value::Null) => None,
        Some(Value::String(q)) => {
            let q = q.to_lowercase();
            if q.trim().is_empty() {
                return Err(bad(cmd, "`query` must not be empty"));
            }
            Some(q)
        }
        Some(_) => return Err(bad(cmd, "`query` must be a string")),
    };

    let mut components: Vec<Value> = Vec::new();
    let mut problems: Vec<Value> = Vec::new();
    match std::fs::read_dir(root) {
        Err(_) => problems.push(json!({"error": format!("the components root `{}` cannot be read; set PHOTOCRAFT_COMPONENTS_DIR", root.to_string_lossy())})),
        Ok(entries) => {
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.path())
                // Cap the collection itself: a runaway components root must not size the
                // Vec (the vendor's installed-profiles walk caps its collection the same
                // way). Membership follows the OS listing order, the reply stays sorted.
                .take(MAX_COMPONENTS)
                .collect();
            dirs.sort();
            for dir in &dirs {
                let Some(id) = dir.file_name().and_then(|n| n.to_str()) else { continue };
                let path = dir.join(MANIFEST_FILE);
                let readable = std::fs::metadata(&path).map(|m| m.len() <= MAX_MANIFEST_BYTES).unwrap_or(false)
                    && crate::file_cmds::read_file(&path.to_string_lossy()).is_ok();
                let Some(bytes) = readable.then(|| crate::file_cmds::read_file(&path.to_string_lossy())).flatten() else {
                    problems.push(json!({"id": id, "error": "no readable component.json"}));
                    continue;
                };
                match manifest::parse(&bytes) {
                    Err(e) => problems.push(json!({"id": id, "error": format!("invalid manifest: {e}")})),
                    Ok(m) => {
                        if let Some(want) = &tags {
                            let have: BTreeSet<String> = m.tags.iter().map(|t| t.to_lowercase()).collect();
                            if !want.iter().all(|t| have.contains(t)) {
                                continue;
                            }
                        }
                        if let Some(q) = &query {
                            if !m.id.to_lowercase().contains(q) && !m.name.to_lowercase().contains(q) {
                                continue;
                            }
                        }
                        components.push(json!({
                            "id": m.id, "name": m.name, "version": m.version, "tags": m.tags,
                            "defaultSize": { "width": m.default_size.width, "height": m.default_size.height },
                            "license": m.license,
                            "variables": m.variables.keys().cloned().collect::<Vec<_>>(),
                            "comps": m.comps,
                        }));
                    }
                }
            }
        }
    }
    Ok(json!({"components": components, "problems": problems}))
}

// --------------------------------------------------------------------------- component.inspect

fn inspect_core(root: &Path, s: &Session, p: &Value) -> Result<Value> {
    let cmd = "component.inspect";
    let id = id_param(p, cmd)?;
    let m = load_manifest(root, id, cmd)?;
    let version = version_param(p, &m, cmd)?;
    let master = load_master(s, cmd, root, &m, version)?;
    let layers: Vec<Value> = master
        .walk()
        .iter()
        .map(|(_, _, l)| {
            json!({"layer": l.id.0, "name": l.name, "kind": l.content.kind_name(), "visible": l.visible})
        })
        .collect();
    let variables: Vec<Value> = master
        .variables
        .defs
        .iter()
        .map(|d| json!({"name": d.name, "layer": d.layer.0, "type": engine_kind_name(&d.kind)}))
        .collect();
    Ok(json!({
        "manifest": m.to_json().map_err(|e| EngineError::Other(format!("component `{id}` has an invalid manifest: {e}")))?,
        "version": version,
        "master": {
            "size": { "width": master.size.width, "height": master.size.height },
            // Master ids: an instance copy gets fresh ids (component.place reports its own).
            "layers": layers,
            "variables": variables,
        },
    }))
}

// --------------------------------------------------------------------------- component.place

fn place_core(s: &mut Session, root: &Path, p: &Value) -> Result<Value> {
    let cmd = "component.place";
    let id = id_param(p, cmd)?;
    let m = load_manifest(root, id, cmd)?;
    let version = version_param(p, &m, cmd)?;
    // In-memory, read-only: the master is the source of a copy, never a document here.
    let master = load_master(s, cmd, root, &m, version)?;

    let st = s.active().ok_or(EngineError::NoDocument)?;
    let canvas = [f64::from(st.doc.size.width), f64::from(st.doc.size.height)];
    let host_mode = st.doc.mode;
    let host_depth = st.doc.depth;
    let active = st.active_layer;
    drop(st);

    let mut warnings: Vec<Value> = Vec::new();
    if host_mode != master.mode || host_depth != master.depth {
        warnings.push(json!({"warning": format!(
            "the component was authored as {:?} {:?}; its layers keep their own mode and depth inside this document",
            master.mode, master.depth
        )}));
    }

    let anchor = anchor_param(&m, p, cmd)?;
    let target = target_rect(&m, p, anchor, canvas, cmd)?;
    let overrides = vars_param(&m, p, cmd, false)?;
    let mut state = m.default_state();
    for (name, value) in overrides {
        state.insert(name, value);
    }

    // Copy the master's stack with fresh ids (smart contents stay shared), and follow
    // its variable bindings across the copy.
    let mut remap = HashMap::new();
    let children: Vec<Layer> = master
        .layers
        .iter()
        .map(|l| clone_layer(l, 1, &mut remap))
        .collect::<Result<Vec<_>>>()?;
    let bindings = remapped_bindings(&master, &remap, &m, cmd)?;

    let mut group = Layer::group(m.name.clone(), children);
    let content = stack_bounds(group.children().unwrap_or(&[]));
    // Layers without rendered caches (type before its first render) place from the
    // design origin instead of pixel bounds — the documented approximation.
    let content = if content.is_empty() {
        Rect::from_xywh(0, 0, m.default_size.width, m.default_size.height)
    } else {
        content
    };
    let placement = Placement::map(content, target, cmd)?;
    placement.apply(&master, &mut group)?;
    apply_colors(&master, &mut group, &m, &state, &bindings, &mut warnings);

    let record = InstanceRecord {
        component: m.id.clone(),
        version,
        vars: state.clone(),
        layers: bindings.iter().map(|(n, l)| (n.clone(), l.0)).collect(),
        transform: placement.record(),
    };
    write_record(&mut group, &record)?;

    let parent = parent_param(s, p, cmd)?;
    let name = m.name.clone();
    let gid = group.id;
    let gid = s.edit(&format!("Place Component \"{name}\""), move |doc, active| {
        let gid = match parent {
            Some(pid) => {
                let l = doc.layer_mut(pid).ok_or_else(|| bad(cmd, "the parent layer no longer exists"))?;
                let ch = l.children_mut().ok_or_else(|| bad(cmd, "the parent layer is no longer a group"))?;
                ch.push(group);
                gid
            }
            None => doc.insert_above(*active, group),
        };
        *active = Some(gid);
        Ok(gid)
    })?;

    // Wire text/visibility through the variables machinery and apply as one step.
    // These are configuration + the data-set application; if they were to fail after
    // the group is in, the instance exists with the master's own content and the
    // command reports the error (the data set was just written, so in practice only
    // authorization or an aborted batch can land here).
    let set = bind_instance_variables(s, cmd, &m, gid, &state, &bindings)?;
    if let Some(set_name) = set {
        s.execute("image.applyDataSet", json!({"name": set_name}))?;
    }

    let st = s.active().ok_or(EngineError::NoDocument)?;
    let Some(l) = st.doc.layer(gid) else { return Err(EngineError::NoLayer(gid)) };
    let b = crate::transform_cmds::whole_layer_bounds(l);
    Ok(json!({
        "instance": gid.0,
        "component": m.id,
        "version": version,
        "bounds": [b.x0, b.y0, b.width(), b.height()],
        "anchor": anchor,
        "vars": state,
        "warnings": warnings,
    }))
}

// --------------------------------------------------------------------------- component.setVars

fn set_vars_core(s: &mut Session, root: &Path, p: &Value) -> Result<Value> {
    let cmd = "component.setVars";
    let (gid, record) = resolve_instance(s, p, cmd)?;
    let m = load_manifest(root, &record.component, cmd)?;
    let overrides = vars_param(&m, p, cmd, true)?;

    let mut state = record.vars.clone();
    let mut warnings: Vec<Value> = Vec::new();
    // Values kept from an older manifest version validate against the current one.
    for name in state.clone().keys() {
        if let Err(e) = m.check_var(name, state.get(name).unwrap_or(&Value::Null)) {
            state.remove(name);
            warnings.push(json!({"warning": format!("variable `{name}` is dropped: {e}")}));
        }
    }
    for (name, value) in overrides {
        state.insert(name, value);
    }

    let bindings: BTreeMap<String, LayerId> =
        record.layers.iter().map(|(n, l)| (n.clone(), LayerId(*l))).collect();
    let new_record = InstanceRecord {
        component: record.component.clone(),
        version: record.version,
        vars: state.clone(),
        layers: record.layers.clone(),
        transform: record.transform,
    };

    s.edit("Set Component Variables", |doc, _| {
        let snapshot = doc.clone();
        let Some(group) = doc.layer_mut(gid) else { return Err(EngineError::NoLayer(gid)) };
        apply_colors(&snapshot, group, &m, &state, &bindings, &mut warnings);
        write_record(group, &new_record)?;
        Ok(())
    })?;

    let set = bind_instance_variables(s, cmd, &m, gid, &state, &bindings)?;
    if let Some(set_name) = set {
        s.execute("image.applyDataSet", json!({"name": set_name}))?;
    }
    Ok(json!({"instance": gid.0, "vars": state, "warnings": warnings}))
}

// --------------------------------------------------------------------------- component.updateInstance

/// Where a layer's colour sits (the slots a colour variable drives).
fn dominant_color(l: &Layer) -> Option<Color> {
    match &l.content {
        LayerContent::Fill(Fill::Solid(c)) => Some(*c),
        LayerContent::Text(t) => Some(t.color),
        LayerContent::Shape(sh) => match &sh.fill {
            Some(Fill::Solid(c)) => Some(*c),
            _ => None,
        },
        _ => None,
    }
}

fn colors_differ(a: Color, b: Color) -> bool {
    let (x, y) = (a.to_rgba8(), b.to_rgba8());
    x.iter().zip(y.iter()).any(|(p, q)| p.abs_diff(*q) > 2)
}

/// The aspects of `b` (the live instance layer) that differ from what the placed
/// master version plus the variable state predicts — the user's own edits (§8.4).
/// `managed` maps the instance layer id to the variable that drives it, so
/// variable-owned aspects compare against the state, not the master.
fn diff_layer(
    a: &Layer,
    b: &Layer,
    managed: &HashMap<u64, (&String, manifest::VarKind)>,
    state: &BTreeMap<String, Value>,
    placed: &InstanceTransform,
    depth: usize,
    out: &mut Vec<Value>,
) {
    if depth > MAX_TREE_DEPTH || out.len() >= MAX_USER_CHANGES {
        return;
    }
    let note = |aspect: &str, detail: String| {
        if out.len() < MAX_USER_CHANGES {
            out.push(json!({"layer": b.name, "aspect": aspect, "detail": detail}));
        }
    };
    if a.name != b.name {
        note("name", format!("renamed from \"{}\"", a.name));
    }
    if a.content.kind_name() != b.content.kind_name() {
        note("kind", format!("is a {} layer where the placed version had a {} layer", b.content.kind_name(), a.content.kind_name()));
    }
    let driven = managed.get(&b.id.0);
    let expected_visible = match driven {
        Some((name, manifest::VarKind::Visibility)) => {
            state.get(*name).and_then(Value::as_bool).unwrap_or(a.visible)
        }
        _ => a.visible,
    };
    if b.visible != expected_visible {
        note("visible", "visibility differs from the variable state".to_string());
    }
    if let (LayerContent::Text(ta), LayerContent::Text(tb)) = (&a.content, &b.content) {
        let expected = match driven {
            Some((name, manifest::VarKind::Text)) => state.get(*name).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| ta.text.clone()),
            _ => ta.text.clone(),
        };
        if tb.text != expected {
            note("text", "the text differs from the variable state".to_string());
        }
    }
    if !matches!(driven.map(|(_, k)| *k), Some(manifest::VarKind::Color)) {
        if let (Some(ca), Some(cb)) = (dominant_color(a), dominant_color(b)) {
            if colors_differ(ca, cb) {
                note("color", "the fill or text colour was changed".to_string());
            }
        }
    }
    if (a.opacity - b.opacity).abs() > 1.0 / 255.0 {
        note("opacity", "the layer's opacity was changed".to_string());
    }
    if a.blend != b.blend {
        note("blend", "the blend mode was changed".to_string());
    }
    let (ba, bb) = (crate::transform_cmds::whole_layer_bounds(a), crate::transform_cmds::whole_layer_bounds(b));
    if !ba.is_empty() && !bb.is_empty() {
        // The instance record comes from the file, so its transform is hostile: a huge
        // scale/offset maps to a point that saturates at i64::MIN/MAX, where the naive
        // subtraction overflows and `i64::MIN.abs()` panics. Checked math keeps the
        // comparison total — an unrepresentable gap counts as moved, never as a crash.
        let gap = |want: i64, got: i32| {
            want.checked_sub(i64::from(got)).and_then(i64::checked_abs).is_none_or(|d| d > 1)
        };
        let (want_x, want_y) = placed.maps(ba.x0, ba.y0);
        if gap(want_x, bb.x0) || gap(want_y, bb.y0) {
            note("position", "the layer was moved inside the instance".to_string());
        }
    }
    if let (Some(ac), Some(bc)) = (a.children(), b.children()) {
        diff_stack(ac, bc, managed, state, placed, depth + 1, out);
    }
}

fn diff_stack(
    old: &[Layer],
    live: &[Layer],
    managed: &HashMap<u64, (&String, manifest::VarKind)>,
    state: &BTreeMap<String, Value>,
    placed: &InstanceTransform,
    depth: usize,
    out: &mut Vec<Value>,
) {
    if depth > MAX_TREE_DEPTH || out.len() >= MAX_USER_CHANGES {
        return;
    }
    if old.len() != live.len() && out.len() < MAX_USER_CHANGES {
        out.push(json!({"aspect": "structure", "detail": format!("the instance holds {} layers where the placed version had {} (layers were added or removed)", live.len(), old.len())}));
    }
    for (a, b) in old.iter().zip(live.iter()) {
        diff_layer(a, b, managed, state, placed, depth, out);
    }
}

fn update_core(s: &mut Session, root: &Path, p: &Value) -> Result<Value> {
    let cmd = "component.updateInstance";
    let (gid, record) = resolve_instance(s, p, cmd)?;
    let m = load_manifest(root, &record.component, cmd)?;
    if record.version == m.version {
        return Ok(json!({
            "instance": gid.0, "component": m.id, "from": record.version, "to": m.version,
            "updated": false, "userChanges": [], "warnings": [], "vars": record.vars,
        }));
    }
    let master = load_master(s, cmd, root, &m, m.version)?;

    // The diff baseline: the placed version of the same component.
    let mut user_changes: Vec<Value> = Vec::new();
    let mut warnings: Vec<Value> = Vec::new();
    {
        let st = s.active().ok_or(EngineError::NoDocument)?;
        let Some(group) = st.doc.layer(gid) else { return Err(EngineError::NoLayer(gid)) };
        let Some(live) = group.children() else { return Err(bad(cmd, "the instance group no longer holds layers")) };
        match load_master(s, cmd, root, &m, record.version) {
            Ok(old) => {
                let managed: HashMap<u64, (&String, manifest::VarKind)> = record
                    .layers
                    .iter()
                    .filter_map(|(n, id)| m.variables.get(n).map(|spec| (*id, (n, spec.kind))))
                    .collect();
                diff_stack(&old.layers, live, &managed, &record.vars, &record.transform, 0, &mut user_changes);
            }
            Err(e) => warnings.push(json!({"warning": format!(
                "the master file for the placed version {} is gone, so your own edits inside the instance cannot be reported: {e}",
                record.version
            )})),
        }
    }

    // Reconcile the variable state with the new manifest.
    let mut state = record.vars.clone();
    let mut dropped: Vec<String> = Vec::new();
    for name in state.clone().keys() {
        let gone = match state.get(name) {
            Some(v) => m.check_var(name, v).is_err(),
            None => true,
        };
        if gone {
            state.remove(name);
            dropped.push(name.clone());
        }
    }
    let mut added: Vec<String> = Vec::new();
    for (name, spec) in &m.variables {
        if !state.contains_key(name) {
            state.insert(name.clone(), spec.default.clone());
            added.push(name.clone());
        }
    }
    if !dropped.is_empty() {
        warnings.push(json!({"warning": format!("variables the new version removed no longer apply: {}", dropped.join(", "))}));
    }
    if !added.is_empty() {
        warnings.push(json!({"warning": format!("new variables take their defaults: {}", added.join(", "))}));
    }

    // Fresh copy of the new master, placed onto the instance's current outer bounds so
    // a moved or scaled instance stays exactly where the user put it.
    let mut remap = HashMap::new();
    let mut children: Vec<Layer> = master
        .layers
        .iter()
        .map(|l| clone_layer(l, 1, &mut remap))
        .collect::<Result<Vec<_>>>()?;
    let bindings = remapped_bindings(&master, &remap, &m, cmd)?;
    let content = stack_bounds(&children);
    let content = if content.is_empty() {
        Rect::from_xywh(0, 0, m.default_size.width, m.default_size.height)
    } else {
        content
    };
    let st = s.active().ok_or(EngineError::NoDocument)?;
    let Some(group) = st.doc.layer(gid) else { return Err(EngineError::NoLayer(gid)) };
    let current = crate::transform_cmds::whole_layer_bounds(group);
    if current.is_empty() {
        return Err(bad(cmd, "the instance has no content left to align the update with"));
    }
    let target = [
        f64::from(current.x0),
        f64::from(current.y0),
        f64::from(current.width()),
        f64::from(current.height()),
    ];
    let group_name = group.name.clone();
    drop(st);

    let placement = Placement::map(content, target, cmd)?;
    for l in children.iter_mut() {
        placement.apply(&master, l)?;
    }
    for l in children.iter_mut() {
        apply_colors(&master, l, &m, &state, &bindings, &mut warnings);
    }

    let new_record = InstanceRecord {
        component: m.id.clone(),
        version: m.version,
        vars: state.clone(),
        layers: bindings.iter().map(|(n, l)| (n.clone(), l.0)).collect(),
        transform: placement.record(),
    };
    let record_for_edit = new_record.clone();
    s.edit(&format!("Update Component \"{group_name}\""), move |doc, _| {
        let Some(group) = doc.layer_mut(gid) else { return Err(EngineError::NoLayer(gid)) };
        let Some(ch) = group.children_mut() else { return Err(bad(cmd, "the instance is no longer a group")) };
        *ch = children;
        write_record(group, &record_for_edit)?;
        Ok(())
    })?;

    // Rebind to the fresh layer ids and re-apply the state (defs carry the instance
    // prefix, so the old rows for this instance are replaced, not duplicated).
    let set = bind_instance_variables(s, cmd, &m, gid, &state, &bindings)?;
    if let Some(set_name) = set {
        s.execute("image.applyDataSet", json!({"name": set_name}))?;
    }

    Ok(json!({
        "instance": gid.0, "component": m.id, "from": record.version, "to": m.version,
        "updated": true, "userChanges": user_changes, "warnings": warnings, "vars": state,
    }))
}

// --------------------------------------------------------------------------- component.publish

/// Later phase (§8.3): refuse with a typed not-yet-available error that spells out the
/// planned semantics, rather than half-publishing or faking a success shape.
fn publish(_s: &mut Session, p: &Value) -> Result<Value> {
    let _ = p; // `group`/`id`/`version` are validated when the command exists.
    Err(EngineError::Disabled(
        "component.publish".into(),
        "not yet available — publishing lands in a later phase (spec §8.3). Planned semantics: \
         validate the group, write a NEW <id>/component.json + <id>@N.pcraft into the components \
         root, never mutating an existing component or its master (§8.4)".into(),
    ))
}

// --------------------------------------------------------------------------- registry

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec {
            id: "component.list",
            label: "List Components",
            menu: &[],
            shortcut: None,
            params: r##"{"tags":[str]? (a component matches when it has every tag),"query":str? (substring of the id or name)} → {components:[{id,name,version,tags,defaultSize,license,variables,comps}],problems:[{id,error}]}"##,
            enabled: crate::commands::always,
            run: |s, p| list_core(&components_root(), p),
            journal: false,
        },
        CommandSpec {
            id: "component.inspect",
            label: "Inspect Component",
            menu: &[],
            shortcut: None,
            params: r##"{"id":str,"version":n? (default: the current version)} → {manifest,master:{size,layers,variables},version}; layer ids are the MASTER's — an instance copy gets fresh ids"##,
            enabled: crate::commands::always,
            run: |s, p| inspect_core(&components_root(), s, p),
            journal: false,
        },
        CommandSpec {
            id: "component.place",
            label: "Place Component",
            menu: &[],
            shortcut: None,
            params: r##"{"id":str,"version":n?,"parent":layerRef? (a group to place into),"bounds":[x,y,w,h]? (default: the design box at the anchor point),"anchor":str|[x,y]? (a declared name, or [0..1] fractions; default the centre),"vars":{str:value}? (defaults fill the rest)} → {instance,component,version,bounds,anchor,vars,warnings} — the master is never mutated (§8.4)"##,
            enabled: has_doc,
            run: |s, p| place_core(s, &components_root(), p),
            journal: true,
        },
        CommandSpec {
            id: "component.setVars",
            label: "Set Component Variables",
            menu: &[],
            shortcut: None,
            params: r##"{"instance":layerRef,"vars":{str:value}} → {instance,vars,warnings}; unknown names are refused with the allowed list (§8.4); text and visibility apply through the instance's data set, colours recolour the bound layers"##,
            enabled: has_doc,
            run: |s, p| set_vars_core(s, &components_root(), p),
            journal: true,
        },
        CommandSpec {
            id: "component.updateInstance",
            label: "Update Component Instance",
            menu: &[],
            shortcut: None,
            params: r##"{"instance":layerRef} → {instance,component,from,to,updated,userChanges,warnings,vars}; pulls the latest version, keeps the outer placement and variables, reports (never silently discards) edits outside the declared variables (§8.4)"##,
            enabled: has_doc,
            run: |s, p| update_core(s, &components_root(), p),
            journal: true,
        },
        CommandSpec {
            id: "component.publish",
            label: "Publish Component",
            menu: &[],
            shortcut: None,
            params: r##"{"group":layerRef,"id":str?,"version":n?} — later phase (§8.3): answers not-yet-available with the planned semantics instead of half-publishing"##,
            enabled: has_doc,
            run: publish,
            journal: false,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use manifest::VarKind as MKind;
    use photocraft_color::{ColorMode, SampleType};
    use photocraft_doc::Size;
    use photocraft_raster::from_rgba;

    // ---------------------------------------------------------------- fixtures

    /// A fresh components root per test (parallel-safe: no env vars, no shared state).
    fn root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pc-comp-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).map_err(|e| e.to_string()).expect("temp dir");
        d
    }

    /// The offer-badge manifest with defaults, per the §8.2 example.
    fn badge_manifest(version: u32) -> manifest::ComponentManifest {
        manifest::ComponentManifest::parse(
            format!(
                r#"{{
                    "id": "offer-badge",
                    "version": {version},
                    "name": "Offer Badge",
                    "tags": ["badge", "promo"],
                    "defaultSize": {{ "width": 180, "height": 180 }},
                    "variables": {{
                        "label":      {{ "kind": "text", "default": "SALE", "maxChars": 12 }},
                        "bg":         {{ "kind": "color", "default": "#D96C3B" }},
                        "textColor":  {{ "kind": "color", "default": "#FFF7EE" }},
                        "showRibbon": {{ "kind": "visibility", "default": false }}
                    }},
                    "anchors": {{ "center": [0.5, 0.5], "topRight": [1, 0], "bottomLeft": [0, 1] }},
                    "comps": ["default", "light", "dark"],
                    "license": "workspace"
                }}"#
            )
            .as_bytes(),
        )
        .expect("manifest fixture")
    }

    /// The master document: a plate raster (deterministic bounds), a fill layer, a
    /// ribbon raster and a label type layer, with `variables.defs` binding each
    /// manifest variable to its layer. `extra` appends one more layer (version 2).
    fn badge_master(version: u32, extra: bool) -> Document {
        let mut d = Document::new(format!("offer-badge@{version}.pcraft"), Size::new(180, 180), ColorMode::Rgb, SampleType::U8);
        let fmt = d.pixel_format();
        let mut plate = Layer::raster("Plate", fmt);
        {
            let s = plate.surface_mut().expect("raster");
            s.fill_rect(Rect::new(0, 0, 180, 180), &from_rgba(&fmt, [0.9, 0.9, 0.9, 1.0]));
        }
        let mut ribbon = Layer::raster("Ribbon", fmt);
        {
            let s = ribbon.surface_mut().expect("raster");
            s.fill_rect(Rect::new(0, 160, 180, 180), &from_rgba(&fmt, [1.0, 0.0, 0.0, 1.0]));
        }
        let label = Layer::new(
            "Label",
            LayerContent::Text(photocraft_doc::TextLayer {
                text: if version == 1 { "LABEL".into() } else { "NEW LABEL".into() },
                size_pt: 24.0,
                ..Default::default()
            }),
        );
        let bg = Layer::new("Badge background", LayerContent::Fill(Fill::Solid(Color::rgb(0.6, 0.2, 0.1))));
        let (plate_id, ribbon_id, label_id, bg_id) = (plate.id, ribbon.id, label.id, bg.id);
        d.layers.push(plate);
        d.layers.push(bg);
        d.layers.push(ribbon);
        d.layers.push(label);
        if extra {
            let bit = Layer::raster("New bit", fmt);
            {
                let s = bit.surface_mut().expect("raster");
                s.fill_rect(Rect::new(0, 0, 40, 40), &from_rgba(&fmt, [0.0, 0.0, 1.0, 1.0]));
            }
            d.layers.push(bit);
        }
        // The §8.1 bindings: colour variables ride any def kind (the layer is what counts).
        d.variables.defs = vec![
            VariableDef { name: "label".into(), layer: label_id, kind: VarKind::TextReplacement },
            VariableDef { name: "showRibbon".into(), layer: ribbon_id, kind: VarKind::Visibility },
            VariableDef { name: "bg".into(), layer: bg_id, kind: VarKind::TextReplacement },
            VariableDef { name: "textColor".into(), layer: label_id, kind: VarKind::TextReplacement },
        ];
        d
    }

    /// Write the component: `component.json` + the given versions' master files.
    fn write_component(dir: &Path, version: u32, versions: &[u32]) {
        let cdir = dir.join("offer-badge");
        std::fs::create_dir_all(&cdir).expect("mkdir");
        let m = badge_manifest(version);
        std::fs::write(cdir.join("component.json"), serde_json::to_vec(&m).expect("serde")).expect("write manifest");
        for v in versions {
            let bytes = photocraft_io::export(&badge_master(*v, *v >= 2), "pcraft", &photocraft_io::ExportOptions::default())
                .expect("export")
                .bytes;
            std::fs::write(cdir.join(format!("offer-badge@{v}.pcraft")), bytes).expect("write master");
        }
    }

    fn session() -> Session {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 400, "height": 400, "background": "transparent"})).expect("file.new");
        s
    }

    fn text_of(s: &Session, id: LayerId) -> String {
        match &s.active().expect("doc").doc.layer(id).expect("layer").content {
            LayerContent::Text(t) => t.text.clone(),
            other => format!("not a text layer: {}", other.kind_name()),
        }
    }

    fn color_of(s: &Session, id: LayerId) -> [u8; 4] {
        let l = s.active().expect("doc").doc.layer(id).expect("layer");
        dominant_color(l).map(|c| c.to_rgba8()).unwrap_or([0; 4])
    }

    fn child_by_name(s: &Session, gid: LayerId, name: &str) -> LayerId {
        let l = s.active().expect("doc").doc.layer(gid).expect("group");
        l.children()
            .and_then(|ch| ch.iter().find(|c| c.name == name))
            .map(|c| c.id)
            .unwrap_or(LayerId(0))
    }

    // ---------------------------------------------------------------- anchor math

    #[test]
    fn nine_point_anchor_math() {
        let design = [180.0, 180.0];
        let canvas = [400.0, 400.0];
        let table = [
            ([0.0, 0.0], [0.0, 0.0]),
            ([0.5, 0.5], [110.0, 110.0]),
            ([1.0, 1.0], [220.0, 220.0]),
            ([1.0, 0.0], [220.0, 0.0]),
            ([0.0, 1.0], [0.0, 220.0]),
            ([0.25, 0.75], [55.0, 165.0]),
        ];
        for (anchor, want) in table {
            let r = anchored_rect(anchor, design, canvas);
            assert_eq!(&r[..2], &want, "{anchor:?}");
            assert_eq!(&r[2..], &[180.0, 180.0]);
        }
        // A design larger than its canvas overflows symmetrically, off-canvas is legal
        // for computed placements (only user-passed negative bounds refuse).
        let r = anchored_rect([0.5, 0.5], [500.0, 180.0], [400.0, 400.0]);
        assert_eq!(&r[..2], &[-50.0, 110.0]);
    }

    // ---------------------------------------------------------------- place

    #[test]
    fn list_inspect_place_happy_path() {
        let dir = root("happy");
        write_component(&dir, 1, &[1]);
        let mut s = session();

        // list: discovery with tags + query.
        let listed = list_core(&dir, &json!({})).expect("list");
        assert_eq!(listed["components"].as_array().map(Vec::len), Some(1));
        assert_eq!(listed["components"][0]["id"], "offer-badge");
        assert_eq!(listed["problems"].as_array().map(Vec::len), Some(0));
        let by_tag = list_core(&dir, &json!({"tags": ["promo", "badge"]})).expect("tags");
        assert_eq!(by_tag["components"].as_array().map(Vec::len), Some(1));
        let none = list_core(&dir, &json!({"tags": ["nope"]})).expect("tags miss");
        assert_eq!(none["components"].as_array().map(Vec::len), Some(0));
        let by_query = list_core(&dir, &json!({"query": "OFFER"})).expect("query");
        assert_eq!(by_query["components"].as_array().map(Vec::len), Some(1));

        // inspect: manifest + layer map + master bindings.
        let insp = inspect_core(&dir, &s, &json!({"id": "offer-badge"})).expect("inspect");
        assert_eq!(insp["manifest"]["id"], "offer-badge");
        assert_eq!(insp["manifest"]["defaultSize"]["width"], 180);
        assert!(insp["master"]["layers"].as_array().map(Vec::len).is_some_and(|n| n >= 4));
        assert_eq!(insp["master"]["variables"].as_array().map(Vec::len), Some(4));

        // place: defaults applied (text, visibility, both colours), registry written.
        let placed = place_core(&mut s, &dir, &json!({"id": "offer-badge"})).expect("place");
        let gid = LayerId(placed["instance"].as_u64().expect("id"));
        assert_eq!(placed["component"], "offer-badge");
        assert_eq!(placed["version"], 1);
        assert_eq!(placed["bounds"], json!([110, 110, 180, 180]), "default anchor is the centre");
        assert_eq!(placed["vars"]["label"], "SALE");
        let group = s.active().expect("doc").doc.layer(gid).expect("group");
        assert_eq!(group.name, "Offer Badge");
        assert!(record_of(group).expect("record").is_some(), "the instance carries its record");
        assert_eq!(text_of(&s, child_by_name(&s, gid, "Label")), "SALE");
        assert!(!s.active().expect("doc").doc.layer(child_by_name(&s, gid, "Ribbon")).expect("l").visible, "visibility default false");
        let bg = color_of(&s, child_by_name(&s, gid, "Badge background"));
        assert_eq!(bg, [217, 108, 59, 255], "bg colour default #D96C3B");
        let tc = color_of(&s, child_by_name(&s, gid, "Label"));
        assert_eq!(tc, [255, 247, 238, 255], "text colour default #FFF7EE");
        // The instance rides the variables machinery: defs + one data set, host-wide.
        let vars = &s.active().expect("doc").doc.variables;
        assert!(vars.defs.len() >= 2, "text + visibility defs bound");
        assert!(vars.data_sets.iter().any(|d| d.name == "offer-badge#0" || d.name.starts_with("offer-badge#")), "instance data set exists");
        let _ = MKind::Text;
    }

    #[test]
    fn place_bounds_scale_and_anchor() {
        let dir = root("bounds");
        write_component(&dir, 1, &[1]);
        let mut s = session();
        // Explicit bounds scale the 180×180 design down to 90×90 at (10, 20).
        let placed = place_core(&mut s, &dir, &json!({"id": "offer-badge", "bounds": [10, 20, 90, 90]})).expect("place");
        let b = &placed["bounds"];
        assert_eq!(b[0], 10, "{b}");
        assert_eq!(b[1], 20, "{b}");
        assert_eq!(b[2], 90, "{b}");
        assert_eq!(b[3], 90, "{b}");
        // The named anchor pins the 9-point position.
        let placed = place_core(&mut s, &dir, &json!({"id": "offer-badge", "anchor": "topRight"})).expect("place");
        assert_eq!(placed["bounds"], json!([220, 0, 180, 180]));
        // Raw fractions are clamped into the grid (§8.4) — [1.5, -0.5] ≡ [1, 0].
        let placed = place_core(&mut s, &dir, &json!({"id": "offer-badge", "anchor": [1.5, -0.5]})).expect("place");
        assert_eq!(placed["bounds"], json!([220, 0, 180, 180]));
        // Two instances coexist: each gets its own defs and data set.
        let n = s.active().expect("doc").doc.variables.data_sets.len();
        assert_eq!(n, 2, "one data set per instance");
    }

    #[test]
    fn place_into_a_parent_group() {
        let dir = root("parent");
        write_component(&dir, 1, &[1]);
        let mut s = session();
        let (holder, _) = s
            .edit("make group", |doc, _| {
                let g = Layer::group("Holder", vec![]);
                let id = g.id;
                doc.layers.push(g);
                Ok((id, ()))
            })
            .expect("edit");
        let placed = place_core(&mut s, &dir, &json!({"id": "offer-badge", "parent": "Holder"})).expect("place");
        let gid = LayerId(placed["instance"].as_u64().expect("id"));
        let holder_layer = s.active().expect("doc").doc.layer(holder).expect("holder");
        assert!(holder_layer.children().is_some_and(|ch| ch.iter().any(|c| c.id == gid)), "the instance is inside the parent");
    }

    #[test]
    fn place_vars_override_defaults_and_are_schema_checked() {
        let dir = root("vars");
        write_component(&dir, 1, &[1]);
        let mut s = session();
        let placed = place_core(
            &mut s,
            &dir,
            &json!({"id": "offer-badge", "vars": {"label": "20% OFF", "showRibbon": true, "bg": "#101010"}}),
        )
        .expect("place");
        assert_eq!(placed["vars"]["label"], "20% OFF");
        let gid = LayerId(placed["instance"].as_u64().expect("id"));
        assert_eq!(text_of(&s, child_by_name(&s, gid, "Label")), "20% OFF");
        assert!(s.active().expect("doc").doc.layer(child_by_name(&s, gid, "Ribbon")).expect("l").visible);
        assert_eq!(color_of(&s, child_by_name(&s, gid, "Badge background")), [16, 16, 16, 255]);
        // Defaults still fill the unset variables.
        assert_eq!(placed["vars"]["textColor"], "#FFF7EE");

        // Unknown variables name the allowed list (§8.4).
        let err = place_core(&mut s, &dir, &json!({"id": "offer-badge", "vars": {"nope": "x"}})).err().map(|e| e.to_string()).unwrap_or_default();
        assert!(err.contains("unknown variable `nope`") && err.contains("allowed variables: label, bg, showRibbon, textColor"), "{err}");
        // Astral-plane names are refused at char boundaries, not mid-code-point.
        let err = place_core(&mut s, &dir, &json!({"id": "offer-badge", "vars": {"𝕏": "x"}})).err().map(|e| e.to_string()).unwrap_or_default();
        assert!(err.contains("unknown variable"), "{err}");
    }

    #[test]
    fn set_vars_merges_and_recolors() {
        let dir = root("setvars");
        write_component(&dir, 1, &[1]);
        let mut s = session();
        let placed = place_core(&mut s, &dir, &json!({"id": "offer-badge"})).expect("place");
        let gid = LayerId(placed["instance"].as_u64().expect("id"));
        // setVars merges into the previous state, not replaces it.
        let r = set_vars_core(&mut s, &dir, &json!({"instance": gid.0, "vars": {"bg": "#101010"}})).expect("setVars");
        assert_eq!(r["vars"]["label"], "SALE", "unset variables keep their values");
        assert_eq!(r["vars"]["bg"], "#101010");
        let r = set_vars_core(&mut s, &dir, &json!({"instance": "Offer Badge", "vars": {"label": "MINE", "showRibbon": true}})).expect("setVars by name");
        assert_eq!(r["vars"]["bg"], "#101010", "state survives a second setVars");
        assert_eq!(text_of(&s, child_by_name(&s, gid, "Label")), "MINE");
        assert_eq!(color_of(&s, child_by_name(&s, gid, "Badge background")), [16, 16, 16, 255]);
        assert!(s.active().expect("doc").doc.layer(child_by_name(&s, gid, "Ribbon")).expect("l").visible);
        // The registry carries the merged state.
        let group = s.active().expect("doc").doc.layer(gid).expect("g");
        let record = record_of(group).expect("record").expect("some");
        assert_eq!(record.vars["label"], json!("MINE"));

        // Errors: empty vars, unknown variable, wrong types, not-an-instance.
        assert!(set_vars_core(&mut s, &dir, &json!({"instance": gid.0, "vars": {}})).is_err(), "empty vars refuse");
        let err = set_vars_core(&mut s, &dir, &json!({"instance": gid.0, "vars": {"nope": true}})).err().map(|e| e.to_string()).unwrap_or_default();
        assert!(err.contains("allowed variables"), "{err}");
        assert!(set_vars_core(&mut s, &dir, &json!({"instance": gid.0, "vars": {"showRibbon": "yes"}})).is_err(), "string visibility refuses");
        assert!(set_vars_core(&mut s, &dir, &json!({"instance": gid.0, "vars": {"bg": "#12"}})).is_err(), "bad hex refuses");
        let other = {
            let (id, _) = s.edit("plain group", |doc, _| {
                let g = Layer::group("Plain", vec![]);
                let id = g.id;
                doc.layers.push(g);
                Ok((id, ()))
            }).expect("edit");
            id
        };
        let err = set_vars_core(&mut s, &dir, &json!({"instance": other.0, "vars": {"label": "x"}})).err().map(|e| e.to_string()).unwrap_or_default();
        assert!(err.contains("not a component instance"), "{err}");
        assert!(set_vars_core(&mut s, &dir, &json!({"instance": 987654, "vars": {"label": "x"}})).is_err(), "unknown instance id");
        assert!(set_vars_core(&mut s, &dir, &json!({"vars": {"label": "x"}})).is_err(), "missing instance");
    }

    #[test]
    fn update_instance_swaps_content_and_reports_user_changes() {
        let dir = root("update");
        write_component(&dir, 2, &[1, 2]);
        let mut s = session();
        let placed = place_core(&mut s, &dir, &json!({"id": "offer-badge", "bounds": [10, 10, 120, 120], "vars": {"label": "MINE"}})).expect("place");
        let gid = LayerId(placed["instance"].as_u64().expect("id"));
        // A user edit OUTSIDE the declared variables: hide the unbound plate.
        s.edit("hide plate", |doc, _| {
            let id = doc.layer(gid).and_then(|g| g.children()).and_then(|ch| ch.iter().find(|c| c.name == "Plate")).map(|c| c.id);
            if let Some(id) = id {
                doc.layer_mut(id).map(|l| l.visible = false);
            }
            Ok(())
        }).expect("edit");

        let r = update_core(&mut s, &dir, &json!({"instance": gid.0})).expect("update");
        assert_eq!(r["updated"], true);
        assert_eq!(r["from"], 1);
        assert_eq!(r["to"], 2);
        // Never silent: the user's own edit is reported.
        let changes = r["userChanges"].as_array().cloned().unwrap_or_default();
        assert!(changes.iter().any(|c| c["layer"] == "Plate" && c["aspect"] == "visible"), "{changes:?}");
        assert!(changes.iter().all(|c| c["layer"] != "Ribbon"), "variable-owned aspects are not user changes: {changes:?}");
        // The instance keeps its outer bounds and the variable state on the NEW layers.
        let group = s.active().expect("doc").doc.layer(gid).expect("g");
        assert_eq!(crate::transform_cmds::whole_layer_bounds(group), Rect::new(10, 10, 130, 130));
        assert_eq!(text_of(&s, child_by_name(&s, gid, "Label")), "MINE", "the override survives onto the new text layer");
        assert!(group.children().is_some_and(|ch| ch.iter().any(|c| c.name == "New bit")), "version 2's layer arrived");
        let record = record_of(group).expect("record").expect("some");
        assert_eq!(record.version, 2);
        // Idempotence: the second call is a no-op.
        let r = update_core(&mut s, &dir, &json!({"instance": gid.0})).expect("update again");
        assert_eq!(r["updated"], false);
        // Unknown instances refuse.
        assert!(update_core(&mut s, &dir, &json!({"instance": 424242})).is_err());
    }

    #[test]
    fn update_instance_reports_master_gone() {
        let dir = root("gone");
        write_component(&dir, 2, &[1, 2]);
        let mut s = session();
        let placed = place_core(&mut s, &dir, &json!({"id": "offer-badge", "version": 1})).expect("place");
        let gid = LayerId(placed["instance"].as_u64().expect("id"));
        // Remove BOTH masters: the old one costs the diff, the new one is fatal.
        std::fs::remove_file(dir.join("offer-badge/offer-badge@1.pcraft")).expect("rm");
        std::fs::remove_file(dir.join("offer-badge/offer-badge@2.pcraft")).expect("rm");
        let err = update_core(&mut s, &dir, &json!({"instance": gid.0})).err().map(|e| e.to_string()).unwrap_or_default();
        assert!(err.contains("no master file"), "{err}");
    }

    #[test]
    fn the_master_directory_is_never_written() {
        let dir = root("master");
        write_component(&dir, 2, &[1, 2]);
        let master_path = dir.join("offer-badge/offer-badge@1.pcraft");
        let manifest_path = dir.join("offer-badge/component.json");
        let before: Vec<Vec<u8>> = [master_path.clone(), manifest_path.clone()]
            .iter()
            .map(|p| std::fs::read(p).expect("read"))
            .collect();
        let mut s = session();
        let placed = place_core(&mut s, &dir, &json!({"id": "offer-badge", "vars": {"label": "OURS"}})).expect("place");
        let gid = LayerId(placed["instance"].as_u64().expect("id"));
        set_vars_core(&mut s, &dir, &json!({"instance": gid.0, "vars": {"bg": "#0f0f0f"}})).expect("setVars");
        update_core(&mut s, &dir, &json!({"instance": gid.0})).expect("update");
        let after: Vec<Vec<u8>> = [master_path, manifest_path].iter().map(|p| std::fs::read(p).expect("read")).collect();
        assert_eq!(before, after, "§8.4: placing, setVars and updates never touch the masters");
        // And the source directory gained no instance bookkeeping files.
        let mut names: Vec<String> = std::fs::read_dir(dir.join("offer-badge")).expect("dir").flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["component.json", "offer-badge@1.pcraft", "offer-badge@2.pcraft"], "no writes into the components dir");
        // The working copy diverges freely — it is a copy, not the master.
        assert_eq!(text_of(&s, child_by_name(&s, gid, "Label")), "OURS");
    }

    // ---------------------------------------------------------------- adversarial params

    #[test]
    fn adversarial_params_are_errors_never_panics() {
        let dir = root("adversarial");
        write_component(&dir, 1, &[1]);
        let mut s = session();

        // Non-object / missing / wrong-typed params.
        for p in [
            json!({}),
            json!({"id": 42}),
            json!({"id": ""}),
            json!({"id": null}),
            json!({"id": "../offer-badge"}),
            json!({"id": "a/b"}),
            json!({"id": "OFFER-BADGE"}),
            json!({"id": "offer-badge", "version": 0}),
            json!({"id": "offer-badge", "version": -1}),
            json!({"id": "offer-badge", "version": 1e18}),
            json!({"id": "offer-badge", "version": "1"}),
            json!({"id": "offer-badge", "version": null}),
            json!({"id": "offer-badge", "version": 99}),
        ] {
            assert!(place_core(&mut s, &dir, &p).is_err(), "{p} must refuse");
        }
        // Bounds: negative, zero-size, NaN-ish (1e999 → inf), huge, wrong shape.
        for b in [
            json!([-1, 0, 10, 10]),
            json!([0, -1, 10, 10]),
            json!([0, 0, 0, 0]),
            json!([0, 0, -10, 10]),
            json!([0, 0, 10, 0]),
            json!([1e999, 0, 10, 10]),
            json!([0, 0, 1e999, 10]),
            json!([0, 0, 90000, 90000]),
            json!([0, 0, 9000, 9000]),
            json!([0, 0, 10]),
            json!([0, 0, 10, 10, 10]),
            json!(["0", "0", 10, 10]),
            json!([null, 0, 10, 10]),
            json!([0, 0, "10", 10]),
        ] {
            assert!(place_core(&mut s, &dir, &json!({"id": "offer-badge", "bounds": b})).is_err(), "bounds {b} must refuse");
        }
        // Anchors: unknown names list the declared ones; NaN-ish and wrong shapes refuse.
        let err = place_core(&mut s, &dir, &json!({"id": "offer-badge", "anchor": "middleLeft"})).err().map(|e| e.to_string()).unwrap_or_default();
        assert!(err.contains("unknown anchor") && err.contains("center, bottomLeft, topRight"), "{err}");
        for a in [json!([1e999, 0]), json!([0.5]), json!([0.5, 0.5, 0.5]), json!(["a", "b"]), json!([null, 0]), json!(5), json!(true)] {
            assert!(place_core(&mut s, &dir, &json!({"id": "offer-badge", "anchor": a})).is_err(), "anchor {a} must refuse");
        }
        // vars: wrong shape, too many, over maxChars, wrong types, huge strings.
        assert!(place_core(&mut s, &dir, &json!({"id": "offer-badge", "vars": []})).is_err());
        assert!(place_core(&mut s, &dir, &json!({"id": "offer-badge", "vars": "label=SALE"})).is_err());
        let mut many = serde_json::Map::new();
        many.insert("label".into(), json!("SALE"));
        for i in 0..64 {
            many.insert(format!("x{i}"), json!(1));
        }
        assert!(place_core(&mut s, &dir, &json!({"id": "offer-badge", "vars": many})).is_err(), "more than MAX_VARS entries refuse");
        assert!(place_core(&mut s, &dir, &json!({"id": "offer-badge", "vars": {"label": "thirteen chars"}})).is_err(), "over maxChars");
        assert!(place_core(&mut s, &dir, &json!({"id": "offer-badge", "vars": {"label": "é".repeat(5000)}})).is_err(), "astral length cap");
        assert!(place_core(&mut s, &dir, &json!({"id": "offer-badge", "vars": {"label": 42}})).is_err());
        assert!(place_core(&mut s, &dir, &json!({"id": "offer-badge", "vars": {"bg": null}})).is_err());
        // Parents: unknown ids, names, and non-group layers all refuse.
        assert!(place_core(&mut s, &dir, &json!({"id": "offer-badge", "parent": 999999})).is_err());
        assert!(place_core(&mut s, &dir, &json!({"id": "offer-badge", "parent": "nope"})).is_err());
        assert!(place_core(&mut s, &dir, &json!({"id": "offer-badge", "parent": 1.5})).is_err());
        // Unknown components and a broken components root.
        assert!(place_core(&mut s, &dir, &json!({"id": "missing"})).is_err());
        assert!(place_core(&mut s, &Path::new("/nonexistent-components-dir"), &json!({"id": "offer-badge"})).is_err());
        let listed = list_core(Path::new("/nonexistent-components-dir"), &json!({})).expect("a missing root lists, with a problem");
        assert!(listed["problems"].as_array().is_some_and(|a| !a.is_empty()));
        // list/inspect param hygiene.
        assert!(list_core(&dir, &json!({"tags": "badge"})).is_err(), "tags must be an array");
        assert!(list_core(&dir, &json!({"tags": []})).is_err(), "empty tags refuse");
        assert!(list_core(&dir, &json!({"tags": [""]})).is_err(), "empty tag names refuse");
        assert!(list_core(&dir, &json!({"query": ""})).is_err(), "empty query refuses");
        assert!(list_core(&dir, &json!({"query": "𝕏𝕐"})).is_ok(), "astral query is a query, not a panic");
        assert!(inspect_core(&dir, &s, &json!({})).is_err(), "inspect needs an id");
        assert!(inspect_core(&dir, &s, &json!({"id": "offer-badge", "version": 0})).is_err());
        assert!(inspect_core(&dir, &s, &json!({"id": "offer-badge", "version": 7})).is_err(), "no master for v7");
        // publish refuses with the typed later-phase error.
        let err = publish(&mut s, &json!({"group": 1})).err().map(|e| e.to_string()).unwrap_or_default();
        assert!(err.contains("not available right now") && err.contains("later phase"), "{err}");
        // A malformed manifest is a problem row, not a crash.
        let junk = dir.join("junk");
        std::fs::create_dir_all(&junk).expect("mkdir");
        std::fs::write(junk.join("component.json"), b"{ not json").expect("write");
        let listed = list_core(&dir, &json!({})).expect("list");
        assert!(listed["problems"].as_array().is_some_and(|a| a.iter().any(|p| p["id"] == "junk")));
    }

    #[test]
    fn colorless_and_varless_components_place_cleanly() {
        let dir = root("minimal");
        // A component with no variables at all: no defs, no data sets, still an instance.
        let cdir = dir.join("divider");
        std::fs::create_dir_all(&cdir).expect("mkdir");
        let m: serde_json::Value = serde_json::from_str(&serde_json::to_string(&badge_manifest(1)).expect("s"))
            .expect("value")
            .as_object()
            .map(|o| {
                let mut o = o.clone();
                o.insert("id".into(), json!("divider"));
                o.insert("name".into(), json!("Divider"));
                o.remove("variables");
                o
            })
            .unwrap_or_default();
        std::fs::write(cdir.join("component.json"), serde_json::to_vec(&m).expect("v")).expect("w");
        let mut d = Document::new("divider@1.pcraft", Size::new(40, 4), ColorMode::Rgb, SampleType::U8);
        let mut bar = Layer::raster("Bar", d.pixel_format());
        {
            let s = bar.surface_mut().expect("raster");
            s.fill_rect(Rect::new(0, 0, 40, 4), &from_rgba(&d.pixel_format(), [0.2, 0.2, 0.2, 1.0]));
        }
        let bytes = photocraft_io::export(&d, "pcraft", &photocraft_io::ExportOptions::default()).expect("e").bytes;
        std::fs::write(cdir.join("divider@1.pcraft"), bytes).expect("w");
        let mut s = session();
        let placed = place_core(&mut s, &dir, &json!({"id": "divider", "bounds": [0, 0, 40, 4]})).expect("place");
        assert_eq!(placed["warnings"].as_array().map(Vec::len), Some(0));
        assert_eq!(placed["vars"].as_object().map(|o| o.len()), Some(0));
        assert!(s.active().expect("doc").doc.variables.defs.is_empty(), "nothing to drive");
        let gid = LayerId(placed["instance"].as_u64().expect("id"));
        let r = set_vars_core(&mut s, &dir, &json!({"instance": gid.0, "vars": {}}));
        assert!(r.is_err(), "no variables to set");
    }
}
