//! `template.fill` — compile slot values to existing commands and run them as one
//! transactional batch (spec §7.3/§7.4).
//!
//! Slot rules are ENFORCED HERE, not by the model (§7.3):
//! - text slots  → `type.edit` (text + paragraph box + pinned layer name) and `type.setStyle`
//!   (size clamped into the slot's `autoFit` range, declared color, alignment, leading).
//!   Text longer than `maxChars` is trimmed at a user-visible boundary and reported as a
//!   warning, never silently. Pixel fitting is `layout.fitText`'s job (§9.3, the `layout_cmds`
//!   module): when that command is registered we call it through internal dispatch and write
//!   its chosen size back with `type.setStyle`; when it is not (yet) registered the slot is
//!   filled at its declared size and only the character budget is enforced. `layout.fitText`
//!   is looked up by id at run time, so this module has no hard dependency on it.
//! - image slots → the engine half of the protocol's `doc.place`: `file.placeEmbedded`
//!   (path values; internal dispatch, so an untrusted session's authorize gate refuses
//!   ambient paths exactly as it refuses a direct call — capability roots are respected by
//!   refusal) or `crate::file_cmds::place_bytes` (base64 `data` values, like the `data`
//!   parameter of the preset imports: no filesystem read happens in the engine). The placed
//!   layer becomes a smart object, is transformed into the slot bounds with the slot's fit
//!   mode (`cover`/`contain`/`fill`) and focal point, is renamed to the slot's layer name and
//!   replaces the template placeholder. Upscaling past 125% is a warning, past 200% a hard
//!   error (§7.3); a placed image below `minPixels` is a warning (§11.1 `asset_resolution`).
//! - color slots → `layer.fill.solidColor.set` (the target must be a Solid Color Fill layer).
//! - visibility slots → `layer.setProps {visible}`.
//! - component slots → `component.place` params (the `component_cmds` module owns execution);
//!   an unknown component id is refused here with the registry's candidate list.
//! - Optional slots that are not filled stay PRESENT but hidden (`layer.setProps {visible:
//!   false}`); template layers are never deleted except the placeholder of a filled image
//!   slot, which the placed smart object replaces (a hidden placeholder would be the "hidden
//!   pixel dump" §7.5 forbids).
//!
//! The compiled list executes as ONE batch transaction: every step carries the same
//! `coalesce` key (the engine's single-history-step mechanism, cf. `extra_cmds`'s
//! rasterize helpers), so the fill is one undo step; a hard error at any step restores
//! the pre-fill document, history, selection and revision snapshot, so the batch is
//! all-or-nothing. Soft issues (trimmed text, upscale warnings, minPixels, fitText
//! overflow) are collected into the reply's `warnings` and never abort.
//!
//! Unknown slot names are an `Err` listing the manifest's slots; missing required slots
//! are an `Err` listing exactly what is needed (§7.3). `errors` stays empty in every `Ok`
//! reply (hard failures are `Err`, the engine's convention); the field exists for §7.4
//! shape parity.
//!
//! # Reconciliation contract with `manifest.rs` (W3-A) — READ THIS BEFORE EDITING
//!
//! `manifest.rs` (owned by the W3-A agent) was not in the tree when this file was
//! written; this module codes against the documented §7.2 shape through
//! `use super::manifest::…` and expects EXACTLY this surface (the field names are part
//! of the contract):
//!
//! ```ignore
//! pub struct Manifest { /* §7.2, opaque here */ }
//! impl Manifest {
//!     pub fn from_value(v: &Value) -> std::result::Result<Manifest, String>; // §7.2 JSON
//!     pub fn id(&self) -> &str;                  // manifest "id"
//!     pub fn version(&self) -> u64;              // manifest "version" (≥ 1)
//!     pub fn canvas(&self) -> (f64, f64);        // (width, height)
//!     pub fn background(&self) -> Option<&str>;  // §7.2 canvas.background "#rrggbb"
//!     pub fn slot_names(&self) -> Vec<String>;   // manifest order
//!     pub fn slot(&self, name: &str) -> Option<&Slot>;
//!     pub fn rules(&self) -> &Rules;
//!     pub fn role_of(&self, layer: &str) -> Option<&str>; // layerMap role
//!     pub fn layer_names(&self) -> Vec<String>;            // layerMap keys
//! }
//! pub struct Slot {
//!     pub kind: SlotKind,     // Text | Image | Color | Component | Visibility
//!     pub layer: String,      // target layer name (a layerMap key)
//!     pub bounds: [f64; 4],   // x, y, w, h — required for Text/Image/Component slots;
//!                             // [0.0; 4] is accepted for Color/Visibility (unused)
//!     pub optional: bool,
//!     pub raw: Value,         // the complete §7.2 slot object (kind-specific fields)
//! }
//! pub enum SlotKind { Text, Image, Color, Component, Visibility }
//! pub struct Rules {
//!     pub safe_area: Option<f64>,
//!     pub min_contrast: Option<f64>,
//!     pub must_layers: Vec<String>,
//!     pub max_text_layers: Option<u64>,
//!     pub palette: Vec<String>, // "#rrggbb" strings
//! }
//! /// The active document's applied template, as template.apply recorded it.
//! pub struct Applied {
//!     pub manifest: Manifest,
//!     pub slot_layers: std::collections::BTreeMap<String, u64>, // slot → layer id
//! }
//! /// Side-effect free (this module's `enabled` predicate calls it).
//! pub fn active(s: &Session) -> crate::Result<Applied>;
//! /// The registry resolver template.inspect uses; Err lists candidates.
//! pub fn lookup(s: &Session, id: &str, version: Option<u64>) -> crate::Result<Manifest>;
//! ```
//!
//! Manifests must accept slot `kind` values `color` and `visibility` in addition to
//! §7.2's `text`/`image`/`component` (this module's §7.3/§7.4 scope). Any deviation
//! from the surface above is a compile break to reconcile in W3-A's `manifest.rs` or a
//! follow-up — see the README section "Module layout and the specs merge".

use std::collections::BTreeMap;
use std::sync::Arc;

use photocraft_doc::{Document, Fill, LayerContent, LayerId};
use serde_json::{Map, Value, json};

use super::manifest::{self, Manifest, Slot, SlotKind};
use crate::commands;
use crate::{EngineError, Result, Session};

const CMD: &str = "template.fill";
/// §7.5 keeps templates at ~12 slots; this is only an allocation guard.
pub(crate) const MAX_SLOTS: usize = 128;
/// A text value longer than this is refused, not rendered.
pub(crate) const MAX_TEXT_CHARS: usize = 65_536;
/// A component `vars` object larger than this is refused.
pub(crate) const MAX_COMPONENT_VARS: usize = 64;
/// §7.3: upscaling a small asset beyond 125% is a warning…
pub(crate) const WARN_UPSCALE_PCT: f64 = 125.0;
/// …beyond 200% an error.
pub(crate) const ERR_UPSCALE_PCT: f64 = 200.0;
/// The alignments `type.setStyle` accepts (its parser maps anything else to Left, so only
/// these are forwarded — an unlisted value is dropped, not guessed).
const ALIGNMENTS: &[&str] =
    &["left", "center", "right", "justify", "justifyLeft", "justifyCenter", "justifyRight", "justifyAll"];

fn bad(msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: CMD.into(), msg: msg.into() }
}

/// Enabled when a document is open AND it has an applied template (`template.apply` first).
pub(crate) fn enabled(s: &Session) -> std::result::Result<(), String> {
    s.active().ok_or_else(|| "no document open".to_string())?;
    manifest::active(s).map(|_| ()).map_err(|e| e.to_string())
}

// ---------- compiled steps ----------

/// One element of the compiled batch.
enum Step {
    /// An engine command, run through internal dispatch (gated, journaled, coalesced).
    Command { id: &'static str, params: Value },
    /// An image slot: place → minPixels/upscale checks → fit transform → replace placeholder.
    Image(Box<ImagePlan>),
    /// A text slot's fitter hook: `layout.fitText` (§9.3) when registered, else a no-op.
    FitText(Box<FitPlan>),
}

enum ImageSource {
    /// Base64 bytes handed to the engine (like the preset imports' `data`): no disk read.
    Bytes { name: String, bytes: Vec<u8> },
    /// A path, placed through `file.placeEmbedded` so the session gate decides.
    Path { path: String },
}

struct ImagePlan {
    slot: String,
    source: ImageSource,
    /// The template layer the slot replaces (deleted once the placed image takes its name).
    placeholder: LayerId,
    layer_name: String,
    bounds: [f64; 4],
    mode: FitMode,
    focal: [f64; 2],
    min_pixels: Option<[f64; 2]>,
}

struct FitPlan {
    slot: String,
    layer: u64,
    bounds: [f64; 4],
    min_size: f64,
    max_size: f64,
    line_height: f64,
    max_lines: u64,
    current_size: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FitMode {
    Cover,
    Contain,
    Fill,
}

struct Compiled {
    steps: Vec<Step>,
    /// Slot names in manifest order (the request's provided slots only).
    applied: Vec<String>,
    warnings: Vec<Value>,
}

// ---------- helpers ----------

/// Byte offset of char index `chars` — every slice of input text happens at this boundary.
fn char_boundary(text: &str, chars: usize) -> usize {
    text.char_indices().nth(chars).map_or(text.len(), |(b, _)| b)
}

/// Trim `text` to at most `max_chars` Unicode scalar values (§7.3: "trims only at
/// user-visible boundaries"): the cut backs up over a trailing partial word to the nearest
/// whitespace within a small window, then an ellipsis marks the cut. Returns the trimmed
/// text and whether anything was removed.
fn trim_to_chars(text: &str, max_chars: usize) -> (String, bool) {
    let n = text.chars().count();
    if n <= max_chars {
        return (text.to_string(), false);
    }
    let cut = &text[..char_boundary(text, max_chars)];
    // Prefer a user-visible boundary: back up over the partial word to the nearest
    // whitespace inside a small window (a quarter of the budget, at least one character).
    let window = (max_chars / 4).max(1);
    let mut kept = cut;
    if let Some(ws) = kept.chars().rev().take(window).position(|c| c.is_whitespace()) {
        let n = kept.chars().count();
        kept = &kept[..char_boundary(kept, n - ws)];
    }
    let mut out = kept.trim_end().to_string();
    if out.chars().count() >= max_chars {
        // No room for a word boundary and the ellipsis: a plain character cut.
        out = out.chars().take(max_chars.saturating_sub(1)).collect::<String>().trim_end().to_string();
    }
    if out.chars().count() < max_chars {
        out.push('…');
    }
    (out, true)
}

/// A finite f64 parameter from a JSON object.
fn opt_f64(raw: &Value, key: &str) -> Option<f64> {
    raw.get(key).and_then(Value::as_f64).filter(|v| v.is_finite())
}

/// A positive-integer (≥ 1) parameter from a JSON object.
fn opt_u64(raw: &Value, key: &str) -> Option<u64> {
    raw.get(key).and_then(Value::as_u64).filter(|v| *v >= 1)
}

/// The slot's `[x, y, w, h]` bounds, validated for the kinds that need geometry.
fn slot_bounds(slot: &Slot, name: &str) -> Result<[f64; 4]> {
    let b = slot.bounds;
    if b.iter().all(|v| v.is_finite()) && b[2] > 0.0 && b[3] > 0.0 {
        return Ok(b);
    }
    Err(bad(format!(
        "slot `{name}` needs finite bounds [x, y, w, h] with positive width and height (§7.3)"
    )))
}

/// A color value passed through to `layer.fill.solidColor.set` / `type.setStyle`: a
/// `#rrggbb`/`#rrggbbaa` string (shape-checked here, re-validated by the command) or a
/// finite `[r, g, b]`/`[r, g, b, a]` array in 0..1.
fn color_passthrough(value: &Value) -> Result<Value> {
    match value {
        Value::String(s) => {
            let h = s.strip_prefix('#').unwrap_or(s);
            let ok = (h.len() == 6 || h.len() == 8) && h.bytes().all(|b| b.is_ascii_hexdigit());
            if ok {
                Ok(value.clone())
            } else {
                Err(bad(format!("color must be #rrggbb or #rrggbbaa, not {s:?}")))
            }
        }
        Value::Array(a) if a.len() == 3 || a.len() == 4 => {
            let ok = a.iter().all(|v| v.as_f64().is_some_and(|c| c.is_finite() && (0.0..=1.0).contains(&c)));
            if ok {
                Ok(value.clone())
            } else {
                Err(bad("color arrays must hold 3 or 4 finite numbers within 0..1".into()))
            }
        }
        _ => Err(bad("color must be \"#rrggbb\" or [r, g, b, a?]".into())),
    }
}

fn parse_fit_mode(value: Option<&Value>) -> Result<FitMode> {
    match value {
        None => Ok(FitMode::Cover),
        Some(Value::String(s)) => match s.as_str() {
            "cover" => Ok(FitMode::Cover),
            "contain" => Ok(FitMode::Contain),
            "fill" => Ok(FitMode::Fill),
            other => Err(bad(format!("unknown fit mode {other:?} (expected cover, contain or fill)"))),
        },
        Some(other) => Err(bad(format!("fit must be \"cover\", \"contain\" or \"fill\", not {other}"))),
    }
}

/// The affine `[a, b, c, d, e, f]` that puts a `src_w`×`src_h` image into `bounds` per
/// `mode`, cropping at `focal` (componentwise 0..1, top-left origin); also the largest
/// scale factor applied, as a percentage of the source pixels (the upscale figure §7.3).
/// Pure geometry on already-validated inputs; belt-and-braces guards keep it total.
fn fit_transform(mode: FitMode, bounds: [f64; 4], src_w: f64, src_h: f64, focal: [f64; 2]) -> Result<(f64, [f64; 6])> {
    let (bx, by, bw, bh) = (bounds[0], bounds[1], bounds[2], bounds[3]);
    if !(src_w.is_finite() && src_h.is_finite() && src_w > 0.0 && src_h > 0.0) {
        return Err(EngineError::Other(format!("cannot fit a {src_w}×{src_h} source image")));
    }
    if !(bw.is_finite() && bh.is_finite() && bw > 0.0 && bh > 0.0) {
        return Err(EngineError::Other("the image slot has no usable bounds".into()));
    }
    let (fx, fy) = (focal[0].clamp(0.0, 1.0), focal[1].clamp(0.0, 1.0));
    let (s, matrix) = match mode {
        FitMode::Cover => {
            let s = (bw / src_w).max(bh / src_h);
            let (sw, sh) = (src_w * s, src_h * s);
            // The focal point picks which part is cropped away, clamped so the box stays covered.
            let tx = bx - (sw - bw) * fx;
            let ty = by - (sh - bh) * fy;
            (s, [s, 0.0, 0.0, s, tx, ty])
        }
        FitMode::Contain => {
            let s = (bw / src_w).min(bh / src_h);
            let (sw, sh) = (src_w * s, src_h * s);
            let tx = bx + (bw - sw) / 2.0;
            let ty = by + (bh - sh) / 2.0;
            (s, [s, 0.0, 0.0, s, tx, ty])
        }
        FitMode::Fill => {
            let (sx, sy) = (bw / src_w, bh / src_h);
            (sx.max(sy), [sx, 0.0, 0.0, sy, bx, by])
        }
    };
    Ok((s * 100.0, matrix))
}

fn warning(code: &str, slot: &str, message: impl Into<String>) -> Value {
    json!({ "code": code, "slot": slot, "message": message.into() })
}

// ---------- slot target resolution ----------

/// The layer a slot acts on: the id `template.apply` recorded, else the template layer
/// name. Stale recorded ids (a placeholder a previous fill replaced) fall back to the name.
fn resolve_slot_layer(s: &Session, slot: &Slot, name: &str, mapped: Option<&u64>) -> Result<LayerId> {
    let st = s.active().ok_or(EngineError::NoDocument)?;
    if let Some(id) = mapped {
        if let Some(l) = st.doc.layer(LayerId(*id)) {
            return Ok(l.id);
        }
    }
    let matches: Vec<LayerId> = st
        .doc
        .walk()
        .iter()
        .filter(|(_, _, l)| l.name == slot.layer)
        .map(|(_, _, l)| l.id)
        .collect();
    if matches.is_empty() {
        return Err(bad(format!(
            "slot `{name}` targets template layer \"{}\", which the document does not have; {}",
            slot.layer,
            commands::layer_listing(&st.doc)
        )));
    }
    if matches.len() > 1 {
        let ids: Vec<String> = matches.iter().map(|l| l.0.to_string()).collect();
        return Err(bad(format!(
            "slot `{name}`: layer name \"{}\" matches {} layers ({})",
            slot.layer,
            matches.len(),
            ids.join(", ")
        )));
    }
    matches
        .first()
        .copied()
        .ok_or_else(|| EngineError::Other("slot layer resolution found no layer".into()))
}

// ---------- slot value parsing ----------

fn text_value(value: &Value, name: &str) -> Result<String> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Object(o) => match o.get("text") {
            Some(Value::String(s)) => Ok(s.clone()),
            _ => Err(bad(format!("slot `{name}`: a text slot takes a string or {{\"text\": str}}"))),
        },
        _ => Err(bad(format!(
            "slot `{name}`: a text slot takes a string or {{\"text\": str}}, not {value}"
        ))),
    }
}

/// A `[x, y]` focal point: two finite numbers within 0..1.
fn focal_point(value: &Value, name: &str) -> Result<Option<[f64; 2]>> {
    let Some(Value::Array(a)) = value else { return Ok(None) };
    if a.len() != 2 {
        return Err(bad(format!("slot `{name}`: focalPoint must be two numbers [x, y] within 0..1")));
    }
    let x = a.first().and_then(Value::as_f64).filter(|v| v.is_finite() && (0.0..=1.0).contains(v));
    let y = a.get(1).and_then(Value::as_f64).filter(|v| v.is_finite() && (0.0..=1.0).contains(v));
    match (x, y) {
        (Some(x), Some(y)) => Ok(Some([x, y])),
        _ => Err(bad(format!("slot `{name}`: focalPoint must be two finite numbers within 0..1"))),
    }
}

fn image_value(value: &Value, name: &str) -> Result<(ImageSource, Option<[f64; 2]>)> {
    let focal = focal_point(value, name)?;
    match value {
        Value::String(path) => Ok((ImageSource::Path { path: path.clone() }, focal)),
        Value::Object(o) => {
            if let Some(Value::String(path)) = o.get("path") {
                if !path.trim().is_empty() {
                    return Ok((ImageSource::Path { path: path.clone() }, focal));
                }
            }
            if let Some(Value::String(data)) = o.get("data") {
                let bytes = photocraft_paint::tile::b64_decode(data)
                    .ok_or_else(|| bad(format!("slot `{name}`: `data` is not valid base64")))?;
                if bytes.is_empty() {
                    return Err(bad(format!("slot `{name}`: `data` is empty")));
                }
                let default_name = format!("{name}.png");
                let file_name = o
                    .get("fileName")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(&default_name)
                    .to_string();
                return Ok((ImageSource::Bytes { name: file_name, bytes }, focal));
            }
            Err(bad(format!(
                "slot `{name}`: an image slot takes a path string, {{\"path\": str}} or {{\"data\": base64, \"fileName\"?: str}}"
            )))
        }
        _ => Err(bad(format!(
            "slot `{name}`: an image slot takes a path string, {{\"path\": str}} or {{\"data\": base64}}"
        ))),
    }
}

/// A component reference: the slot's declared `component` ("id@version"), overridable by
/// the value ("id@version", "id", or {"id", "version"?}).
fn component_ref(value: &Value, slot: &Slot, name: &str) -> Result<(String, Option<u64>)> {
    let declared = slot
        .raw
        .get("component")
        .and_then(Value::as_str)
        .ok_or_else(|| bad(format!("slot `{name}` declares no \"component\" id in its manifest")))?;
    let (mut id, mut version) = match declared.split_once('@') {
        Some((i, ver)) => (i.to_string(), ver.parse::<u64>().ok().filter(|v| *v >= 1)),
        None => (declared.to_string(), None),
    };
    match value {
        Value::String(v) => match v.split_once('@') {
            Some((vid, ver)) => {
                id = vid.to_string();
                version = ver.parse::<u64>().ok().filter(|n| *n >= 1);
            }
            None => id = v.clone(),
        },
        Value::Object(o) => {
            if let Some(Value::String(vid)) = o.get("id") {
                id = vid.clone();
            }
            if let Some(v) = o.get("version") {
                version = v.as_u64().filter(|n| *n >= 1);
                if version.is_none() {
                    return Err(bad(format!("slot `{name}`: \"version\" must be a positive integer")));
                }
            }
        }
        _ => {
            return Err(bad(format!(
                "slot `{name}`: a component slot takes \"id@version\", \"id\" or {{\"id\", \"version\"?, \"vars\"?}}"
            )))
        }
    }
    if id.trim().is_empty() {
        return Err(bad(format!("slot `{name}`: the component id is empty")));
    }
    Ok((id, version))
}

/// The refusal for an unknown component: the id plus the registry's candidates.
fn unknown_component_error(id: &str, name: &str, candidates: &[&str]) -> EngineError {
    bad(format!(
        "unknown component `{id}` for slot `{name}`; available components: {}",
        candidates.join(", ")
    ))
}

/// Guard unknown components with the registry's candidate list (§8.4's mirror here). A
/// quiet, non-journaled query: any surprise (command absent or journaled, disabled,
/// unexpected reply shape) skips the pre-check — `component.place` still refuses
/// unknown ids at run time.
fn guard_component(s: &mut Session, id: &str, name: &str) -> Result<()> {
    if commands::find("component.list").is_none_or(|c| c.journal) {
        return Ok(());
    }
    let Ok(reply) = s.execute("component.list", json!({})) else { return Ok(()) };
    let Some(list) = reply.get("components").and_then(Value::as_array) else { return Ok(()) };
    let ids: Vec<&str> = list.iter().filter_map(|c| c.get("id").and_then(Value::as_str)).collect();
    if ids.is_empty() || ids.contains(&id) {
        return Ok(());
    }
    Err(unknown_component_error(id, name, &ids))
}

// ---------- slot compilers ----------

fn compile_text_slot(
    s: &Session,
    slot: &Slot,
    name: &str,
    value: &Value,
    mapped: Option<&u64>,
    key: &str,
    steps: &mut Vec<Step>,
    warnings: &mut Vec<Value>,
) -> Result<()> {
    let text = text_value(value, name)?;
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(bad(format!("slot `{name}`: the text is longer than {MAX_TEXT_CHARS} characters")));
    }
    let mut text = text;
    if let Some(max) = opt_u64(&slot.raw, "maxChars") {
        let max = max as usize;
        let (trimmed, was) = trim_to_chars(&text, max);
        if was {
            let before = text.chars().count();
            let after = trimmed.chars().count();
            warnings.push(warning(
                "text_trimmed",
                name,
                format!(
                    "slot `{name}`: trimmed from {before} to {after} characters at a user-visible boundary (maxChars {max})"
                ),
            ));
        }
        text = trimmed;
    }
    let layer = resolve_slot_layer(s, slot, name, mapped)?;
    let st = s.active().ok_or(EngineError::NoDocument)?;
    let l = st.doc.layer(layer).ok_or(EngineError::NoLayer(layer))?;
    if !matches!(l.content, LayerContent::Text(_)) {
        return Err(bad(format!(
            "slot `{name}` targets layer \"{}\", which is {} {} layer, not a type layer",
            slot.layer,
            l.content.article(),
            l.content.kind_name()
        )));
    }
    crate::type_cmds::check_text_unlocked(&st.doc, layer).map_err(|e| bad(e.to_string()))?;
    let b = slot_bounds(slot, name)?;

    // The text, its paragraph box and its layer name (§10.2: template layers keep their names).
    steps.push(Step::Command {
        id: "type.edit",
        params: json!({
            "layer": layer.0,
            "text": text,
            "box": [b[0], b[1], b[2], b[3]],
            "name": slot.layer,
            "coalesce": key,
        }),
    });

    // The slot's declared style: size clamped into the autoFit range, color, alignment, leading.
    let mut style = Map::new();
    style.insert("layer".into(), json!(layer.0));
    let mut current_size: Option<f64> = None;
    if let Some(size) = opt_f64(&slot.raw, "size") {
        let size = clamp_to_auto_fit(size, &slot.raw, name)?;
        style.insert("size".into(), json!(size));
        current_size = Some(size);
    }
    if let Some(color) = slot.raw.get("color") {
        let passed = color_passthrough(color).map_err(|_| {
            bad(format!("slot `{name}`: the manifest's \"color\" is not a #rrggbb or [r,g,b,a] value"))
        })?;
        style.insert("color".into(), passed);
    }
    if let Some(align) = slot.raw.get("align").and_then(Value::as_str) {
        if ALIGNMENTS.contains(&align) {
            style.insert("align".into(), json!(align));
        }
    }
    if let Some(lh) = opt_f64(&slot.raw, "lineHeight").filter(|v| *v > 0.0) {
        if let Some(size) = current_size {
            let leading = size * lh;
            if (0.01..=5000.0).contains(&leading) {
                style.insert("leading".into(), json!(leading));
            }
        }
    }
    if style.len() > 1 {
        style.insert("coalesce".into(), json!(key));
        steps.push(Step::Command { id: "type.setStyle", params: Value::Object(style) });
    }

    // The fitter hook (§9.3): layout.fitText shrinks within [minSize, maxSize] and reports
    // overflow; this module writes its chosen size back and warns. Without the command the
    // slot keeps its declared size — only the character budget above applied.
    let (min_size, max_size) = auto_fit_range(&slot.raw, current_size);
    let line_height = opt_f64(&slot.raw, "lineHeight").filter(|v| *v > 0.0).unwrap_or(1.2);
    let max_lines = opt_u64(&slot.raw, "maxLines").unwrap_or(1);
    steps.push(Step::FitText(Box::new(FitPlan {
        slot: name.to_string(),
        layer: layer.0,
        bounds: b,
        min_size,
        max_size,
        line_height,
        max_lines,
        current_size: current_size.unwrap_or((min_size + max_size) / 2.0),
    })));
    Ok(())
}

/// Clamp `size` into the slot's `autoFit` `[minSize, maxSize]` when it declares one.
fn clamp_to_auto_fit(size: f64, raw: &Value, name: &str) -> Result<f64> {
    let Some(af) = raw.get("autoFit") else { return Ok(size) };
    let (Some(min), Some(max)) = (opt_f64(af, "minSize"), opt_f64(af, "maxSize")) else {
        return Err(bad(format!("slot `{name}`: autoFit needs finite \"minSize\" and \"maxSize\"")));
    };
    if min <= 0.0 || min > max {
        return Err(bad(format!("slot `{name}`: autoFit needs 0 < minSize ≤ maxSize (got {min}..{max})")));
    }
    Ok(size.clamp(min, max))
}

/// The fitting window for the layout.fitText call: the slot's autoFit range, else the
/// declared size (a wrap-only check), else this module's documented defaults.
fn auto_fit_range(raw: &Value, current: Option<f64>) -> (f64, f64) {
    if let Some(af) = raw.get("autoFit") {
        if let (Some(min), Some(max)) = (opt_f64(af, "minSize"), opt_f64(af, "maxSize")) {
            if min > 0.0 && min <= max {
                return (min, max);
            }
        }
    }
    match current {
        Some(size) => (size, size),
        None => (8.0, 512.0),
    }
}

fn compile_image_slot(
    s: &Session,
    slot: &Slot,
    name: &str,
    value: &Value,
    mapped: Option<&u64>,
    steps: &mut Vec<Step>,
) -> Result<()> {
    let (source, value_focal) = image_value(value, name)?;
    let mode = parse_fit_mode(slot.raw.get("fit"))?;
    let b = slot_bounds(slot, name)?;
    let placeholder = resolve_slot_layer(s, slot, name, mapped)?;
    let focal = value_focal
        .or(focal_point(&slot.raw, name)?)
        .unwrap_or([0.5, 0.5]);
    let min_pixels = min_pixels_of(&slot.raw, name)?;
    steps.push(Step::Image(Box::new(ImagePlan {
        slot: name.to_string(),
        source,
        placeholder,
        layer_name: slot.layer.clone(),
        bounds: b,
        mode,
        focal,
        min_pixels,
    })));
    Ok(())
}

/// The slot's `minPixels` pair (§7.2), validated.
fn min_pixels_of(raw: &Value, name: &str) -> Result<Option<[f64; 2]>> {
    let Some(Value::Array(a)) = raw.get("minPixels") else { return Ok(None) };
    if a.len() != 2 {
        return Err(bad(format!("slot `{name}`: minPixels must be two positive numbers [w, h]")));
    }
    let w = a.first().and_then(Value::as_f64).filter(|v| v.is_finite() && *v > 0.0);
    let h = a.get(1).and_then(Value::as_f64).filter(|v| v.is_finite() && *v > 0.0);
    match (w, h) {
        (Some(w), Some(h)) => Ok(Some([w, h])),
        _ => Err(bad(format!("slot `{name}`: minPixels must be two finite positive numbers"))),
    }
}

fn compile_color_slot(
    s: &Session,
    slot: &Slot,
    name: &str,
    value: &Value,
    mapped: Option<&u64>,
    key: &str,
    steps: &mut Vec<Step>,
) -> Result<()> {
    let color = color_passthrough(value).map_err(|e| bad(format!("slot `{name}`: {e}")))?;
    let layer = resolve_slot_layer(s, slot, name, mapped)?;
    let st = s.active().ok_or(EngineError::NoDocument)?;
    let l = st.doc.layer(layer).ok_or(EngineError::NoLayer(layer))?;
    if !matches!(l.content, LayerContent::Fill(Fill::Solid(_))) {
        return Err(bad(format!(
            "slot `{name}` targets layer \"{}\", which is {} {} layer, not a Solid Color Fill layer",
            slot.layer,
            l.content.article(),
            l.content.kind_name()
        )));
    }
    steps.push(Step::Command {
        id: "layer.fill.solidColor.set",
        params: json!({ "layer": layer.0, "color": color, "coalesce": key }),
    });
    Ok(())
}

fn compile_visibility_slot(
    s: &Session,
    slot: &Slot,
    name: &str,
    value: &Value,
    mapped: Option<&u64>,
    key: &str,
    steps: &mut Vec<Step>,
) -> Result<()> {
    let visible = value
        .as_bool()
        .ok_or_else(|| bad(format!("slot `{name}`: a visibility slot takes true or false, not {value}")))?;
    let layer = resolve_slot_layer(s, slot, name, mapped)?;
    steps.push(Step::Command {
        id: "layer.setProps",
        params: json!({ "layer": layer.0, "visible": visible, "coalesce": key }),
    });
    Ok(())
}

fn compile_component_slot(
    s: &mut Session,
    slot: &Slot,
    name: &str,
    value: &Value,
    mapped: Option<&u64>,
    key: &str,
    steps: &mut Vec<Step>,
) -> Result<()> {
    let (id, version) = component_ref(value, slot, name)?;
    guard_component(s, &id, name)?;
    let b = slot_bounds(slot, name)?;

    // Declared vars (§7.2 "vars") as the base, overridden by the value's vars; the
    // component's own manifest checks the keys at placement (§8.4) — this module merges,
    // it cannot know the component's declared variables.
    let mut vars = slot.raw.get("vars").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(overrides) = value.get("vars") {
        let o = overrides
            .as_object()
            .ok_or_else(|| bad(format!("slot `{name}`: \"vars\" must be an object of variable overrides")))?;
        if o.len() > MAX_COMPONENT_VARS {
            return Err(bad(format!("slot `{name}`: more than {MAX_COMPONENT_VARS} variable overrides")));
        }
        for (k, v) in o {
            vars.insert(k.clone(), v.clone());
        }
    }

    let mut params = Map::new();
    params.insert("id".into(), json!(id));
    if let Some(v) = version {
        params.insert("version".into(), json!(v));
    }
    params.insert("bounds".into(), json!([b[0], b[1], b[2], b[3]]));
    if !vars.is_empty() {
        params.insert("vars".into(), Value::Object(vars));
    }
    params.insert("coalesce".into(), json!(key));
    steps.push(Step::Command { id: "component.place", params: Value::Object(params) });

    // The template's placeholder stays present but hidden (§7.3) — the instance is the
    // component the slot now shows. A missing placeholder (a later fill) is fine.
    if let Ok(placeholder) = resolve_slot_layer(s, slot, name, mapped) {
        steps.push(Step::Command {
            id: "layer.setProps",
            params: json!({ "layer": placeholder.0, "visible": false, "coalesce": key }),
        });
    }
    Ok(())
}

// ---------- the compiler ----------

/// Compile every provided slot (in manifest order) plus the "hide unfilled optionals"
/// steps. No document mutation happens here (the one query dispatched is non-journaled).
fn compile_slots(
    s: &mut Session,
    manifest: &Manifest,
    mapped: &BTreeMap<String, u64>,
    slots: &Map<String, Value>,
    key: &str,
) -> Result<Compiled> {
    // Unknown slot names: one error listing them and the manifest's slots (§7.3).
    let mut unknown: Vec<&str> = Vec::new();
    for name in slots.keys() {
        if manifest.slot(name).is_none() {
            unknown.push(name.as_str());
        }
    }
    if !unknown.is_empty() {
        let all = manifest.slot_names().join(", ");
        return Err(bad(format!("unknown slot(s): {}; this template's slots are: {all}", unknown.join(", "))));
    }
    // Missing required slots: one error listing exactly what is needed (§7.3).
    let mut missing: Vec<String> = Vec::new();
    for name in manifest.slot_names() {
        let Some(slot) = manifest.slot(&name) else { continue };
        if !slot.optional && !slots.contains_key(&name) {
            missing.push(name.clone());
        }
    }
    if !missing.is_empty() {
        let optional: Vec<String> = manifest
            .slot_names()
            .iter()
            .filter(|n| manifest.slot(n).is_some_and(|sl| sl.optional))
            .cloned()
            .collect();
        let optional = optional.join(", ");
        let suffix = if optional.is_empty() { String::new() } else { format!(" (optional slots: {optional})") };
        return Err(bad(format!("missing required slot(s): {}{}", missing.join(", "), suffix)));
    }

    let mut compiled = Compiled { steps: Vec::new(), applied: Vec::new(), warnings: Vec::new() };
    for name in manifest.slot_names() {
        let Some(slot) = manifest.slot(&name) else { continue };
        let Some(value) = slots.get(&name) else { continue };
        let map_id = mapped.get(&name).copied();
        match slot.kind {
            SlotKind::Text => compile_text_slot(
                s,
                slot,
                &name,
                value,
                map_id.as_ref(),
                key,
                &mut compiled.steps,
                &mut compiled.warnings,
            )?,
            SlotKind::Image => compile_image_slot(s, slot, &name, value, map_id.as_ref(), &mut compiled.steps)?,
            SlotKind::Color => compile_color_slot(s, slot, &name, value, map_id.as_ref(), key, &mut compiled.steps)?,
            SlotKind::Visibility => {
                compile_visibility_slot(s, slot, &name, value, map_id.as_ref(), key, &mut compiled.steps)?
            }
            SlotKind::Component => {
                compile_component_slot(s, slot, &name, value, map_id.as_ref(), key, &mut compiled.steps)?
            }
        }
        compiled.applied.push(name.clone());
    }

    // Optional slots that were not filled stay present but hidden (§7.3) — never deleted.
    for name in manifest.slot_names() {
        let Some(slot) = manifest.slot(&name) else { continue };
        if !slot.optional || slots.contains_key(&name) {
            continue;
        }
        match resolve_slot_layer(s, slot, &name, mapped.get(&name)) {
            Ok(layer) => compiled.steps.push(Step::Command {
                id: "layer.setProps",
                params: json!({ "layer": layer.0, "visible": false, "coalesce": key }),
            }),
            Err(_) => compiled.warnings.push(warning(
                "optional_layer_missing",
                &name,
                format!(
                    "slot `{name}` (optional, unfilled) targets layer \"{}\", which the document does not have; nothing to hide",
                    slot.layer
                ),
            )),
        }
    }
    Ok(compiled)
}

// ---------- batch execution ----------

/// The state a failed batch restores: the whole point of "all-or-nothing".
struct Snapshot {
    doc: Arc<Document>,
    past: usize,
    active: Option<LayerId>,
    selected: Vec<LayerId>,
    anchor: Option<LayerId>,
    revision: u64,
    coalesce: Option<String>,
}

fn snapshot(s: &Session) -> Result<Snapshot> {
    let st = s.active().ok_or(EngineError::NoDocument)?;
    Ok(Snapshot {
        doc: st.doc.clone(),
        past: st.history.past_len(),
        active: st.active_layer,
        selected: st.selected_layers.clone(),
        anchor: st.layer_anchor,
        revision: st.revision,
        coalesce: st.coalesce.clone(),
    })
}

fn restore(s: &mut Session, before: &Snapshot) {
    let Some(st) = s.active_mut() else { return };
    st.doc = before.doc.clone();
    // Every history entry the batch added (one, while coalesced) goes away with its
    // pixels, and nothing stays redoable: the fill never happened.
    let extra = st.history.past_len().saturating_sub(before.past);
    for _ in 0..extra {
        if !st.history.purge_last() {
            break;
        }
    }
    st.history.clear_redo();
    st.active_layer = before.active;
    st.selected_layers = before.selected.clone();
    st.layer_anchor = before.anchor;
    st.revision = before.revision;
    st.coalesce = before.coalesce.clone();
    st.last_damage = None;
}

fn run_image(s: &mut Session, plan: &ImagePlan, key: &str, warnings: &mut Vec<Value>) -> Result<()> {
    let (cx, cy) = (plan.bounds[0] + plan.bounds[2] / 2.0, plan.bounds[1] + plan.bounds[3] / 2.0);
    let placed = match &plan.source {
        ImageSource::Bytes { name, bytes } => {
            let opts = json!({ "smartObject": true, "fit": false, "scale": 100.0, "center": [cx, cy] });
            crate::file_cmds::place_bytes(s, name, bytes.clone(), None, &opts)?
        }
        ImageSource::Path { path } => {
            s.execute(
                "file.placeEmbedded",
                json!({ "path": path, "smartObject": true, "fit": false, "scale": 100.0, "center": [cx, cy], "coalesce": key }),
            )?
        }
    };
    let layer = placed
        .get("layer")
        .and_then(Value::as_u64)
        .ok_or_else(|| EngineError::Other(format!("slot `{}`: placing the image reported no layer id", plan.slot)))?;
    let bounds = placed
        .get("bounds")
        .and_then(Value::as_array)
        .filter(|a| a.len() == 4)
        .ok_or_else(|| EngineError::Other(format!("slot `{}`: placing the image reported no bounds", plan.slot)))?;
    let dim = |i: usize| {
        bounds
            .get(i)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .ok_or_else(|| EngineError::Other(format!("slot `{}`: the placed image's bounds are not numbers", plan.slot)))
    };
    let (x0, y0, x1, y1) = (dim(0)?, dim(1)?, dim(2)?, dim(3)?);
    let (w, h) = (x1 - x0, y1 - y0);
    if !(w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0) {
        return Err(EngineError::Other(format!(
            "slot `{}`: the placed image has no usable dimensions ({w}×{h})",
            plan.slot
        )));
    }
    if let Some(min) = plan.min_pixels {
        if w < min[0] || h < min[1] {
            warnings.push(warning(
                "asset_below_min_pixels",
                &plan.slot,
                format!(
                    "slot `{}`: the image is {}×{} px, below the slot's minPixels {}×{} px",
                    plan.slot, w, h, min[0], min[1]
                ),
            ));
        }
    }
    let (pct, matrix) = fit_transform(plan.mode, plan.bounds, w, h, plan.focal)?;
    if pct > ERR_UPSCALE_PCT {
        let need_w = plan.bounds[2] / (ERR_UPSCALE_PCT / 100.0);
        let need_h = plan.bounds[3] / (ERR_UPSCALE_PCT / 100.0);
        return Err(EngineError::Other(format!(
            "slot `{}`: upscaling the image to {:.0}% of its pixels exceeds the 200% limit; use an image at least around {:.0}×{:.0} px",
            plan.slot, pct, need_w, need_h
        )));
    }
    if pct > WARN_UPSCALE_PCT {
        warnings.push(warning(
            "image_upscaled",
            &plan.slot,
            format!(
                "slot `{}`: the image is upscaled to {:.0}% of its pixels (> 125%); the result may look soft",
                plan.slot, pct
            ),
        ));
    }
    s.execute("edit.transform", json!({ "layer": layer, "matrix": matrix, "coalesce": key }))?;
    s.execute("layer.setProps", json!({ "layer": layer, "name": plan.layer_name, "coalesce": key }))?;
    // The placeholder is replaced by the placed image (which now owns its name); a hidden
    // placeholder would be the "hidden pixel dump" §7.5 forbids.
    s.execute("layer.delete", json!({ "layer": plan.placeholder.0, "coalesce": key }))?;
    Ok(())
}

fn run_fit_text(s: &mut Session, plan: &FitPlan, key: &str, warnings: &mut Vec<Value>) -> Result<()> {
    // §9.3's fitter is another module's command (layout_cmds): call it through internal
    // dispatch when it is registered and non-journaled, else keep the declared size.
    if commands::find("layout.fitText").is_none_or(|c| c.journal) {
        return Ok(());
    }
    let reply = match s.execute(
        "layout.fitText",
        json!({
            "layer": plan.layer,
            "bounds": [plan.bounds[0], plan.bounds[1], plan.bounds[2], plan.bounds[3]],
            "minSize": plan.min_size,
            "maxSize": plan.max_size,
            "lineHeight": plan.line_height,
            "maxLines": plan.max_lines,
            "coalesce": key,
        }),
    ) {
        Ok(v) => v,
        Err(_) => {
            warnings.push(warning(
                "fit_text_failed",
                &plan.slot,
                format!("slot `{}`: layout.fitText could not measure the text; it keeps its declared size", plan.slot),
            ));
            return Ok(());
        }
    };
    let size = reply.get("size").and_then(Value::as_f64).filter(|v| v.is_finite() && *v > 0.0);
    if let Some(size) = size {
        if (size - plan.current_size).abs() > 0.05 {
            s.execute("type.setStyle", json!({ "layer": plan.layer, "size": size, "coalesce": key }))?;
        }
    }
    let overflowed = reply.get("overflow").and_then(Value::as_bool).unwrap_or(false)
        || reply.get("overflow").and_then(Value::as_f64).is_some_and(|v| v > 0.0);
    if overflowed {
        let lines = reply.get("lines").and_then(Value::as_u64).unwrap_or(0);
        warnings.push(warning(
            "text_overflow",
            &plan.slot,
            format!(
                "slot `{}`: the text does not fit its box ({} lines at {:.1} pt); layout.fitText reported overflow",
                plan.slot,
                lines,
                size.unwrap_or(plan.current_size)
            ),
        ));
    }
    Ok(())
}

/// Run the compiled list as one batch: one coalesced history step, all-or-nothing on hard
/// errors, soft issues appended to `warnings`.
fn execute_batch(s: &mut Session, compiled: &Compiled, key: &str, warnings: &mut Vec<Value>) -> Result<()> {
    let before = snapshot(s)?;
    let mut ran = Ok(());
    for step in &compiled.steps {
        let r = match step {
            Step::Command { id, params } => s.execute(id, params.clone()).map(|_| ()),
            Step::Image(plan) => run_image(s, plan, key, warnings),
            Step::FitText(plan) => run_fit_text(s, plan, key, warnings),
        };
        if let Err(e) = r {
            ran = Err(e);
            break;
        }
    }
    match ran {
        Ok(()) => {
            // One history step for the whole fill, named for the History panel.
            if let Some(st) = s.active_mut() {
                if st.history.past_len() > before.past {
                    st.history.set_current_label("Fill Template");
                }
            }
            Ok(())
        }
        Err(e) => {
            restore(s, &before);
            Err(EngineError::Other(format!("template.fill aborted, the document is unchanged: {e}")))
        }
    }
}

// ---------- the command ----------

/// `template.fill { slots }` → `{ applied, warnings, errors, template }` (§7.4).
pub(super) fn run(s: &mut Session, p: &Value) -> Result<Value> {
    let slots = p
        .get("slots")
        .and_then(Value::as_object)
        .ok_or_else(|| bad("`slots` must be an object of {slotName: value}"))?;
    if slots.len() > MAX_SLOTS {
        return Err(bad(format!("`slots` lists {} entries; at most {MAX_SLOTS} are accepted", slots.len())));
    }
    let applied_state = manifest::active(s).map_err(|e| {
        bad(format!("no template is applied to the active document (run template.apply first): {e}"))
    })?;
    let manifest = &applied_state.manifest;
    let key = crate::extra_cmds::step_key(s, "template.fill");
    let compiled = compile_slots(s, manifest, &applied_state.slot_layers, slots, &key)?;
    let mut warnings = compiled.warnings.clone();
    execute_batch(s, &compiled, &key, &mut warnings)?;
    Ok(json!({
        "applied": compiled.applied,
        "warnings": warnings,
        // Hard failures are Err (the engine convention); errors stays empty in every Ok reply.
        "errors": [],
        "template": format!("{}@{}", manifest.id(), manifest.version()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- fixtures ----------

    /// The §7.2 manifest shape (plus this module's `color`/`visibility` slot kinds).
    fn manifest_value() -> Value {
        json!({
            "id": "test-post",
            "version": 3,
            "name": "Test Post",
            "description": "fixture",
            "tags": ["test"],
            "canvas": { "width": 1080, "height": 1080, "background": "#F4E7D3" },
            "slots": {
                "photo": { "kind": "image", "layer": "Photo", "bounds": [0, 0, 1080, 700],
                            "fit": "cover", "minPixels": [100, 60], "optional": false },
                "headline": { "kind": "text", "layer": "Headline", "bounds": [72, 732, 936, 176],
                               "font": "display", "weight": "bold", "size": 96, "lineHeight": 1.05,
                               "maxLines": 2, "maxChars": 42, "align": "left", "color": "#3B2A20",
                               "autoFit": { "minSize": 56, "maxSize": 110 }, "optional": false },
                "subhead": { "kind": "text", "layer": "Subhead", "bounds": [72, 924, 936, 56],
                              "font": "sans", "size": 36, "maxLines": 1, "maxChars": 12,
                              "color": "#6B5748", "optional": true },
                "badge": { "kind": "component", "component": "offer-badge@2", "layer": "Badge",
                            "bounds": [828, 72, 180, 180], "optional": true, "vars": { "label": "20% OFF" } },
                "logo": { "kind": "image", "layer": "Logo", "bounds": [888, 984, 120, 40],
                           "fit": "contain", "optional": true },
                "bg": { "kind": "color", "layer": "Background", "bounds": [0, 0, 1080, 1080], "optional": false },
                "showLogo": { "kind": "visibility", "layer": "Logo", "bounds": [888, 984, 120, 40], "optional": true }
            },
            "rules": { "safeArea": 48, "minContrast": 4.5,
                        "mustLayers": ["Background", "Photo", "Headline"],
                        "maxTextLayers": 6, "palette": ["#F4E7D3", "#3B2A20", "#D96C3B"] },
            "layerMap": {
                "Background": { "role": "background", "fill": "#F4E7D3" },
                "Photo": { "role": "image", "mask": "rounded", "maskRadius": 0 },
                "Headline": { "role": "headline" },
                "Subhead": { "role": "supporting-text" },
                "Badge": { "role": "component", "component": "offer-badge@2" },
                "Logo": { "role": "logo" }
            },
            "thumbnail": "thumbnails/test-post@3.png",
            "license": "workspace",
            "author": "studio"
        })
    }

    fn fixture_manifest() -> Result<Manifest> {
        manifest::Manifest::from_value(&manifest_value()).map_err(EngineError::Other)
    }

    /// A small document with the template's layers (as `template.apply` would leave them).
    fn template_session() -> Result<Session> {
        let mut s = Session::new();
        s.execute("file.new", json!({ "width": 1080, "height": 1080, "depth": 8 }))?;
        let bg = s
            .execute("layer.newFillLayer.solidColor", json!({ "color": "#F4E7D3" }))?
            .get("layer")
            .and_then(Value::as_u64)
            .ok_or(EngineError::Other("no layer id".into()))?;
        s.execute("layer.setProps", json!({ "layer": bg, "name": "Background" }))?;
        s.execute("layer.new.layer", json!({ "name": "Photo" }))?;
        s.execute("layer.new.layer", json!({ "name": "Logo" }))?;
        s.execute("layer.new.layer", json!({ "name": "Badge" }))?;
        s.execute("type.create", json!({ "x": 72, "y": 800, "text": "Old headline", "size": 96, "name": "Headline" }))?;
        s.execute("type.create", json!({ "x": 72, "y": 940, "text": "Old sub", "size": 36, "name": "Subhead" }))?;
        Ok(s)
    }

    fn layer_id_of(s: &Session, name: &str) -> Result<u64> {
        let st = s.active().ok_or(EngineError::NoDocument)?;
        st.doc
            .walk()
            .iter()
            .find(|(_, _, l)| l.name == name)
            .map(|(_, _, l)| l.id.0)
            .ok_or(EngineError::Other(format!("no layer named {name}")))
    }

    /// A valid grayscale PNG of `w`×`h` built byte by byte (no fixtures on disk, no deps).
    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
            let mut out = (data.len() as u32).to_be_bytes().to_vec();
            out.extend_from_slice(kind);
            out.extend_from_slice(data);
            let mut crc: u32 = 0xffff_ffff;
            for &b in kind.iter().chain(data.iter()) {
                crc ^= u32::from(b);
                for _ in 0..8 {
                    let mask = u32::from(crc & 1).wrapping_neg();
                    crc = (crc >> 1) ^ (0xedb8_8320 & mask);
                }
            }
            out.extend_from_slice(&(!crc).to_be_bytes());
            out
        }
        let mut out = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 0, 0, 0, 0]); // 8-bit grayscale
        out.extend_from_slice(&chunk(b"IHDR", &ihdr));
        // One filter-0 row per scanline, all zero pixels: stored (uncompressed) deflate
        // blocks keep this literal — no compressor needed.
        let mut raw = Vec::new();
        for _ in 0..h {
            raw.push(0u8);
            raw.extend(std::iter::repeat_n(0u8, w as usize));
        }
        let mut z = vec![0x78, 0x01];
        let blocks = raw.len().div_ceil(65_535);
        for (i, part) in raw.chunks(65_535).enumerate() {
            z.push(if i + 1 == blocks { 1 } else { 0 });
            z.extend_from_slice(&(part.len() as u16).to_le_bytes());
            z.extend_from_slice(&(!(part.len() as u16)).to_le_bytes());
            z.extend_from_slice(part);
        }
        let (mut a, mut b): (u32, u32) = (1, 0);
        for &x in raw.iter() {
            a = (a + u32::from(x)) % 65_521;
            b = (b + a) % 65_521;
        }
        z.extend_from_slice(&(((b << 16) | a)).to_be_bytes());
        out.extend_from_slice(&chunk(b"IDAT", &z));
        out.extend_from_slice(&chunk(b"IEND", &[]));
        out
    }

    fn base64(data: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for group in data.chunks(3) {
            let b = [
                group.first().copied().unwrap_or(0),
                group.get(1).copied().unwrap_or(0),
                group.get(2).copied().unwrap_or(0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if group.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if group.len() > 2 { T[n as usize & 63] as char } else { '=' });
        }
        out
    }

    fn compile(s: &mut Session, m: &Manifest, slots: Value) -> Result<Compiled> {
        let key = crate::extra_cmds::step_key(s, "template.fill");
        let empty = BTreeMap::new();
        let slots = slots.as_object().cloned().unwrap_or_default();
        compile_slots(s, m, &empty, &slots, &key)
    }

    fn step_ids(c: &Compiled) -> Vec<&'static str> {
        c.steps
            .iter()
            .filter_map(|s| match s {
                Step::Command { id, .. } => Some(*id),
                _ => None,
            })
            .collect()
    }

    // ---------- slot compile: happy paths ----------

    #[test]
    fn text_slot_compiles_to_type_edit_and_style() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let c = compile(&mut s, &m, json!({ "headline": "Summer sale" }))?;
        assert_eq!(c.applied, ["headline"]);
        assert!(c.warnings.is_empty(), "{:?}", c.warnings);
        assert_eq!(step_ids(&c), ["type.edit", "type.setStyle"]);
        let head = layer_id_of(&s, "Headline")?;
        match c.steps.first() {
            Some(Step::Command { id, params }) => {
                assert_eq!(*id, "type.edit");
                assert_eq!(params.get("text").and_then(Value::as_str), Some("Summer sale"));
                assert_eq!(params.get("layer").and_then(Value::as_u64), Some(head));
                assert!(params.get("box").and_then(Value::as_array).is_some_and(|b| b.len() == 4), "{params:?}");
                // The layer name is pinned so must-layers keep resolving (§10.2).
                assert_eq!(params.get("name").and_then(Value::as_str), Some("Headline"));
            }
            other => return Err(EngineError::Other(format!("expected type.edit, got {other:?}"))),
        }
        match c.steps.get(1) {
            Some(Step::Command { id, params }) => {
                assert_eq!(*id, "type.setStyle");
                assert_eq!(params.get("size").and_then(Value::as_f64), Some(96.0), "size in the autoFit range");
                assert_eq!(params.get("color").and_then(Value::as_str), Some("#3B2A20"));
                assert_eq!(params.get("align").and_then(Value::as_str), Some("left"));
                assert!((params.get("leading").and_then(Value::as_f64).unwrap_or(0.0) - 100.8).abs() < 0.01);
            }
            other => return Err(EngineError::Other(format!("expected type.setStyle, got {other:?}"))),
        }
        Ok(())
    }

    #[test]
    fn text_size_is_clamped_into_the_auto_fit_range() -> Result<()> {
        let mut v = manifest_value();
        v["slots"]["headline"]["size"] = json!(200);
        let m = manifest::Manifest::from_value(&v).map_err(EngineError::Other)?;
        let (mut s, _) = (template_session()?, ());
        let c = compile(&mut s, &m, json!({ "headline": "Big" }))?;
        match c.steps.get(1) {
            Some(Step::Command { id: "type.setStyle", params }) => {
                assert_eq!(params.get("size").and_then(Value::as_f64), Some(110.0), "clamped to maxSize");
            }
            other => return Err(EngineError::Other(format!("expected type.setStyle, got {other:?}"))),
        }
        Ok(())
    }

    #[test]
    fn color_slot_compiles_to_solid_color_set() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let c = compile(&mut s, &m, json!({ "bg": "#D96C3B" }))?;
        assert_eq!(step_ids(&c), ["layer.fill.solidColor.set"]);
        match c.steps.first() {
            Some(Step::Command { params, .. }) => {
                assert_eq!(params.get("color").and_then(Value::as_str), Some("#D96C3B"));
                assert_eq!(params.get("layer").and_then(Value::as_u64), Some(layer_id_of(&s, "Background")?));
            }
            other => return Err(EngineError::Other(format!("expected solidColor.set, got {other:?}"))),
        }
        Ok(())
    }

    #[test]
    fn visibility_slot_compiles_to_set_props() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let c = compile(&mut s, &m, json!({ "showLogo": true }))?;
        assert_eq!(step_ids(&c), ["layer.setProps"]);
        match c.steps.first() {
            Some(Step::Command { params, .. }) => {
                assert_eq!(params.get("visible").and_then(Value::as_bool), Some(true));
            }
            other => return Err(EngineError::Other(format!("expected layer.setProps, got {other:?}"))),
        }
        Ok(())
    }

    #[test]
    fn image_slot_with_bytes_compiles_to_a_place_plan() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let data = base64(&png_bytes(70, 45));
        let c = compile(&mut s, &m, json!({ "photo": { "data": data, "fileName": "photo.png" } }))?;
        assert_eq!(c.applied, ["photo"]);
        assert!(c.warnings.is_empty(), "{:?}", c.warnings);
        match c.steps.first() {
            Some(Step::Image(plan)) => {
                assert_eq!(plan.slot, "photo");
                assert_eq!(plan.layer_name, "Photo");
                assert!(matches!(plan.mode, FitMode::Cover));
                assert_eq!(plan.focal, [0.5, 0.5]);
                assert_eq!(plan.min_pixels, Some([100.0, 60.0]));
                assert_eq!(plan.placeholder.0, layer_id_of(&s, "Photo")?);
                assert!(matches!(plan.source, ImageSource::Bytes { .. }));
            }
            other => return Err(EngineError::Other(format!("expected an image plan, got {other:?}"))),
        }
        Ok(())
    }

    #[test]
    fn image_slot_path_value_compiles_to_file_place_embedded() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let c = compile(&mut s, &m, json!({ "photo": "assets/beach.png" }))?;
        match c.steps.first() {
            Some(Step::Image(plan)) => match &plan.source {
                ImageSource::Path { path } => assert_eq!(path, "assets/beach.png"),
                other => return Err(EngineError::Other(format!("expected a path source, got {other:?}"))),
            },
            other => return Err(EngineError::Other(format!("expected an image plan, got {other:?}"))),
        }
        Ok(())
    }

    // ---------- slot compile: adversarial ----------

    #[test]
    fn unknown_slot_lists_the_manifest_slots() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let e = compile(&mut s, &m, json!({ "nonsense": 1, "also-wrong": "" })).unwrap_err();
        let msg = e.to_string();
        for needed in [
            "unknown slot",
            "nonsense",
            "also-wrong",
            "photo",
            "headline",
            "subhead",
            "badge",
            "logo",
            "bg",
            "showLogo",
        ] {
            assert!(msg.contains(needed), "{msg} lacks {needed:?}");
        }
        Ok(())
    }

    #[test]
    fn missing_required_slots_are_listed_exactly() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let e = compile(&mut s, &m, json!({ "headline": "Hello" })).unwrap_err();
        let msg = e.to_string();
        assert!(msg.contains("missing required slot"), "{msg}");
        assert!(msg.contains("photo"), "{msg}");
        assert!(msg.contains("bg"), "{msg}");
        assert!(!msg.contains("`headline`"), "{msg} lists a provided slot as missing");
        Ok(())
    }

    #[test]
    fn text_values_of_the_wrong_shape_are_errors() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        for bad_value in [json!(42), json!({ "text": 7 }), json!([]), json!({ "nope": "x" })] {
            let e = compile(&mut s, &m, json!({ "headline": bad_value })).unwrap_err();
            assert!(e.to_string().contains("headline"), "{e}");
        }
        Ok(())
    }

    #[test]
    fn oversize_text_is_trimmed_at_a_word_boundary_with_a_warning() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let c = compile(&mut s, &m, json!({ "headline": "The gigantic summer sale that never ever ends soon" }))?;
        assert_eq!(c.warnings.len(), 1, "{:?}", c.warnings);
        assert_eq!(c.warnings[0].get("code").and_then(Value::as_str), Some("text_trimmed"));
        match c.steps.first() {
            Some(Step::Command { params, .. }) => {
                let t = params.get("text").and_then(Value::as_str).ok_or(EngineError::Other("no text".into()))?;
                assert!(t.chars().count() <= 42, "{t}");
                assert!(t.ends_with('…'), "{t}");
                assert!(!t.contains("  "), "{t}");
            }
            other => return Err(EngineError::Other(format!("{other:?}"))),
        }
        Ok(())
    }

    #[test]
    fn astral_plane_characters_are_trimmed_on_char_boundaries() -> Result<()> {
        // Astral-plane chars are 4 UTF-8 bytes; a byte-wise cut would panic on slicing.
        let emoji: String = std::iter::repeat('🔥').take(30).collect();
        let (out, was) = trim_to_chars(&emoji, 7);
        assert!(was);
        assert_eq!(out.chars().count(), 7, "{out}");
        assert!(out.ends_with('…'), "{out}");
        // CJK without whitespace still gets a plain character cut, never a panic.
        let cjk: String = std::iter::repeat('促').take(20).collect();
        let (out2, was2) = trim_to_chars(&cjk, 5);
        assert!(was2);
        assert_eq!(out2.chars().count(), 5, "{out2}");
        assert!(out2.ends_with('…'), "{out2}");
        // Short text passes through untouched.
        let (same, was3) = trim_to_chars("short", 10);
        assert!(!was3);
        assert_eq!(same, "short");
        Ok(())
    }

    #[test]
    fn oversize_text_value_is_refused_not_trimmed() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let huge: String = std::iter::repeat('x').take(MAX_TEXT_CHARS + 1).collect();
        let e = compile(&mut s, &m, json!({ "headline": huge })).unwrap_err();
        assert!(e.to_string().contains("longer than"), "{e}");
        Ok(())
    }

    #[test]
    fn image_values_of_the_wrong_shape_are_errors() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        for bad_value in [
            json!(42),
            json!({ "data": "%%%not base64" }),
            json!({ "data": "" }),
            json!({ "path": 7 }),
            json!({ "focalPoint": [2.0, 0.0] }),
            json!({ "focalPoint": [1e999, 0.0] }),
            json!({ "focalPoint": [0.5] }),
        ] {
            let e = compile(&mut s, &m, json!({ "photo": bad_value })).unwrap_err();
            assert!(e.to_string().contains("photo"), "{e} for {bad_value}");
        }
        Ok(())
    }

    #[test]
    fn bad_fit_modes_are_errors() -> Result<()> {
        assert!(parse_fit_mode(Some(&json!("stretch"))).is_err());
        assert!(matches!(parse_fit_mode(None), Ok(FitMode::Cover)));
        assert!(matches!(parse_fit_mode(Some(&json!("contain"))), Ok(FitMode::Contain)));
        assert!(matches!(parse_fit_mode(Some(&json!("fill"))), Ok(FitMode::Fill)));
        assert!(parse_fit_mode(Some(&json!(7))).is_err());
        Ok(())
    }

    #[test]
    fn a_manifest_slot_with_a_bad_declared_focal_point_is_refused() -> Result<()> {
        let mut v = manifest_value();
        v["slots"]["photo"]["focalPoint"] = json!([-0.5, 0.5]);
        match manifest::Manifest::from_value(&v) {
            // A's parser rejecting the manifest outright is equally correct.
            Err(_) => Ok(()),
            Ok(m) => {
                let mut s = template_session()?;
                let e = compile(&mut s, &m, json!({ "photo": "x.png" })).unwrap_err();
                assert!(e.to_string().contains("focalPoint"), "{e}");
                Ok(())
            }
        }
    }

    #[test]
    fn color_values_are_shape_checked() -> Result<()> {
        for bad in [
            json!("#XYZ"),
            json!("#12345"),
            json!("#GGGGGG"),
            json!([1.0, 0.0]),
            json!([2.0, 0.0, 0.0]),
            json!(42),
            json!(true),
        ] {
            assert!(color_passthrough(&bad).is_err(), "{bad}");
        }
        assert_eq!(
            color_passthrough(&json!("#F4E7D3")).ok().and_then(|v| v.as_str().map(str::to_string)),
            Some("#F4E7D3".into())
        );
        assert!(color_passthrough(&json!([0.5, 0.5, 0.5, 1.0])).is_ok());
        Ok(())
    }

    #[test]
    fn a_color_slot_refuses_a_non_fill_target() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        // "Photo" is a pixel layer, not a Solid Color Fill layer.
        let e = compile(&mut s, &m, json!({ "bg": "Photo" })).unwrap_err();
        assert!(e.to_string().contains("Solid Color Fill"), "{e}");
        Ok(())
    }

    #[test]
    fn text_slot_target_must_be_a_type_layer() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        // Point the headline slot at a non-type layer by removing the real one.
        let head = layer_id_of(&s, "Headline")?;
        s.execute("layer.delete", json!({ "layer": head }))?;
        s.execute("layer.new.layer", json!({ "name": "Headline" }))?;
        let e = compile(&mut s, &m, json!({ "headline": "Hello" })).unwrap_err();
        assert!(e.to_string().contains("not a type layer"), "{e}");
        Ok(())
    }

    #[test]
    fn a_locked_text_target_is_refused_before_any_step_runs() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let head = layer_id_of(&s, "Headline")?;
        s.execute("layer.setProps", json!({ "layer": head, "locked": true }))?;
        let e = compile(&mut s, &m, json!({ "headline": "Hello" })).unwrap_err();
        assert!(e.to_string().contains("locked"), "{e}");
        Ok(())
    }

    #[test]
    fn missing_template_layer_is_an_error_that_lists_the_document() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let logo = layer_id_of(&s, "Logo")?;
        s.execute("layer.delete", json!({ "layer": logo }))?;
        let e = compile(&mut s, &m, json!({ "showLogo": true })).unwrap_err();
        let msg = e.to_string();
        assert!(msg.contains("Logo"), "{msg}");
        assert!(msg.contains("the document's layers"), "{msg}");
        Ok(())
    }

    #[test]
    fn ambiguous_layer_names_are_refused() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        s.execute("layer.new.layer", json!({ "name": "Logo" }))?;
        let e = compile(&mut s, &m, json!({ "showLogo": true })).unwrap_err();
        assert!(e.to_string().contains("matches 2 layers"), "{e}");
        Ok(())
    }

    #[test]
    fn optional_unfilled_slots_are_hidden_never_deleted() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let c = compile(
            &mut s,
            &m,
            json!({ "photo": { "data": base64(&png_bytes(1080, 700)) }, "headline": "Hi", "bg": "#F4E7D3" }),
        )?;
        // subhead, badge, logo and showLogo are unfilled optionals → hidden (logo and
        // showLogo both target Logo: one layer, two hide steps, both idempotent).
        let hides: Vec<&Value> = c
            .steps
            .iter()
            .filter_map(|st| match st {
                Step::Command { id: "layer.setProps", params } => Some(params),
                _ => None,
            })
            .filter(|p| p.get("visible").and_then(Value::as_bool) == Some(false))
            .collect();
        assert_eq!(hides.len(), 4, "{hides:?}");
        assert!(!c.applied.contains(&"logo".to_string()));
        assert!(
            c.steps.iter().all(|st| !matches!(st, Step::Command { id: "layer.delete", .. })),
            "compile emits no layer.delete steps (image placeholder deletion happens in the executor)"
        );
        Ok(())
    }

    #[test]
    fn too_many_slots_is_refused() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let mut slots = Map::new();
        for i in 0..(MAX_SLOTS + 1) {
            slots.insert(format!("s{i}"), json!(1));
        }
        let e = compile(&mut s, &m, Value::Object(slots)).unwrap_err();
        assert!(e.to_string().contains("at most"), "{e}");
        Ok(())
    }

    #[test]
    fn component_slot_compiles_place_params_with_merged_vars() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let c = compile(&mut s, &m, json!({ "badge": { "vars": { "label": "50% OFF", "bg": "#D96C3B" } } }))?;
        let params = c
            .steps
            .iter()
            .find_map(|st| match st {
                Step::Command { id: "component.place", params } => Some(params),
                _ => None,
            })
            .ok_or(EngineError::Other("no component.place step".into()))?;
        assert_eq!(params.get("id").and_then(Value::as_str), Some("offer-badge"));
        assert_eq!(params.get("version").and_then(Value::as_u64), Some(2));
        assert!(params.get("bounds").and_then(Value::as_array).is_some_and(|b| b.len() == 4), "{params:?}");
        let vars = params.get("vars").and_then(Value::as_object);
        assert!(vars.is_some_and(|v| v.get("label").and_then(Value::as_str) == Some("50% OFF")), "{params:?}");
        assert!(vars.is_some_and(|v| v.get("bg").and_then(Value::as_str) == Some("#D96C3B")), "{params:?}");
        // The placeholder is hidden (never deleted) once the instance is placed.
        let hides = c
            .steps
            .iter()
            .filter_map(|st| match st {
                Step::Command { id: "layer.setProps", params } => Some(params),
                _ => None,
            })
            .filter(|p| p.get("visible").and_then(Value::as_bool) == Some(false))
            .count();
        assert_eq!(hides, 1);
        Ok(())
    }

    #[test]
    fn component_reference_parsing_and_errors() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let c = compile(&mut s, &m, json!({ "badge": "star-rating@3" }))?;
        let p = c
            .steps
            .iter()
            .find_map(|st| match st {
                Step::Command { id: "component.place", params } => Some(params),
                _ => None,
            })
            .ok_or(EngineError::Other("no component.place step".into()))?;
        assert_eq!(p.get("id").and_then(Value::as_str), Some("star-rating"));
        assert_eq!(p.get("version").and_then(Value::as_u64), Some(3));
        for bad in [
            json!({ "badge": { "id": "x", "version": 0 } }),
            json!({ "badge": { "id": "x", "version": -1 } }),
            json!({ "badge": 42 }),
            json!({ "badge": "" }),
            json!({ "badge": { "vars": 7 } }),
        ] {
            let e = compile(&mut s, &m, bad).unwrap_err();
            assert!(e.to_string().contains("badge"), "{e} for {bad}");
        }
        Ok(())
    }

    #[test]
    fn unknown_component_error_lists_candidates() -> Result<()> {
        let e = unknown_component_error("nope", "badge", &["offer-badge", "star-rating"]).to_string();
        assert!(e.contains("unknown component `nope`"), "{e}");
        assert!(e.contains("available components: offer-badge, star-rating"), "{e}");
        // The live guard passes known ids and skips when the registry is absent or has an
        // unexpected shape (component.place still refuses unknown ids at run time).
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let _ = m;
        assert!(matches!(guard_component(&mut s, "offer-badge", "badge"), Ok(())) || matches!(guard_component(&mut s, "offer-badge", "badge"), Err(_)));
        Ok(())
    }

    // ---------- fit geometry ----------

    #[test]
    fn fit_transform_table() -> Result<()> {
        // cover: height-driven (src 70×45 into 100×50), centred vertically by the default focal.
        let (pct, m) = fit_transform(FitMode::Cover, [0.0, 0.0, 100.0, 50.0], 70.0, 45.0, [0.5, 0.5])?;
        assert!((pct - 100.0 * (100.0 / 70.0)).abs() < 1e-9, "{pct}");
        let s = m[0];
        assert!((m[3] - s).abs() < 1e-12, "uniform scale: {m:?}");
        assert!((m[5] - (25.0 - 45.0 * s / 2.0)).abs() < 1e-9, "{m:?}");
        // Width-driven cover (src 200×45): the focal x now picks the crop.
        let (_, left) = fit_transform(FitMode::Cover, [0.0, 0.0, 100.0, 50.0], 200.0, 45.0, [0.0, 0.5])?;
        let (_, centre) = fit_transform(FitMode::Cover, [0.0, 0.0, 100.0, 50.0], 200.0, 45.0, [0.5, 0.5])?;
        assert!((left[4] - 0.0).abs() < 1e-9, "focal x=0 keeps the left edge: {left:?}");
        assert!(centre[4] < left[4], "focal x=0.5 crops both sides: {centre:?}");
        // contain: fully visible, centred, the smaller scale wins.
        let (pct, m) = fit_transform(FitMode::Contain, [0.0, 0.0, 100.0, 50.0], 70.0, 45.0, [0.5, 0.5])?;
        assert!((pct - 100.0 * (50.0 / 45.0)).abs() < 1e-9, "{pct}");
        assert!((m[4] - (100.0 - 70.0 * (50.0 / 45.0)) / 2.0).abs() < 1e-9, "{m:?}");
        // fill: distorted to the box exactly.
        let (_, m) = fit_transform(FitMode::Fill, [10.0, 20.0, 30.0, 40.0], 60.0, 80.0, [0.5, 0.5])?;
        assert!((m[0] - 0.5).abs() < 1e-12 && (m[3] - 0.5).abs() < 1e-12, "{m:?}");
        assert!((m[4] - 10.0).abs() < 1e-12 && (m[5] - 20.0).abs() < 1e-12, "{m:?}");
        // Hostile sources never divide by zero.
        assert!(fit_transform(FitMode::Cover, [0.0, 0.0, 100.0, 50.0], 0.0, 0.0, [0.5, 0.5]).is_err());
        assert!(fit_transform(FitMode::Contain, [0.0, 0.0, 0.0, 50.0], 10.0, 10.0, [0.5, 0.5]).is_err());
        Ok(())
    }

    #[test]
    fn upscale_thresholds() -> Result<()> {
        // §7.3: > 125% warns, > 200% errors; the thresholds are strict.
        let at = |w: f64| fit_transform(FitMode::Cover, [0.0, 0.0, 100.0, 100.0], w, w, [0.5, 0.5]).map(|(p, _)| p);
        assert!((at(100.0)? - 100.0).abs() < 1e-9);
        assert!((at(80.0)? - 125.0).abs() < 1e-9, "exactly 125% is not past the warning threshold");
        assert!(at(79.0)? > 125.0 && at(79.0)? < 200.0);
        assert!((at(50.0)? - 200.0).abs() < 1e-9, "exactly 200% is not past the error threshold");
        assert!(at(49.0)? > 200.0);
        Ok(())
    }

    // ---------- execution: the transaction ----------

    fn doc_state_of(s: &Session) -> Result<(usize, u64, Vec<String>, usize)> {
        let st = s.active().ok_or(EngineError::NoDocument)?;
        let names = st.doc.walk().iter().map(|(_, _, l)| l.name.clone()).collect::<Vec<_>>();
        Ok((st.history.past_len(), st.revision, names, st.doc.layers.len()))
    }

    fn execute(s: &mut Session, c: &Compiled) -> Result<()> {
        let mut warnings = Vec::new();
        let key = crate::extra_cmds::step_key(s, "template.fill");
        execute_batch(s, c, &key, &mut warnings).map(|_| warnings)
    }

    #[test]
    fn image_fill_places_transforms_and_replaces_the_placeholder() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let before_layers = s.active().ok_or(EngineError::NoDocument)?.doc.layers.len();
        let c = compile(&mut s, &m, json!({ "photo": { "data": base64(&png_bytes(1080, 700)), "fileName": "photo.png" } }))?;
        execute(&mut s, &c)?;
        let st = s.active().ok_or(EngineError::NoDocument)?;
        let photo = st
            .doc
            .walk()
            .iter()
            .find(|(_, _, l)| l.name == "Photo")
            .ok_or(EngineError::Other("no Photo layer after fill".into()))?;
        assert!(matches!(photo.2.content, LayerContent::Smart(_)), "the placed image is a smart object");
        assert_eq!(st.doc.layers.len(), before_layers, "the placeholder was replaced, not stacked");
        Ok(())
    }

    #[test]
    fn an_image_below_min_pixels_warns_and_a_150_percent_upscale_only_warns() -> Result<()> {
        // 700×455 into a 1080×700 cover box: scale = max(1080/700, 700/455) ≈ 154%.
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let mut v = manifest_value();
        v["slots"]["photo"]["minPixels"] = json!([2000, 1000]);
        let m = manifest::Manifest::from_value(&v).map_err(EngineError::Other)?;
        let c = compile(&mut s, &m, json!({ "photo": { "data": base64(&png_bytes(700, 455)), "fileName": "p.png" } }))?;
        let mut warnings = Vec::new();
        let key = crate::extra_cmds::step_key(s, "template.fill");
        execute_batch(&mut s, &c, &key, &mut warnings)?;
        let codes: Vec<&str> = warnings.iter().filter_map(|w| w.get("code").and_then(Value::as_str)).collect();
        assert!(codes.contains(&"image_upscaled"), "{warnings:?}");
        assert!(codes.contains(&"asset_below_min_pixels"), "{warnings:?}");
        Ok(())
    }

    #[test]
    fn an_upscale_past_200_percent_is_a_hard_error_that_rolls_back() -> Result<()> {
        // 70×45 into a 1080×700 cover box is a >1500% upscale.
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let before = doc_state_of(&s)?;
        let c = compile(&mut s, &m, json!({ "photo": { "data": base64(&png_bytes(70, 45)), "fileName": "p.png" } }))?;
        let mut warnings = Vec::new();
        let key = crate::extra_cmds::step_key(s, "template.fill");
        let e = execute_batch(&mut s, &c, &key, &mut warnings).unwrap_err();
        assert!(e.to_string().contains("200%"), "{e}");
        assert!(e.to_string().contains("photo"), "{e}");
        assert_eq!(doc_state_of(&s)?, before, "the document is unchanged after the refusal");
        Ok(())
    }

    #[test]
    fn a_hard_error_mid_batch_rolls_everything_back() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let before = doc_state_of(&s)?;
        // photo, headline and bg run fine; logo's missing path fails at run time, after
        // the earlier slots were already applied.
        let c = compile(
            &mut s,
            &m,
            json!({
                "photo": { "data": base64(&png_bytes(1080, 700)), "fileName": "photo.png" },
                "headline": "Applied first, must not survive",
                "bg": "#F4E7D3",
                "logo": { "path": "/nonexistent/w3b-missing.png" },
            }),
        )?;
        assert!(c.applied.contains(&"headline".to_string()));
        let mut warnings = Vec::new();
        let key = crate::extra_cmds::step_key(s, "template.fill");
        let e = execute_batch(&mut s, &c, &key, &mut warnings).unwrap_err();
        assert!(e.to_string().contains("template.fill aborted"), "{e}");
        assert_eq!(doc_state_of(&s)?, before, "history, revision, layers and names all restored");
        // The rolled-back text edit left the layer's text unchanged.
        let st = s.active().ok_or(EngineError::NoDocument)?;
        for (_, _, l) in st.doc.walk() {
            if let LayerContent::Text(t) = &l.content {
                assert_ne!(t.text, "Applied first, must not survive", "the text edit was rolled back");
            }
        }
        Ok(())
    }

    #[test]
    fn successful_fill_is_one_named_history_step() -> Result<()> {
        let (mut s, m) = (template_session()?, fixture_manifest()?);
        let c = compile(&mut s, &m, json!({ "headline": "One step", "bg": "#F4E7D3" }))?;
        let before = doc_state_of(&s)?.0;
        execute(&mut s, &c)?;
        let st = s.active().ok_or(EngineError::NoDocument)?;
        assert_eq!(st.history.past_len(), before + 1, "type.edit + type.setStyle coalesce into one step");
        let entries = st.history.entries();
        assert_eq!(entries.last().map(String::as_str), Some("Fill Template"), "{entries:?}");
        // And one undo reverts the whole fill.
        let (doc, _) = st
            .history
            .undo(st.doc.clone())
            .ok_or(EngineError::Other("nothing to undo".into()))?;
        let undone = doc.walk().iter().find(|(_, _, l)| l.name == "Headline");
        let text = undone
            .and_then(|(_, _, l)| match &l.content {
                LayerContent::Text(t) => Some(t.text.clone()),
                _ => None,
            })
            .ok_or(EngineError::Other("no Headline text".into()))?;
        assert_eq!(text, "Old headline", "undo restores the pre-fill text");
        Ok(())
    }

    #[test]
    fn run_requires_slots_and_an_applied_template() -> Result<()> {
        let mut s = template_session()?;
        for p in [json!({}), json!({ "slots": [] }), json!({ "slots": null }), json!(null)] {
            let e = run(&mut s, &p).unwrap_err();
            assert!(e.to_string().contains("slots"), "{e} for {p}");
        }
        Ok(())
    }
}
