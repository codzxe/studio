//! The `layout.fitText` and `layout.measure` commands (spec §9.4), wired to the §9.3 fit in
//! `super::fit_text`:
//!
//! * `layout.fitText { layer, bounds, minSize, maxSize, lineHeight, maxLines }` →
//!   `{ size, lines, overflow, bounds }` — measures, fits, and **applies the answer back with
//!   one `type.edit` call** (§9.3 step 5; the exact call is echoed in the result's `applied`
//!   and documented on the command's `params`):
//!
//!   ```json
//!   {
//!     "layer": <id>, "box": [x, y, w, h],
//!     "text": "<largest fitting prefix>…",          // only when the fit ellipsized
//!     "runs": [{ "start": 0, "end": <chars>, "size": <chosen>, "tracking": -20 }]
//!   }
//!   ```
//!
//!   The `box` write makes the layer a paragraph layer of exactly the fit bounds (so the
//!   wrapped measurement is the wrapped render — the layer's linear transform is kept, as
//!   `type.edit` defines `box`); the `runs` write sets the chosen size on every character
//!   (and the condensed tracking when §9.3 step 3 applied it). An overflow (step 4) writes
//!   nothing: the command reports `text_overflow` with the exact `overflowPx`/`overflowChars`
//!   for §11.1's blocker check and never clips silently. Undo reverts the fit (one history
//!   step, `type.edit`'s).
//! * `layout.measure { layer?, bounds?, text? }` → metrics for planning, pure: no mutation,
//!   `journal: false` (it needs a document only for fonts, resolution and the canvas width).
//!
//! Upstream shape: `crates/engine/src/layout_cmds.rs` declares
//! `pub mod fit_specs;` (with `fit_text` and `layout_apply`) and merges these into
//! `pub fn specs()`; the registry line is the single existing-file edit
//! (`engine-patches/registration/commands-registry.patch.md`).
//!
//! Golden rules: never panic on hostile params (§9.5 validate-before-math via
//! `fit_text::validate` and the local parsers; Err, never a panic); the fit's loops are
//! bounded (`fit_text::SEARCH_CAP`); lock checks reuse `type_cmds::check_text_unlocked` so a
//! locked layer fails fast with Photoshop's message instead of after the expensive fit.

use photocraft_doc::text::{CharStyle, TextShape};
use photocraft_doc::{LayerContent, LayerId, TextLayer};
use serde_json::{json, Value};

use super::fit_text::{fit_text, EngineTextMeasurer, FitRequest, FontRef, TextMeasurer, MAX_BOX_PX};
use crate::commands::CommandSpec;
use crate::type_cmds::{TYPE_SIZE_MAX_PT, TYPE_SIZE_MIN_PT};
use crate::{EngineError, Result, Session};

const FIT_TEXT_PARAMS: &str = r##"{"layer":id? (id or name; default active type layer),"bounds":[x,y,w,h] px (the fit box),"minSize":pt=12,"maxSize":pt (default: the layer's current size),"lineHeight":mult=1.2 (leading as ×size),"maxLines":int (default: how many minSize lines the box height holds)} → {"size":pt,"lines":int,"overflow":bool,"bounds":[x0,y0,x1,y1],"warnings":[…]?,"overflowPx":px?,"overflowChars":int?,"applied":{"command":"type.edit","params":…}?} — fits §9.3 and applies it with one type.edit {layer, box, text?, runs:[{start:0, end:chars, size, tracking?}]}; on overflow nothing is written (report only, never clipped silently)"##;

const MEASURE_PARAMS: &str = r##"{"layer":id? (id or name; default the active type layer),"text":str? (measure this text instead of the layer's; needs "size" without a layer),"size":pt?,"font":str? (family for ad-hoc text; default the layer's face / the engine default),"lineHeight":mult?=1.2 (×size leading),"bounds":[x,y,w,h] px? (w = wrap width; default: the layer's box width, else the canvas width)} → {"layer":id?,"text":str,"size":pt,"pxPerPt":px,"maxWidth":px,"width":px,"lines":int,"lineHeight":px,"height":px,"bounds":[0,0,width,height],"warnings":[…]?} — pure metrics for planning, no mutation (§9.4)"##;

fn has_doc(s: &Session) -> std::result::Result<(), String> {
    s.active().map(|_| ()).ok_or_else(|| "no document open".into())
}

fn bad(cmd: &str, msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: cmd.into(), msg: msg.into() }
}

/// The `layout.*` commands this module owns. The registry insert is
/// `v.extend(crate::layout_cmds::specs())` (the parent module merges `layout_apply::specs()`
/// with these; §2.3 workspace rule: one specs() per module).
pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec {
            id: "layout.fitText",
            label: "Fit Text to Box",
            menu: &[],
            shortcut: None,
            params: FIT_TEXT_PARAMS,
            enabled: has_doc,
            journal: true,
            run: fit_text_cmd,
        },
        CommandSpec {
            id: "layout.measure",
            label: "Measure Text",
            menu: &[],
            shortcut: None,
            params: MEASURE_PARAMS,
            enabled: has_doc,
            // Pure query: metrics for planning, no mutation (§9.4).
            journal: false,
            run: measure_cmd,
        },
    ]
}

/// The type layer the params name (`layer` id or name, else the active layer), with the
/// document resolution measurement runs at.
fn text_layer_of(s: &Session, p: &Value) -> Result<(LayerId, TextLayer, f32)> {
    let id = crate::commands::layer_param(s, p)?;
    let d = s.active().ok_or(EngineError::NoDocument)?;
    let l = d.doc.layer(id).ok_or(EngineError::NoLayer(id))?;
    match &l.content {
        LayerContent::Text(t) => Ok((id, t.clone(), d.doc.resolution_dpi)),
        other => Err(EngineError::Other(format!("layer {} is {} {} layer, not a type layer", id.0, other.article(), other.kind_name()))),
    }
}

/// A text layer's fit style: the first character run's face, tracking and size, plus the
/// first paragraph's auto leading (the `lineHeight` default). `char_runs` normalizes an empty
/// style list from the layer's summary fields, so this works for every layer the engine
/// saved.
fn text_layer_style(t: &TextLayer) -> (FontRef, f64, f64, f64) {
    let style = match t.char_runs().first() {
        Some(r) => r.style.clone(),
        None => CharStyle::default(),
    };
    let auto_leading = match t.paragraph_runs().first() {
        Some(r) => f64::from(r.style.auto_leading),
        None => 1.2,
    };
    (FontRef::from_style(&style), f64::from(style.tracking), f64::from(style.size_pt), auto_leading)
}

/// A `[x, y, w, h]` box param, document pixels: finite, ≥ 1 px wide and tall (`type.edit`'s
/// `box` clamps below 1, so the fit is measured at exactly what will be written) and
/// ≤ [`MAX_BOX_PX`]. `None` when absent and not required.
fn parse_box(cmd: &str, p: &Value, required: bool) -> Result<Option<[f64; 4]>> {
    const KEY: &str = "bounds";
    match p.get(KEY) {
        None | Some(Value::Null) if !required => Ok(None),
        None | Some(Value::Null) => Err(bad(cmd, format!("`{KEY}` `[x, y, w, h]` is required"))),
        Some(Value::Array(a)) if a.len() == 4 => {
            let mut v = [0.0f64; 4];
            for (slot, x) in v.iter_mut().zip(a.iter()) {
                let n = x.as_f64().ok_or_else(|| bad(cmd, format!("`{KEY}` must contain four numbers")))?;
                if !n.is_finite() {
                    return Err(bad(cmd, format!("`{KEY}` entries must be finite numbers")));
                }
                *slot = n;
            }
            if v[0].abs() > 1e9 || v[1].abs() > 1e9 {
                return Err(bad(cmd, "`bounds` x/y are outside the coordinate range"));
            }
            if !(1.0..=MAX_BOX_PX).contains(&v[2]) || !(1.0..=MAX_BOX_PX).contains(&v[3]) {
                return Err(bad(cmd, format!("`bounds` width and height must be between 1 and {MAX_BOX_PX} px")));
            }
            Ok(Some(v))
        }
        Some(_) => Err(bad(cmd, format!("`{KEY}` must be `[x, y, w, h]`"))),
    }
}

/// A finite number param, `None` when absent. NaN/inf cannot arrive through JSON, but engine
/// callers may hand us constructed values: refuse rather than silently default.
fn opt_number(cmd: &str, p: &Value, key: &str) -> Result<Option<f64>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_f64() {
            Some(n) if n.is_finite() => Ok(Some(n)),
            _ => Err(bad(cmd, format!("`{key}` must be a finite number"))),
        },
    }
}

/// `maxLines` default (§9.4 leaves the cap to the slot): how many `minSize` lines the box
/// height holds — the largest line count the smallest allowed size could need, capped sanely.
fn default_max_lines(h: f64, line_height: f64, min_size: f64, px_per_pt: f64) -> usize {
    let line_px = (line_height * min_size * px_per_pt).max(0.01);
    (h / line_px).floor().clamp(1.0, 1000.0) as usize
}

// ---------- layout.fitText ----------

fn fit_text_cmd(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "layout.fitText";
    crate::commands::check_f32_values(CMD, p)?;
    let (id, t, dpi) = text_layer_of(s, p)?;
    {
        // Fail fast with Photoshop's lock message before the expensive fit (type_cmds #3132).
        let d = s.active().ok_or(EngineError::NoDocument)?;
        crate::type_cmds::check_text_unlocked(&d.doc, id)?;
    }
    let (font, tracking, current_size, auto_leading) = text_layer_style(&t);
    let text = crate::type_cmds::norm_text(&t.text);
    let bounds = match parse_box(CMD, p, true)? {
        Some(b) => b,
        None => return Err(bad(CMD, "`bounds` `[x, y, w, h]` is required")),
    };
    let min_size = match opt_number(CMD, p, "minSize")? {
        Some(v) => v,
        None => 12.0, // §11.1's body floor: never shrink body copy below 12 pt by default
    };
    let max_size = match opt_number(CMD, p, "maxSize")? {
        Some(v) => v,
        None => current_size, // §9.3 step 1's "requested size" is the layer's current one
    };
    let line_height = match opt_number(CMD, p, "lineHeight")? {
        Some(v) => v,
        None => auto_leading, // the paragraph's auto leading (Photoshop default 1.2)
    };
    let px_per_pt = f64::from(dpi) / 72.0;
    let max_lines = match p.get("maxLines") {
        None => default_max_lines(bounds[3], line_height, min_size, px_per_pt),
        Some(_) => match crate::commands::int(p, "maxLines") {
            Some(n) if (1..=1_000_000).contains(&n) => n as usize,
            _ => return Err(bad(CMD, "`maxLines` must be a whole number between 1 and 1000000")),
        },
    };
    let req = FitRequest { text: &text, font: &font, bounds, min_size, max_size, line_height, max_lines, tracking, px_per_pt };
    let measurer = EngineTextMeasurer::new(dpi, line_height, tracking);
    let outcome = fit_text(&measurer, &req)?;

    // §9.4 result contract + the §9.3 step-5 write-back data.
    let mut out = json!({
        "layer": id.0,
        "size": outcome.size,
        "lines": outcome.lines,
        "overflow": outcome.overflow,
        "bounds": outcome.bounds,
    });
    if !outcome.warnings.is_empty() {
        out["warnings"] = json!(outcome.warnings.iter().map(|w| json!({ "code": w.code, "message": w.message })).collect::<Vec<_>>());
    }
    match &outcome.report {
        Some(report) => {
            // §9.3 step 4: report only — nothing is written, the text is never clipped
            // silently. `overflowPx`/`overflowChars` feed §11.1's `text_overflow` blocker.
            out["overflowPx"] = json!(report.overflow_px);
            out["overflowChars"] = json!(report.overflow_chars);
        }
        None => {
            // §9.3 step 5: apply the fit with one type.edit — the exact call:
            //   type.edit {"layer": id, "box": [x, y, w, h], "text": <prefix>…?,
            //              "runs": [{"start": 0, "end": <chars>, "size": size, "tracking": t?}]}
            // (`type.edit` replaces `text` before applying `runs`, so the run covers the
            // new text's characters; it re-renders the layer and takes one history step.)
            let final_text = match &outcome.text {
                Some(new_text) => new_text.clone(),
                None => text.clone(),
            };
            let chars = final_text.chars().count();
            let mut run = json!({ "start": 0, "end": chars, "size": outcome.size });
            if let Some(tracking) = outcome.tracking {
                run["tracking"] = json!(tracking);
            }
            let mut edit = json!({ "layer": id.0, "box": [bounds[0], bounds[1], bounds[2], bounds[3]] });
            if let Some(new_text) = &outcome.text {
                edit["text"] = json!(new_text);
            }
            edit["runs"] = json!([run]);
            s.execute("type.edit", edit.clone())?;
            out["applied"] = json!({ "command": "type.edit", "params": edit });
        }
    }
    Ok(out)
}

// ---------- layout.measure ----------

fn measure_cmd(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "layout.measure";
    crate::commands::check_f32_values(CMD, p)?;
    let st = s.active().ok_or(EngineError::NoDocument)?;
    let dpi = st.doc.resolution_dpi;
    let px_per_pt = f64::from(dpi) / 72.0;

    // The style source: a named layer (which must be a type layer), else the active layer
    // when it is one — ad-hoc `text` may carry no layer at all.
    let named = crate::commands::explicit_layer(s, p)?;
    let doc = &st.doc;
    let active_text = st.active_layer.filter(|id| doc.layer(*id).is_some_and(|l| matches!(l.content, LayerContent::Text(_))));
    let source: Option<(LayerId, TextLayer)> = match named.or(active_text) {
        Some(id) => {
            let l = doc.layer(id).ok_or(EngineError::NoLayer(id))?;
            match &l.content {
                LayerContent::Text(t) => Some((id, t.clone())),
                other => return Err(EngineError::Other(format!("layer {} is {} {} layer, not a type layer", id.0, other.article(), other.kind_name()))),
            }
        }
        None => None,
    };
    let (layer_font, layer_tracking, layer_size, layer_auto) = match &source {
        Some((_, t)) => {
            let (f, tracking, size, auto) = text_layer_style(t);
            (Some(f), tracking, Some(size), auto)
        }
        None => (None, 0.0, None, 1.2),
    };

    // Text: the `text` param, else the layer's text, else there is nothing to measure.
    let text = match p.get("text").and_then(Value::as_str).map(crate::type_cmds::norm_text) {
        Some(t) => t,
        None => match source.as_ref().map(|(_, t)| t.text.clone()) {
            Some(t) => crate::type_cmds::norm_text(&t),
            None => return Err(bad(CMD, "measure needs text: pass `text` or name a type `layer`")),
        },
    };
    let size = match opt_number(CMD, p, "size")? {
        Some(v) => v,
        None => match layer_size {
            Some(v) => v,
            None => return Err(bad(CMD, "`size` is required when measuring text without a type layer")),
        },
    };
    if !size.is_finite() || !(TYPE_SIZE_MIN_PT..=TYPE_SIZE_MAX_PT).contains(&size) {
        return Err(bad(CMD, format!("`size` must be a finite number of points between {TYPE_SIZE_MIN_PT} and {TYPE_SIZE_MAX_PT}")));
    }
    let mut font = match layer_font {
        Some(f) => f,
        None => FontRef { family: photocraft_text::fonts::DEFAULT_FAMILY.to_string(), ..FontRef::default() },
    };
    if let Some(family) = p.get("font").and_then(Value::as_str) {
        // A renamed family no longer names that face (#3556's rule in reverse).
        font.family = family.to_string();
        font.postscript_name = None;
    }
    let tracking = if layer_tracking.is_finite() { layer_tracking } else { 0.0 };
    let line_height = match opt_number(CMD, p, "lineHeight")? {
        Some(v) => v,
        None => layer_auto, // the layer's auto leading (Photoshop default 1.2), or the default
    };
    if !line_height.is_finite() || !(0.01..=1000.0).contains(&line_height) {
        return Err(bad(CMD, "`lineHeight` must be a finite multiplier between 0.01 and 1000"));
    }

    // Wrap width: the `bounds` box's width, else the layer's paragraph box, else the canvas
    // (a point-text layer has no wrap of its own; the canvas bounds the measurement).
    let max_width = match parse_box(CMD, p, false)? {
        Some(b) => b[2],
        None => match source.as_ref().map(|(_, t)| &t.shape) {
            Some(TextShape::Box { width, .. }) => f64::from(*width),
            _ => f64::from(st.doc.size.width),
        },
    };
    if !max_width.is_finite() || !(1.0..=MAX_BOX_PX).contains(&max_width) {
        return Err(bad(CMD, format!("the measure width must be between 1 and {MAX_BOX_PX} px (check `bounds` or the layer box)")));
    }

    let measurer = EngineTextMeasurer::new(dpi, line_height, tracking);
    let mx = measurer.measure(&text, &font, size, max_width);
    let height = mx.lines as f64 * mx.line_height;
    let mut out = json!({
        "layer": source.as_ref().map(|(id, _)| id.0),
        "text": text,
        "size": size,
        "pxPerPt": px_per_pt,
        "maxWidth": max_width,
        "width": mx.width,
        "lines": mx.lines,
        "lineHeight": mx.line_height,
        "height": height,
        "bounds": [0.0, 0.0, mx.width, height],
    });
    if let Some((_, t)) = &source {
        let warnings = crate::type_extra_cmds::missing_font_warnings_for_layer(t);
        if !warnings.is_empty() {
            out["warnings"] = json!(warnings);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A command result as a value, failing the test with the engine's own message.
    fn ok_value(result: Result<Value>, what: &str) -> Value {
        match result {
            Ok(v) => v,
            Err(e) => {
                assert!(false, "{what}: {e}");
                Value::Null
            }
        }
    }

    fn session() -> Session {
        let mut s = Session::new();
        ok_value(s.execute("file.new", json!({"width": 400, "height": 300, "background": "transparent"})), "file.new");
        s
    }

    fn type_layer(s: &mut Session, text: &str, size: f64) -> u64 {
        let v = ok_value(s.execute("type.create", json!({"text": text, "size": size, "x": 0.0, "y": size * 2.0})), "type.create");
        match v.get("layer").and_then(Value::as_u64) {
            Some(id) => id,
            None => {
                assert!(false, "type.create returned no layer id");
                0
            }
        }
    }

    fn revision(s: &Session) -> u64 {
        match s.active() {
            Some(d) => d.revision,
            None => {
                assert!(false, "no document");
                0
            }
        }
    }

    #[test]
    fn fit_text_writes_the_fit_back_with_one_type_edit() {
        let mut s = session();
        let id = type_layer(&mut s, "Hello", 24.0);
        let r = ok_value(
            s.execute("layout.fitText", json!({
                "layer": id, "bounds": [0.0, 0.0, 400.0, 200.0],
                "minSize": 12.0, "maxSize": 48.0, "lineHeight": 1.2, "maxLines": 3
            })),
            "layout.fitText",
        );
        // "Hello" at 48 pt sits well inside a 400×200 box: fitted at the requested size.
        assert_eq!(r["size"].as_f64(), Some(48.0), "{r}");
        assert_eq!(r["lines"].as_u64(), Some(1));
        assert_eq!(r["overflow"].as_bool(), Some(false));
        assert!(r["warnings"].is_null(), "{r}");
        // §9.3 step 5: the exact type.edit call is applied and echoed.
        assert_eq!(r["applied"]["command"].as_str(), Some("type.edit"), "{r}");
        assert_eq!(r["applied"]["params"]["layer"].as_u64(), Some(id));
        assert_eq!(r["applied"]["params"]["box"][2].as_f64(), Some(400.0));
        assert_eq!(r["applied"]["params"]["runs"][0]["size"].as_f64(), Some(48.0));
        // The layer really has the fitted size now…
        let info = ok_value(s.execute("type.info", json!({ "layer": id })), "type.info");
        assert_eq!(info["runs"][0]["style"]["size_pt"].as_f64(), Some(48.0), "{info}");
        // …and undo reverts it (one history step, the write-back's).
        assert!(s.undo());
        let info = ok_value(s.execute("type.info", json!({ "layer": id })), "type.info");
        assert_eq!(info["runs"][0]["style"]["size_pt"].as_f64(), Some(24.0), "{info}");
    }

    #[test]
    fn fit_text_reports_overflow_and_never_clips() {
        let mut s = session();
        let text = "The quick brown fox jumps over the lazy dog";
        let id = type_layer(&mut s, text, 24.0);
        let r = ok_value(
            s.execute("layout.fitText", json!({
                "layer": id, "bounds": [0.0, 0.0, 50.0, 30.0],
                "minSize": 12.0, "maxSize": 96.0, "lineHeight": 1.2, "maxLines": 2
            })),
            "layout.fitText",
        );
        // 43 characters cannot fit a 50×30 px slot at 12 pt: §9.3 step 4's report.
        assert_eq!(r["overflow"].as_bool(), Some(true), "{r}");
        assert_eq!(r["size"].as_f64(), Some(12.0));
        assert!(r["overflowPx"].as_f64().is_some_and(|v| v > 0.0), "{r}");
        assert!(r["overflowChars"].as_u64().is_some_and(|v| v > 0), "{r}");
        assert!(r["applied"].is_null(), "an overflow report writes nothing: {r}");
        assert!(r["warnings"].as_array().is_some_and(|w| w.iter().any(|x| x["code"] == "text_overflow")), "{r}");
        // The layer was not touched: no silent clipping, no silent edits.
        let info = ok_value(s.execute("type.info", json!({ "layer": id })), "type.info");
        assert_eq!(info["text"].as_str(), Some(text), "{info}");
        assert_eq!(info["runs"][0]["style"]["size_pt"].as_f64(), Some(24.0), "{info}");
    }

    #[test]
    fn fit_text_ellipsizes_a_single_line_slot_with_a_warning() {
        let mut s = session();
        let text = "The quick brown fox jumps over the lazy dog";
        let id = type_layer(&mut s, text, 12.0);
        let r = ok_value(
            s.execute("layout.fitText", json!({
                "layer": id, "bounds": [0.0, 0.0, 60.0, 20.0],
                "minSize": 12.0, "maxSize": 12.0, "lineHeight": 1.2, "maxLines": 1
            })),
            "layout.fitText",
        );
        // Single-line slot, fixed size: condensing cannot rescue a 250+ px line in 60 px, so
        // the text is cut to the largest fitting prefix + "…", with a warning (§9.3 step 3).
        assert_eq!(r["overflow"].as_bool(), Some(false), "{r}");
        assert_eq!(r["lines"].as_u64(), Some(1));
        assert!(r["warnings"].as_array().is_some_and(|w| w.iter().any(|x| x["code"] == "text_ellipsized")), "{r}");
        assert_eq!(r["applied"]["command"].as_str(), Some("type.edit"), "{r}");
        assert_eq!(r["applied"]["params"]["layer"].as_u64(), Some(id));
        // The write-back carried the shortened text (the run covers its characters).
        let info = ok_value(s.execute("type.info", json!({ "layer": id })), "type.info");
        let stored = info["text"].as_str();
        assert!(stored.is_some_and(|t| t.ends_with('…') && t.chars().count() < text.chars().count()), "{stored:?}");
        let chars = stored.map_or(0, |t| t.chars().count());
        assert_eq!(r["applied"]["params"]["runs"][0]["end"].as_u64(), Some(chars as u64));
    }

    #[test]
    fn fit_text_on_empty_text_sets_the_style_for_next_typing() {
        let mut s = session();
        let id = type_layer(&mut s, "", 24.0);
        let r = ok_value(
            s.execute("layout.fitText", json!({
                "layer": id, "bounds": [0.0, 0.0, 200.0, 100.0],
                "minSize": 12.0, "maxSize": 30.0, "lineHeight": 1.2, "maxLines": 2
            })),
            "layout.fitText",
        );
        assert_eq!(r["size"].as_f64(), Some(30.0), "{r}");
        assert_eq!(r["lines"].as_u64(), Some(0));
        assert_eq!(r["overflow"].as_bool(), Some(false));
        // type.edit's empty-text branch keeps the size for the next typed characters.
        let info = ok_value(s.execute("type.info", json!({ "layer": id })), "type.info");
        assert_eq!(info["runs"][0]["style"]["size_pt"].as_f64(), Some(30.0), "{info}");
    }

    #[test]
    fn fit_text_rejects_hostile_params() {
        let mut s = session();
        let id = type_layer(&mut s, "Hello", 24.0);
        let raster = ok_value(s.execute("layer.new.layer", json!({ "name": "Pixels" })), "layer.new.layer");
        let raster_id = raster.get("layer").and_then(Value::as_u64);
        let cases = [
            (json!({ "layer": id }), "no bounds"),
            (json!({ "layer": id, "bounds": [0.0, 0.0, 0.0, 100.0] }), "zero width"),
            (json!({ "layer": id, "bounds": [0.0, 0.0, 100.0, 0.0] }), "zero height"),
            (json!({ "layer": id, "bounds": [0.0, 0.0, -100.0, 100.0] }), "negative width"),
            (json!({ "layer": id, "bounds": [0.0, 0.0, 100.0, 1e30] }), "f32-overflowing height"),
            (json!({ "layer": id, "bounds": [0.0, 0.0, 100.0, 100.0], "minSize": 40.0, "maxSize": 20.0 }), "minSize > maxSize"),
            (json!({ "layer": id, "bounds": [0.0, 0.0, 100.0, 100.0], "minSize": 0.0 }), "minSize below the type range"),
            (json!({ "layer": id, "bounds": [0.0, 0.0, 100.0, 100.0], "maxSize": 5000.0 }), "maxSize above the type range"),
            (json!({ "layer": id, "bounds": [0.0, 0.0, 100.0, 100.0], "maxLines": 0 }), "maxLines 0"),
            (json!({ "layer": id, "bounds": [0.0, 0.0, 100.0, 100.0], "maxLines": -2 }), "negative maxLines"),
            (json!({ "layer": id, "bounds": [0.0, 0.0, 100.0, 100.0], "maxLines": "many" }), "non-numeric maxLines"),
            (json!({ "layer": id, "bounds": [0.0, 0.0, 100.0, 100.0], "lineHeight": 0.0 }), "zero lineHeight"),
            (json!({ "layer": id, "bounds": [0.0, 0.0, "wide", 100.0] }), "non-numeric bounds entry"),
            (json!({ "layer": 999_999, "bounds": [0.0, 0.0, 100.0, 100.0] }), "no such layer"),
        ];
        for (params, what) in cases {
            assert!(s.execute("layout.fitText", params).is_err(), "{what}: {params}");
        }
        // A named raster layer is a type-layer error, not a silent fit.
        if let Some(raster_id) = raster_id {
            assert!(s.execute("layout.fitText", json!({ "layer": raster_id, "bounds": [0.0, 0.0, 100.0, 100.0] })).is_err());
        }
        // The numeric rejections are bad-params (hostile numbers, §9.5), named distinctly.
        assert!(matches!(
            s.execute("layout.fitText", json!({ "layer": id, "bounds": [0.0, 0.0, 100.0, 100.0], "minSize": 40.0, "maxSize": 20.0 })),
            Err(EngineError::BadParams { cmd, .. }) if cmd == "layout.fitText"
        ));
        // No document: the command is disabled, not panicking.
        let mut bare = Session::new();
        assert!(bare.execute("layout.fitText", json!({ "bounds": [0.0, 0.0, 10.0, 10.0] })).is_err());
    }

    #[test]
    fn fit_text_is_deterministic_across_identical_documents() {
        // §9.5: same input + same document revision ⇒ identical output.
        let mut a = session();
        let mut b = session();
        let id_a = type_layer(&mut a, "Fit me please", 32.0);
        let id_b = type_layer(&mut b, "Fit me please", 32.0);
        let fit = |id: u64| json!({ "layer": id, "bounds": [0.0, 0.0, 100.0, 40.0], "minSize": 8.0, "maxSize": 32.0, "lineHeight": 1.2, "maxLines": 1 });
        let ra = ok_value(a.execute("layout.fitText", fit(id_a)), "fit a");
        let rb = ok_value(b.execute("layout.fitText", fit(id_b)), "fit b");
        assert_eq!(ra["size"], rb["size"], "{ra} vs {rb}");
        assert_eq!(ra["lines"], rb["lines"]);
        assert_eq!(ra["overflow"], rb["overflow"]);
        // Identical documents may pick different layer ids; the fit itself is identical.
        assert_eq!(ra["applied"]["params"]["runs"], rb["applied"]["params"]["runs"], "{ra} vs {rb}");
        assert_eq!(ra["applied"]["params"]["box"], rb["applied"]["params"]["box"]);
        assert_eq!(ra["applied"]["params"].get("text"), rb["applied"]["params"].get("text"));
    }

    #[test]
    fn measure_reports_metrics_without_mutating() {
        let mut s = session();
        let id = type_layer(&mut s, "Hello", 24.0);
        let before = revision(&s);
        let r = ok_value(s.execute("layout.measure", json!({ "layer": id })), "layout.measure");
        assert_eq!(r["layer"].as_u64(), Some(id), "{r}");
        assert_eq!(r["text"].as_str(), Some("Hello"));
        assert_eq!(r["size"].as_f64(), Some(24.0));
        assert_eq!(r["pxPerPt"].as_f64(), Some(1.0)); // file.new defaults to 72 dpi
        assert!(r["width"].as_f64().is_some_and(|v| v > 0.0), "{r}");
        assert_eq!(r["lines"].as_u64(), Some(1), "{r}");
        assert!(r["height"].as_f64().is_some_and(|v| v > 0.0));
        // Point text has no box of its own: the canvas width is the wrap width.
        assert_eq!(r["maxWidth"].as_f64(), Some(400.0), "{r}");
        // Pure query (§9.4): the revision did not move.
        assert_eq!(before, revision(&s), "layout.measure must not mutate");
    }

    #[test]
    fn measure_ad_hoc_text_in_the_style_of_a_slot() {
        let mut s = session();
        let id = type_layer(&mut s, "Short", 18.0);
        let r = ok_value(
            s.execute("layout.measure", json!({
                "layer": id, "text": "A considerably longer headline for planning",
                "bounds": [0.0, 0.0, 120.0, 40.0]
            })),
            "layout.measure",
        );
        // The slot's style (18 pt), the caller's text, the box's wrap width.
        assert_eq!(r["text"].as_str(), Some("A considerably longer headline for planning"));
        assert_eq!(r["size"].as_f64(), Some(18.0), "{r}");
        assert_eq!(r["maxWidth"].as_f64(), Some(120.0));
        assert!(r["lines"].as_u64().is_some_and(|l| l >= 2), "wraps in 120 px: {r}");
        assert!(r["height"].as_f64().is_some_and(|v| v > 0.0));
    }

    #[test]
    fn measure_without_a_layer_needs_a_size() {
        let mut s = session();
        // No type layer anywhere: ad-hoc text without a size has nothing to measure at.
        assert!(s.execute("layout.measure", json!({ "text": "Hello" })).is_err());
        let r = ok_value(s.execute("layout.measure", json!({ "text": "Hello", "size": 24.0 })), "layout.measure");
        assert!(r["layer"].is_null(), "{r}");
        assert_eq!(r["size"].as_f64(), Some(24.0));
        assert!(r["width"].as_f64().is_some_and(|w| w > 0.0), "{r}");
        // Neither text nor a layer: refused with a fix hint.
        assert!(s.execute("layout.measure", json!({})).is_err());
        // A raster active layer is not an implicit style source for ad-hoc text.
        ok_value(s.execute("layer.new.layer", json!({})), "layer.new.layer");
        assert!(s.execute("layout.measure", json!({})).is_err());
        let r = ok_value(s.execute("layout.measure", json!({ "text": "Hi", "size": 12.0 })), "layout.measure");
        assert_eq!(r["lines"].as_u64(), Some(1), "{r}");
    }

    #[test]
    fn measure_rejects_hostile_params() {
        let mut s = session();
        let id = type_layer(&mut s, "Hello", 24.0);
        let cases = [
            json!({ "layer": id, "size": 0.0 }),
            json!({ "layer": id, "size": 5000.0 }),
            json!({ "layer": id, "lineHeight": 0.0 }),
            json!({ "layer": id, "text": "" }),  // empty text measures as 0 lines — allowed, not hostile
            json!({ "layer": id, "bounds": [0.0, 0.0, 0.0, 40.0] }),
            json!({ "layer": id, "bounds": "big" }),
            json!({ "layer": 999_999 }),
        ];
        let expect_ok = [
            false, // size 0 below the type range
            false, // size 5000 above the type range
            false, // lineHeight 0
            true,  // empty text is a valid measurement (0 lines)
            false, // zero-width box
            false, // bounds not an array
            false, // no such layer
        ];
        for (params, ok) in cases.iter().zip(expect_ok.iter()) {
            let result = s.execute("layout.measure", params.clone());
            assert_eq!(result.is_ok(), *ok, "{}: {params} -> {result:?}", "measure");
        }
    }

    #[test]
    fn registry_entries_are_query_and_mutator() {
        let fit = crate::commands::find("layout.fitText");
        let measure = crate::commands::find("layout.measure");
        assert!(fit.is_some_and(|c| c.journal), "layout.fitText mutates (its type.edit write-back)");
        assert!(measure.is_some_and(|c| !c.journal), "layout.measure is a pure query");
        assert!(fit.is_some_and(|c| c.menu.is_empty()));
        // Without a document neither runs (enabled = has_doc).
        let s = Session::new();
        assert!(fit.is_some_and(|c| (c.enabled)(&s).is_err()));
        assert!(measure.is_some_and(|c| (c.enabled)(&s).is_err()));
    }
}
