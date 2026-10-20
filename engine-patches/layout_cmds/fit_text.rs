//! Text fitting for `layout.fitText` (spec §9.3) and the metrics behind `layout.measure`
//! (§9.4): measure at the requested size, binary-search down to `minSize` tracking wrapped
//! lines, then rescue a single-line slot with condensed tracking and an ellipsis, and report
//! `text_overflow` with the exact px and characters instead of ever clipping silently.
//!
//! Units follow the type commands' seam (crates/engine/src/type_cmds.rs header): sizes are
//! **points**, boxes and metrics are **document pixels**, and a measurer converts with the
//! document resolution (`px_per_pt = dpi / 72`, the same factor `photocraft_text` applies).
//!
//! Upstream shape: `crates/engine/src/layout_cmds.rs` declares
//! `pub mod fit_text; pub mod fit_specs; mod layout_apply;` (submodule files in
//! `crates/engine/src/layout_cmds/`, the `adjust_cmds.rs` + `adjust_cmds/` precedent) and
//! `pub fn specs()` merges `layout_apply::specs()` with `fit_specs::specs()` — the registry
//! line `v.extend(crate::layout_cmds::specs())` is the single existing-file edit
//! (engine-patches/registration/).
//!
//! Golden rules (vendor AGENTS.md): no panics on hostile numbers. Every float is checked for
//! NaN/inf before use (the `validate` guard, §9.5), every loop is bounded by [`SEARCH_CAP`], and a
//! measurer returning garbage (non-finite metrics) fails the fit (an overflow report), never
//! a NaN in a reply (`sanitize`).

use photocraft_doc::text::{CharStyle, ParagraphRun, ParagraphStyle, TextRun, TextShape};
use photocraft_doc::TextLayer;

use crate::type_cmds::{TYPE_SIZE_MAX_PT, TYPE_SIZE_MIN_PT, TRACKING_MAX, TRACKING_MIN};
use crate::{EngineError, Result};

/// §9.3 step 3: condensed tracking tightens by up to 2% of the em.
pub const CONDENSED_TRACKING_EM: f64 = 0.02;
/// The same tightening in the engine's tracking units (tracking is 1/1000 em,
/// `CharStyle::tracking`, so −2% em is exactly −20 units).
pub const CONDENSED_TRACKING_PER_MILLE: f64 = -20.0;
/// Truncation marker (a single U+2026, like `type_cmds::layer_name` cuts long names).
pub const ELLIPSIS: &str = "…";
/// Hard bound for every bisection in this module (§9.5: no unbounded loops on user text).
pub const SEARCH_CAP: usize = 64;
/// Chosen sizes are quantized down to 1/100 pt (deterministic output, §9.5) and never above
/// the largest measured fitting size.
pub const SIZE_STEP: f64 = 0.01;
/// A fit box wider/taller than this is not a box an agent would fit text into; refusing it
/// also bounds the probe `TextLayer` handed to the text engine.
pub const MAX_BOX_PX: f64 = 1e6;
/// Line-cap sanity bound (a slot asking for more lines than a million characters is a bug).
const MAX_LINES: usize = 1_000_000;
/// Leading multiplier bounds (a paragraph's auto leading as ×size; covers the panel's range).
const MIN_LINE_HEIGHT: f64 = 0.01;
const MAX_LINE_HEIGHT: f64 = 1000.0;
/// Scale factor bounds for `px_per_pt` (documents run 1..=2400 dpi).
const MIN_PX_PER_PT: f64 = 0.001;
const MAX_PX_PER_PT: f64 = 1000.0;
/// Box origin sanity, document pixels.
const MAX_COORD_PX: f64 = 1e9;
/// What a hostile or broken measurer's non-finite metric becomes: a width no box fits, so
/// the fit fails into an overflow report instead of poisoning the reply with NaN.
const METRIC_CEILING: f64 = 1e9;

// ---------- the font the engine measures with ----------

/// How the engine identifies a font: exactly the `CharStyle` fields the text engine
/// resolves a face from — family, exact PostScript name, face style, CSS weight, italic
/// (see `type_cmds::installed_postscript` and the face resolution at the top of
/// `photocraft_text`'s `Layouter::layout`). Measurement rebuilds a probe style from these.
#[derive(Clone, Debug, PartialEq)]
pub struct FontRef {
    /// Family name ("Inter"); empty = the engine's default family.
    pub family: String,
    /// PostScript name of the exact face ("Inter-Bold"), when known (PSD round-trip).
    pub postscript_name: Option<String>,
    /// Face style name as shown in the UI ("Bold Italic"); informational.
    pub style: String,
    /// CSS-style weight, 100–900.
    pub weight: u16,
    pub italic: bool,
}

impl FontRef {
    /// The face a character style uses, for measurement.
    pub fn from_style(style: &CharStyle) -> Self {
        Self {
            family: style.font_family.clone(),
            postscript_name: style.postscript_name.clone(),
            style: style.font_style.clone(),
            weight: style.weight,
            italic: style.italic,
        }
    }
}

impl Default for FontRef {
    fn default() -> Self {
        Self { family: String::new(), postscript_name: None, style: String::new(), weight: 400, italic: false }
    }
}

// ---------- the measurement seam ----------

/// One measurement of laid-out text, document pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextMetrics {
    /// Widest line after wrapping at the requested `max_width`.
    pub width: f64,
    /// Wrapped line count (0 for empty text; hard `\n` breaks included).
    pub lines: usize,
    /// One line's height in px: the leading the layer uses (baseline-to-baseline), or the
    /// single line's ascent + descent.
    pub line_height: f64,
}

/// The engine's text metrics as a seam, so the fit algorithm is testable without fonts and
/// the pure math stays independent of `photocraft_text`. `measure` lays `text` (line breaks
/// normalized to `\n`) out in `font` at `size` **points**, wrapped at `max_width` **document
/// pixels** — a paragraph (box) type layer's layout, where a word wider than the box breaks
/// at the box edge (`OverflowWrap::BreakWord`, engine #6694).
pub trait TextMeasurer {
    fn measure(&self, text: &str, font: &FontRef, size: f64, max_width: f64) -> TextMetrics;
}

// ---------- request / outcome ----------

/// One `layout.fitText` request: §9.4's params plus the style context of the fitted layer.
#[derive(Debug)]
pub struct FitRequest<'a> {
    /// The text to fit, line breaks normalized to `\n`.
    pub text: &'a str,
    /// The face it is set in (the layer's first character run).
    pub font: &'a FontRef,
    /// The fit box `[x, y, width, height]`, document pixels.
    pub bounds: [f64; 4],
    /// Smallest size considered, pt (§7.3: shrink within `[min_size, max_size]`).
    pub min_size: f64,
    /// Requested size, pt: measured first, shrunk from (§9.3 step 1).
    pub max_size: f64,
    /// Leading as a multiple of the font size (the auto leading the layer runs with).
    pub line_height: f64,
    /// Line cap; a single-line slot is `max_lines == 1` (§9.3 step 3's "single-line slot").
    pub max_lines: usize,
    /// The style's current tracking, 1/1000 em; condensed tracking moves from here.
    pub tracking: f64,
    /// Document pixels per point (`resolution_dpi / 72`), for em-accurate tracking math.
    pub px_per_pt: f64,
}

/// A degradation the fit reports; serialized as `{code, message}`. Never silent (§7.3).
#[derive(Clone, Debug, PartialEq)]
pub struct FitWarning {
    pub code: &'static str,
    pub message: String,
}

/// §9.3 step 4's `text_overflow` report: exactly how much does not fit (§11.1's `text_overflow`
/// blocker reads this).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OverflowReport {
    /// Overage in px: max(line-stack height − box height, widest line − box width, 0).
    pub overflow_px: f64,
    /// Characters that must go for the rest to fit at `min_size` (Unicode scalars).
    pub overflow_chars: usize,
}

/// The fit's answer: §9.4's result plus the write-back data for `type.edit`.
#[derive(Clone, Debug, PartialEq)]
pub struct FitOutcome {
    /// Chosen size, pt (≤ the largest measured fitting size, quantized to 0.01 pt).
    pub size: f64,
    /// Line count at `size`.
    pub lines: usize,
    /// Used bounds `[x0, y0, x1, y1]` relative to the fit box, document pixels.
    pub bounds: [f64; 4],
    /// True only when the text cannot fit even at `min_size` (then `report` is set).
    pub overflow: bool,
    pub warnings: Vec<FitWarning>,
    /// §9.3 step 4's report, present only when `overflow`.
    pub report: Option<OverflowReport>,
    /// Condensed tracking the write-back must apply (1/1000 em), when step 3 rescued the fit.
    pub tracking: Option<f64>,
    /// Replacement text (largest fitting prefix + "…"), when the fit ellipsized.
    pub text: Option<String>,
}

// ---------- the fit, §9.3 ----------

/// Fits `req.text` in `req.bounds`, §9.3 exactly:
///
/// 1. measure at the requested size ([`FitRequest::max_size`]);
/// 2. binary search down to `min_size` when it overflows, tracking wrapped lines;
/// 3. a single-line slot still overflowing: condensed tracking (±2% em), then ellipsis
///    with a warning;
/// 4. multi-line still overflowing at `min_size`: report `text_overflow` with the exact
///    px and characters — never clip silently;
/// 5. return the chosen size, line count, used bounds and overflow flag (the caller applies
///    them via `type.edit`; see `fit_specs` for the exact call).
///
/// Pure: mutates nothing. All loops are bounded ([`SEARCH_CAP`]); `Err` only on invalid
/// input, never a panic.
pub fn fit_text(m: &dyn TextMeasurer, req: &FitRequest) -> Result<FitOutcome> {
    validate(req)?;
    let [x, y, w, h] = req.bounds;
    if req.text.is_empty() {
        // Nothing to fit: the requested size is the answer (an empty layer keeps the style
        // for the next typed characters; the write-back still applies it).
        return Ok(FitOutcome {
            size: req.max_size,
            lines: 0,
            bounds: [x, y, x, y],
            overflow: false,
            warnings: Vec::new(),
            report: None,
            tracking: None,
            text: None,
        });
    }
    // §9.3 step 1: measure at the requested size with the engine's text metrics.
    let at_max = m.measure(req.text, req.font, req.max_size, w);
    if fits(&at_max, w, h, req.max_lines) {
        return Ok(outcome(req.max_size, &at_max, req));
    }
    let at_min = m.measure(req.text, req.font, req.min_size, w);
    if !fits(&at_min, w, h, req.max_lines) {
        // No size in range fits: §9.3 steps 3–4.
        return Ok(rescue(m, req, &at_min));
    }
    // §9.3 step 2: binary search down to minSize, tracking wrapped lines at every probe.
    // Invariant: `lo` was measured to fit, `hi` was measured not to.
    let (mut lo, mut hi) = (req.min_size, req.max_size);
    for _ in 0..search_cap(hi - lo) {
        if hi - lo <= SIZE_STEP {
            break; // converged: another halving cannot move the quantized answer
        }
        let mid = (lo + hi) / 2.0;
        if fits(&m.measure(req.text, req.font, mid, w), w, h, req.max_lines) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    // Quantize down (never above the fitted size, never below minSize), then re-verify: a
    // measurer need not be monotone in size, so the returned size is always a measured fit.
    let quantized = ((lo / SIZE_STEP).floor() * SIZE_STEP).max(req.min_size);
    let at_chosen = m.measure(req.text, req.font, quantized, w);
    if fits(&at_chosen, w, h, req.max_lines) {
        Ok(outcome(quantized, &at_chosen, req))
    } else {
        let at_lo = m.measure(req.text, req.font, lo, w);
        Ok(outcome(lo, &at_lo, req))
    }
}

/// Whether laid-out metrics fit the box: wrapped lines within the cap and their stack within
/// the height. The width check only bites where wrapping cannot help — a single cluster
/// wider than the box (engine #6694 breaks words at the box edge, so a wrapped line can only
/// exceed `w` that way).
fn fits(mx: &TextMetrics, w: f64, h: f64, max_lines: usize) -> bool {
    mx.width <= w && mx.lines <= max_lines && mx.lines as f64 * mx.line_height <= h
}

/// The plain outcome at a measured, fitting size.
fn outcome(size: f64, mx: &TextMetrics, req: &FitRequest) -> FitOutcome {
    let [x, y, _, _] = req.bounds;
    FitOutcome {
        size,
        lines: mx.lines,
        bounds: [x, y, x + mx.width, y + mx.lines as f64 * mx.line_height],
        overflow: false,
        warnings: Vec::new(),
        report: None,
        tracking: None,
        text: None,
    }
}

/// §9.3 steps 3–4, for text that cannot fit even at `min_size`.
fn rescue(m: &dyn TextMeasurer, req: &FitRequest, at_min: &TextMetrics) -> FitOutcome {
    let [x, y, w, h] = req.bounds;
    let n = req.text.chars().count();
    if req.max_lines == 1 {
        // The natural single-line width (a box wide enough that nothing wraps), so the
        // condensed pass can judge the one line it may rescue.
        let natural = m.measure(req.text, req.font, req.min_size, MAX_BOX_PX);
        if natural.lines == 1 {
            // Condensed tracking: tighten by up to 2% of the em (−20/1000 em), clamped to
            // the engine's tracking range, applied only when it rescues the fit. Tracking
            // advances every character but the last of the line, so the width shrinks by
            // (n−1) · applied/1000 em — the same linear model the engine's advances follow.
            let target = (req.tracking + CONDENSED_TRACKING_PER_MILLE).clamp(TRACKING_MIN, TRACKING_MAX);
            let applied = req.tracking - target;
            let size_px = req.min_size * req.px_per_pt;
            let condensed = natural.width - (n.saturating_sub(1)) as f64 * applied / 1000.0 * size_px;
            if applied > 0.0 && condensed <= w && natural.line_height <= h {
                return FitOutcome {
                    size: req.min_size,
                    lines: 1,
                    bounds: [x, y, x + condensed, y + natural.line_height],
                    overflow: false,
                    warnings: vec![FitWarning {
                        code: "text_condensed",
                        message: format!(
                            "tracking tightened by 2% of the em (to {target}/1000 em) so the line fits {w} px at {} pt",
                            req.min_size
                        ),
                    }],
                    report: None,
                    tracking: Some(target),
                    text: None,
                };
            }
        }
        // Then ellipsis, with a warning: the largest prefix + "…" that fits one line.
        let probe = |k: usize| -> TextMetrics {
            let cut = char_byte(req.text, k);
            let mut s = String::with_capacity(cut + ELLIPSIS.len());
            s.push_str(&req.text[..cut]);
            s.push_str(ELLIPSIS);
            m.measure(&s, req.font, req.min_size, w)
        };
        let base = probe(0);
        if fits(&base, w, h, 1) {
            let (mut lo, mut lo_mx) = (0usize, base);
            if n > 0 {
                let top = n - 1;
                // A minimal cut first: keep everything but the last character, add "…".
                let all_but_one = probe(top);
                if fits(&all_but_one, w, h, 1) {
                    lo = top;
                    lo_mx = all_but_one;
                } else {
                    let mut hi = top;
                    let mut steps = 0usize;
                    while hi - lo > 1 && steps < SEARCH_CAP {
                        steps += 1;
                        let mid = lo + (hi - lo) / 2;
                        let mx = probe(mid);
                        if fits(&mx, w, h, 1) {
                            lo = mid;
                            lo_mx = mx;
                        } else {
                            hi = mid;
                        }
                    }
                }
            }
            let cut = char_byte(req.text, lo);
            let mut text = String::with_capacity(cut + ELLIPSIS.len());
            text.push_str(&req.text[..cut]);
            text.push_str(ELLIPSIS);
            let removed = n - lo;
            return FitOutcome {
                size: req.min_size,
                lines: lo_mx.lines,
                bounds: [x, y, x + lo_mx.width, y + lo_mx.lines as f64 * lo_mx.line_height],
                overflow: false,
                warnings: vec![FitWarning {
                    code: "text_ellipsized",
                    message: format!(
                        "{removed} of {n} characters cut so the line fits {w} px at {} pt; the slot's text now ends with an ellipsis",
                        req.min_size
                    ),
                }],
                report: None,
                tracking: None,
                text: Some(text),
            };
        }
    }
    // §9.3 step 4: report text_overflow — the exact px and characters; never clip silently.
    let width = sanitize(at_min.width);
    let line_height = sanitize(at_min.line_height);
    let stack = at_min.lines as f64 * line_height;
    let overflow_px = (stack - h).max(width - w).max(0.0);
    let fitting_chars = largest_fitting_prefix(m, req, w, h);
    FitOutcome {
        size: req.min_size,
        lines: at_min.lines,
        bounds: [x, y, x + width, y + stack],
        overflow: true,
        warnings: vec![FitWarning {
            code: "text_overflow",
            message: format!(
                "text does not fit {w}×{h} px even at {} pt: over by {overflow_px:.2} px; {} of {n} characters fit",
                req.min_size, fitting_chars
            ),
        }],
        report: Some(OverflowReport { overflow_px, overflow_chars: n - fitting_chars }),
        tracking: None,
        text: None,
    }
}

/// The largest number of leading characters that fit the box at `min_size` (0 when nothing
/// does). Bisection over the prefix length; every accepted prefix is verified by measurement,
/// and the loop halves `hi - lo` so it runs at most [`SEARCH_CAP`] times even for huge text.
fn largest_fitting_prefix(m: &dyn TextMeasurer, req: &FitRequest, w: f64, h: f64) -> usize {
    let n = req.text.chars().count();
    let (mut lo, mut hi) = (0usize, n); // the empty prefix fits trivially; the full text does not
    let mut steps = 0usize;
    while hi - lo > 1 && steps < SEARCH_CAP {
        steps += 1;
        let mid = lo + (hi - lo) / 2;
        let cut = char_byte(req.text, mid);
        let mx = m.measure(&req.text[..cut], req.font, req.min_size, w);
        if fits(&mx, w, h, req.max_lines) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

/// Byte offset of character `k` (Unicode scalars — the engine's character indices, see the
/// type_cmds header), the string's length past the end.
fn char_byte(text: &str, k: usize) -> usize {
    text.char_indices().nth(k).map_or(text.len(), |(b, _)| b)
}

/// Iteration bound for the size bisection: `ceil(log2(range))`, clamped to
/// `[1, SEARCH_CAP]` (§9.3 step 2 is bounded by construction; tests assert the call count).
fn search_cap(range: f64) -> usize {
    if !range.is_finite() || range <= 0.0 {
        return 1;
    }
    (range.log2().ceil().max(1.0) as usize).min(SEARCH_CAP)
}

/// §9.5: hard-validate every number before any math. Ranges mirror the type commands
/// (`type_cmds::check_size_tracking`), so the §9.3 step-5 write-back can never be rejected
/// downstream; the box minimum of 1 px matches `type.edit`'s `box` clamp.
fn validate(req: &FitRequest) -> Result<()> {
    const CMD: &str = "layout.fitText";
    let bad = |msg: String| EngineError::BadParams { cmd: CMD.into(), msg };
    let [x, y, w, h] = req.bounds;
    if !x.is_finite() || !y.is_finite() || x.abs() > MAX_COORD_PX || y.abs() > MAX_COORD_PX {
        return Err(bad(format!("`bounds` x/y must be finite pixels within ±{MAX_COORD_PX}")));
    }
    if !w.is_finite() || !h.is_finite() {
        return Err(bad("`bounds` width and height must be finite numbers".into()));
    }
    if !(1.0..=MAX_BOX_PX).contains(&w) {
        return Err(bad(format!("`bounds` width must be between 1 and {MAX_BOX_PX} px")));
    }
    if !(1.0..=MAX_BOX_PX).contains(&h) {
        return Err(bad(format!("`bounds` height must be between 1 and {MAX_BOX_PX} px")));
    }
    if !req.min_size.is_finite() || !req.max_size.is_finite() {
        return Err(bad("`minSize` and `maxSize` must be finite numbers (pt)".into()));
    }
    if !(TYPE_SIZE_MIN_PT..=TYPE_SIZE_MAX_PT).contains(&req.min_size) || !(TYPE_SIZE_MIN_PT..=TYPE_SIZE_MAX_PT).contains(&req.max_size) {
        return Err(bad(format!(
            "`minSize` and `maxSize` must be between {TYPE_SIZE_MIN_PT} and {TYPE_SIZE_MAX_PT} pt (the type size range)"
        )));
    }
    if req.min_size > req.max_size {
        return Err(bad(format!("`minSize` ({}) must not exceed `maxSize` ({})", req.min_size, req.max_size)));
    }
    if !req.line_height.is_finite() || !(MIN_LINE_HEIGHT..=MAX_LINE_HEIGHT).contains(&req.line_height) {
        return Err(bad(format!("`lineHeight` must be a finite multiplier between {MIN_LINE_HEIGHT} and {MAX_LINE_HEIGHT}")));
    }
    if req.max_lines == 0 || req.max_lines > MAX_LINES {
        return Err(bad(format!("`maxLines` must be between 1 and {MAX_LINES}")));
    }
    if !req.tracking.is_finite() || !(TRACKING_MIN..=TRACKING_MAX).contains(&req.tracking) {
        return Err(bad(format!(
            "`tracking` must be between {TRACKING_MIN} and {TRACKING_MAX} (1/1000 em, the engine's tracking range)"
        )));
    }
    if !req.px_per_pt.is_finite() || !(MIN_PX_PER_PT..=MAX_PX_PER_PT).contains(&req.px_per_pt) {
        return Err(bad("`pxPerPt` must be a finite positive scale (resolution_dpi / 72)".into()));
    }
    Ok(())
}

// ---------- the production measurer ----------

/// The production [`TextMeasurer`]: lays text out with the engine's own text engine
/// (`photocraft_text::shared()`, the same seam `type.info` uses), as a paragraph (box) layer
/// with the fit's leading and the style's tracking — so wrapping matches what the fitted
/// layer will render.
///
/// Clamps instead of erroring: it is built from already-validated command params, and a
/// hostile probe (non-finite size, absurd width) yields [`METRIC_CEILING`] metrics — a fit
/// that fails, never a panic.
pub struct EngineTextMeasurer {
    dpi: f32,
    auto_leading: f32,
    tracking: f32,
}

impl EngineTextMeasurer {
    /// `line_height` is the auto-leading multiplier the fit runs with (§9.4 `lineHeight`);
    /// `tracking` is the style's current tracking (1/1000 em), measured as-is.
    pub fn new(dpi: f32, line_height: f64, tracking: f64) -> Self {
        let dpi = if dpi.is_finite() && dpi > 0.0 { dpi } else { 72.0 };
        let auto_leading = if line_height.is_finite() { (line_height as f32).clamp(MIN_LINE_HEIGHT as f32, MAX_LINE_HEIGHT as f32) } else { 1.2 };
        let tracking = if tracking.is_finite() { (tracking as f32).clamp(TRACKING_MIN as f32, TRACKING_MAX as f32) } else { 0.0 };
        Self { dpi, auto_leading, tracking }
    }

    fn px_per_pt(&self) -> f64 {
        f64::from(self.dpi) / 72.0
    }
}

impl TextMeasurer for EngineTextMeasurer {
    fn measure(&self, text: &str, font: &FontRef, size: f64, max_width: f64) -> TextMetrics {
        let px_per_pt = self.px_per_pt();
        let hostile = || TextMetrics { width: METRIC_CEILING, lines: 1, line_height: METRIC_CEILING };
        if !size.is_finite() || size <= 0.0 || !max_width.is_finite() || !(1.0..=MAX_BOX_PX).contains(&max_width) {
            return hostile();
        }
        let text = crate::type_cmds::norm_text(text);
        if text.is_empty() {
            let line_height = size * px_per_pt * f64::from(self.auto_leading);
            return TextMetrics { width: 0.0, lines: 0, line_height: sanitize(line_height) };
        }
        // The probe: one run in the named face, the paragraph style carrying the fit's
        // leading, a box shape so the engine wraps at `max_width` — the same model
        // `type_cmds::new_text_layer` builds for paragraph text.
        let style = CharStyle {
            font_family: font.family.clone(),
            font_style: font.style.clone(),
            postscript_name: font.postscript_name.clone(),
            weight: font.weight,
            italic: font.italic,
            size_pt: size as f32,
            tracking: self.tracking,
            ..CharStyle::default()
        };
        let para = ParagraphStyle { auto_leading: self.auto_leading, ..ParagraphStyle::default() };
        let len = text.len();
        let probe = TextLayer {
            text,
            runs: vec![TextRun { len, style }],
            paragraphs: vec![ParagraphRun { len, style: para }],
            shape: TextShape::Box { x: 0.0, y: 0.0, width: max_width as f32, height: 0.0 },
            ..TextLayer::default()
        };
        let layout = match photocraft_text::shared().lock() {
            // A poisoned lock only means another thread panicked inside the text engine; the
            // engine itself is intact, so proceed with it (the vendor idiom in type_cmds).
            Ok(mut engine) => engine.layout(&probe, self.dpi),
            Err(poisoned) => poisoned.into_inner().layout(&probe, self.dpi),
        };
        let width = match layout.line_bounds() {
            Some(b) => f64::from(b[2] - b[0]),
            None => 0.0,
        };
        let line_height = match (layout.lines.first(), layout.lines.get(1)) {
            (Some(a), Some(b)) => f64::from(b.baseline - a.baseline), // the leading in use
            (Some(a), None) => f64::from(a.ascent + a.descent),        // single line: its box
            (None, _) => size * px_per_pt * f64::from(self.auto_leading), // not reached for non-empty text; keep a sane box
        };
        TextMetrics { width: sanitize(width), lines: layout.lines.len(), line_height: sanitize(line_height) }
    }
}

/// A metric that is negative, NaN or infinite becomes a width no box fits, so garbage fails
/// the fit (an overflow report) instead of reaching a reply as NaN.
fn sanitize(v: f64) -> f64 {
    if v.is_finite() && v >= 0.0 {
        v.min(METRIC_CEILING)
    } else {
        METRIC_CEILING
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// A monospace-ish measurer: every character advances 0.6 em plus the style's tracking
    /// (which never follows a line's last character, matching the engine's advance model);
    /// text wraps greedily at `max_width`; one line per paragraph (empty paragraphs hold a
    /// line); leading = `line_height` × size. `px_per_pt` is 1 so 1 pt = 1 px.
    struct Fake {
        line_height: f64,
        tracking: f64,
        calls: Cell<usize>,
    }

    impl Fake {
        fn new(line_height: f64) -> Self {
            Self { line_height, tracking: 0.0, calls: Cell::new(0) }
        }
    }

    impl TextMeasurer for Fake {
        fn measure(&self, text: &str, _font: &FontRef, size: f64, max_width: f64) -> TextMetrics {
            self.calls.set(self.calls.get() + 1);
            let size_px = size; // px_per_pt = 1
            let pitch = 0.6 * size_px + self.tracking / 1000.0 * size_px;
            let tail = self.tracking / 1000.0 * size_px; // tracking the last char of a line does not add
            if text.is_empty() {
                return TextMetrics { width: 0.0, lines: 0, line_height: self.line_height * size_px };
            }
            let mut lines = 0usize;
            let mut width = 0.0f64;
            for para in text.split('\n') {
                let chars = para.chars().count();
                if chars == 0 {
                    lines += 1;
                    continue;
                }
                let per_line = if pitch > 1e-9 {
                    let k = ((max_width + tail) / pitch).floor();
                    if k >= 1.0 { k as usize } else { 1 }
                } else {
                    chars // pitch ~0: the whole paragraph is one line
                };
                let on_line = chars.min(per_line);
                lines += (chars + per_line - 1) / per_line;
                width = width.max(on_line as f64 * pitch - tail);
            }
            TextMetrics { width, lines, line_height: self.line_height * size_px }
        }
    }

    /// Tracking-blind measurer (advance independent of tracking) for the clamp test: the
    /// condensed pass is judged analytically, so this fake isolates the clamp arithmetic.
    /// 0.9 em per character, never wraps (single line).
    struct FlatFake;

    impl TextMeasurer for FlatFake {
        fn measure(&self, text: &str, _font: &FontRef, size: f64, _max_width: f64) -> TextMetrics {
            let chars = text.chars().count();
            if chars == 0 {
                return TextMetrics { width: 0.0, lines: 0, line_height: 1.2 * size };
            }
            TextMetrics { width: chars as f64 * 0.9 * size, lines: 1, line_height: 1.2 * size }
        }
    }

    /// A measurer returning garbage, proving hostile metrics fail the fit instead of
    /// poisoning the report with NaN.
    struct Garbage;

    impl TextMeasurer for Garbage {
        fn measure(&self, _text: &str, _font: &FontRef, _size: f64, _max_width: f64) -> TextMetrics {
            TextMetrics { width: f64::NAN, lines: 7, line_height: f64::INFINITY }
        }
    }

    fn font() -> &'static FontRef {
        // A leaked-once fixture face: `FitRequest` borrows its font, so the tests need one
        // that outlives the helper that builds the request.
        static FONT: std::sync::OnceLock<FontRef> = std::sync::OnceLock::new();
        FONT.get_or_init(|| FontRef { family: "Fake".into(), postscript_name: None, style: String::new(), weight: 400, italic: false })
    }

    fn req<'a>(text: &'a str, min: f64, max: f64, bounds: [f64; 4], max_lines: usize, line_height: f64) -> FitRequest<'a> {
        FitRequest {
            text,
            font: font(),
            bounds,
            min_size: min,
            max_size: max,
            line_height,
            max_lines,
            tracking: 0.0,
            px_per_pt: 1.0,
        }
    }

    fn ok(m: &dyn TextMeasurer, r: FitRequest) -> FitOutcome {
        match fit_text(m, &r) {
            Ok(o) => o,
            Err(e) => {
                assert!(false, "fit_text returned {e}");
                FitOutcome { size: 0.0, lines: 0, bounds: [0.0; 4], overflow: false, warnings: Vec::new(), report: None, tracking: None, text: None }
            }
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-9
    }

    fn report_of(o: &FitOutcome) -> OverflowReport {
        match o.report {
            Some(r) => r,
            None => {
                assert!(false, "expected a text_overflow report");
                OverflowReport { overflow_px: 0.0, overflow_chars: 0 }
            }
        }
    }

    #[test]
    fn font_ref_mirrors_the_char_style_face() {
        let style = CharStyle {
            font_family: "Inter".into(),
            font_style: "Bold".into(),
            postscript_name: Some("Inter-Bold".into()),
            weight: 700,
            italic: true,
            ..CharStyle::default()
        };
        let f = FontRef::from_style(&style);
        assert_eq!(f.family, "Inter");
        assert_eq!(f.postscript_name.as_deref(), Some("Inter-Bold"));
        assert_eq!(f.style, "Bold");
        assert_eq!(f.weight, 700);
        assert!(f.italic);
        assert_eq!(FontRef::default().weight, 400);
    }

    #[test]
    fn binary_search_picks_max_fitting_size() {
        let f = Fake::new(1.2);
        let ten = "abcdefghij";
        // Fits at the requested size: answered at once, no shrink.
        let o = ok(&f, req("abc", 10.0, 40.0, [0.0, 0.0, 600.0, 100.0], 1, 1.2));
        assert!(close(o.size, 40.0) && o.lines == 1 && !o.overflow, "{o:?}");
        // Too big at 40 pt: the largest fitting size is exactly 10 pt (10 chars × 0.6 em =
        // 6·s px, which stops fitting past 10 pt in a 60 px box), so the search lands on
        // minSize without ever moving `lo`.
        let o = ok(&f, req(ten, 10.0, 40.0, [0.0, 0.0, 60.0, 100.0], 1, 1.2));
        assert!(close(o.size, 10.0), "size {}", o.size);
        assert_eq!(o.lines, 1);
        // A mid-range answer: 6 chars in a 60 px box fit up to 16.6̄ pt; the bounded search
        // (ceil(log2 30) = 5 probes) plus the 0.01 pt quantization land on 16.56 pt — never
        // above the fitted size, never below `minSize`.
        let o = ok(&f, req("abcdef", 10.0, 40.0, [0.0, 0.0, 60.0, 100.0], 1, 1.2));
        assert!(close(o.size, 16.56), "size {}", o.size);
        assert_eq!(o.lines, 1);
        assert!(o.warnings.is_empty() && !o.overflow);
    }

    #[test]
    fn size_search_is_iteration_bounded() {
        let f = Fake::new(1.2);
        let _ = ok(&f, req("abcdefghij", 10.0, 40.0, [0.0, 0.0, 60.0, 100.0], 1, 1.2));
        // 1 probe at maxSize + 1 at minSize + ceil(log2 30) = 5 bisection probes + 1 verify.
        assert_eq!(f.calls.get(), 8, "bounded: {}", f.calls.get());
        let f = Fake::new(1.2);
        let _ = ok(&f, req("abcdef", 10.0, 40.0, [0.0, 0.0, 60.0, 100.0], 1, 1.2));
        assert_eq!(f.calls.get(), 8);
        // The full engine size range is still a handful of probes: ceil(log2 1296) = 11.
        assert!(search_cap(1296.0) == 11 && search_cap(30.0) == 5 && search_cap(0.0) == 1 && search_cap(f64::NAN) == 1);
    }

    #[test]
    fn shrunk_text_wraps_and_reports_the_line_count() {
        let f = Fake::new(1.2);
        let ten = "abcdefghij";
        // 10 chars in a 54 px box at 10 pt: 9 per line → 2 lines; used bounds are exact.
        let o = ok(&f, req(ten, 10.0, 10.0, [10.0, 20.0, 54.0, 100.0], 3, 1.2));
        assert!(close(o.size, 10.0));
        assert_eq!(o.lines, 2);
        assert!(close(o.bounds[0], 10.0) && close(o.bounds[1], 20.0), "{o:?}");
        assert!(close(o.bounds[2], 64.0) && close(o.bounds[3], 44.0), "{o:?}");
        // Shrinking a multi-line slot to fit its line cap: 20 chars, 100 px wide, 2 lines.
        // Lines ≤ 2 needs cpl ≥ 10 → s ≤ 16.6̄ pt; the search quantizes to 16.37 pt.
        let o = ok(&f, req(&"t".repeat(20), 4.0, 40.0, [0.0, 0.0, 100.0, 200.0], 2, 1.2));
        assert!(close(o.size, 16.37), "size {}", o.size);
        assert_eq!(o.lines, 2);
        assert!(!o.overflow);
    }

    #[test]
    fn condensed_tracking_rescues_a_single_line() {
        let f = Fake::new(1.2);
        // 10 chars at 20 pt = 120 px in a 117 px box: −2% em removes 9 × 0.4 px = 3.6 px →
        // 116.4 px fits, with tracking −20 (1/1000 em) written back.
        let o = ok(&f, req("abcdefghij", 20.0, 20.0, [0.0, 0.0, 117.0, 1000.0], 1, 1.2));
        assert!(!o.overflow, "{o:?}");
        assert_eq!(o.tracking, Some(-20.0));
        assert_eq!(o.lines, 1);
        assert!(close(o.bounds[2], 116.4), "width {}", o.bounds[2]);
        assert!(o.warnings.iter().any(|w| w.code == "text_condensed"));
        assert!(o.text.is_none() && o.report.is_none());
    }

    #[test]
    fn condensed_tracking_clamps_to_the_engine_range() {
        // The style already sits at −990/1000 em: condensing by 20 more would pass the
        // engine's TRACKING_MIN (−1000), so only 10/1000 em may be applied (FlatFake's
        // advance is tracking-blind, isolating the arithmetic).
        let mut r = req("abcdefghij", 20.0, 20.0, [0.0, 0.0, 178.5, 1000.0], 1, 1.2);
        r.tracking = -990.0;
        let o = ok(&FlatFake, r);
        assert_eq!(o.tracking, Some(-1000.0), "clamped to TRACKING_MIN");
        assert!(!o.overflow && close(o.bounds[2], 178.2), "{o:?}");
        // One tenth of an em short of fitting: the clamp cannot rescue, ellipsis takes over.
        let mut r = req("abcdefghij", 20.0, 20.0, [0.0, 0.0, 178.1, 1000.0], 1, 1.2);
        r.tracking = -990.0;
        let o = ok(&FlatFake, r);
        assert!(o.tracking.is_none());
        assert_eq!(o.text.as_deref(), Some("abcdefgh…"), "{o:?}");
        assert!(o.warnings.iter().any(|w| w.code == "text_ellipsized"));
    }

    #[test]
    fn ellipsis_cuts_to_the_largest_fitting_prefix_with_a_warning() {
        let f = Fake::new(1.2);
        // 10 chars at 20 pt = 120 px in a 30 px box: condensing cannot rescue (116.4 > 30),
        // so the largest prefix + "…" that fits one line is "a…" (24 px).
        let o = ok(&f, req("abcdefghij", 20.0, 20.0, [0.0, 0.0, 30.0, 1000.0], 1, 1.2));
        assert_eq!(o.text.as_deref(), Some("a…"), "{o:?}");
        assert_eq!(o.lines, 1);
        assert!(!o.overflow);
        assert!(o.tracking.is_none());
        assert!(close(o.bounds[2], 24.0) && close(o.bounds[3], 24.0), "{o:?}");
        let warning = o.warnings.iter().find(|w| w.code == "text_ellipsized");
        assert!(warning.is_some_and(|w| w.message.contains("9 of 10 characters")), "{:?}", o.warnings);
        assert!(o.report.is_none());
    }

    #[test]
    fn multi_line_overflow_reports_exact_px_and_chars() {
        let f = Fake::new(1.2);
        // 10 chars at 20 pt in a 54 px box: 4 per line → 3 lines, but the slot allows 2 and
        // is 50 px tall → over by 72 − 50 = 22 px; the 2 fitting lines hold 8 characters.
        let o = ok(&f, req("abcdefghij", 20.0, 20.0, [0.0, 0.0, 54.0, 50.0], 2, 1.2));
        assert!(o.overflow && o.report.is_some(), "{o:?}");
        let report = report_of(&o);
        assert!(close(report.overflow_px, 22.0), "px {}", report.overflow_px);
        assert_eq!(report.overflow_chars, 2);
        assert_eq!(o.lines, 3);
        assert!(o.text.is_none() && o.tracking.is_none(), "nothing is applied to the layer");
        assert!(o.warnings.iter().any(|w| w.code == "text_overflow"));
    }

    #[test]
    fn overflow_when_even_one_line_is_too_tall() {
        let f = Fake::new(1.2);
        // One 40 pt line is 48 px tall in a 10 px slot: no prefix fits, not even "…" alone.
        let o = ok(&f, req("abcdefghij", 40.0, 40.0, [0.0, 0.0, 1000.0, 10.0], 1, 1.2));
        let report = report_of(&o);
        assert!(o.overflow);
        assert!(close(report.overflow_px, 38.0), "px {}", report.overflow_px);
        assert_eq!(report.overflow_chars, 10, "no character fits at all");
    }

    #[test]
    fn hostile_metrics_fail_the_fit_instead_of_poisoning_it() {
        let o = ok(&Garbage, req("abcdefghij", 10.0, 40.0, [0.0, 0.0, 60.0, 100.0], 1, 1.2));
        let report = report_of(&o);
        assert!(o.overflow);
        assert!(report.overflow_px.is_finite(), "never NaN in a reply");
        assert!(report.overflow_chars <= 10);
    }

    #[test]
    fn empty_text_fits_without_measuring() {
        let f = Fake::new(1.2);
        let o = ok(&f, req("", 10.0, 40.0, [5.0, 6.0, 60.0, 100.0], 1, 1.2));
        assert!(close(o.size, 40.0) && o.lines == 0 && !o.overflow, "{o:?}");
        assert!(close(o.bounds[0], 5.0) && close(o.bounds[1], 6.0) && close(o.bounds[2], 5.0) && close(o.bounds[3], 6.0));
        assert!(o.warnings.is_empty() && o.report.is_none());
        assert_eq!(f.calls.get(), 0, "nothing to measure");
    }

    #[test]
    fn huge_text_stays_bounded_and_exactly_reported() {
        let big = "a".repeat(200_000);
        let f = Fake::new(1.2);
        let o = ok(&f, req(&big, 12.0, 96.0, [0.0, 0.0, 100.0, 300.0], 3, 1.2));
        let report = report_of(&o);
        // At 12 pt the box fits 13 chars/line: 15,385 lines; 3 lines hold 39 characters.
        assert_eq!(report.overflow_chars, 199_961);
        assert!(close(report.overflow_px, 221_244.0), "px {}", report.overflow_px);
        assert_eq!(o.lines, 15_385);
        // Bounded-loop proof: 2 initial probes + ≤ 64 prefix probes, nothing else.
        assert!(f.calls.get() <= 70, "calls: {}", f.calls.get());
    }

    #[test]
    fn hostile_numbers_are_rejected_before_any_math() {
        let f = Fake::new(1.2);
        let ten = "abcdefghij";
        let base = || req(ten, 10.0, 40.0, [0.0, 0.0, 60.0, 100.0], 1, 1.2);
        assert!(fit_text(&f, &base()).is_ok(), "the baseline request is valid");
        let mut cases: Vec<FitRequest> = Vec::new();
        let mut r = base();
        r.min_size = f64::NAN;
        cases.push(r);
        let mut r = base();
        r.max_size = f64::INFINITY;
        cases.push(r);
        let mut r = base();
        r.min_size = 30.0;
        r.max_size = 20.0;
        cases.push(r);
        let mut r = base();
        r.min_size = 0.05;
        cases.push(r);
        let mut r = base();
        r.max_size = 2000.0;
        cases.push(r);
        let mut r = base();
        r.bounds = [f64::NAN, 0.0, 60.0, 100.0];
        cases.push(r);
        let mut r = base();
        r.bounds = [0.0, f64::INFINITY, 60.0, 100.0];
        cases.push(r);
        let mut r = base();
        r.bounds = [0.0, 0.0, 0.0, 100.0];
        cases.push(r);
        let mut r = base();
        r.bounds = [0.0, 0.0, 60.0, 0.5];
        cases.push(r);
        let mut r = base();
        r.bounds = [0.0, 0.0, -60.0, 100.0];
        cases.push(r);
        let mut r = base();
        r.bounds = [0.0, 0.0, 1e7, 100.0];
        cases.push(r);
        let mut r = base();
        r.max_lines = 0;
        cases.push(r);
        let mut r = base();
        r.max_lines = 2_000_000;
        cases.push(r);
        let mut r = base();
        r.line_height = 0.0;
        cases.push(r);
        let mut r = base();
        r.line_height = f64::NAN;
        cases.push(r);
        let mut r = base();
        r.line_height = -1.5;
        cases.push(r);
        let mut r = base();
        r.tracking = f64::NAN;
        cases.push(r);
        let mut r = base();
        r.tracking = 20_000.0;
        cases.push(r);
        let mut r = base();
        r.px_per_pt = 0.0;
        cases.push(r);
        let mut r = base();
        r.px_per_pt = f64::NAN;
        cases.push(r);
        for r in &cases {
            assert!(matches!(fit_text(&f, r), Err(EngineError::BadParams { .. })), "rejected: {:?}", r);
        }
        assert_eq!(cases.len(), 20);
    }

    #[test]
    fn same_input_fits_identically() {
        // §9.5: same input + same document revision ⇒ identical output.
        let a = ok(&Fake::new(1.2), req("abcdefghij", 10.0, 40.0, [0.0, 0.0, 60.0, 100.0], 1, 1.2));
        let b = ok(&Fake::new(1.2), req("abcdefghij", 10.0, 40.0, [0.0, 0.0, 60.0, 100.0], 1, 1.2));
        assert_eq!(a, b);
        let a = ok(&Fake::new(1.2), req("abcdefghij", 20.0, 20.0, [0.0, 0.0, 54.0, 50.0], 2, 1.2));
        let b = ok(&Fake::new(1.2), req("abcdefghij", 20.0, 20.0, [0.0, 0.0, 54.0, 50.0], 2, 1.2));
        assert_eq!(a, b);
    }
}
