//! `layout.apply`'s engine-side text metrics (§9.2 `hug`): the one `TextMeasurer` impl the
//! solver's measure seam was missing. `layout_apply` defines the trait and its
//! `EngineTextMeasurer`, and its module docs leave the `impl` to the measure side; this
//! module is that bridge, so the coercion in `layout_apply::apply`
//! (`&EngineTextMeasurer` → `&dyn TextMeasurer`) resolves.
//!
//! The bridge: `layout_apply::EngineTextMeasurer` carries the document; the trait asks for
//! a layer's `(width, height)` wrapped to a max width. This module extracts the layer's own
//! style context — the first character run's face, tracking and size (`TextLayer::char_runs`,
//! the same "the layer's size" `type.info` and the layer summary report), the first
//! paragraph's auto leading, the document resolution — and measures through
//! `fit_text::EngineTextMeasurer`, the family's production measurer, which owns the one
//! text-stack call (`photocraft_text::shared().lock().layout(..)` — the `type.info` idiom,
//! `type_cmds.rs`'s `info`; see `fit_text`'s module docs). One model, one text-engine home:
//! a layer hugged by `layout.apply` measures exactly what `layout.fitText`/`layout.measure`
//! report for it.
//!
//! Contract (`layout_apply::TextMeasurer`): `Err` when there is nothing measurable — the
//! layer is missing, is not a type layer, or has no text. The doc's "no font" case is
//! measured, not refused: the engine resolves an empty or unknown family to its default
//! face (`CharStyle::font_family`: "empty = the default family"; missing fonts are §9.4
//! warnings, not measurement blockers), so such a layer measures as it renders.
//!
//! Units (the `type_cmds` seam): sizes are points, boxes and metrics are document pixels
//! (`px_per_pt = dpi / 72`).
//!
//! Golden rules: no panics on hostile input — none reachable. Every float is guarded before
//! the engine call: `max_width` must be finite and within `1..=MAX_BOX_PX` px (the same
//! bound `layout.measure` enforces, so the probe the text engine is handed is never
//! garbage), the layer's type size must be finite within the engine's type range, and
//! non-finite tracking falls back to 0 the way `layout.measure` does. The measurer clamps
//! dpi/leading and sanitizes its metrics, so the returned pair is finite by construction —
//! never a NaN in a placement.
//!
//! Approximations, bounded and shared with the fit family: the layer is re-modelled as one
//! run in its first run's face and size with the first paragraph's auto leading (an explicit
//! `leading_pt` is approximated by the auto leading — the same model `fit_specs`'s
//! `text_layer_style` measures `layout.fitText`/`layout.measure` with), as horizontal
//! paragraph text (the fit's probe model). For §9.2's hug targets — single-style labels —
//! exact; multi-run layers measure at their dominant (first) size, like the Type panel
//! reports.

use photocraft_doc::text::CharStyle;
use photocraft_doc::{LayerContent, LayerId};

use super::fit_text::{EngineTextMeasurer, FontRef, TextMeasurer as _, MAX_BOX_PX};
use crate::type_cmds::{TYPE_SIZE_MAX_PT, TYPE_SIZE_MIN_PT};
use crate::{EngineError, Result};

/// The command this seam serves: the solver wraps every measurement error as `layout.apply`'s
/// `BadParams` (§9.5 — a hugging `text` node that cannot measure tells the caller to size
/// the node explicitly instead).
const CMD: &str = "layout.apply";

fn bad(msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: CMD.into(), msg: msg.into() }
}

impl super::layout_apply::TextMeasurer for super::layout_apply::EngineTextMeasurer<'_> {
    /// The `(width, height)` the layer's text occupies at its current size wrapped to
    /// `max_width` px (§9.2 hug): the family's production measurer at the document's
    /// resolution — the same measurement `layout.measure` reports. `Err` exactly where the
    /// trait contract says nothing is measurable; hostile floats are typed errors before
    /// any engine call.
    fn measure_text(&self, layer: LayerId, max_width: f64) -> Result<(f64, f64)> {
        // What the layer is, and whether it has text at all: the trait's "nothing
        // measurable" rows (the solver turns these into "size the node explicitly").
        let Some(l) = self.doc.layer(layer) else {
            return Err(EngineError::NoLayer(layer));
        };
        let LayerContent::Text(t) = &l.content else {
            return Err(EngineError::Other(format!(
                "layer {} is {} {} layer, not a type layer; only text can hug",
                layer.0,
                l.content.article(),
                l.content.kind_name()
            )));
        };
        let text = crate::type_cmds::norm_text(&t.text);
        if text.is_empty() {
            return Err(EngineError::Other(format!("layer {} has no text to measure", layer.0)));
        }
        // The style context the fit family measures with (fit_specs' text_layer_style
        // model): first character run's face/tracking/size, first paragraph's auto leading —
        // `char_runs`/`paragraph_runs` normalize whatever the document holds.
        let style = match t.char_runs().first() {
            Some(r) => r.style.clone(),
            None => CharStyle::default(),
        };
        let auto_leading = match t.paragraph_runs().first() {
            Some(r) => f64::from(r.style.auto_leading),
            None => 1.2,
        };
        // Hostile floats never reach the engine. The size comes from the document, not the
        // command params, so a degenerate style is a measurement error, not a probe.
        let size = f64::from(style.size_pt);
        if !size.is_finite() || !(TYPE_SIZE_MIN_PT..=TYPE_SIZE_MAX_PT).contains(&size) {
            return Err(EngineError::Other(format!(
                "layer {}'s type size is outside the engine's type range ({}–{} pt)",
                layer.0, TYPE_SIZE_MIN_PT, TYPE_SIZE_MAX_PT
            )));
        }
        if !max_width.is_finite() || !(1.0..=MAX_BOX_PX).contains(&max_width) {
            return Err(bad(format!(
                "the wrap width must be a finite number of pixels between 1 and {MAX_BOX_PX}"
            )));
        }
        let tracking = f64::from(style.tracking);
        let tracking = if tracking.is_finite() { tracking } else { 0.0 };
        // The measurement: wrapped to `max_width` at the document's resolution. With the
        // guards above the measurer never answers its hostile ceiling for a real layer —
        // real metrics or an error, nothing in between.
        let measurer = EngineTextMeasurer::new(self.doc.resolution_dpi, auto_leading, tracking);
        let mx = measurer.measure(&text, &FontRef::from_style(&style), size, max_width);
        Ok((mx.width, mx.lines as f64 * mx.line_height))
    }
}

#[cfg(test)]
mod tests {
    //! The fit_specs fixture pattern: real sessions through commands, the bundled Inter
    //! measuring real metrics (fonts are embedded, so CI needs none installed).

    use crate::layout_cmds::layout_apply::{EngineTextMeasurer, TextMeasurer};
    use crate::{EngineError, Session};
    use photocraft_doc::LayerId;
    use serde_json::{json, Value};

    /// A command result as a value, failing the test with the engine's own message.
    fn ok_value(result: crate::Result<Value>, what: &str) -> Value {
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
        ok_value(
            s.execute(
                "file.new",
                json!({"width": 400, "height": 300, "background": "transparent"}),
            ),
            "file.new",
        );
        s
    }

    fn type_layer(s: &mut Session, text: &str, size: f64) -> LayerId {
        let v = ok_value(
            s.execute(
                "type.create",
                json!({"text": text, "size": size, "x": 0.0, "y": size * 2.0}),
            ),
            "type.create",
        );
        match v.get("layer").and_then(Value::as_u64) {
            Some(id) => LayerId(id),
            None => {
                assert!(false, "type.create returned no layer id");
                LayerId(0)
            }
        }
    }

    /// The measurer under test, over the session's document.
    fn measurer(s: &Session) -> EngineTextMeasurer<'_> {
        EngineTextMeasurer { doc: &s.active().expect("the fixtures open a document").doc }
    }

    fn measure(s: &Session, id: LayerId, max_width: f64) -> crate::Result<(f64, f64)> {
        measurer(s).measure_text(id, max_width)
    }

    #[test]
    fn measures_a_type_layer_wrapped_to_the_requested_width() {
        let mut s = session();
        let id = type_layer(&mut s, "measure me twice", 24.0);
        // Wide: one line, wider than tall, inside the wrap width.
        let (w, h) = match measure(&s, id, 800.0) {
            Ok(v) => v,
            Err(e) => {
                assert!(false, "measuring at 800 px: {e}");
                (0.0, 0.0)
            }
        };
        assert!(w.is_finite() && w > 0.0 && w <= 800.0, "width {w}");
        assert!(h.is_finite() && h > 0.0, "height {h}");
        // Narrow: the same text wraps — narrower across, taller down.
        let (w2, h2) = match measure(&s, id, 40.0) {
            Ok(v) => v,
            Err(e) => {
                assert!(false, "measuring at 40 px: {e}");
                (0.0, 0.0)
            }
        };
        assert!(w2 < w, "wrapped width {w2} must be under the one-line {w}");
        assert!(w2 <= 40.5, "a wrapped line stays at its box (± ink): {w2}");
        assert!(h2 > h, "wrapped height {h2} must exceed the one-line {h}");
        // Same revision ⇒ the same answer, exactly (§9.5).
        match measure(&s, id, 40.0) {
            Ok(v) => assert_eq!(v, (w2, h2), "identical measurement for an unchanged layer"),
            Err(e) => assert!(false, "{e}"),
        }
    }

    #[test]
    fn errs_exactly_where_the_trait_contract_says() {
        let mut s = session();
        // A painted raster layer: text nodes only measure type layers.
        ok_value(s.execute("layer.new.layer", json!({})), "layer.new.layer");
        ok_value(
            s.execute("select.rect", json!({"x": 2, "y": 2, "width": 10, "height": 10})),
            "select.rect",
        );
        ok_value(s.execute("edit.fill", json!({"color": "#3366aa"})), "edit.fill");
        let raster = match s.active().and_then(|d| d.active_layer) {
            Some(id) => id,
            None => {
                assert!(false, "no active layer after edit.fill");
                LayerId(0)
            }
        };
        let empty = type_layer(&mut s, "", 24.0);
        // The three "nothing measurable" rows: missing, not a type layer, no text.
        match measure(&s, LayerId(99_999), 100.0) {
            Err(EngineError::NoLayer(id)) => assert_eq!(id, LayerId(99_999)),
            other => assert!(false, "expected NoLayer, got {other:?}"),
        }
        match measure(&s, raster, 100.0) {
            Err(EngineError::Other(msg)) => assert!(msg.contains("not a type layer"), "{msg}"),
            other => assert!(false, "a raster layer must refuse, got {other:?}"),
        }
        match measure(&s, empty, 100.0) {
            Err(EngineError::Other(msg)) => assert!(msg.contains("no text"), "{msg}"),
            other => assert!(false, "an empty text layer must refuse, got {other:?}"),
        }
    }

    #[test]
    fn hostile_wrap_widths_are_typed_errors_not_engine_probes() {
        let mut s = session();
        let id = type_layer(&mut s, "Hello", 24.0);
        for w in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -1.0, 1e7] {
            match measure(&s, id, w) {
                Err(EngineError::BadParams { msg, .. }) => {
                    assert!(msg.contains("wrap width"), "width {w}: {msg}")
                }
                other => assert!(false, "width {w} must be refused, got {other:?}"),
            }
        }
        // The lower bound itself measures (the same range `layout.measure` enforces).
        match measure(&s, id, 1.0) {
            Ok((w, h)) => assert!(w.is_finite() && h.is_finite(), "{w} × {h}"),
            Err(e) => assert!(false, "a 1 px wrap is measurable: {e}"),
        }
    }

    #[test]
    fn measurement_follows_the_layer_and_is_stable_within_a_revision() {
        let mut s = session();
        let id = type_layer(&mut s, "Hi", 24.0);
        let (w1, h1) = match measure(&s, id, 800.0) {
            Ok(v) => v,
            Err(e) => {
                assert!(false, "{e}");
                (0.0, 0.0)
            }
        };
        assert!(h1 > 0.0, "height {h1}");
        // Editing the text bumps the revision; the same layer measures its new text.
        ok_value(s.execute("type.edit", json!({"layer": id.0, "text": "Hi there"})), "type.edit");
        let (w2, h2) = match measure(&s, id, 800.0) {
            Ok(v) => v,
            Err(e) => {
                assert!(false, "{e}");
                (0.0, 0.0)
            }
        };
        assert!(h2 > 0.0 && w2 > w1 + 1.0, "the longer text measures wider: {w1} → {w2}");
        // Within one revision the measurement is exact and repeatable (§9.5).
        match (measure(&s, id, 800.0), measure(&s, id, 800.0)) {
            (Ok(a), Ok(b)) => assert_eq!(a, b, "same revision, same answer"),
            (a, b) => assert!(false, "{a:?} / {b:?}"),
        }
    }

    #[test]
    fn layout_apply_hugs_a_type_layer_through_this_impl() {
        let mut s = session();
        let id = type_layer(&mut s, "Badge", 24.0);
        // What the seam reports is what the solver places: the stack's cross width is the
        // canvas, so measure there and compare with the committed placement.
        let (w, h) = match measure(&s, id, 400.0) {
            Ok(v) => v,
            Err(e) => {
                assert!(false, "{e}");
                (0.0, 0.0)
            }
        };
        assert!(w.is_finite() && w > 0.0 && h.is_finite() && h > 0.0, "{w} × {h}");
        let r = ok_value(
            s.execute(
                "layout.apply",
                json!({
                    "root": {"type": "stack", "align": "start", "children": [
                        {"type": "text", "layer": id.0, "hug": true}
                    ]}
                }),
            ),
            "layout.apply",
        );
        assert_eq!(r["moved"].as_array().map(Vec::len), Some(1), "{r}");
        assert_eq!(r["moved"][0]["to"], json!([0, 0, w.round() as i64, h.round() as i64]), "{r}");
    }
}
