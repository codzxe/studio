//! `template.validate` — the deterministic check pass: a document against a template
//! manifest's rules (§7.4), or the manifest-independent §10.2 naming checks when no
//! template is given. This is the exact, cheap half of the quality system (§5.1's
//! "validate before critique"); the render-based §11.1 validator and the §11.2 critic
//! run in the worker on top of the same code vocabulary.
//!
//! Params (§7.4's `{ template?, document? }` — at least one is required):
//! - `"template"` — a template id or `id@version` pin, resolved from the catalog like
//!   `template.inspect`. Its manifest is the rulebook: `rules.mustLayers`, `safeArea`,
//!   `minContrast`, `maxTextLayers`, `palette`, the slots' declared bounds and the
//!   `layerMap` roles.
//! - `"document"` — an open document's index; the active document when left out. With no
//!   document open, a `"template"`-only call validates the template's OWN `.pcraft`
//!   document as shipped (template-author linting — the catalog is where the rules
//!   live). Without `"template"`, the pass is the naming half alone.
//!
//! Issue rows (§7.4 + §11.1's shape): `{ level: blocker|major|minor, code: snake_case,
//! layer?, message, fix }`. `ok` is true while there is no blocker and no major (§11.1:
//! minors are suggestions and never trigger a revision by themselves). The reply pins
//! the template as `id@version` (§7.4: always explicit in the command log).
//!
//! The checks, in a fixed order (same document + manifest ⇒ same issues, same order):
//!
//! | code | level | reads |
//! |---|---|---|
//! | `missing_must_layer` | blocker | every `rules.mustLayers` name exists in the document |
//! | `slot_layer_missing` | major | every slot's target layer exists (§7.3: template layers are never deleted) |
//! | `slot_bounds` | major | a slot's layer sits inside its declared `[x, y, w, h]` |
//! | `safe_area` | major | essential content keeps `rules.safeArea` px clear of the canvas edges |
//! | `contrast` | blocker | visible text vs the declared background, WCAG relative-luminance ratio |
//! | `max_text_layers` | major | the document's text-layer count within `rules.maxTextLayers` |
//! | `color_out_of_palette` | minor | visible text and solid-fill colours are in `rules.palette` |
//! | `naming` | minor | §10.2: machine names (`Layer 27`), empty names, role-pattern warnings |
//!
//! Deliberate scope (a decision, not an omission — each line is §-cited):
//! - Essential content = text slots, component slots and brand-role images (`logo`,
//!   `badge`, `watermark`). Photos and backgrounds bleed on purpose (the §7.2 example's
//!   photo is full-bleed), and a slot's DECLARED box is the design intent, so essential
//!   slots are checked by it whether or not they are filled and visible.
//! - Contrast compares against the declared background (the `background` role's `fill`,
//!   else `canvas.background`); text over a photo is a render question, which the
//!   worker's pixel-based §11.1 pass owns.
//! - `maxTextLayers` counts hidden placeholders too: the cap is the template's design
//!   budget, and optional slots stay present (§7.3).
//! - Slot bounds use the layer's computed bounds exactly as `document.inspect` reports
//!   them; un-rasterized text has none, so its declared box carries that check instead.
//!
//! Golden rules (`../tests/README.md`): manifests arrive pre-validated by `manifest.rs`,
//! and the math below still checks `is_finite()` before use (NaN is a violation, never a
//! panic); no recursion of its own — the document walk is the engine's depth-bounded
//! `walk()`; the reply is capped ([`MAX_ISSUES`]) so a hostile document cannot size it
//! (§2.2 reply budgets). Params are validated before anything reads env or state, and a
//! document with no layers is a typed `Err` (the panic-hunt table's row).

use std::path::Path;

use photocraft_color::Color;
use photocraft_doc::{Document, Fill, Layer, LayerContent};
use serde_json::{Value, json};

use super::manifest::{Slot, TemplateManifest, parse_pin};
use super::{layer_by_name, resolve, templates_dir};
use crate::commands::parse_hex;
use crate::file_cmds;
use crate::{EngineError, Result, Session};

const CMD: &str = "template.validate";

/// §7.4's issue levels, as the reply spells them (§11.1's ladder).
const BLOCKER: &str = "blocker";
const MAJOR: &str = "major";
const MINOR: &str = "minor";

/// The issue cap: one row per rule per layer can grow with the document, and the reply
/// must not (§2.2 reply budgets). The cap reports itself as `truncated: true`.
const MAX_ISSUES: usize = 256;
/// Names echoed into messages are cut at a char boundary (the panel listing's own cap).
const NAME_CAP: usize = 64;
/// §11.1 `contrast`: body text needs 4.5:1, large display text 3:1 (WCAG's large-text
/// cut is 18 pt); the manifest's `minContrast` overrides both when it declares one.
const LARGE_TEXT_PT: f64 = 18.0;
const BODY_CONTRAST: f64 = 4.5;
const LARGE_CONTRAST: f64 = 3.0;
/// Render-rounding tolerance for the slot-bounds compare, in canvas px.
const BOUNDS_EPS_PX: f64 = 0.5;
/// Float slack on the contrast compare, so a ratio that lands exactly on the threshold
/// passes (§11.1 says "≥").
const RATIO_EPS: f64 = 1e-9;
/// §10.2's variant separator: `… — <size/lang>` (em dash, one space each side).
const VARIANT_SEP: &str = " — ";
/// The editor's machine-generated default name kinds (§7.5's `Layer 27`, §10.1's `Group 3`).
const MACHINE_KINDS: &[&str] = &["Layer", "Group", "Shape"];

fn bad(msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: CMD.into(), msg: msg.into() }
}

/// No templates directory configured: the same refusal the catalog commands give
/// (`template_cmds.rs`'s message, mirrored here because that helper is private).
fn no_dir() -> EngineError {
    EngineError::Other(
        "no templates directory is configured: set PHOTOCRAFT_TEMPLATES_DIR to the folder that holds the templates (each is a JSON manifest with its .pcraft document beside it)".into(),
    )
}

// ---------- the issues ----------

/// The §7.4 issues of one pass, capped at [`MAX_ISSUES`] (`truncated` reports the cap).
#[derive(Default)]
struct Issues {
    rows: Vec<Value>,
    truncated: bool,
}

impl Issues {
    fn push(&mut self, level: &str, code: &str, layer: Option<&str>, message: String, fix: String) {
        if self.rows.len() >= MAX_ISSUES {
            self.truncated = true;
            return;
        }
        let mut row = json!({ "level": level, "code": code, "message": message, "fix": fix });
        if let (Some(name), Some(map)) = (layer, row.as_object_mut()) {
            map.insert("layer".into(), json!(name));
        }
        self.rows.push(row);
    }

    /// `ok` per §11.1: no blocker, no major — minors never flip it on their own.
    fn passes(&self) -> bool {
        self.rows.iter().all(|r| r.get("level").and_then(Value::as_str).is_none_or(|l| l == MINOR))
    }
}

/// A layer or slot name for a message, cut at a char boundary (names are unbounded
/// input; the reply is not — the panel listing cuts at the same width).
fn short(name: &str) -> String {
    match name.char_indices().nth(NAME_CAP) {
        Some((cut, _)) => format!("{}…", &name[..cut]),
        None => name.to_string(),
    }
}

// ---------- the math (pure, hostile-number-safe) ----------

/// WCAG 2.x relative luminance of sRGB components in 0..=1: linearize each channel
/// (c ≤ 0.04045 ? c/12.92 : ((c + 0.055)/1.055)^2.4), then 0.2126R + 0.7152G + 0.0722B.
/// Non-finite channels are 0 — the manifest has already refused them, and this keeps the
/// math total (NaN in, a number out; never a panic).
fn relative_luminance(rgb: [f64; 3]) -> f64 {
    let channel = |c: f64| {
        if !c.is_finite() {
            return 0.0;
        }
        let c = c.clamp(0.0, 1.0);
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

/// The WCAG contrast ratio of two colours, 1..=21 — the lighter over the darker, so the
/// order of the arguments never matters. §11.1's `contrast` check.
fn contrast_ratio(a: [f64; 3], b: [f64; 3]) -> f64 {
    let (la, lb) = (relative_luminance(a), relative_luminance(b));
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    // lo + 0.05 ≥ 0.05 > 0: the division is total by construction.
    (hi + 0.05) / (lo + 0.05)
}

/// A `#rrggbb`/`#rrggbbaa` string as 0..=1 sRGB components (the registry's own parser).
fn hex_rgb(hex: &str) -> Option<[f64; 3]> {
    let [r, g, b, ..] = parse_hex(hex)?;
    Some([f64::from(r), f64::from(g), f64::from(b)])
}

/// The 8-bit rgb a palette compare uses — the same quantisation `Color::to_rgba8` has,
/// so a colour set from a palette hex compares equal to it.
fn hex_rgb8(hex: &str) -> Option<[u8; 3]> {
    let [r, g, b, ..] = parse_hex(hex)?;
    let q = |v: f32| (v * 255.0 + 0.5) as u8;
    Some([q(r), q(g), q(b)])
}

/// A document colour as 0..=1 sRGB (converted out of its own colour model;
/// non-finite components are 0, keeping the math total).
fn color_rgb(c: &Color) -> [f64; 3] {
    let [r, g, b] = c.to_rgb();
    let f = |v: f32| if v.is_finite() { f64::from(v).clamp(0.0, 1.0) } else { 0.0 };
    [f(r), f(g), f(b)]
}

fn color_rgb8(c: &Color) -> [u8; 3] {
    let [r, g, b, ..] = c.to_rgba8();
    [r, g, b]
}

/// §11.1 `safe_area`: does box `[x, y, w, h]` keep `safe` px clear of a `w × h` canvas's
/// edges? Non-finite numbers are violations (false), never panics — the manifest has
/// already refused them; this stays total when called on anything.
fn within_safe_area(b: [f64; 4], canvas: [f64; 2], safe: f64) -> bool {
    let (x, y, w, h) = (b[0], b[1], b[2], b[3]);
    let (cw, ch) = (canvas[0], canvas[1]);
    let numbers = [x, y, w, h, cw, ch, safe];
    if !(numbers.iter().all(|v| v.is_finite()) && safe >= 0.0) {
        return false;
    }
    x >= safe && y >= safe && x + w <= cw - safe && y + h <= ch - safe
}

/// Does `inner` sit inside `outer`, ± [`BOUNDS_EPS_PX`] (render rounding)? Non-finite
/// numbers are violations, never panics.
fn fits_in(inner: [f64; 4], outer: [f64; 4]) -> bool {
    if !inner.iter().chain(outer.iter()).all(|v| v.is_finite()) {
        return false;
    }
    inner[0] >= outer[0] - BOUNDS_EPS_PX
        && inner[1] >= outer[1] - BOUNDS_EPS_PX
        && inner[0] + inner[2] <= outer[0] + outer[2] + BOUNDS_EPS_PX
        && inner[1] + inner[3] <= outer[1] + outer[3] + BOUNDS_EPS_PX
}

// ---------- naming (§10.2) ----------

/// §7.5/§10.1: a machine-generated default name — a kind, one space, then only digits
/// (`Layer 27`, `Group 3`, `Shape 12`). Byte inspection only: no slicing, any UTF-8 is
/// safe.
fn is_machine_name(name: &str) -> bool {
    let (kind, digits) = match name.split_once(' ') {
        Some(parts) => parts,
        None => return false,
    };
    MACHINE_KINDS.contains(&kind) && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// §10.2's name pattern for a `layerMap` role. A trailing ` — <variant>` is allowed on
/// every role (the Variants row: `Headline — es`); unknown roles are unchecked (the
/// manifest is the authority on what a role means, not this table).
fn role_name_ok(role: &str, name: &str) -> bool {
    // Strip ONE trailing variant segment, UTF-8-safely (rsplit splits on the char
    // boundary the separator itself provides; an empty tail means a dangling separator).
    let base = match name.rsplit_once(VARIANT_SEP) {
        Some((head, tail)) if !tail.is_empty() => head,
        _ => name,
    };
    const TEXT_ROLES: &[&str] = &["Headline", "Subhead", "Body", "Caption", "CTA"];
    match role {
        "background" => base == "Background",
        "image" | "photo" => base == "Photo",
        "headline" | "subhead" | "body" | "caption" | "cta" | "text" | "supporting-text" => {
            TEXT_ROLES.contains(&base)
        }
        "logo" => base == "Logo",
        "badge" => base == "Badge",
        "watermark" => base == "Watermark",
        // `<ComponentName>` or `<ComponentName> — <variant>`: a PascalCase-ish word up front.
        "component" => base.chars().next().is_some_and(|c| c.is_uppercase()),
        _ => true,
    }
}

/// §10.2's own examples, for the message of a role-pattern warning.
fn role_example(role: &str) -> &'static str {
    match role {
        "background" => "`Background`",
        "image" | "photo" => "`Photo` or `Photo — <subject>`",
        "headline" => "`Headline` or `Headline — <variant>`",
        "subhead" | "supporting-text" => "`Subhead` or `Subhead — <variant>`",
        "body" => "`Body` or `Body — <variant>`",
        "caption" => "`Caption` or `Caption — <variant>`",
        "cta" => "`CTA` or `CTA — <variant>`",
        "logo" => "`Logo` or `Logo — <variant>`",
        "badge" => "`Badge` or `Badge — <variant>`",
        "watermark" => "`Watermark` or `Watermark — <variant>`",
        "component" => "`<ComponentName>` or `<ComponentName> — <variant>`",
        _ => "the §10.2 pattern the role names",
    }
}

// ---------- document reading ----------

/// The layer's computed bounds as `document.inspect` reports them — `[x, y, w, h]` of its
/// surface's content — when it has measurable pixels (empty rasters and un-rasterized
/// text have none, and a zero-size box counts as none).
fn computed_bounds(l: &Layer) -> Option<[f64; 4]> {
    let r = l.surface()?.content_bounds();
    let (w, h) = (r.width() as f64, r.height() as f64);
    if !w.is_finite() || !h.is_finite() || w <= 0.0 || h <= 0.0 {
        return None;
    }
    Some([f64::from(r.x0), f64::from(r.y0), w, h])
}

// ---------- the checks (each pure: document + manifest → issues) ----------

/// `missing_must_layer` (blocker): every `rules.mustLayers` name exists in the document.
fn check_must_layers(out: &mut Issues, doc: &Document, m: &TemplateManifest) {
    for name in &m.rules.must_layers {
        if layer_by_name(doc, name).is_none() {
            out.push(
                BLOCKER,
                "missing_must_layer",
                Some(name.as_str()),
                format!(
                    "rules.mustLayers requires a layer named \"{}\", which the document does not have",
                    short(name)
                ),
                format!(
                    "add the layer, or rename the layer that plays the part so it is named \"{}\" (layer.setProps name)",
                    short(name)
                ),
            );
        }
    }
}

/// `slot_layer_missing` (major): every slot's target layer exists — template layers are
/// never deleted (§7.3), and `template.fill` cannot fill a slot whose layer is gone.
fn check_slot_layers(out: &mut Issues, doc: &Document, m: &TemplateManifest) {
    for (name, slot) in &m.slots {
        if layer_by_name(doc, slot.layer()).is_none() {
            let optional = if slot.optional() { " (optional)" } else { "" };
            out.push(
                MAJOR,
                "slot_layer_missing",
                Some(slot.layer()),
                format!(
                    "slot `{}` targets layer \"{}\", which the document does not have{}; template.apply expects it present and template.fill cannot fill the slot without it",
                    short(name),
                    short(slot.layer()),
                    optional
                ),
                "re-apply the template (template.apply), or rename the layer that holds the slot's content".into(),
            );
        }
    }
}

/// `slot_bounds` (major): a slot's layer sits inside its declared `[x, y, w, h]` when it
/// has measurable pixels — a fill or a move that escaped the slot. Un-rasterized text
/// has none, and its declared box carries the safe-area check instead.
fn check_slot_bounds(out: &mut Issues, doc: &Document, m: &TemplateManifest) {
    for (name, slot) in &m.slots {
        let Some(declared) = slot_bounds(slot) else { continue };
        let Some(l) = layer_by_name(doc, slot.layer()).and_then(|id| doc.layer(id)) else {
            continue; // Missing layers are reported by check_slot_layers.
        };
        let Some(actual) = computed_bounds(l) else { continue };
        if !fits_in(actual, declared) {
            out.push(
                MAJOR,
                "slot_bounds",
                Some(l.name.as_str()),
                format!(
                    "slot `{}`'s layer \"{}\" sits at [{:.0}, {:.0}, {:.0}, {:.0}], outside its declared bounds [{:.0}, {:.0}, {:.0}, {:.0}]",
                    short(name),
                    short(&l.name),
                    actual[0],
                    actual[1],
                    actual[2],
                    actual[3],
                    declared[0],
                    declared[1],
                    declared[2],
                    declared[3],
                ),
                "transform the layer back into its slot (edit.transform, or layout.apply)".into(),
            );
        }
    }
}

/// The slot's declared `[x, y, w, h]`, when its kind carries geometry.
fn slot_bounds(slot: &Slot) -> Option<[f64; 4]> {
    match slot {
        Slot::Text(t) => Some(t.bounds),
        Slot::Image(i) => Some(i.bounds),
        Slot::Component(c) => c.bounds,
        Slot::Color(_) | Slot::Visibility(_) => None,
    }
}

/// The layerMap role the manifest gives a layer name, when it names one.
fn role_of(m: &TemplateManifest, layer: &str) -> Option<&str> {
    m.layer_map.get(layer).map(|r| r.role.as_str())
}

/// Is a slot's content essential (safe-area checked)? Text and component content always
/// is; images are decorative art that may bleed (the §7.2 example's photo is full-bleed)
/// unless they carry a brand role.
fn essential_slot(m: &TemplateManifest, slot: &Slot) -> bool {
    match slot {
        Slot::Text(_) | Slot::Component(_) => true,
        Slot::Image(_) => matches!(role_of(m, slot.layer()), Some("logo" | "badge" | "watermark")),
        Slot::Color(_) | Slot::Visibility(_) => false,
    }
}

/// `safe_area` (major): essential content keeps `rules.safeArea` px clear of the canvas
/// edges. A slot's box is its layer's computed bounds when it has pixels (the real
/// position after a fill or a move), else its declared box (the design intent — checked
/// whether or not the slot is filled, since an unfilled optional still shows when the
/// user switches it on). Visible text no slot covers is checked too, when it has pixels.
fn check_safe_area(out: &mut Issues, doc: &Document, m: &TemplateManifest) {
    let Some(safe) = m.rules.safe_area.filter(|s| s.is_finite() && *s >= 0.0) else { return };
    let canvas = [f64::from(doc.size.width), f64::from(doc.size.height)];
    if canvas[0] <= 0.0 || canvas[1] <= 0.0 {
        return;
    }
    for (name, slot) in &m.slots {
        if !essential_slot(m, slot) {
            continue;
        }
        let Some(l) = layer_by_name(doc, slot.layer()).and_then(|id| doc.layer(id)) else {
            continue; // Missing layers are reported by check_slot_layers.
        };
        let Some(b) = computed_bounds(l).or_else(|| slot_bounds(slot)) else { continue };
        if !within_safe_area(b, canvas, safe) {
            out.push(
                MAJOR,
                "safe_area",
                Some(l.name.as_str()),
                format!(
                    "slot `{}`'s content \"{}\" at [{:.0}, {:.0}, {:.0}, {:.0}] reaches inside the {:.0} px safe-area margin of the {:.0}×{:.0} canvas",
                    short(name),
                    short(&l.name),
                    b[0],
                    b[1],
                    b[2],
                    b[3],
                    safe,
                    canvas[0],
                    canvas[1],
                ),
                format!("keep essential content at least {safe:.0} px inside every canvas edge (edit.transform, or layout.apply)"),
            );
        }
    }
    // Text the manifest does not know about (added after the apply): pixels, not intent.
    let targets: Vec<&str> = m.slots.values().map(|s| s.layer()).collect();
    for (_, _, l) in doc.walk() {
        if !l.visible || !matches!(l.content, LayerContent::Text(_)) || targets.contains(&l.name.as_str()) {
            continue;
        }
        let Some(b) = computed_bounds(l) else { continue };
        if !within_safe_area(b, canvas, safe) {
            out.push(
                MAJOR,
                "safe_area",
                Some(l.name.as_str()),
                format!(
                    "the text layer \"{}\" at [{:.0}, {:.0}, {:.0}, {:.0}] reaches inside the {:.0} px safe-area margin of the {:.0}×{:.0} canvas",
                    short(&l.name),
                    b[0],
                    b[1],
                    b[2],
                    b[3],
                    safe,
                    canvas[0],
                    canvas[1],
                ),
                format!("keep text at least {safe:.0} px inside every canvas edge (edit.transform, or layout.apply)"),
            );
        }
    }
}

/// `contrast` (blocker): visible text against the declared background — the `background`
/// role's `fill`, else the manifest canvas's — as a WCAG relative-luminance ratio. The
/// threshold is `rules.minContrast` when declared, else §11.1's 4.5:1 body / 3:1 large
/// (≥ [`LARGE_TEXT_PT`] pt). Text over a photo is a render question: the worker's
/// pixel-based §11.1 pass owns that pair.
fn check_contrast(out: &mut Issues, doc: &Document, m: &TemplateManifest) {
    let Some(bg) = m
        .layer_map
        .values()
        .find(|r| r.role == "background")
        .and_then(|r| r.fill.as_deref())
        .or(m.canvas.background.as_deref())
        .and_then(hex_rgb)
    else {
        return; // No declared background: nothing deterministic to compare against.
    };
    for (_, _, l) in doc.walk() {
        if !l.visible {
            continue;
        }
        let LayerContent::Text(t) = &l.content else { continue };
        let required = m
            .rules
            .min_contrast
            .filter(|c| c.is_finite() && *c >= 0.0)
            .unwrap_or(if f64::from(t.size_pt) >= LARGE_TEXT_PT { LARGE_CONTRAST } else { BODY_CONTRAST });
        let ratio = contrast_ratio(color_rgb(&t.color), bg);
        if ratio + RATIO_EPS < required {
            out.push(
                BLOCKER,
                "contrast",
                Some(l.name.as_str()),
                format!(
                    "the text on \"{}\" contrasts {:.1}:1 against the declared background, below the required {:.1}:1",
                    short(&l.name),
                    ratio,
                    required
                ),
                format!(
                    "darken the text or lighten the background until the WCAG ratio reaches {required:.1}:1 (type.setStyle color / layer.fill.solidColor.set)"
                ),
            );
        }
    }
}

/// `max_text_layers` (major): the document's text-layer count — hidden placeholders
/// included; the cap is the template's design budget, and optional slots stay present
/// (§7.3) — within `rules.maxTextLayers`.
fn check_max_text_layers(out: &mut Issues, doc: &Document, m: &TemplateManifest) {
    let Some(max) = m.rules.max_text_layers else { return };
    let n = doc.walk().iter().filter(|(_, _, l)| matches!(l.content, LayerContent::Text(_))).count();
    if n as u64 > u64::from(max) {
        out.push(
            MAJOR,
            "max_text_layers",
            None,
            format!("the document carries {n} text layers; the template caps them at {max}"),
            "hide or remove text layers beyond the cap (layer.setProps visible / layer.delete)".into(),
        );
    }
}

/// `color_out_of_palette` (minor): visible text and solid-fill colours are in
/// `rules.palette`, compared as 8-bit rgb. Raster pixels are image-derived and exempt
/// (§11.1); hidden layers are not rendered.
fn check_palette(out: &mut Issues, doc: &Document, m: &TemplateManifest) {
    if m.rules.palette.is_empty() {
        return;
    }
    let palette: Vec<[u8; 3]> = m.rules.palette.iter().filter_map(|h| hex_rgb8(h)).collect();
    if palette.is_empty() {
        return; // Unparseable entries are manifest.rs's refusal, not ours to report.
    }
    for (_, _, l) in doc.walk() {
        if !l.visible {
            continue;
        }
        let c = match &l.content {
            LayerContent::Text(t) => &t.color,
            LayerContent::Fill(Fill::Solid(c)) => c,
            _ => continue, // Raster pixels are image-derived (§11.1 exempts them).
        };
        if !palette.contains(&color_rgb8(c)) {
            out.push(
                MINOR,
                "color_out_of_palette",
                Some(l.name.as_str()),
                format!(
                    "the colour of \"{}\" is not one of the template's {} palette colours",
                    short(&l.name),
                    palette.len()
                ),
                "set it to the nearest palette colour (type.setStyle color / layer.fill.solidColor.set)".into(),
            );
        }
    }
}

/// `naming` (minor), manifest half: the `layerMap`'s own names follow their roles' §10.2
/// patterns. A warning, never a blocker — roles are design metadata.
fn check_role_naming(out: &mut Issues, m: &TemplateManifest) {
    for (name, role) in &m.layer_map {
        if !role_name_ok(&role.role, name) {
            out.push(
                MINOR,
                "naming",
                Some(name.as_str()),
                format!(
                    "a layer with the \"{}\" role should be named like {} (§10.2), but the manifest names it \"{}\"",
                    short(&role.role),
                    role_example(&role.role),
                    short(name)
                ),
                "rename the layer (or correct its layerMap role) so the name and the role agree".into(),
            );
        }
    }
}

/// `naming` (minor), document half: machine-generated names (`Layer 27`, §7.5) and empty
/// ones — §10.2's "no Layer N" row. Runs with or without a manifest.
fn check_machine_names(out: &mut Issues, doc: &Document) {
    for (_, _, l) in doc.walk() {
        if l.name.trim().is_empty() {
            out.push(
                MINOR,
                "naming",
                None,
                format!("layer {} has no name", l.id.0),
                "name it after its role (§10.2: Background, Photo — <subject>, Headline, CTA)".into(),
            );
        } else if is_machine_name(&l.name) {
            out.push(
                MINOR,
                "naming",
                Some(l.name.as_str()),
                format!("\"{}\" is a machine-generated name", short(&l.name)),
                "rename it after its role (§10.2: Background, Photo — <subject>, Headline, CTA)".into(),
            );
        }
    }
}

// ---------- the pass ----------

/// The whole pass in one fixed order: the manifest's rules first (mustLayers, slot
/// layers, slot bounds, safe area, contrast, maxTextLayers, palette, role names), then
/// the manifest-independent machine-name check. Pure — no session, no disk; the tuple is
/// the reply's `issues` and `truncated`.
fn check(doc: &Document, manifest: Option<&TemplateManifest>) -> (Vec<Value>, bool) {
    let mut out = Issues::default();
    if let Some(m) = manifest {
        check_must_layers(&mut out, doc, m);
        check_slot_layers(&mut out, doc, m);
        check_slot_bounds(&mut out, doc, m);
        check_safe_area(&mut out, doc, m);
        check_contrast(&mut out, doc, m);
        check_max_text_layers(&mut out, doc, m);
        check_palette(&mut out, doc, m);
        check_role_naming(&mut out, m);
    }
    check_machine_names(&mut out, doc);
    (out.rows, out.truncated)
}

// ---------- the command ----------

/// `template.validate`'s core, given the catalog directory (`None` when no template is
/// asked for — the document-only arm never reads the catalog).
pub(crate) fn validate_from(
    s: &mut Session,
    dir: Option<&Path>,
    template: Option<(String, Option<u64>)>,
    document: Option<u64>,
) -> Result<Value> {
    // The manifest first: a bad pin is the catalog's own typed error, never half a pass.
    let t = match template {
        Some((id, version)) => {
            let dir = dir.ok_or_else(no_dir)?;
            Some(resolve(dir, &id, version)?)
        }
        None => None,
    };
    // The document under check: the named open one, else the active one, else — with no
    // document open — the template's own .pcraft, as shipped (template-author linting).
    let (doc, index) = match document {
        Some(i) => {
            let i = usize::try_from(i).map_err(|_| bad(format!("`document` {i} is not a valid index")))?;
            let n = s.documents().len();
            let st = s
                .documents()
                .get(i)
                .ok_or_else(|| bad(format!("document {i} is not open; the session has {n} open document(s)")))?;
            (st.doc.clone(), Some(i))
        }
        None => match s.active() {
            Some(st) => (st.doc.clone(), s.active_index()),
            None => {
                let t = t.as_ref().ok_or_else(|| {
                    bad("no document is open; pass \"document\" (an open document to check), or \"template\" to lint the template's own document")
                })?;
                let bytes = file_cmds::read_file(&t.doc)?;
                let d = file_cmds::import(&t.doc, &bytes)?;
                (d, None)
            }
        },
    };
    if doc.layers.is_empty() {
        return Err(EngineError::Other(format!("the document \"{}\" has no layers to validate", short(&doc.name))));
    }
    let (issues, truncated) = check(&doc, t.as_ref().map(|t| &t.manifest));
    let ok = issues
        .iter()
        .all(|i| i.get("level").and_then(Value::as_str).is_none_or(|l| l != BLOCKER && l != MAJOR));
    Ok(json!({
        "ok": ok,
        "issues": issues,
        // §7.4: the pin is always explicit in the command log.
        "template": t.as_ref().map(|t| t.pin()),
        "document": index,
        "truncated": truncated,
    }))
}

/// The `template.validate` command (§7.4): parse the params, then [`validate_from`] with
/// the configured catalog. At least one of `template`/`document` is required — there is
/// nothing to validate otherwise.
pub(super) fn run(s: &mut Session, p: &Value) -> Result<Value> {
    let template = match p.get("template") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) => Some(parse_pin(id).map_err(|e| bad(format!("`template`: {e}")))?),
        Some(other) => return Err(bad(format!("`template` must be a template id or \"id@version\", not {other}"))),
    };
    let document = match p.get("document") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_u64().ok_or_else(|| bad(format!("`document` must be an open document's index, not {v}")))?),
    };
    if template.is_none() && document.is_none() {
        return Err(bad(
            "pass \"template\" (the manifest whose rules to check), \"document\" (an open document to check), or both — there is nothing to validate yet",
        ));
    }
    // The catalog is read only when a template is asked for: the document-only arm works
    // without any directory configured.
    let dir = match template {
        Some(_) => Some(templates_dir().ok_or_else(no_dir)?),
        None => None,
    };
    validate_from(s, dir.as_deref(), template, document)
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_color::{ColorMode, SampleType};
    use photocraft_doc::{Size, TextLayer};

    /// The §7.2 manifest, verbatim — the same one `manifest.rs`'s and `template_cmds.rs`'s
    /// tests parse, including its own gap: the subhead colour is not in the palette,
    /// which the pass must report as exactly one minor.
    fn manifest_value() -> Value {
        json!({
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
        })
    }

    /// The manifest with `edits` applied (one table row per test), parsed and validated.
    fn manifest_with(edits: impl FnOnce(&mut Value)) -> std::result::Result<TemplateManifest, Box<dyn std::error::Error>> {
        let mut v = manifest_value();
        edits(&mut v);
        Ok(TemplateManifest::from_value(&v).map_err(|e| e.to_string().into())?)
    }

    /// A document colour from a hex, the way the engine's own parsers build one.
    fn hex_color(hex: &str) -> std::result::Result<Color, Box<dyn std::error::Error>> {
        let [r, g, b, a] = parse_hex(hex).ok_or_else(|| format!("{hex:?} is not #rrggbb"))?;
        Ok(Color::rgba(r, g, b, a))
    }

    /// The §7.2 template document: the manifest's slots and mustLayers by name, with the
    /// declared colours on its text layers (what the catalog fixture ships as .pcraft).
    fn template_doc() -> std::result::Result<Document, Box<dyn std::error::Error>> {
        let mut doc = Document::new("Instagram Post", Size::new(1080, 1080), ColorMode::Rgb, SampleType::U8);
        doc.layers.push(Layer::new("Background", LayerContent::Fill(Fill::Solid(hex_color("#F4E7D3")?))));
        doc.layers.push(Layer::raster("Photo", doc.pixel_format()));
        doc.layers.push(Layer::new(
            "Headline",
            LayerContent::Text(TextLayer {
                text: "Old headline".into(),
                size_pt: 96.0,
                color: hex_color("#3B2A20")?,
                ..Default::default()
            }),
        ));
        doc.layers.push(Layer::new(
            "Subhead",
            LayerContent::Text(TextLayer {
                text: "Old sub".into(),
                size_pt: 36.0,
                color: hex_color("#6B5748")?,
                ..Default::default()
            }),
        ));
        doc.layers.push(Layer::raster("Badge", doc.pixel_format()));
        doc.layers.push(Layer::raster("Logo", doc.pixel_format()));
        Ok(doc)
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

    /// The rows of a pass with a given code.
    fn coded(issues: &[Value], code: &str) -> Vec<&Value> {
        issues.iter().filter(|i| i.get("code").and_then(Value::as_str) == Some(code)).collect()
    }

    /// `ok` for a pass's rows (§11.1: no blocker, no major).
    fn passes(issues: &[Value]) -> bool {
        issues
            .iter()
            .all(|i| i.get("level").and_then(Value::as_str).is_none_or(|l| l == MINOR))
    }

    /// Every issue row carries §7.4's shape: level, code, message, fix — a layer name
    /// exactly when the check knows one, and a snake_case code.
    fn shape_is_held(issues: &[Value]) {
        for i in issues {
            for key in ["level", "code", "message", "fix"] {
                assert!(i.get(key).and_then(Value::as_str).is_some(), "{key} missing in {i}");
            }
            assert!(
                matches!(i.get("level").and_then(Value::as_str), Some("blocker") | Some("major") | Some("minor")),
                "{i}"
            );
            if let Some(code) = i.get("code").and_then(Value::as_str) {
                assert!(
                    code.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                    "the code {code:?} is not snake_case: {i}"
                );
            }
        }
    }

    // ---------- the math tables ----------

    #[test]
    fn contrast_ratio_table() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let hx = |h: &str| hex_rgb(h).ok_or_else(|| format!("{h:?} is not a hex"));
        let near = |a: f64, b: f64| (a - b).abs() < 0.01;
        // WCAG's own reference pairs first.
        assert!(near(contrast_ratio([0.0; 3], [1.0, 1.0, 1.0]), 21.0));
        assert!(near(contrast_ratio([1.0; 3], [1.0, 1.0, 1.0]), 1.0));
        assert!(near(contrast_ratio(hx("#767676")?, [1.0, 1.0, 1.0]), 4.54), "the famous 4.54:1 gray");
        assert!(near(contrast_ratio(hx("#777777")?, [1.0, 1.0, 1.0]), 4.48), "just under 4.5:1");
        // The fixture's pairs on the cream background.
        let bg = hx("#F4E7D3")?;
        assert!(near(contrast_ratio(hx("#3B2A20")?, bg), 11.19));
        assert!(near(contrast_ratio(hx("#6B5748")?, bg), 5.59));
        // Order never matters.
        assert!((contrast_ratio(hx("#3B2A20")?, bg) - contrast_ratio(bg, hx("#3B2A20")?)).abs() < 1e-12);
        // Hostile numbers: NaN channels read as black, never a panic or a NaN.
        assert_eq!(relative_luminance([f64::NAN, f64::INFINITY, 0.0]), 0.0);
        assert!(near(contrast_ratio([f64::NAN; 3], [f64::NAN; 3]), 1.0));
        assert!(near(relative_luminance([1.0, 1.0, 1.0]), 1.0));
        assert!(near(relative_luminance(bg), 0.8109));
        Ok(())
    }

    #[test]
    fn hex_rgb_parses_the_registry_spellings() -> std::result::Result<(), Box<dyn std::error::Error>> {
        assert_eq!(hex_rgb("#F4E7D3").ok_or("6-digit hex")?, [244.0 / 255.0, 231.0 / 255.0, 211.0 / 255.0]);
        // An alpha channel is accepted and ignored by the ratio math.
        assert_eq!(hex_rgb("#3B2A2080").ok_or("8-digit hex")?, hex_rgb("#3B2A20").ok_or("no alpha")?);
        for junk in ["", "#", "#F4E", "#GGGGGG", "#F4E7D", "#F4E7D33"] {
            assert!(hex_rgb(junk).is_none(), "{junk:?} parsed");
        }
        // The 8-bit quantisation matches Color::to_rgba8's, so palette hexes compare equal.
        assert_eq!(hex_rgb8("#F4E7D3").ok_or("quantize")?, color_rgb8(&Color::rgb(244.0 / 255.0, 231.0 / 255.0, 211.0 / 255.0)));
        Ok(())
    }

    #[test]
    fn safe_area_table() {
        let canvas = [1080.0, 1080.0];
        assert!(within_safe_area([72.0, 732.0, 936.0, 176.0], canvas, 48.0), "well inside");
        // Full-bleed art is outside — the caller decides what is essential; the math only
        // says where the box is.
        assert!(!within_safe_area([0.0, 0.0, 1080.0, 700.0], canvas, 48.0));
        // Exactly at the margin passes; just past each edge fails.
        assert!(within_safe_area([48.0, 48.0, 984.0, 984.0], canvas, 48.0));
        assert!(!within_safe_area([47.9, 48.0, 984.0, 984.0], canvas, 48.0));
        assert!(!within_safe_area([48.0, 47.9, 984.0, 984.0], canvas, 48.0));
        assert!(!within_safe_area([48.0, 48.0, 984.1, 984.0], canvas, 48.0));
        assert!(!within_safe_area([48.0, 48.0, 984.0, 984.1], canvas, 48.0));
        // A zero margin disables the rule.
        assert!(within_safe_area([0.0, 0.0, 1080.0, 1080.0], canvas, 0.0));
        // Hostile numbers are violations, never panics.
        for b in [[f64::NAN, 0.0, 10.0, 10.0], [0.0, f64::INFINITY, 10.0, 10.0], [0.0, 0.0, f64::NAN, 10.0], [0.0, 0.0, 10.0, 1e999]] {
            assert!(!within_safe_area(b, canvas, 48.0), "{b:?} passed");
        }
        assert!(!within_safe_area([0.0, 0.0, 100.0, 100.0], [f64::NAN, 1080.0], 48.0));
        assert!(!within_safe_area([0.0, 0.0, 100.0, 100.0], canvas, -1.0));
    }

    #[test]
    fn fits_in_table() {
        let slot = [72.0, 732.0, 936.0, 176.0];
        assert!(fits_in(slot, slot), "a box fits itself");
        assert!(fits_in([72.4, 732.0, 935.0, 175.0], slot), "inside");
        assert!(fits_in([71.6, 731.6, 936.9, 176.9], slot), "half a pixel of render rounding each way");
        assert!(!fits_in([71.0, 732.0, 936.0, 176.0], slot), "past the left edge");
        assert!(!fits_in([72.0, 732.0, 1000.0, 176.0], slot), "too wide");
        assert!(!fits_in([f64::NAN, 0.0, 10.0, 10.0], slot), "NaN never fits");
        assert!(!fits_in([0.0, f64::INFINITY, 10.0, 10.0], [f64::NAN; 4]), "infinities never fit");
    }

    #[test]
    fn machine_name_table() {
        for machine in ["Layer 1", "Layer 27", "Group 3", "Shape 12", "Layer 0"] {
            assert!(is_machine_name(machine), "{machine:?} is not flagged");
        }
        for fine in
            ["Layer", "Layer X", "Layer 12a", "Layer 12 3", "layer 3", "LAYER 3", "Layer 3 ", "Background", "Photo — Latte", "Headline — es", "Offer Badge — 20%", "🔥🔥", "Layer ③"]
        {
            assert!(!is_machine_name(fine), "{fine:?} is flagged");
        }
    }

    #[test]
    fn role_name_table() {
        // §10.2's rows: the role's own name, its variant form…
        for (role, fine, variant) in [
            ("background", "Background", "Background — Dark"),
            ("image", "Photo", "Photo — Latte"),
            ("headline", "Headline", "Headline — es"),
            ("subhead", "Subhead", "Subhead — Offer"),
            ("supporting-text", "Body", "Caption — es"),
            ("caption", "Caption", "CTA"),
            ("cta", "CTA", "CTA — Weekend"),
            ("logo", "Logo", "Logo — Mono"),
            ("badge", "Badge", "Badge — 20%"),
            ("watermark", "Watermark", "Watermark — Light"),
            ("component", "Offer Badge", "Offer Badge — 20%"),
        ] {
            assert!(role_name_ok(role, fine), "{role}: {fine:?} flagged");
            assert!(role_name_ok(role, variant), "{role}: {variant:?} flagged");
        }
        // …and the violations.
        for (role, off) in [
            ("background", "Bg"),
            ("image", "Photograph"),
            ("image", "photo"),
            ("headline", "Title"),
            ("headline", "Headline — "), // dangling separator
            ("logo", "Logotype"),
            ("component", "offer badge"), // not PascalCase-ish
            ("component", ""),
        ] {
            assert!(!role_name_ok(role, off), "{role}: {off:?} passed");
        }
        // Unknown roles are the manifest's business, not this table's.
        assert!(role_name_ok("mood-board", "whatever 42"));
    }

    #[test]
    fn role_examples_name_a_pattern() {
        for role in ["background", "image", "headline", "supporting-text", "logo", "component", "mood-board"] {
            assert!(!role_example(role).is_empty(), "{role}");
        }
    }

    // ---------- the pass on fixtures ----------

    #[test]
    fn the_spec_example_validates_with_only_its_own_palette_gap()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let m = manifest_with(|_| {})?;
        let (issues, truncated) = check(&template_doc()?, Some(&m));
        shape_is_held(&issues);
        assert!(!truncated, "{issues:?}");
        // The §7.2 example's subhead colour is not in its own palette: exactly one minor.
        let off = coded(&issues, "color_out_of_palette");
        assert_eq!(off.len(), 1, "{issues:?}");
        assert_eq!(off[0].get("layer").and_then(Value::as_str), Some("Subhead"));
        for code in ["missing_must_layer", "slot_layer_missing", "slot_bounds", "safe_area", "contrast", "max_text_layers", "naming"] {
            assert!(coded(&issues, code).is_empty(), "{code} fired on the clean fixture: {issues:?}");
        }
        assert!(passes(&issues), "minors never flip ok: {issues:?}");
        Ok(())
    }

    #[test]
    fn a_missing_must_layer_is_a_blocker() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let m = manifest_with(|_| {})?;
        let mut doc = template_doc()?;
        doc.layers.retain(|l| l.name != "Headline"); // a mustLayers name and a slot target
        let (issues, _) = check(&doc, Some(&m));
        shape_is_held(&issues);
        let missing = coded(&issues, "missing_must_layer");
        assert_eq!(missing.len(), 1, "{issues:?}");
        assert_eq!(missing[0].get("level").and_then(Value::as_str), Some("blocker"));
        assert_eq!(missing[0].get("layer").and_then(Value::as_str), Some("Headline"));
        // The same removal also loses the slot's layer — a major, in its own row.
        assert_eq!(coded(&issues, "slot_layer_missing").len(), 1, "{issues:?}");
        assert!(!passes(&issues), "{issues:?}");
        Ok(())
    }

    #[test]
    fn a_missing_slot_layer_is_a_major_even_when_optional() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let m = manifest_with(|_| {})?;
        let mut doc = template_doc()?;
        doc.layers.retain(|l| l.name != "Logo"); // optional image slot, brand role
        let (issues, _) = check(&doc, Some(&m));
        let missing = coded(&issues, "slot_layer_missing");
        assert_eq!(missing.len(), 1, "{issues:?}");
        assert_eq!(missing[0].get("level").and_then(Value::as_str), Some("major"));
        assert_eq!(missing[0].get("layer").and_then(Value::as_str), Some("Logo"));
        assert!(missing[0].get("message").and_then(Value::as_str).is_some_and(|s| s.contains("optional")), "{missing:?}");
        // Its safe-area row is gone with it (nothing to place).
        assert!(coded(&issues, "safe_area").is_empty(), "{issues:?}");
        Ok(())
    }

    #[test]
    fn slot_bounds_compare_computed_bounds_to_the_declared_box()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let m = manifest_with(|_| {})?;
        // Real pixels via the engine's own commands: a filled raster is a Photo that
        // escaped its [0, 0, 1080, 700] slot.
        let mut s = Session::new();
        s.execute("file.new", json!({ "width": 1080, "height": 1080, "depth": 8 }))?;
        s.execute("layer.new.layer", json!({ "name": "Photo" }))?;
        s.execute("edit.fill", json!({ "color": "#3366cc" }))?;
        let doc = s.active().ok_or("no document")?.doc.clone();
        let (issues, _) = check(&doc, Some(&m));
        shape_is_held(&issues);
        let escaped = coded(&issues, "slot_bounds");
        assert_eq!(escaped.len(), 1, "{issues:?}");
        assert_eq!(escaped[0].get("level").and_then(Value::as_str), Some("major"));
        assert_eq!(escaped[0].get("layer").and_then(Value::as_str), Some("Photo"));
        assert!(
            escaped[0].get("message").and_then(Value::as_str).is_some_and(|s| s.contains("1080") && s.contains("700")),
            "{escaped:?}"
        );
        Ok(())
    }

    #[test]
    fn essential_content_reaching_the_margin_is_a_major() -> std::result::Result<(), Box<dyn std::error::Error>> {
        // The headline starts 8 px from the edge — inside the 48 px margin.
        let m = manifest_with(|v| v["slots"]["headline"]["bounds"] = json!([8, 732, 936, 176]))?;
        let (issues, _) = check(&template_doc()?, Some(&m));
        let area = coded(&issues, "safe_area");
        assert_eq!(area.len(), 1, "{issues:?}");
        assert_eq!(area[0].get("level").and_then(Value::as_str), Some("major"));
        assert_eq!(area[0].get("layer").and_then(Value::as_str), Some("Headline"));
        assert!(area[0].get("message").and_then(Value::as_str).is_some_and(|s| s.contains("48")), "{area:?}");
        // The full-bleed photo is not essential: no safe-area row for it.
        assert!(!passes(&issues), "{issues:?}");
        Ok(())
    }

    #[test]
    fn brand_role_images_are_essential_but_photos_bleed() -> std::result::Result<(), Box<dyn std::error::Error>> {
        // The logo slot (role logo) sits 8 px from the edge; the photo's full-bleed box
        // stays unflagged.
        let m = manifest_with(|v| v["slots"]["logo"]["bounds"] = json!([8, 984, 120, 40]))?;
        let (issues, _) = check(&template_doc()?, Some(&m));
        let area = coded(&issues, "safe_area");
        assert_eq!(area.len(), 1, "{issues:?}");
        assert_eq!(area[0].get("layer").and_then(Value::as_str), Some("Logo"), "{issues:?}");
        Ok(())
    }

    #[test]
    fn low_contrast_text_is_a_blocker_and_size_and_rules_move_the_threshold()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        // #777777 on #F4E7D3 is ~3.7:1 — below §11.1's 4.5:1 at 14 pt, fine as large
        // display text (≥ 18 pt, 3:1), and fine under a declared minContrast of 3.
        let mut body = template_doc()?;
        {
            let sub = body.layers.iter_mut().find(|l| l.name == "Subhead").ok_or("no Subhead")?;
            match &mut sub.content {
                LayerContent::Text(t) => {
                    t.color = hex_color("#777777")?;
                    t.size_pt = 14.0;
                }
                _ => return Err("Subhead is not text".into()),
            }
        }
        let m = manifest_with(|v| v["rules"]["minContrast"] = Value::Null)?;
        let (issues, _) = check(&body, Some(&m));
        let contrast = coded(&issues, "contrast");
        assert_eq!(contrast.len(), 1, "{issues:?}");
        assert_eq!(contrast[0].get("level").and_then(Value::as_str), Some("blocker"));
        assert_eq!(contrast[0].get("layer").and_then(Value::as_str), Some("Subhead"));
        assert!(
            contrast[0].get("message").and_then(Value::as_str).is_some_and(|s| s.contains("4.5:1")),
            "{contrast:?}"
        );

        // Large display text: the same colour passes at 24 pt.
        let mut large = body.clone();
        {
            let sub = large.layers.iter_mut().find(|l| l.name == "Subhead").ok_or("no Subhead")?;
            match &mut sub.content {
                LayerContent::Text(t) => t.size_pt = 24.0,
                _ => return Err("Subhead is not text".into()),
            }
        }
        let (issues, _) = check(&large, Some(&m));
        assert!(coded(&issues, "contrast").is_empty(), "{issues:?}");

        // A declared minContrast of 3 passes it at any size.
        let relaxed = manifest_with(|v| v["rules"]["minContrast"] = json!(3.0))?;
        let (issues, _) = check(&body, Some(&relaxed));
        assert!(coded(&issues, "contrast").is_empty(), "{issues:?}");

        // A declared minContrast of 12 outranks both compliant pairs (11.2:1, 5.6:1).
        let strict = manifest_with(|v| v["rules"]["minContrast"] = json!(12.0))?;
        let (issues, _) = check(&template_doc()?, Some(&strict));
        let contrast = coded(&issues, "contrast");
        assert_eq!(contrast.len(), 2, "both text layers: {issues:?}");
        assert!(
            contrast.iter().all(|i| i.get("level").and_then(Value::as_str) == Some("blocker")),
            "{contrast:?}"
        );
        Ok(())
    }

    #[test]
    fn contrast_is_skipped_without_a_declared_background() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let m = manifest_with(|v| {
            v["canvas"]["background"] = Value::Null;
            v["layerMap"]["Background"]["fill"] = Value::Null;
        })?;
        let mut doc = template_doc()?;
        {
            let sub = doc.layers.iter_mut().find(|l| l.name == "Subhead").ok_or("no Subhead")?;
            match &mut sub.content {
                LayerContent::Text(t) => t.color = hex_color("#777777")?,
                _ => return Err("Subhead is not text".into()),
            }
        }
        let (issues, _) = check(&doc, Some(&m));
        assert!(coded(&issues, "contrast").is_empty(), "{issues:?}");
        Ok(())
    }

    #[test]
    fn max_text_layers_counts_hidden_placeholders_too() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let m = manifest_with(|v| v["rules"]["maxTextLayers"] = json!(3))?;
        let mut doc = template_doc()?;
        for i in 0..2 {
            // §7.3: optional slots stay present but hidden — the cap is the design budget.
            let mut extra = Layer::new(format!("Caption — {i}"), LayerContent::Text(TextLayer::default()));
            extra.visible = false;
            doc.layers.push(extra);
        }
        let (issues, _) = check(&doc, Some(&m));
        let cap = coded(&issues, "max_text_layers");
        assert_eq!(cap.len(), 1, "{issues:?}");
        assert_eq!(cap[0].get("level").and_then(Value::as_str), Some("major"));
        assert!(
            cap[0].get("message").and_then(Value::as_str).is_some_and(|s| s.contains("4 text layers") && s.contains("3")),
            "{cap:?}"
        );
        assert!(cap[0].get("layer").is_none(), "{cap:?}");
        Ok(())
    }

    #[test]
    fn off_palette_solids_are_minor_and_never_flip_ok() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let m = manifest_with(|_| {})?;
        let mut doc = template_doc()?;
        doc.layers.push(Layer::new("Accent", LayerContent::Fill(Fill::Solid(hex_color("#77FFE0")?))));
        let (issues, _) = check(&doc, Some(&m));
        let off = coded(&issues, "color_out_of_palette");
        assert_eq!(off.len(), 2, "Subhead + Accent: {issues:?}");
        assert!(off.iter().all(|i| i.get("level").and_then(Value::as_str) == Some("minor")), "{issues:?}");
        assert!(passes(&issues), "minors never flip ok");
        Ok(())
    }

    #[test]
    fn machine_names_and_role_warnings_are_minor_naming_rows()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        // The manifest names its headline layer "Title": the headline role's §10.2
        // pattern disagrees. The document also carries a machine-named stray.
        let m = manifest_with(|v| {
            if let Some(map) = v["layerMap"].as_object_mut() {
                if let Some(entry) = map.get_mut("Headline") {
                    let entry = entry.clone();
                    map.insert("Title".into(), entry);
                    map.remove("Headline");
                }
            }
        })?;
        let mut doc = template_doc()?;
        doc.layers.push(Layer::raster("Group 3", doc.pixel_format()));
        let (issues, _) = check(&doc, Some(&m));
        shape_is_held(&issues);
        let naming = coded(&issues, "naming");
        assert_eq!(naming.len(), 2, "{issues:?}");
        assert!(naming.iter().all(|i| i.get("level").and_then(Value::as_str) == Some("minor")), "{issues:?}");
        assert!(naming.iter().any(|i| i.get("layer").and_then(Value::as_str) == Some("Title")), "{issues:?}");
        assert!(naming.iter().any(|i| i.get("layer").and_then(Value::as_str) == Some("Group 3")), "{issues:?}");
        // The headline slot still resolves (it targets layer "Headline", which the
        // document has) — only the layerMap's naming disagrees.
        assert!(coded(&issues, "slot_layer_missing").is_empty(), "{issues:?}");
        assert!(passes(&issues), "warnings never flip ok");
        Ok(())
    }

    #[test]
    fn empty_names_are_naming_rows_that_point_at_the_id() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let mut doc = template_doc()?;
        doc.layers.push(Layer::raster("   ", doc.pixel_format()));
        let (issues, _) = check(&doc, None);
        let naming = coded(&issues, "naming");
        assert_eq!(naming.len(), 1, "{issues:?}");
        // The row has no name to point at, so it names the layer by its id instead.
        assert!(naming[0].get("layer").is_none(), "{naming:?}");
        assert!(
            naming[0].get("message").and_then(Value::as_str).is_some_and(|s| s.contains("no name") && s.contains("layer ")),
            "{naming:?}"
        );
        Ok(())
    }

    #[test]
    fn deep_groups_walk_without_hanging() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let mut doc = Document::new("deep", Size::new(64, 64), ColorMode::Rgb, SampleType::U8);
        // Engine-legal depth (MAX_GROUP_DEPTH): the pass never recurses on its own, and
        // the engine's walk is bounded — this must return, not hang.
        let mut group = Layer::group("Outer", vec![Layer::raster("Layer 1", doc.pixel_format())]);
        for _ in 1..photocraft_doc::MAX_GROUP_DEPTH {
            group = Layer::group("Outer", vec![group]);
        }
        doc.layers.push(group);
        let (issues, _) = check(&doc, None);
        assert_eq!(issues.len(), 1, "one machine name at the bottom: {issues:?}");
        assert_eq!(issues[0].get("code").and_then(Value::as_str), Some("naming"));
        Ok(())
    }

    #[test]
    fn issues_are_capped_and_report_the_cap() {
        let mut doc = Document::new("wide", Size::new(64, 64), ColorMode::Rgb, SampleType::U8);
        for i in 0..(MAX_ISSUES + 44) {
            doc.layers.push(Layer::raster(format!("Layer {i}"), doc.pixel_format()));
        }
        let (issues, truncated) = check(&doc, None);
        assert_eq!(issues.len(), MAX_ISSUES);
        assert!(truncated);
    }

    #[test]
    fn hidden_layers_skip_the_render_checks_but_count_as_design()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let m = manifest_with(|_| {})?;
        let mut doc = template_doc()?;
        {
            let sub = doc.layers.iter_mut().find(|l| l.name == "Subhead").ok_or("no Subhead")?;
            sub.visible = false;
            match &mut sub.content {
                // Off-palette AND low-contrast — but hidden text is not rendered.
                LayerContent::Text(t) => t.color = hex_color("#77FFE0")?,
                _ => return Err("Subhead is not text".into()),
            }
        }
        let (issues, _) = check(&doc, Some(&m));
        assert!(coded(&issues, "contrast").is_empty(), "hidden text is not rendered: {issues:?}");
        assert!(coded(&issues, "color_out_of_palette").is_empty(), "{issues:?}");
        Ok(())
    }

    // ---------- the command (params first, then the disk) ----------

    #[test]
    fn run_validates_params_before_touching_env_or_state() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let mut s = Session::new();
        // Nothing to validate: both arms absent (the panic-hunt table's first row).
        let e = must_err(run(&mut s, &json!({})), "validated nothing")?;
        assert!(e.to_string().contains("template") && e.to_string().contains("document"), "{e}");
        // Wrong shapes and bad pins for both arms.
        for p in [
            json!({ "template": 42 }),
            json!({ "template": [] }),
            json!({ "template": "" }),
            json!({ "template": "x@" }),
            json!({ "template": "x@0" }),
            json!({ "template": "../escape" }),
            json!({ "template": "x", "document": "0" }),
            json!({ "template": "x", "document": -1 }),
            json!({ "template": "x", "document": 2.5 }),
        ] {
            let e = must_err(run(&mut s, &p), format!("accepted {p}"))?;
            assert!(e.to_string().contains("template.validate"), "{p}: {e}");
        }
        // 1e999 parses as infinity: not an index.
        let huge: Value = serde_json::from_str(r#"{"document": 1e999}"#)?;
        let e = must_err(run(&mut s, &huge), "accepted an infinite index")?;
        assert!(e.to_string().contains("document"), "{e}");
        // Well-formed template, no directory configured: the catalog's env error.
        let e = must_err(run(&mut s, &json!({ "template": "instagram-post" })), "resolved without a dir")?;
        assert!(e.to_string().contains("PHOTOCRAFT_TEMPLATES_DIR"), "{e}");
        Ok(())
    }

    #[test]
    fn the_document_only_arm_needs_no_catalog() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let mut s = Session::new();
        let mut doc = Document::new("scratch", Size::new(64, 48), ColorMode::Rgb, SampleType::U8);
        doc.layers.push(Layer::raster("Layer 3", doc.pixel_format()));
        let i = s.add_document(doc, None);
        let r = run(&mut s, &json!({ "document": i }))?;
        assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "a minor does not flip ok: {r}");
        assert!(r.get("template").is_some_and(Value::is_null), "{r}");
        assert_eq!(r.get("document").and_then(Value::as_u64), Some(i as u64));
        let issues = r.get("issues").and_then(Value::as_array).ok_or("no issues")?;
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(issues[0].get("code").and_then(Value::as_str), Some("naming"));
        // An index that is not open is a typed error listing what is.
        let e = must_err(run(&mut s, &json!({ "document": i + 5 })), "validated a closed document")?;
        assert!(
            e.to_string().contains(&format!("document {}", i + 5)) && e.to_string().contains("1 open document"),
            "{e}"
        );
        Ok(())
    }

    #[test]
    fn a_document_with_no_layers_is_refused() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let mut s = Session::new();
        let i = s.add_document(Document::new("empty", Size::new(64, 48), ColorMode::Rgb, SampleType::U8), None);
        let e = must_err(run(&mut s, &json!({ "document": i })), "validated an empty document")?;
        assert!(e.to_string().contains("no layers"), "{e}");
        Ok(())
    }

    // ---------- the catalog arms (files on disk) ----------

    /// A catalog directory holding the §7.2 example at @3, as the engine reads one:
    /// `<stem>.json` + `<stem>.pcraft` pairs.
    #[cfg(not(target_arch = "wasm32"))]
    fn fixture_dir() -> std::result::Result<tempfile::TempDir, Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        std::fs::write(dir.path().join("instagram-post.json"), manifest_value().to_string().as_bytes())?;
        std::fs::write(
            dir.path().join("instagram-post.pcraft"),
            &photocraft_format::save_to_bytes(&template_doc()?, &Default::default())?,
        )?;
        Ok(dir)
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn validate_from_lints_the_templates_own_document() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = fixture_dir()?;
        let mut s = Session::new(); // no document open: the template's own .pcraft is checked
        let r = validate_from(&mut s, Some(dir.path()), Some(("instagram-post".into(), Some(3))), None)?;
        assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "{r}");
        assert_eq!(r.get("template").and_then(Value::as_str), Some("instagram-post@3"));
        assert!(r.get("document").is_some_and(Value::is_null), "{r}");
        let issues = r.get("issues").and_then(Value::as_array).ok_or("no issues")?;
        assert_eq!(coded(issues, "color_out_of_palette").len(), 1, "{issues:?}"); // the §7.2 palette gap
        assert!(coded(issues, "contrast").is_empty(), "{issues:?}"); // colours survive the round trip
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn validate_from_checks_a_named_open_document() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = fixture_dir()?;
        let mut s = Session::new();
        let mut doc = Document::new("scratch", Size::new(64, 48), ColorMode::Rgb, SampleType::U8);
        doc.layers.push(Layer::raster("Layer 3", doc.pixel_format()));
        let i = s.add_document(doc, None);
        let r = validate_from(&mut s, Some(dir.path()), Some(("instagram-post".into(), None)), Some(i))?;
        assert_eq!(r.get("document").and_then(Value::as_u64), Some(i as u64));
        let issues = r.get("issues").and_then(Value::as_array).ok_or("no issues")?;
        shape_is_held(issues);
        // The scratch document has none of the template's layers: the mustLayers
        // blockers, the slot layers, and the stray's machine name — and ok is false.
        assert_eq!(coded(issues, "missing_must_layer").len(), 3, "{issues:?}");
        assert!(coded(issues, "slot_layer_missing").len() >= 4, "{issues:?}");
        assert_eq!(coded(issues, "naming").len(), 1, "{issues:?}");
        assert_eq!(r.get("ok").and_then(Value::as_bool), Some(false));
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn validate_from_explains_unknown_pins_and_broken_templates()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = fixture_dir()?;
        let mut s = Session::new();
        let e = must_err(
            validate_from(&mut s, Some(dir.path()), Some(("youtube-thumb".into(), None)), None),
            "served a missing template",
        )?;
        assert!(e.to_string().contains("no template `youtube-thumb`"), "{e}");
        let e = must_err(
            validate_from(&mut s, Some(dir.path()), Some(("instagram-post".into(), Some(99))), None),
            "served a missing version",
        )?;
        assert!(e.to_string().contains("no version 99"), "{e}");
        // A manifest without its .pcraft explains itself (the catalog's own refusal).
        let lost = tempfile::tempdir()?;
        std::fs::write(
            lost.path().join("lost.json"),
            json!({ "id": "lost", "version": 1, "name": "Lost", "canvas": { "width": 8, "height": 8 } }).to_string().as_bytes(),
        )?;
        let e = must_err(
            validate_from(&mut s, Some(lost.path()), Some(("lost".into(), None)), None),
            "linted a manifest without a document",
        )?;
        assert!(e.to_string().contains("no .pcraft document"), "{e}");
        // A template asked for without any catalog directory is the env error.
        let e = must_err(validate_from(&mut s, None, Some(("x".into(), None)), None), "resolved without a dir")?;
        assert!(e.to_string().contains("PHOTOCRAFT_TEMPLATES_DIR"), "{e}");
        Ok(())
    }

    /// The whole command path, driven through `Session::execute` in a child process (the
    /// directory is process-wide configuration, so the env var is set there — the same
    /// pattern `template_cmds.rs`'s list test uses; the command id resolves only in the
    /// patched clone, where the registration patch has landed).
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn validate_serves_the_configured_directory() -> std::result::Result<(), Box<dyn std::error::Error>> {
        const CHILD: &str = "PHOTOCRAFT_TEST_VALIDATE_CHILD";
        const TEST: &str = "template_cmds::validate::tests::validate_serves_the_configured_directory";
        if std::env::var_os(CHILD).is_some() {
            if std::env::var_os("PHOTOCRAFT_TEMPLATES_DIR").filter(|v| !v.is_empty()).is_none() {
                return Err("the child was spawned without a templates directory".into());
            }
            let mut s = Session::new();
            let r = s.execute("template.validate", json!({ "template": "instagram-post@3" }))?;
            assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "the fixture lints clean: {r}");
            assert_eq!(r.get("template").and_then(Value::as_str), Some("instagram-post@3"));
            assert!(s.journal.is_empty(), "a query must not journal: {:?}", s.journal);
            return Ok(());
        }
        let dir = fixture_dir()?;
        let status = std::process::Command::new(std::env::current_exe()?)
            .args(["--exact", TEST, "--nocapture"])
            .env(CHILD, "1")
            .env("PHOTOCRAFT_TEMPLATES_DIR", dir.path())
            .status()?;
        assert!(status.success(), "the child validation failed: {status}");
        Ok(())
    }
}
