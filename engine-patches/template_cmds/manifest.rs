//! Template manifests: the JSON contract that pairs a `.pcraft` template document with its
//! catalog entry — identity, canvas, named slots, the rules a filled template must satisfy and
//! the layer map agents address layers through. Shared by every `template.*` command
//! (`template_cmds.rs`; `fill.rs` and `validate.rs` live beside it and read the same types).
//!
//! A manifest is small, human-written data, so parsing is as strict as the control channel's
//! wire types: unknown fields are errors, and every number that later becomes geometry is
//! checked here — finite, in range, whole where it must be whole — so no command ever has to
//! defend against its own template. The shape:
//!
//! ```text
//! { "id": "instagram-post", "version": 3, "name": "Instagram Post — Promo", "tags": ["social"],
//!   "canvas": {"width": 1080, "height": 1080, "background": "#F4E7D3"},
//!   "slots": {"headline": {"kind": "text", "layer": "Headline", "bounds": [72,732,936,176], …}},
//!   "rules": {"safeArea": 48, "minContrast": 4.5, "mustLayers": ["Background"], "palette": []},
//!   "layerMap": {"Headline": {"role": "headline"}},
//!   "thumbnail": "thumbnails/instagram-post@3.png", "license": "public", "author": "…" }
//! ```
//!
//! Slots are a `kind`-tagged union: `text`, `image`, `component`, `color` or `visibility`. A
//! template with more than ~12 slots is a component's job; 64 is where the catalog stops
//! trusting the file.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::parse_hex;
use crate::document_preset_cmds::MAX_DIMENSION;

// ---------- bounds of what a manifest may say ----------

/// Slots one manifest may declare (a catalog of more than a few slots per template is a design
/// smell; this is the hard refusal, so a hostile file cannot size a reply).
pub(crate) const MAX_SLOTS: usize = 64;
/// The id, and the version pin, stay short: they are echoed in messages and joined into
/// catalog pins everywhere.
const MAX_ID: usize = 64;
const MAX_NAME: usize = 128;
const MAX_DESCRIPTION: usize = 4096;
/// Tags, palette colours and required layers are curated lists, not haystacks.
const MAX_TAGS: usize = 32;
const MAX_TAG: usize = 64;
const MAX_LAYERS_LISTED: usize = 32;
const MAX_PALETTE: usize = 32;
const MAX_LAYER_MAP: usize = 128;
/// Slot names and the layer names slots point at (layer names in documents are unbounded; the
/// manifest's copies are not).
const MAX_SLOT_NAME: usize = 64;
const MAX_LAYER_NAME: usize = 256;
/// Slot geometry is pixel coordinates; beyond ±10⁷ a value can never be placed as a 32-bit
/// coordinate, so it is refused here rather than wrapped somewhere later.
const BOUND: f64 = 1e7;
const MAX_FONT: f64 = 1e5;
const MAX_LINE_HEIGHT: f64 = 100.0;
/// Contrast ratios stop at WCAG's 21:1.
const MAX_CONTRAST: f64 = 21.0;
const MAX_SAFE_AREA: f64 = 1e6;
const MAX_VARS: usize = 64;
const MAX_THUMBNAIL: usize = 512;
/// Text alignment and image fit as the engine spells them elsewhere.
const ALIGN: &[&str] = &["left", "center", "right", "justify"];
const FIT: &[&str] = &["cover", "contain", "fill"];
const LICENSE: &[&str] = &["workspace", "public"];

// ---------- the manifest ----------

/// A template manifest, exactly as the JSON above; `Err` on anything the catalog cannot serve.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct TemplateManifest {
    /// The catalog id: a slug of lowercase letters, digits and hyphens.
    pub id: String,
    /// Versions start at 1 and pin a template (`id@version`).
    pub version: u64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    pub canvas: Canvas,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub slots: BTreeMap<String, Slot>,
    #[serde(default, skip_serializing_if = "is_default_rules")]
    pub rules: TemplateRules,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub layer_map: BTreeMap<String, LayerRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

/// The canvas a `.pcraft` of this manifest is expected to have. The bounds `file.new` accepts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Canvas {
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
}

/// The rules a filled template must satisfy (`template.validate` checks them; `template.fill`
/// reports the ones it can see while filling).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct TemplateRules {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safe_area: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_contrast: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub must_layers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_text_layers: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub palette: Vec<String>,
}

fn is_default_rules(r: &TemplateRules) -> bool {
    *r == TemplateRules::default()
}

/// One `layerMap` entry: how a named layer is used, and what a fresh copy of it gets.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LayerRole {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask_radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
}

/// The shrink range a text slot may auto-fit within (`minSize` ≤ the used size ≤ `maxSize`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct AutoFit {
    pub min_size: f64,
    pub max_size: f64,
}

// ---------- slots ----------

/// One named slot: what a fill provides and the layer it goes to. The `kind` tag selects the
/// shape; unknown kinds and unknown fields are errors.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum Slot {
    Text(TextSlot),
    Image(ImageSlot),
    Component(ComponentSlot),
    Color(ColorSlot),
    Visibility(VisibilitySlot),
}

/// A text slot: bounds, font and the fitting rules the type must obey.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct TextSlot {
    /// The layer the slot fills, by name.
    pub layer: String,
    /// `[x, y, w, h]` in canvas pixels.
    pub bounds: [f64; 4],
    pub font: String,
    pub size: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_lines: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_fit: Option<AutoFit>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

/// An image slot: bounds, how the image is fitted into them, and how small it may be.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ImageSlot {
    pub layer: String,
    pub bounds: [f64; 4],
    /// `cover`, `contain` or `fill`.
    pub fit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_pixels: Option<[u32; 2]>,
    /// Focal point `[x, y]`, each within 0..=1 (cover crops around it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focal: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

/// A component slot: which `component@version` instance the layer holds, and the variable
/// values its declared variables start from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ComponentSlot {
    /// The component reference, `id@version` (or a plain id for the newest).
    pub component: String,
    pub layer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<[f64; 4]>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub vars: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

/// A colour slot: the layer (or its fill) takes a palette colour when filled.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ColorSlot {
    pub layer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

/// A visibility slot: the layer is shown or hidden by the fill. An unfilled optional slot stays
/// present but hidden, never deleted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct VisibilitySlot {
    pub layer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<bool>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

impl Slot {
    /// The `kind` as the manifest spells it.
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Slot::Text(_) => "text",
            Slot::Image(_) => "image",
            Slot::Component(_) => "component",
            Slot::Color(_) => "color",
            Slot::Visibility(_) => "visibility",
        }
    }

    /// The layer the slot fills, by name.
    pub(crate) fn layer(&self) -> &str {
        match self {
            Slot::Text(s) => &s.layer,
            Slot::Image(s) => &s.layer,
            Slot::Component(s) => &s.layer,
            Slot::Color(s) => &s.layer,
            Slot::Visibility(s) => &s.layer,
        }
    }

    /// Whether the slot may stay unfilled.
    pub(crate) fn optional(&self) -> bool {
        match self {
            Slot::Text(s) => s.optional,
            Slot::Image(s) => s.optional,
            Slot::Component(s) => s.optional,
            Slot::Color(s) => s.optional,
            Slot::Visibility(s) => s.optional,
        }
    }
}

// ---------- errors ----------

/// A manifest that cannot serve: the file it came from (attached with [`ManifestError::at`])
/// and the reason, for a typed `Err` — never a panic.
#[derive(Debug, Clone)]
pub(crate) struct ManifestError {
    /// The manifest's path, as the message reports it ("" until a caller attaches one).
    pub path: String,
    pub message: String,
}

impl ManifestError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self { path: String::new(), message: message.into() }
    }

    /// Attach the file the manifest was read from (kept when one is already there).
    pub(crate) fn at(mut self, path: impl Into<String>) -> Self {
        if self.path.is_empty() {
            self.path = path.into();
        }
        self
    }
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() {
            write!(f, "{}", self.message)
        } else {
            write!(f, "{}: {}", self.path, self.message)
        }
    }
}

impl std::error::Error for ManifestError {}

// ---------- parsing ----------

impl TemplateManifest {
    /// Parse and validate manifest JSON: strict (unknown fields are errors) and fully checked
    /// (see [`TemplateManifest::validate`]). Attach the source file with
    /// [`ManifestError::at`] for the message.
    pub(crate) fn from_value(v: &Value) -> Result<Self, ManifestError> {
        let m: TemplateManifest = serde_json::from_value(v.clone())
            .map_err(|e| ManifestError::new(format!("the manifest is not valid: {e}")))?;
        m.validate().map_err(ManifestError::new)?;
        Ok(m)
    }

    /// [`Self::from_value`] of manifest bytes, as the catalog reads a file.
    pub(crate) fn from_slice(bytes: &[u8]) -> Result<Self, ManifestError> {
        let v: Value = serde_json::from_slice(bytes).map_err(|e| ManifestError::new(format!("not valid JSON: {e}")))?;
        Self::from_value(&v)
    }

    /// `id@version`, the pin commands and replies name a template by.
    pub(crate) fn pin(&self) -> String {
        pin(&self.id, self.version)
    }

    /// Every declared limit, checked once so the commands can trust the manifest. `Err` is the
    /// reason, prefixed by the field it names.
    pub(crate) fn validate(&self) -> Result<(), String> {
        // Identity.
        if self.id.is_empty() || self.id.len() > MAX_ID {
            return Err(format!("\"id\" must be 1..={MAX_ID} characters, got {:?}", self.id));
        }
        if self.id.bytes().any(|b| !(b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')) {
            return Err(format!(
                "\"id\" must be a slug of lowercase letters, digits and hyphens, got {:?}",
                self.id
            ));
        }
        if self.id.starts_with('-') || self.id.ends_with('-') {
            return Err(format!("\"id\" must not start or end with a hyphen, got {:?}", self.id));
        }
        if self.version == 0 {
            return Err("\"version\" must be 1 or greater".into());
        }
        if self.name.is_empty() || self.name.len() > MAX_NAME {
            return Err(format!("\"name\" must be 1..={MAX_NAME} characters, got {:?}", self.name));
        }
        if self.description.as_deref().is_some_and(|d| d.len() > MAX_DESCRIPTION) {
            return Err(format!("\"description\" must be at most {MAX_DESCRIPTION} characters"));
        }
        // Tags.
        if self.tags.len() > MAX_TAGS {
            return Err(format!("\"tags\" lists more than {MAX_TAGS} entries"));
        }
        if let Some(t) = self.tags.iter().find(|t| t.is_empty() || t.len() > MAX_TAG) {
            return Err(format!("\"tags\" entries must be 1..={MAX_TAG} characters, got {t:?}"));
        }
        // Canvas.
        if self.canvas.width == 0 || self.canvas.height == 0 || self.canvas.width > MAX_DIMENSION || self.canvas.height > MAX_DIMENSION {
            return Err(format!(
                "\"canvas\" must be 1..={MAX_DIMENSION} pixels on a side, got {}×{}",
                self.canvas.width, self.canvas.height
            ));
        }
        if let Some(bg) = self.canvas.background.as_deref() && parse_hex(bg).is_none() {
            return Err(format!("canvas \"background\" must be \"#rrggbb\" or \"#rrggbbaa\", got {bg:?}"));
        }
        // Slots.
        if self.slots.len() > MAX_SLOTS {
            return Err(format!("the manifest declares {} slots; keep templates under {MAX_SLOTS}", self.slots.len()));
        }
        for (name, slot) in &self.slots {
            let at = format!("slots.{name}");
            if name.is_empty() || name.len() > MAX_SLOT_NAME {
                return Err(format!("{at}: slot names must be 1..={MAX_SLOT_NAME} characters"));
            }
            if slot.layer().is_empty() || slot.layer().len() > MAX_LAYER_NAME {
                return Err(format!("{at}: \"layer\" must name a layer, 1..={MAX_LAYER_NAME} characters, got {:?}", slot.layer()));
            }
            match slot {
                Slot::Text(t) => {
                    check_bounds(&t.bounds, &at)?;
                    if t.font.is_empty() || t.font.len() > MAX_LAYER_NAME {
                        return Err(format!("{at}: \"font\" must be 1..={MAX_LAYER_NAME} characters, got {:?}", t.font));
                    }
                    if !t.size.is_finite() || t.size <= 0.0 || t.size > MAX_FONT {
                        return Err(format!("{at}: \"size\" must be within 0 < size ≤ {MAX_FONT}, got {}", t.size));
                    }
                    if t.weight.as_deref().is_some_and(|w| w.is_empty() || w.len() > MAX_TAG) {
                        return Err(format!("{at}: \"weight\" must be 1..={MAX_TAG} characters"));
                    }
                    if t.line_height.is_some_and(|lh| !lh.is_finite() || lh <= 0.0 || lh > MAX_LINE_HEIGHT) {
                        return Err(format!("{at}: \"lineHeight\" must be within 0 < lineHeight ≤ {MAX_LINE_HEIGHT}, got {}", t.line_height.unwrap_or_default()));
                    }
                    if t.max_lines.is_some_and(|n| n == 0) {
                        return Err(format!("{at}: \"maxLines\" must be 1 or greater"));
                    }
                    if t.max_chars.is_some_and(|n| n == 0) {
                        return Err(format!("{at}: \"maxChars\" must be 1 or greater"));
                    }
                    if let Some(a) = t.align.as_deref() && !ALIGN.contains(&a) {
                        return Err(format!("{at}: \"align\" must be one of {}, got {a:?}", ALIGN.join("|")));
                    }
                    if t.color.as_deref().is_some_and(|c| parse_hex(c).is_none()) {
                        return Err(format!("{at}: \"color\" must be \"#rrggbb\" or \"#rrggbbaa\", got {:?}", t.color));
                    }
                    if let Some(af) = &t.auto_fit
                        && (!af.min_size.is_finite() || !af.max_size.is_finite()
                            || af.min_size <= 0.0
                            || af.min_size > af.max_size
                            || af.max_size > MAX_FONT)
                    {
                        return Err(format!(
                            "{at}: \"autoFit\" must be 0 < minSize ≤ maxSize ≤ {MAX_FONT}, got {}..={}",
                            af.min_size, af.max_size
                        ));
                    }
                }
                Slot::Image(i) => {
                    check_bounds(&i.bounds, &at)?;
                    if !FIT.contains(&i.fit.as_str()) {
                        return Err(format!("{at}: \"fit\" must be one of {}, got {:?}", FIT.join("|"), i.fit));
                    }
                    if i.min_pixels.is_some_and(|p| p[0] == 0 || p[1] == 0) {
                        return Err(format!("{at}: \"minPixels\" sides must be 1 or greater"));
                    }
                    if i.focal.is_some_and(|f| f.iter().any(|c| !c.is_finite() || *c < 0.0 || *c > 1.0)) {
                        return Err(format!("{at}: \"focal\" coordinates must be within 0..=1, got {:?}", i.focal));
                    }
                }
                Slot::Component(c) => {
                    if let Err(e) = parse_pin(&c.component) {
                        return Err(format!("{at}: \"component\": {e}"));
                    }
                    if c.vars.len() > MAX_VARS {
                        return Err(format!("{at}: \"vars\" lists more than {MAX_VARS} entries"));
                    }
                    if let Some(b) = &c.bounds {
                        check_bounds(b, &at)?;
                    }
                }
                Slot::Color(c) => {
                    if c.color.as_deref().is_some_and(|h| parse_hex(h).is_none()) {
                        return Err(format!("{at}: \"color\" must be \"#rrggbb\" or \"#rrggbbaa\", got {:?}", c.color));
                    }
                }
                Slot::Visibility(_) => {}
            }
        }
        // Rules.
        if self.rules.safe_area.is_some_and(|s| !s.is_finite() || s < 0.0 || s > MAX_SAFE_AREA) {
            return Err(format!("rules \"safeArea\" must be within 0..={MAX_SAFE_AREA}, got {}", self.rules.safe_area.unwrap_or_default()));
        }
        if self.rules.min_contrast.is_some_and(|c| !c.is_finite() || c < 0.0 || c > MAX_CONTRAST) {
            return Err(format!("rules \"minContrast\" must be within 0..={MAX_CONTRAST}, got {}", self.rules.min_contrast.unwrap_or_default()));
        }
        if self.rules.must_layers.len() > MAX_LAYERS_LISTED {
            return Err(format!("rules \"mustLayers\" lists more than {MAX_LAYERS_LISTED} layers"));
        }
        if let Some(l) = self.rules.must_layers.iter().find(|l| l.is_empty() || l.len() > MAX_LAYER_NAME) {
            return Err(format!("rules \"mustLayers\" entries must be 1..={MAX_LAYER_NAME} characters, got {l:?}"));
        }
        if self.rules.max_text_layers.is_some_and(|n| n == 0) {
            return Err("rules \"maxTextLayers\" must be 1 or greater".into());
        }
        if self.rules.palette.len() > MAX_PALETTE {
            return Err(format!("rules \"palette\" lists more than {MAX_PALETTE} colours"));
        }
        if let Some((i, c)) = self.rules.palette.iter().enumerate().find(|(_, c)| parse_hex(c).is_none()) {
            return Err(format!("rules \"palette\"[{i}] must be \"#rrggbb\" or \"#rrggbbaa\", got {c:?}"));
        }
        // Layer map.
        if self.layer_map.len() > MAX_LAYER_MAP {
            return Err(format!("\"layerMap\" lists more than {MAX_LAYER_MAP} layers"));
        }
        for (name, role) in &self.layer_map {
            if name.is_empty() || name.len() > MAX_LAYER_NAME {
                return Err(format!("layerMap.{name}: layer names must be 1..={MAX_LAYER_NAME} characters"));
            }
            if role.role.is_empty() || role.role.len() > MAX_ID {
                return Err(format!("layerMap.{name}: \"role\" must be 1..={MAX_ID} characters, got {:?}", role.role));
            }
            if role.fill.as_deref().is_some_and(|f| parse_hex(f).is_none()) {
                return Err(format!("layerMap.{name}: \"fill\" must be \"#rrggbb\" or \"#rrggbbaa\", got {:?}", role.fill));
            }
            if role.mask.as_deref().is_some_and(|m| m.is_empty() || m.len() > MAX_TAG) {
                return Err(format!("layerMap.{name}: \"mask\" must be 1..={MAX_TAG} characters"));
            }
            if role.mask_radius.is_some_and(|r| !r.is_finite() || r < 0.0 || r > MAX_SAFE_AREA) {
                return Err(format!("layerMap.{name}: \"maskRadius\" must be within 0..={MAX_SAFE_AREA}, got {}", role.mask_radius.unwrap_or_default()));
            }
            if role.component.as_deref().is_some_and(|c| parse_pin(c).is_err()) {
                return Err(format!("layerMap.{name}: \"component\" must be an id or id@version, got {c:?}", c = role.component));
            }
        }
        // Provenance.
        if self.thumbnail.as_deref().is_some_and(|t| t.is_empty() || t.len() > MAX_THUMBNAIL) {
            return Err(format!("\"thumbnail\" must be 1..={MAX_THUMBNAIL} characters, a path relative to the template"));
        }
        if self.license.as_deref().is_some_and(|l| !LICENSE.contains(&l)) {
            return Err(format!("\"license\" must be one of {}, got {l:?}", LICENSE.join("|")));
        }
        if self.author.as_deref().is_some_and(|a| a.len() > MAX_NAME) {
            return Err(format!("\"author\" must be at most {MAX_NAME} characters"));
        }
        Ok(())
    }
}

/// `[x, y, w, h]`: finite, placeable as 32-bit coordinates, with a non-negative size.
fn check_bounds(b: &[f64; 4], at: &str) -> Result<(), String> {
    let [x, y, w, h] = *b;
    if !x.is_finite() || !y.is_finite() || !w.is_finite() || !h.is_finite() {
        return Err(format!("{at}: \"bounds\" must be finite numbers, got {b:?}"));
    }
    if x.abs() > BOUND || y.abs() > BOUND {
        return Err(format!("{at}: \"bounds\" must be within ±{BOUND} pixels, got {b:?}"));
    }
    if w < 0.0 || h < 0.0 || w > BOUND || h > BOUND {
        return Err(format!("{at}: \"bounds\" width and height must be within 0..={BOUND} pixels, got {b:?}"));
    }
    Ok(())
}

// ---------- id@version pins ----------

/// Split an `id@version` pin (`"offer-badge@2"`) into its id and pinned version; a plain id
/// means "the newest". Ids never contain `@`, and a version is a whole number from 1 up.
pub(crate) fn parse_pin(s: &str) -> Result<(String, Option<u64>), String> {
    match s.rsplit_once('@') {
        None => {
            check_pin_id(s)?;
            Ok((s.to_string(), None))
        }
        Some((id, v)) => {
            check_pin_id(id)?;
            if v.is_empty() {
                return Err(format!("{s:?}: the version after @ is empty"));
            }
            let n = v.parse::<u64>().map_err(|_| format!("{s:?}: the version after @ must be a whole number, got {v:?}"))?;
            if n == 0 {
                return Err(format!("{s:?}: versions start at 1"));
            }
            Ok((id.to_string(), Some(n)))
        }
    }
}

/// The id half of a pin: non-empty, short, and without separators (it is echoed in messages and
/// matched against manifest file stems, never used to build a path).
fn check_pin_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("the id is empty".into());
    }
    if id.len() > MAX_ID {
        return Err(format!("the id {:?} is longer than {MAX_ID} characters", id));
    }
    if id.bytes().any(|b| matches!(b, b'@' | b'/' | b'\\' | b':') || b.is_ascii_control()) {
        return Err(format!("the id {:?} must not contain @, /, \\, : or control characters", id));
    }
    Ok(())
}

/// `id@version`, the pinned name replies and logs use.
pub(crate) fn pin(id: &str, version: u64) -> String {
    format!("{id}@{version}")
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    /// The documented manifest shape, complete (five slots, every rule), with a neutral author.
    const EXAMPLE: &str = r#"{
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

    fn example() -> std::result::Result<Value, Box<dyn std::error::Error>> {
        Ok(serde_json::from_str(EXAMPLE)?)
    }

    fn parse(v: &Value) -> Result<TemplateManifest, ManifestError> {
        TemplateManifest::from_value(v).map_err(|e| e.at("example.json"))
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

    #[test]
    fn parses_the_documented_example() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let m = parse(&example()?)?;
        assert_eq!(m.id, "instagram-post");
        assert_eq!(m.version, 3);
        assert_eq!(m.name, "Instagram Post — Promo");
        assert_eq!(m.tags, ["social", "promo", "square"]);
        assert_eq!((m.canvas.width, m.canvas.height), (1080, 1080));
        assert_eq!(m.canvas.background.as_deref(), Some("#F4E7D3"));
        assert_eq!(m.slots.len(), 5);
        assert!(matches!(m.slots.get("photo"), Some(Slot::Image(_))));
        assert!(matches!(m.slots.get("headline"), Some(Slot::Text(_))));
        assert!(matches!(m.slots.get("badge"), Some(Slot::Component(_))));
        assert_eq!(m.rules.safe_area, Some(48.0));
        assert_eq!(m.rules.min_contrast, Some(4.5));
        assert_eq!(m.rules.must_layers, ["Background", "Photo", "Headline"]);
        assert_eq!(m.rules.max_text_layers, Some(6));
        assert_eq!(m.rules.palette.len(), 3);
        assert_eq!(m.layer_map.len(), 6);
        assert_eq!(m.thumbnail.as_deref(), Some("thumbnails/instagram-post@3.png"));
        assert_eq!(m.license.as_deref(), Some("workspace"));
        // The slot helpers every command dispatches on.
        let headline = m.slots.get("headline").ok_or("no headline slot")?;
        assert_eq!(headline.kind(), "text");
        assert_eq!(headline.layer(), "Headline");
        assert!(!headline.optional());
        let logo = m.slots.get("logo").ok_or("no logo slot")?;
        assert_eq!(logo.kind(), "image");
        assert!(logo.optional());
        assert_eq!(m.pin(), "instagram-post@3");
        Ok(())
    }

    #[test]
    fn slot_fields_parse_and_round_trip() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let m = parse(&example()?)?;
        let headline = match m.slots.get("headline") {
            Some(Slot::Text(t)) => t,
            _ => return Err("headline is not a text slot".into()),
        };
        assert_eq!(headline.bounds, [72.0, 732.0, 936.0, 176.0]);
        assert_eq!(headline.font, "display");
        assert_eq!(headline.weight.as_deref(), Some("bold"));
        assert_eq!(headline.size, 96.0);
        assert_eq!(headline.line_height, Some(1.05));
        assert_eq!(headline.max_lines, Some(2));
        assert_eq!(headline.max_chars, Some(42));
        assert_eq!(headline.align.as_deref(), Some("left"));
        assert_eq!(headline.color.as_deref(), Some("#3B2A20"));
        let fit = headline.auto_fit.ok_or("no autoFit")?;
        assert_eq!((fit.min_size, fit.max_size), (56.0, 110.0));
        // What parsed serialises back to the same manifest (the byte cap keeps it small).
        let again = serde_json::to_value(&m)?;
        assert_eq!(parse(&again)?, m);
        Ok(())
    }

    #[test]
    fn rejects_unknown_fields_and_kinds() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let bad = json!({"id": "a", "version": 1, "name": "A", "canvas": {"width": 1, "height": 1}, "surprise": true});
        let e = must_err(parse(&bad), "parsed an unknown field")?;
        assert!(e.to_string().contains("unknown field"), "{e}");
        let mut v = example()?;
        v["slots"]["headline"]["kind"] = json!("sound");
        let e = must_err(parse(&v), "parsed an unknown kind")?;
        assert!(e.to_string().contains("unknown variant"), "{e}");
        let mut v = example()?;
        v["slots"]["headline"]["kerning"] = json!(true);
        let e = must_err(parse(&v), "parsed an unknown slot field")?;
        assert!(e.to_string().contains("unknown field"), "{e}");
        Ok(())
    }

    #[test]
    fn rejects_missing_and_empty_identity() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let no_id = json!({"version": 1, "name": "A", "canvas": {"width": 1, "height": 1}});
        let e = must_err(parse(&no_id), "parsed without an id")?;
        assert!(e.to_string().contains("missing field"), "{e}");
        for id in ["", "Instagram Post", "-promo", "promo-", "promo@2", "prom/o", "ünicode"] {
            let mut v = example()?;
            v["id"] = json!(id);
            let e = must_err(parse(&v), format!("parsed id {id:?}"))?;
            assert!(e.to_string().contains("\"id\""), "{id}: {e}");
        }
        let mut v = example()?;
        v["version"] = json!(0);
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("\"version\"")));
        let mut v = example()?;
        v["name"] = json!("");
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("\"name\"")));
        Ok(())
    }

    #[test]
    fn rejects_canvases_the_engine_cannot_open() -> std::result::Result<(), Box<dyn std::error::Error>> {
        for (w, h) in [(0, 1080), (1080, 0), (300_001, 1080), (1080, 300_001)] {
            let mut v = example()?;
            v["canvas"]["width"] = json!(w);
            v["canvas"]["height"] = json!(h);
            let e = must_err(parse(&v), format!("parsed canvas {w}×{h}"))?;
            assert!(e.to_string().contains("\"canvas\""), "{w}×{h}: {e}");
        }
        let mut v = example()?;
        v["canvas"]["background"] = json!("paper");
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("background")));
        Ok(())
    }

    #[test]
    fn rejects_non_finite_and_out_of_range_geometry() -> std::result::Result<(), Box<dyn std::error::Error>> {
        // 1e999 parses as infinity, not as an error; the manifest refuses it.
        let raw = r#"{"id":"a","version":1,"name":"A","canvas":{"width":8,"height":8},
            "slots":{"t":{"kind":"text","layer":"L","bounds":[1e999,0,10,10],"font":"sans","size":12}}}"#;
        let e = must_err(
            TemplateManifest::from_value(&serde_json::from_str::<Value>(raw)?),
            "parsed infinite bounds",
        )?;
        assert!(e.to_string().contains("finite"), "{e}");
        for bounds in [json!([-1e7 - 1.0, 0, 10, 10]), json!([0, 0, -1.0, 10]), json!([0, 0, 1e7 + 1.0, 10])] {
            let mut v = example()?;
            v["slots"]["headline"]["bounds"] = bounds.clone();
            let e = must_err(parse(&v), format!("parsed bounds {bounds}"))?;
            assert!(e.to_string().contains("bounds"), "{bounds}: {e}");
        }
        let mut v = example()?;
        v["slots"]["headline"]["autoFit"] = json!({"minSize": 200, "maxSize": 100});
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("autoFit")));
        let mut v = example()?;
        v["slots"]["headline"]["size"] = json!(0);
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("\"size\"")));
        let mut v = example()?;
        v["slots"]["headline"]["maxChars"] = json!(0);
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("maxChars")));
        let mut v = example()?;
        v["slots"]["headline"]["align"] = json!("diagonal");
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("align")));
        let mut v = example()?;
        v["slots"]["photo"]["fit"] = json!("stretch");
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("fit")));
        let mut v = example()?;
        v["slots"]["photo"]["focal"] = json!([0.5, 1.5]);
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("focal")));
        let mut v = example()?;
        v["slots"]["photo"]["minPixels"] = json!([0, 700]);
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("minPixels")));
        Ok(())
    }

    #[test]
    fn rejects_bad_rules_layer_maps_and_provenance() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let mut v = example()?;
        v["rules"]["minContrast"] = json!(30);
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("minContrast")));
        let mut v = example()?;
        v["rules"]["safeArea"] = json!(-1);
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("safeArea")));
        let mut v = example()?;
        v["rules"]["palette"] = json!(["#F4E7D3", "teal"]);
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("palette")));
        let mut v = example()?;
        v["rules"]["mustLayers"] = json!([""]);
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("mustLayers")));
        let mut v = example()?;
        v["layerMap"]["Photo"]["component"] = json!("a/b@2");
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("component")));
        let mut v = example()?;
        v["license"] = json!("MIT");
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("license")));
        Ok(())
    }

    #[test]
    fn caps_list_lengths() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let mut v = example()?;
        v["tags"] = json!((0..MAX_TAGS + 1).map(|i| format!("t{i}")).collect::<Vec<_>>());
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("tags")));
        let mut v = example()?;
        let slots = v.get_mut("slots").and_then(Value::as_object_mut).ok_or("no slots")?;
        for i in 0..MAX_SLOTS {
            slots.insert(format!("extra{i}"), json!({"kind": "visibility", "layer": "L"}));
        }
        // The example's 5 slots plus MAX_SLOTS more: past the bound.
        assert!(parse(&v).is_err_and(|e| e.to_string().contains("slots")));
        Ok(())
    }

    #[test]
    fn from_slice_reports_json_errors_with_the_path() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let e = must_err(TemplateManifest::from_slice(b"{").map_err(|e| e.at("t.json")), "parsed broken bytes")?;
        assert!(e.to_string().starts_with("t.json: "), "{e}");
        assert!(e.to_string().contains("not valid JSON"), "{e}");
        Ok(())
    }

    #[test]
    fn parses_id_at_version_pins() -> std::result::Result<(), Box<dyn std::error::Error>> {
        assert_eq!(parse_pin("instagram-post")?, ("instagram-post".into(), None));
        assert_eq!(parse_pin("offer-badge@2")?, ("offer-badge".into(), Some(2)));
        assert_eq!(parse_pin("offer-badge@012")?, ("offer-badge".into(), Some(12)));
        for bad in [
            "", "@2", "x@", "x@0", "x@-1", "x@1.5", "x@three", "x@1e3", "x@99999999999999999999",
            "x@2@3", "a/b@2", "a\\b", "a:b", "a\tb", "x@18446744073709551616",
        ] {
            assert!(parse_pin(bad).is_err(), "{bad:?} parsed");
        }
        assert_eq!(pin("offer-badge", 2), "offer-badge@2");
        Ok(())
    }
}
