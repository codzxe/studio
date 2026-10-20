//! `layout.apply` — the constraints-not-coordinates layout command (spec §9).
//!
//! The model supplies intent (stacks, rows, grids, alignment, fit modes, safe areas); this
//! module solves the geometry and commits it as ONE undoable edit, so §9.5's two hard rules
//! hold: **transactional** (any invalid child ⇒ nothing moves — every parse, resolve and solve
//! step runs before the edit, and `Session::edit` only commits a closure that returned `Ok`)
//! and **deterministic** (same input + same revision ⇒ byte-identical output — no HashMap, no
//! clock, no randomness; children keep their input order, warnings are appended in order,
//! and every placement is rounded to whole pixels the same way every run).
//!
//! Upstream shape: this file is part of the `layout_cmds` module directory; siblings reach it
//! as `super::layout_apply`. The pure solver takes the document through three injected seams
//! (`bounds`, `resolve`, and the [`TextMeasurer`] below) so it needs no `Session` and is
//! table-testable.
//!
//! Coordination seam (W3-E): **the `impl TextMeasurer for EngineTextMeasurer` lives in
//! `fit_text.rs`** (the measure module — one home for everything that calls the engine's text
//! stack). The exact block to implement there:
//!
//! ```ignore
//! impl super::layout_apply::TextMeasurer for super::layout_apply::EngineTextMeasurer<'_> {
//!     fn measure_text(&self, layer: LayerId, max_width: f64) -> Result<(f64, f64)> {
//!         // engine text metrics: the (width, height) the layer's text occupies wrapped to
//!         // `max_width` at its current size; Err when the layer has no measurable text.
//!     }
//! }
//! ```

use std::collections::BTreeSet;

use photocraft_algo::transform::{Homography, Interp};
use photocraft_doc::{Document, LayerId};
use photocraft_geom::{Affine, Rect};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::layer_multi_cmds::layer_bounds;
use crate::{EngineError, Result, Session};

const CMD: &str = "layout.apply";

// ---------- §9.5 hard limits, validated before any math ----------
/// A user/LLM tree may not nest deeper than this (recursion bound; the panic-hunt table sends
/// 100+ levels and must get an `Err`, not a stack overflow).
const MAX_DEPTH: usize = 64;
/// Cap on nodes in one tree: allocation stays bounded no matter how hostile the params are.
const MAX_NODES: usize = 4096;
/// Cap on children of one container (10⁵-entry arrays must `Err`, not allocate).
const MAX_CHILDREN: usize = 512;
/// Any single dimension in px. A `grid` of 24 columns × 1e9-px cells is refused here.
const MAX_PX: f64 = 1_048_576.0;
/// Gaps: 0–256 px (§9.5).
const MAX_GAP: f64 = 256.0;
/// Padding / safe-area sides: 0–2048 px (§9.5).
const MAX_SIDE: f64 = 2048.0;
/// Grid columns: 1–24 (§9.5).
const MAX_COLUMNS: usize = 24;
/// Grow weights are capped so one absurd weight cannot zero everyone else.
const MAX_GROW: f64 = 1.0e6;

const KINDS: &str = "stack, row, grid, absolute, center, spacer, text, image, component, divider";

/// Every sizing key every node kind accepts (§9.2 sizing: fixed/grow/hug/aspect/min/max/percent).
const SIZING_KEYS: &[&str] = &["width", "height", "grow", "hug", "percent", "aspect", "minWidth", "maxWidth", "minHeight", "maxHeight"];

/// Keys each kind accepts besides `type`, the sizing keys and `anchor` (§9.2). `x`/`y` and
/// `dx`/`dy` are added per parent kind by [`keys_for`]; unknown keys are `Err` with this list,
/// never silently ignored (a misspelled key must not "succeed" on defaults).
const KIND_KEYS: &[(&str, &[&str])] = &[
    ("stack", &["layer", "within", "children", "direction", "gap", "padding", "align", "dir"]),
    ("row", &["layer", "within", "children", "gap", "padding", "align", "dir"]),
    ("grid", &["layer", "within", "children", "columns", "gap", "padding", "align", "dir"]),
    ("absolute", &["layer", "within", "children", "padding", "dir"]),
    ("center", &["layer", "within", "children", "padding", "dir"]),
    ("spacer", &["size"]),
    ("text", &["layer"]),
    ("image", &["layer", "fit"]),
    ("component", &["layer"]),
    ("divider", &["layer", "size"]),
];

fn bad(msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: CMD.into(), msg: msg.into() }
}

// ---------- serde model (§9.2 node kinds, sizing, anchors) ----------

/// Flow direction of a `stack` (§9.2). A `row` is the horizontal case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Vertical,
    Horizontal,
}

/// Writing direction (§9.5: alignment is logical start/end; `rtl` flips which side "start" is).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlowDir {
    Ltr,
    Rtl,
}

/// Cross-axis alignment (§9.2 `align`). Logical `start`/`end` only — bare `left`/`right` are
/// rejected with this list (§9.5 RTL/CJK rule).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Align {
    Start,
    Center,
    End,
    Stretch,
}

/// 9-point anchors plus `baseline` (§9.2). Physical names; `baseline` centers horizontally and
/// puts the text's base at the point (typographic ascent needs the measure module's metrics).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Anchor {
    TopLeft,
    Top,
    TopRight,
    Left,
    Center,
    Right,
    BottomLeft,
    Bottom,
    BottomRight,
    Baseline,
}

/// How an `image` fills its slot (§9.2 `fit`). `contain` fits inside, `cover` fills and may
/// overflow the slot (clamped to the canvas, with a warning — the engine has no per-node
/// clipping), `fill` stretches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Fit {
    Contain,
    Cover,
    Fill,
}

/// Which coordinates `absolute` children and `within` rects are given in (§9.2 options).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Space {
    Document,
    Parent,
}

/// Sizing every node accepts (§9.2): `width`/`height` are fixed px, `grow` a weight (bool
/// `true` = weight 1), `hug` asks for measured/passed-through content, `percent` a share of
/// the parent's main axis, `aspect` a w/h ratio, `min*`/`max*` px clamps.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sizing {
    pub width: Option<f64>,
    pub height: Option<f64>,
    /// `true` (weight 1) or a number ≥ 0.
    pub grow: Option<Value>,
    pub hug: Option<bool>,
    pub percent: Option<f64>,
    pub aspect: Option<f64>,
    pub min_width: Option<f64>,
    pub max_width: Option<f64>,
    pub min_height: Option<f64>,
    pub max_height: Option<f64>,
}

impl Sizing {
    /// §9.5: every integer or float is checked for NaN/inf before use, and absurd sizes are
    /// refused before any math. `1e999` arrives from JSON as `inf` and dies here.
    fn validate(&self) -> Result<()> {
        let dim = |key: &str, v: Option<f64>| -> Result<()> {
            if let Some(v) = v {
                if !v.is_finite() {
                    return Err(bad(format!("`{key}` must be a finite number (got {v})")));
                }
                if !(0.0..=MAX_PX).contains(&v) {
                    return Err(bad(format!("`{key}` = {v} is outside 0–{MAX_PX:.0} px")));
                }
            }
            Ok(())
        };
        dim("width", self.width)?;
        dim("height", self.height)?;
        dim("minWidth", self.min_width)?;
        dim("maxWidth", self.max_width)?;
        dim("minHeight", self.min_height)?;
        dim("maxHeight", self.max_height)?;
        if let (Some(lo), Some(hi)) = (self.min_width, self.max_width) && lo > hi {
            return Err(bad(format!("`minWidth` ({lo}) exceeds `maxWidth` ({hi})")));
        }
        if let (Some(lo), Some(hi)) = (self.min_height, self.max_height) && lo > hi {
            return Err(bad(format!("`minHeight` ({lo}) exceeds `maxHeight` ({hi})")));
        }
        if let Some(p) = self.percent && !(0.0 < p && p <= 100.0) {
            return Err(bad(format!("`percent` = {p} is outside 1–100")));
        }
        if let Some(a) = self.aspect && !(a.is_finite() && 0.0 < a && a <= MAX_GROW) {
            return Err(bad(format!("`aspect` = {a} must be a positive finite w/h ratio")));
        }
        self.grow().map(|_| ())
    }

    /// The grow weight: `true` → 1.0, `false`/`0` → non-growing, numbers ≥ 0.
    fn grow(&self) -> Result<Option<f64>> {
        match self.grow {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(true)) => Ok(Some(1.0)),
            Some(Value::Bool(false)) => Ok(None),
            Some(v) => {
                let w = v.as_f64().filter(|w| w.is_finite()).ok_or_else(|| bad(format!("`grow` must be a number ≥ 0 (or true), not {v}")))?;
                if w < 0.0 {
                    return Err(bad(format!("`grow` = {w} must be ≥ 0")));
                }
                if w > MAX_GROW {
                    return Err(bad(format!("`grow` = {w} is absurd (max {MAX_GROW})")));
                }
                Ok(Some(w).filter(|w| *w > 0.0))
            }
        }
    }

    /// Clamp physical px per the `min*`/`max*` keys (§9.2 min/max sizing).
    fn clamp(&self, w: &mut f64, h: &mut f64) {
        if let Some(lo) = self.min_width && *w < lo { *w = lo; }
        if let Some(hi) = self.max_width && *w > hi { *w = hi; }
        if let Some(lo) = self.min_height && *h < lo { *h = lo; }
        if let Some(hi) = self.max_height && *h > hi { *h = hi; }
    }
}

// One serde struct per §9.2 node kind. `children` stays raw here; [`parse_tree`] assembles the
// tree itself so depth, node caps and per-kind key checks are enforced with clear messages.

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackNode {
    #[serde(flatten)]
    pub sizing: Sizing,
    pub layer: Option<Value>,
    pub direction: Option<Direction>,
    pub gap: Option<f64>,
    pub align: Option<Align>,
    pub dir: Option<FlowDir>,
    pub anchor: Option<Anchor>,
    pub children: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowNode {
    #[serde(flatten)]
    pub sizing: Sizing,
    pub layer: Option<Value>,
    pub gap: Option<f64>,
    pub align: Option<Align>,
    pub dir: Option<FlowDir>,
    pub anchor: Option<Anchor>,
    pub children: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridNode {
    #[serde(flatten)]
    pub sizing: Sizing,
    pub layer: Option<Value>,
    pub columns: Option<f64>,
    pub gap: Option<f64>,
    pub align: Option<Align>,
    pub dir: Option<FlowDir>,
    pub anchor: Option<Anchor>,
    pub children: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbsoluteNode {
    #[serde(flatten)]
    pub sizing: Sizing,
    pub layer: Option<Value>,
    pub dir: Option<FlowDir>,
    pub anchor: Option<Anchor>,
    pub children: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CenterNode {
    #[serde(flatten)]
    pub sizing: Sizing,
    pub layer: Option<Value>,
    pub dir: Option<FlowDir>,
    pub anchor: Option<Anchor>,
    pub children: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacerNode {
    #[serde(flatten)]
    pub sizing: Sizing,
    pub size: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextNode {
    #[serde(flatten)]
    pub sizing: Sizing,
    pub layer: Option<Value>,
    pub anchor: Option<Anchor>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageNode {
    #[serde(flatten)]
    pub sizing: Sizing,
    pub layer: Option<Value>,
    pub fit: Option<Fit>,
    pub anchor: Option<Anchor>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentNode {
    #[serde(flatten)]
    pub sizing: Sizing,
    pub layer: Option<Value>,
    pub anchor: Option<Anchor>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DividerNode {
    #[serde(flatten)]
    pub sizing: Sizing,
    pub layer: Option<Value>,
    pub size: Option<f64>,
    pub anchor: Option<Anchor>,
}

/// The parsed tree: kind-specific serde payload plus the hand-validated fields.
#[derive(Debug, Clone)]
pub struct LayoutNode {
    pub kind: NodeKind,
    /// `[top, right, bottom, left]` px (§9.2 `padding`).
    pub padding: [f64; 4],
    /// Position of an `absolute` child (required there; `Err` in parse otherwise).
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// Offset of a `center` child.
    pub dx: f64,
    pub dy: f64,
    /// The rect to lay out within instead of the parent's slot (§9.2 `within`).
    pub within: Option<Within>,
    pub children: Vec<LayoutNode>,
}

#[derive(Debug, Clone)]
pub enum NodeKind {
    Stack(StackNode),
    Row(RowNode),
    Grid(GridNode),
    Absolute(AbsoluteNode),
    Center(CenterNode),
    Spacer(SpacerNode),
    Text(TextNode),
    Image(ImageNode),
    Component(ComponentNode),
    Divider(DividerNode),
}

/// §9.2 `within`: a layer (its content bounds are the box) or an explicit rect.
#[derive(Debug, Clone)]
pub enum Within {
    Layer(Value),
    Rect([f64; 4]),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ParentKind {
    Root,
    Flow,
    Absolute,
    Center,
}

impl ParentKind {
    fn of(kind: &str) -> Option<ParentKind> {
        match kind {
            "stack" | "row" | "grid" => Some(ParentKind::Flow),
            "absolute" => Some(ParentKind::Absolute),
            "center" => Some(ParentKind::Center),
            _ => None,
        }
    }
}

impl LayoutNode {
    fn kind_name(&self) -> &'static str {
        match &self.kind {
            NodeKind::Stack(_) => "stack",
            NodeKind::Row(_) => "row",
            NodeKind::Grid(_) => "grid",
            NodeKind::Absolute(_) => "absolute",
            NodeKind::Center(_) => "center",
            NodeKind::Spacer(_) => "spacer",
            NodeKind::Text(_) => "text",
            NodeKind::Image(_) => "image",
            NodeKind::Component(_) => "component",
            NodeKind::Divider(_) => "divider",
        }
    }

    fn sizing(&self) -> &Sizing {
        match &self.kind {
            NodeKind::Stack(n) => &n.sizing,
            NodeKind::Row(n) => &n.sizing,
            NodeKind::Grid(n) => &n.sizing,
            NodeKind::Absolute(n) => &n.sizing,
            NodeKind::Center(n) => &n.sizing,
            NodeKind::Spacer(n) => &n.sizing,
            NodeKind::Text(n) => &n.sizing,
            NodeKind::Image(n) => &n.sizing,
            NodeKind::Component(n) => &n.sizing,
            NodeKind::Divider(n) => &n.sizing,
        }
    }

    fn layer_ref(&self) -> Option<&Value> {
        match &self.kind {
            NodeKind::Spacer(_) => None,
            NodeKind::Stack(n) => n.layer.as_ref(),
            NodeKind::Row(n) => n.layer.as_ref(),
            NodeKind::Grid(n) => n.layer.as_ref(),
            NodeKind::Absolute(n) => n.layer.as_ref(),
            NodeKind::Center(n) => n.layer.as_ref(),
            NodeKind::Text(n) => n.layer.as_ref(),
            NodeKind::Image(n) => n.layer.as_ref(),
            NodeKind::Component(n) => n.layer.as_ref(),
            NodeKind::Divider(n) => n.layer.as_ref(),
        }
    }

    fn anchor(&self) -> Option<Anchor> {
        match &self.kind {
            NodeKind::Spacer(_) => None,
            NodeKind::Stack(n) => n.anchor,
            NodeKind::Row(n) => n.anchor,
            NodeKind::Grid(n) => n.anchor,
            NodeKind::Absolute(n) => n.anchor,
            NodeKind::Center(n) => n.anchor,
            NodeKind::Text(n) => n.anchor,
            NodeKind::Image(n) => n.anchor,
            NodeKind::Component(n) => n.anchor,
            NodeKind::Divider(n) => n.anchor,
        }
    }

    /// `dir` is inherited down the tree; a node may override it (§9.5 logical alignment).
    fn dir_override(&self) -> Option<FlowDir> {
        match &self.kind {
            NodeKind::Stack(n) => n.dir,
            NodeKind::Row(n) => n.dir,
            NodeKind::Grid(n) => n.dir,
            NodeKind::Absolute(n) => n.dir,
            NodeKind::Center(n) => n.dir,
            _ => None,
        }
    }

    fn is_container(&self) -> bool {
        matches!(self.kind, NodeKind::Stack(_) | NodeKind::Row(_) | NodeKind::Grid(_) | NodeKind::Absolute(_) | NodeKind::Center(_))
    }

    /// The flow axis: a `row` is horizontal, a `stack` follows `direction` (§9.2).
    fn flow_axis(&self) -> Axis {
        match &self.kind {
            NodeKind::Row(_) => Axis::Horizontal,
            NodeKind::Stack(n) => match n.direction {
                Some(Direction::Horizontal) | None => Axis::Vertical,  // §9.2: stack defaults vertical
                Some(Direction::Vertical) => Axis::Vertical,
                Some(Direction::Horizontal) => Axis::Horizontal,
            },
            _ => Axis::Vertical,
        }
    }

    fn align_or(&self, default: Align) -> Align {
        match &self.kind {
            NodeKind::Stack(n) => n.align.unwrap_or(default),
            NodeKind::Row(n) => n.align.unwrap_or(default),
            NodeKind::Grid(n) => n.align.unwrap_or(default),
            _ => default,
        }
    }

    /// Validated gap (0–256 px, §9.5); default 0.
    fn gap(&self) -> Result<f64> {
        let raw = match &self.kind {
            NodeKind::Stack(n) | NodeKind::Row(n) | NodeKind::Grid(n) => n.gap,
            _ => None,
        };
        match raw {
            None => Ok(0.0),
            Some(v) if !v.is_finite() => Err(bad(format!("`gap` must be a finite number (got {v})"))),
            Some(v) if !(0.0..=MAX_GAP).contains(&v) => Err(bad(format!("`gap` = {v} is outside 0–{MAX_GAP:.0} px (§9.5)"))),
            Some(v) => Ok(v),
        }
    }

    /// Validated column count (1–24, §9.5), whole numbers only.
    fn columns(&self) -> Result<usize> {
        match &self.kind {
            NodeKind::Grid(n) => match n.columns {
                None => Err(bad(format!("a `grid` needs `columns` (1–{MAX_COLUMNS})"))),
                Some(c) if !c.is_finite() => Err(bad(format!("`columns` must be a whole number 1–{MAX_COLUMNS} (got {c})"))),
                Some(c) if c.fract() != 0.0 || c < 1.0 || c > MAX_COLUMNS as f64 => {
                    Err(bad(format!("`columns` = {c} is outside 1–{MAX_COLUMNS} (§9.5)")))
                }
                Some(c) => Ok(c as usize),
            },
            _ => Err(bad("`columns` is only valid on a `grid` node")),
        }
    }

    /// `size`: the spacer's main-axis length (required) or a divider's thickness (default 1).
    fn size_px(&self) -> Result<f64> {
        match &self.kind {
            NodeKind::Spacer(n) => match n.size {
                Some(v) if v.is_finite() && (0.0..=MAX_PX).contains(&v) => Ok(v),
                Some(v) => Err(bad(format!("`size` = {v} is invalid (0–{MAX_PX:.0} px)"))),
                None => Err(bad("a `spacer` needs `size` (its main-axis length in px)")),
            },
            NodeKind::Divider(n) => match n.size {
                None => Ok(1.0),
                Some(v) if v.is_finite() && (0.0..=MAX_PX).contains(&v) => Ok(v),
                Some(v) => Err(bad(format!("`size` = {v} is invalid (0–{MAX_PX:.0} px)"))),
            },
            _ => Err(bad("`size` is only valid on `spacer` and `divider` nodes")),
        }
    }

    fn fit(&self) -> Fit {
        match &self.kind {
            NodeKind::Image(n) => n.fit.unwrap_or(Fit::Contain),
            _ => Fit::Contain,
        }
    }
}

// Note: or-patterns across the distinct serde struct kinds (`Stack(n) | Row(n)`) do not
// type-check — a binding must have one type in every alternative — so each kind gets its own
// arm in the accessors above.

// ---------- parsing (strict: unknown keys list the valid ones) ----------

fn keys_for(kind: &str, parent: ParentKind) -> Vec<&'static str> {
    let mut keys: Vec<&'static str> = KIND_KEYS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, ks)| *ks)
        .unwrap_or(&[])
        .to_vec();
    keys.extend_from_slice(SIZING_KEYS);
    keys.push("anchor");
    if parent == ParentKind::Absolute {
        keys.extend_from_slice(&["x", "y"]);
    }
    if parent == ParentKind::Center {
        keys.extend_from_slice(&["dx", "dy"]);
    }
    keys
}

fn from_value<T: for<'de> Deserialize<'de>>(kind: &str, v: &Value) -> Result<T> {
    serde_json::from_value::<T>(v.clone()).map_err(|e| {
        let msg = e.to_string();
        // The one typo the spec itself warns about (§9.5): physical left/right alignment.
        let hint = if msg.contains("`left`") || msg.contains("`right`") {
            " (§9.5: alignment is logical `start`/`end`, never bare `left`/`right`)"
        } else {
            ""
        };
        bad(format!("`{kind}` node: {msg}{hint}"))
    })
}

fn finite_px(v: Option<&Value>, key: &str) -> Result<f64> {
    let Some(v) = v else { return Err(bad(format!("`{key}` is required and missing"))); };
    let f = v.as_f64().filter(|f| f.is_finite()).ok_or_else(|| bad(format!("`{key}` must be a finite number, not {v}")))?;
    if f.abs() > MAX_PX {
        return Err(bad(format!("`{key}` = {f} is outside the ±{MAX_PX:.0} px coordinate range")));
    }
    Ok(f)
}

fn opt_finite_px(v: Option<&Value>, key: &str) -> Result<f64> {
    match v {
        None | Some(Value::Null) => Ok(0.0),
        Some(_) => finite_px(v, key),
    }
}

/// `padding`/`safeArea` sides: a number or 1/2/4 numbers, CSS order `[t, r, b, l]`, each side
/// 0–`max` (§9.5).
fn parse_sides(v: Option<&Value>, max: f64, key: &str) -> Result<[f64; 4]> {
    let one = |v: &Value| -> Result<f64> {
        let f = v.as_f64().filter(|f| f.is_finite()).ok_or_else(|| bad(format!("`{key}` must be finite numbers, not {v}")))?;
        if !(0.0..=max).contains(&f) {
            return Err(bad(format!("`{key}` = {f} is outside 0–{max:.0} px (§9.5)")));
        }
        Ok(f)
    };
    let Some(v) = v else { return Ok([0.0; 4]) };
    match v {
        Value::Array(a) => match a.len() {
            1 => {
                let x = one(a.get(0).ok_or_else(|| bad(format!("`{key}` must be 1, 2 or 4 numbers"))))?;
                Ok([x, x, x, x])
            }
            2 => {
                let (vh, lr) = (
                    one(a.get(0).ok_or_else(|| bad(format!("`{key}` must be 1, 2 or 4 numbers"))))?,
                    one(a.get(1).ok_or_else(|| bad(format!("`{key}` must be 1, 2 or 4 numbers"))))?,
                );
                Ok([vh, lr, vh, lr])
            }
            4 => {
                let g = || bad(format!("`{key}` must be 1, 2 or 4 numbers"));
                Ok([
                    one(a.get(0).ok_or_else(g)?)?,
                    one(a.get(1).ok_or_else(g)?)?,
                    one(a.get(2).ok_or_else(g)?)?,
                    one(a.get(3).ok_or_else(g)?)?,
                ])
            }
            n => Err(bad(format!("`{key}` must be one number or an array of 2 or 4, not {n}"))),
        },
        Value::Null => Ok([0.0; 4]),
        other => one(other).map(|x| [x, x, x, x]),
    }
}

fn parse_within(w: &Value) -> Result<Within> {
    match w {
        Value::Object(m) => {
            if m.len() == 1 && m.get("layer").is_some() {
                return Ok(Within::Layer(m.get("layer").ok_or_else(|| bad("`within` needs `layer`"))?.clone()));
            }
            Err(bad("`within` must be {\"layer\": id-or-name} or [x, y, w, h]"))
        }
        Value::Array(a) if a.len() == 4 => {
            let g = || bad("`within` must be [x, y, w, h] with finite numbers");
            let mut r = [0.0; 4];
            for (i, slot) in r.iter_mut().enumerate() {
                // `Some(..)` keeps finite_px's Option-taking signature; a bare `as Option<&Value>`
                // cast would not compile (invalid non-primitive cast).
                *slot = finite_px(Some(a.get(i).ok_or_else(g)?), "within")?;
            }
            if r[2] < 0.0 || r[3] < 0.0 {
                return Err(bad("`within` width and height must be ≥ 0"));
            }
            Ok(Within::Rect(r))
        }
        Value::Null => Err(bad("`within` must not be null")),
        _ => Err(bad("`within` must be {\"layer\": id-or-name} or [x, y, w, h]")),
    }
}

/// Parse and validate the whole §9.2 tree. Strict: unknown types, unknown keys, wrong types,
/// NaN/inf, out-of-range values, over-deep trees and oversized child lists are all `Err` with
/// the valid options listed — never a panic, never silent defaults.
pub fn parse_tree(v: &Value) -> Result<LayoutNode> {
    let mut nodes = 0usize;
    parse_node(v, ParentKind::Root, 0, &mut nodes)
}

fn parse_node(v: &Value, parent: ParentKind, depth: usize, nodes: &mut usize) -> Result<LayoutNode> {
    if depth >= MAX_DEPTH {
        return Err(bad(format!("the node tree nests deeper than {MAX_DEPTH} levels")));
    }
    *nodes = nodes.saturating_add(1);
    if *nodes > MAX_NODES {
        return Err(bad(format!("the node tree has more than {MAX_NODES} nodes")));
    }
    let Some(obj) = v.as_object() else {
        return Err(bad(format!("a layout node must be a JSON object, not {v}")));
    };
    let Some(kind) = obj.get("type").and_then(Value::as_str) else {
        return Err(bad(format!("a layout node needs a `type` ({KINDS})")));
    };
    let valid = keys_for(kind, parent);
    for key in obj.keys() {
        if key != "type" && !valid.contains(&key.as_str()) {
            return Err(bad(format!("unknown key `{key}` on a `{kind}` node; valid keys: type, {}", valid.join(", "))));
        }
    }
    let node = match kind {
        "stack" => NodeKind::Stack(from_value::<StackNode>(kind, v)?),
        "row" => NodeKind::Row(from_value::<RowNode>(kind, v)?),
        "grid" => NodeKind::Grid(from_value::<GridNode>(kind, v)?),
        "absolute" => NodeKind::Absolute(from_value::<AbsoluteNode>(kind, v)?),
        "center" => NodeKind::Center(from_value::<CenterNode>(kind, v)?),
        "spacer" => NodeKind::Spacer(from_value::<SpacerNode>(kind, v)?),
        "text" => NodeKind::Text(from_value::<TextNode>(kind, v)?),
        "image" => NodeKind::Image(from_value::<ImageNode>(kind, v)?),
        "component" => NodeKind::Component(from_value::<ComponentNode>(kind, v)?),
        "divider" => NodeKind::Divider(from_value::<DividerNode>(kind, v)?),
        other => return Err(bad(format!("unknown node type `{other}`; valid types: {KINDS}"))),
    };

    let padding = parse_sides(obj.get("padding"), MAX_SIDE, "padding")?;
    let (x, y) = if parent == ParentKind::Absolute {
        match (obj.get("x"), obj.get("y")) {
            (Some(xv), Some(yv)) => Some((finite_px(Some(xv), "x")?, finite_px(Some(yv), "y")?)),
            (None, _) => return Err(bad("an absolute child needs `x` and `y` (missing `x`)")),
            _ => return Err(bad("an absolute child needs `x` and `y` (missing `y`)")),
        }
    } else {
        None
    };
    let (dx, dy) = if parent == ParentKind::Center {
        (opt_finite_px(obj.get("dx"), "dx")?, opt_finite_px(obj.get("dy"), "dy")?)
    } else {
        (0.0, 0.0)
    };
    let within = match obj.get("within") {
        None | Some(Value::Null) => None,
        Some(w) => Some(parse_within(w)?),
    };

    // Kind-specific validation (§9.5 limits) before the tree goes near the solver.
    let sizing = match &node {
        NodeKind::Stack(n) => &n.sizing,
        NodeKind::Row(n) => &n.sizing,
        NodeKind::Grid(n) => &n.sizing,
        NodeKind::Absolute(n) => &n.sizing,
        NodeKind::Center(n) => &n.sizing,
        NodeKind::Spacer(n) => &n.sizing,
        NodeKind::Text(n) => &n.sizing,
        NodeKind::Image(n) => &n.sizing,
        NodeKind::Component(n) => &n.sizing,
        NodeKind::Divider(n) => &n.sizing,
    };
    sizing.validate()?;
    // gap/columns/size validated by their accessors; do it now so the tree is trusted later.
    let as_node = LayoutNode { kind: node, padding, x, y, dx, dy, within, children: Vec::new() };
    if matches!(as_node.kind, NodeKind::Stack(_) | NodeKind::Row(_) | NodeKind::Grid(_)) {
        as_node.gap()?;
    }
    if matches!(as_node.kind, NodeKind::Grid(_)) {
        as_node.columns()?;
    }
    if matches!(as_node.kind, NodeKind::Spacer(_) | NodeKind::Divider(_)) {
        as_node.size_px()?;
    }
    for leaf in ["text", "image", "component"] {
        if as_node.kind_name() == leaf && as_node.layer_ref().is_none() {
            return Err(bad(format!("a `{leaf}` node needs `layer` (an id or a name)")));
        }
    }

    // Containers need a non-empty, bounded child list; leaves may not carry children at all
    // (the key check above already rejects the key on leaves).
    let mut children = Vec::new();
    if let Some(raw) = match &as_node.kind {
        NodeKind::Stack(n) => n.children.as_deref(),
        NodeKind::Row(n) => n.children.as_deref(),
        NodeKind::Grid(n) => n.children.as_deref(),
        NodeKind::Absolute(n) => n.children.as_deref(),
        NodeKind::Center(n) => n.children.as_deref(),
        _ => None,
    } {
        if raw.is_empty() {
            return Err(bad(format!("a `{}` node needs at least one child (§9.2)", as_node.kind_name())));
        }
        if raw.len() > MAX_CHILDREN {
            return Err(bad(format!("a `{}` node has {} children (max {MAX_CHILDREN})", as_node.kind_name(), raw.len())));
        }
        let child_parent = ParentKind::of(as_node.kind_name()).unwrap_or(ParentKind::Flow);
        for c in raw {
            children.push(parse_node(c, child_parent, depth + 1, nodes)?);
        }
    } else if as_node.is_container() {
        return Err(bad(format!("a `{}` node needs `children` (§9.2)", as_node.kind_name())));
    }
    let LayoutNode { kind, padding: p, x, y, dx, dy, within: w, .. } = as_node;
    Ok(LayoutNode { kind, padding: p, x, y, dx, dy, within: w, children })
}

// ---------- options (§9.2) ----------

#[derive(Debug, Clone, Copy)]
pub struct ApplyOptions {
    pub space: Space,
    /// `safeArea` inset `[t, r, b, l]` px.
    pub safe: [f64; 4],
    /// Root writing direction, inherited unless a node overrides `dir`.
    pub dir: FlowDir,
}

impl ApplyOptions {
    pub fn parse(p: &Value) -> Result<Self> {
        let mut o = ApplyOptions { space: Space::Document, safe: [0.0; 4], dir: FlowDir::Ltr };
        match p.get("options") {
            None | Some(Value::Null) => return Ok(o),
            Some(v) if v.is_object() => {}
            Some(v) => return Err(bad(format!("`options` must be a JSON object, not {v}"))),
        }
        let obj = p.get("options").and_then(Value::as_object).ok_or_else(|| bad("`options` must be a JSON object"))?;
        for (key, val) in obj {
            match key.as_str() {
                "coordinateSpace" => {
                    o.space = match val.as_str() {
                        Some("document") => Space::Document,
                        Some("parent") => Space::Parent,
                        _ => return Err(bad(format!("`options.coordinateSpace` must be \"document\" or \"parent\", not {val}"))),
                    };
                }
                "safeArea" => o.safe = parse_sides(Some(val), MAX_SIDE, "safeArea")?,
                "dir" => {
                    o.dir = match val.as_str() {
                        Some("ltr") => FlowDir::Ltr,
                        Some("rtl") => FlowDir::Rtl,
                        _ => return Err(bad(format!("`options.dir` must be \"ltr\" or \"rtl\", not {val}"))),
                    }
                }
                other => {
                    return Err(bad(format!("unknown `options` key `{other}`; valid keys: coordinateSpace, safeArea, dir")));
                }
            }
        }
        Ok(o)
    }
}

// ---------- the text metrics seam (implemented by the measure module, fit_text.rs) ----------

/// Text metrics for `hug` sizing on `text` nodes (§9.2): the pure solver measures wrapped text
/// through this trait instead of the engine's text stack. The engine implementation lives in
/// `fit_text.rs` (see this file's module docs for the exact `impl` block to write there) —
/// one home for everything that calls the text metrics.
pub trait TextMeasurer {
    /// The `(width, height)` the text of `layer` occupies at its current size, wrapped to at
    /// most `max_width` px. Deterministic per layer + document revision (§9.5); `Err` when the
    /// layer has no measurable text (not a type layer, empty text, no font) — the solver turns
    /// that into an error that tells the caller to size the node explicitly.
    fn measure_text(&self, layer: LayerId, max_width: f64) -> Result<(f64, f64)>;
}

/// The engine-side [`TextMeasurer`], bound to a document. Defined here so the solver and the
/// measure module share one concrete type (the `impl` belongs with the measure commands).
pub struct EngineTextMeasurer<'a> {
    pub doc: &'a Document,
}

// ---------- solver geometry ----------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Axis {
    Vertical,
    Horizontal,
}

/// Float rect in document px; placements are rounded to whole pixels when recorded.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RectF {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl RectF {
    fn from_rect(r: Rect) -> Self {
        RectF { x: f64::from(r.x0), y: f64::from(r.y0), w: f64::from(r.width()), h: f64::from(r.height()) }
    }
    fn x1(&self) -> f64 {
        self.x + self.w
    }
    fn y1(&self) -> f64 {
        self.y + self.h
    }
    fn empty(&self) -> bool {
        self.w <= 0.0 || self.h <= 0.0
    }
    /// Shrink by `[t, r, b, l]`, never past empty (§9.2 `padding`).
    fn inset(&self, p: &[f64; 4]) -> RectF {
        RectF {
            x: self.x + p[3],
            y: self.y + p[0],
            w: (self.w - p[3] - p[1]).max(0.0),
            h: (self.h - p[0] - p[2]).max(0.0),
        }
    }
    /// The overlap with `o`; an empty result sits at the clamped origin with zero extent.
    fn intersect(&self, o: &RectF) -> RectF {
        let (x, y) = (self.x.max(o.x), self.y.max(o.y));
        RectF { x, y, w: (self.x1().min(o.x1()) - x).max(0.0), h: (self.y1().min(o.y1()) - y).max(0.0) }
    }
}

fn extent(rect: &RectF, axis: Axis) -> f64 {
    if axis == Axis::Vertical { rect.h } else { rect.w }
}

/// One solved leaf position, whole-pixel, already clamped to the canvas ∩ safe area.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct Placement {
    pub layer: LayerId,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

struct Solver<'a> {
    usable: RectF,
    space: Space,
    resolve: &'a dyn Fn(&Value) -> Result<LayerId>,
    bounds: &'a dyn Fn(LayerId) -> Option<Rect>,
    text: &'a dyn TextMeasurer,
    /// Layers placed so far — a layer may be positioned once, ever (BTreeSet: deterministic).
    seen: BTreeSet<u64>,
    placements: Vec<Placement>,
    warnings: Vec<String>,
}

impl Solver<'_> {
    fn leaf_id(&self, node: &LayoutNode) -> Result<LayerId> {
        let Some(v) = node.layer_ref() else {
            return Err(bad(format!("a `{}` node needs `layer`", node.kind_name())));
        };
        (self.resolve)(v)
    }

    fn measure(&self, id: LayerId, max_width: f64) -> Result<(f64, f64)> {
        self.text.measure_text(id, max_width).map_err(|e| bad(format!("measuring text of layer {}: {e}", id.0)))
    }

    /// Natural (main, cross) size of `node` within `slot`, before grow distribution:
    /// fixed dims and `percent` are applied by the caller; this is the content-measured
    /// fallback (§9.2 hug / passthrough).
    fn natural(&mut self, node: &LayoutNode, slot: &RectF, axis: Axis) -> Result<(f64, f64)> {
        let s = node.sizing();
        let (m, c) = match &node.kind {
            NodeKind::Spacer(_) => (node.size_px()?, 0.0),
            // A rule spans the slot crosswise (a divider inside a vertical stack is horizontal).
            NodeKind::Divider(_) => (node.size_px()?, extent(slot, if axis == Axis::Vertical { Axis::Horizontal } else { Axis::Vertical })),
            NodeKind::Stack(_) | NodeKind::Row(_) => self.flow_natural(node)?,
            NodeKind::Grid(_) | NodeKind::Absolute(_) | NodeKind::Center(_) => self.box_natural(node)?,
            NodeKind::Text(_) | NodeKind::Image(_) | NodeKind::Component(_) => self.leaf_natural(node, slot, axis)?,
        };
        let fixed_main = if axis == Axis::Vertical { s.height } else { s.width };
        let fixed_cross = if axis == Axis::Vertical { s.width } else { s.height };
        let percent_main = match s.percent {
            Some(p) => {
                let base = extent(slot, axis);
                if base <= 0.0 {
                    let _ = p;
                    None // percent of an unbounded/hugged parent: no defined share
                } else {
                    Some(p * 0.01 * base)
                }
            }
            None => None,
        };
        if s.percent.is_some() && percent_main.is_none() {
            self.warnings.push(format!("`percent` on a `{}` node has no parent size to share (its container hugs its content); treated as unset", node.kind_name()));
        }
        let main = fixed_main.or(percent_main).unwrap_or(m);
        let mut cross = fixed_cross.unwrap_or(c);
        // `aspect` (w/h) derives whichever side is free (§9.2).
        if let Some(ar) = s.aspect {
            if fixed_main.is_some() && fixed_cross.is_none() {
                cross = if axis == Axis::Vertical { main * ar } else { main / ar };
            } else if fixed_main.is_none() && fixed_cross.is_some() {
                cross = if axis == Axis::Vertical { main * ar } else { main / ar }; // keep; main recomputed below
            } else if fixed_main.is_none() && fixed_cross.is_none() {
                cross = if axis == Axis::Vertical { main * ar } else { main / ar };
            }
        }
        let (mut w, mut h) = if axis == Axis::Vertical { (cross, main) } else { (main, cross) };
        s.clamp(&mut w, &mut h);
        Ok(if axis == Axis::Vertical { (h, w) } else { (w, h) })
    }

    /// Hug content of a flow container: padding + children naturals + gaps along its own axis,
    /// padding + the widest/tallest child across.
    fn flow_natural(&mut self, node: &LayoutNode) -> Result<(f64, f64)> {
        let s = node.sizing();
        let own_axis = node.flow_axis();
        let pad = &node.padding;
        let gap = node.gap()?;
        // Percent children of a hugged container have no defined parent size; pass the
        // container's fixed content box, else an empty one (warned in `natural`).
        let inner = RectF {
            x: 0.0,
            y: 0.0,
            w: (s.width.unwrap_or(0.0) - pad[3] - pad[1]).max(0.0),
            h: (s.height.unwrap_or(0.0) - pad[0] - pad[2]).max(0.0),
        };
        let (mut main, mut cross) = match own_axis {
            Axis::Vertical => (pad[0] + pad[2], pad[3] + pad[1]),
            Axis::Horizontal => (pad[3] + pad[1], pad[0] + pad[2]),
        };
        let cross_pad = cross;
        for (i, child) in node.children.iter().enumerate() {
            let (cm, cc) = self.natural(child, &inner, own_axis)?;
            if i > 0 {
                main += gap;
            }
            main += cm;
            cross = cross.max(cross_pad + cc);
        }
        Ok((main, cross))
    }

    /// Hug content of grid/absolute/center: padding + the largest child, both axes. (A grid's
    /// cell size depends on its box, so hugging one is an approximation — warned, deterministic.)
    fn box_natural(&mut self, node: &LayoutNode) -> Result<(f64, f64)> {
        let s = node.sizing();
        let pad = &node.padding;
        let inner = RectF {
            x: 0.0,
            y: 0.0,
            w: (s.width.unwrap_or(0.0) - pad[3] - pad[1]).max(0.0),
            h: (s.height.unwrap_or(0.0) - pad[0] - pad[2]).max(0.0),
        };
        let mut w = pad[3] + pad[1];
        let mut h = pad[0] + pad[2];
        for child in node.children.iter() {
            let (cw, ch) = self.natural(child, &inner, Axis::Horizontal)?;
            w = w.max(pad[3] + pad[1] + cw);
            h = h.max(pad[0] + pad[2] + ch);
        }
        if matches!(node.kind, NodeKind::Grid(_)) {
            self.warnings.push("a `grid` that hugs its content is approximate (padding + largest child)".into());
        }
        Ok((w, h))
    }

    /// Content natural size of a leaf: text measures through the [`TextMeasurer`] seam when it
    /// hugs (§9.2); everything else passes its current content bounds through.
    fn leaf_natural(&mut self, node: &LayoutNode, slot: &RectF, axis: Axis) -> Result<(f64, f64)> {
        let s = node.sizing();
        let id = self.leaf_id(node)?;
        let cross_avail = extent(slot, if axis == Axis::Vertical { Axis::Horizontal } else { Axis::Vertical });
        let (bw, bh) = match &node.kind {
            NodeKind::Text(_) if s.hug.unwrap_or(false) => self.measure(id, cross_avail)?,
            _ => match (self.bounds)(id) {
                Some(r) => {
                    let f = RectF::from_rect(r);
                    (f.w, f.h)
                }
                None if matches!(node.kind, NodeKind::Text(_)) => self.measure(id, cross_avail)?,
                None => {
                    return Err(bad(format!(
                        "layer {} has no content to place; give the `{}` node `width`/`height` (or `hug` it as text) or paint the layer first",
                        id.0,
                        node.kind_name()
                    )))
                }
            },
        };
        Ok(if axis == Axis::Vertical { (bh, bw) } else { (bw, bh) })
    }

    /// The box a node lays its children out in: its `within` rect/layer (document space) when
    /// given, else the parent's slot minus its own padding; always ∩ the safe area.
    fn content_box(&self, node: &LayoutNode, slot: &RectF) -> Result<RectF> {
        let base = match (&node.within, node.layer_ref().filter(|_| node.is_container())) {
            (Some(within), _) => match within {
                Within::Layer(v) => {
                    let id = (self.resolve)(v)?;
                    let Some(r) = (self.bounds)(id) else {
                        return Err(bad(format!("the `within` layer {} has no content bounds to lay out inside", id.0)));
                    };
                    RectF::from_rect(r)
                }
                Within::Rect(r) => match self.space {
                    Space::Document => RectF { x: r[0], y: r[1], w: r[2], h: r[3] },
                    Space::Parent => RectF { x: slot.x + r[0], y: slot.y + r[1], w: r[2], h: r[3] },
                },
            },
            (None, Some(v)) => {
                // A container's `layer` is `within` by that layer (§9.2 shorthand).
                let id = (self.resolve)(v)?;
                let Some(r) = (self.bounds)(id) else {
                    return Err(bad(format!("the `within` layer {} has no content bounds to lay out inside", id.0)));
                };
                RectF::from_rect(r)
            }
            (None, None) => *slot,
        };
        let content = base.inset(&node.padding).intersect(&self.usable);
        if content.empty() {
            return Err(bad(format!(
                "the `{}` node has no usable box: its `within`/slot minus padding, intersected with the safe area, is empty",
                node.kind_name()
            )));
        }
        Ok(content)
    }

    fn solve_node(&mut self, node: &LayoutNode, slot: RectF, inherited_dir: FlowDir) -> Result<()> {
        let dir = node.dir_override().unwrap_or(inherited_dir);
        if matches!(node.kind, NodeKind::Spacer(_)) {
            return Ok(()); // pure space; nothing to move
        }
        if !node.is_container() {
            // A leaf at the root / under absolute or center lands at the slot's start corner
            // with its natural size (those parents place leaves through their own layout).
            let content = self.content_box(node, &slot)?;
            let (w, h) = self.natural(node, &content, Axis::Horizontal)?;
            let s = node.sizing();
            let (mut w, mut h) = (w, h);
            s.clamp(&mut w, &mut h);
            let rect = RectF { x: content.x, y: content.y, w, h };
            self.place_leaf(node, rect, dir)
        } else {
            let content = self.content_box(node, &slot)?;
            match &node.kind {
                NodeKind::Stack(_) | NodeKind::Row(_) => self.layout_flow(node, content, node.flow_axis(), dir),
                NodeKind::Grid(_) => self.layout_grid(node, content, dir),
                NodeKind::Absolute(_) => self.layout_absolute(node, content, dir),
                NodeKind::Center(_) => self.layout_center(node, content, dir),
                _ => Ok(()),
            }
        }
    }

    /// stack/row: children flow along `axis` with `gap`, cross-positioned by `align`
    /// (start|center|end|stretch, logical start/end — §9.2/§9.5). Growers share what is left
    /// after fixed/percent/hug children (§9.2 grow), never shrinking below their natural size.
    fn layout_flow(&mut self, node: &LayoutNode, content: RectF, axis: Axis, dir: FlowDir) -> Result<()> {
        let align = node.align_or(Align::Start);
        let gap = node.gap()?;
        let children = &node.children;
        let n = children.len();
        let content_main = extent(&content, axis);
        let content_cross = extent(&content, if axis == Axis::Vertical { Axis::Horizontal } else { Axis::Vertical });

        let mut naturals: Vec<(f64, f64)> = Vec::with_capacity(n);
        let mut grows: Vec<Option<f64>> = Vec::with_capacity(n);
        for child in children.iter() {
            naturals.push(self.natural(child, &content, axis)?);
            grows.push(child.sizing().grow()?);
        }
        let total_grow: f64 = grows.iter().flatten().sum();
        let taken: f64 = naturals
            .iter()
            .zip(grows.iter())
            .filter(|(_, g)| g.is_none())
            .map(|((m, _), _)| *m)
            .sum();
        let gaps = gap * n.saturating_sub(1) as f64;
        let leftover = content_main - gaps - taken;
        if leftover < -0.5 {
            self.warnings
                .push(format!("children overflow the `{}` by {:-.0} px; everything stays clamped inside the safe area", node.kind_name(), -leftover));
        }

        let forward = !(dir == FlowDir::Rtl && axis == Axis::Horizontal);
        let mut cursor = if axis == Axis::Vertical || forward { extent_origin(&content, axis) } else { content_main_origin_end(&content, axis) };
        for ((child, (nat_main, nat_cross)), grow) in children.iter().zip(naturals.iter()).zip(grows.iter()) {
            let main = match grow {
                Some(w) if total_grow > 0.0 => nat_main + w / total_grow * leftover.max(0.0),
                _ => *nat_main,
            };
            // Cross side: stretch fills the container, fixed/aspect keep their own size, a
            // divider always spans the content (a rule has no reason to hug crosswise).
            let s = child.sizing();
            let fixed_cross = if axis == Axis::Vertical { s.width } else { s.height };
            let mut cross = match (&child.kind, align) {
                (NodeKind::Divider(_), _) => content_cross,
                (_, Align::Stretch) => fixed_cross.unwrap_or(content_cross),
                _ => fixed_cross.unwrap_or(*nat_cross),
            };
            if let Some(ar) = s.aspect && fixed_cross.is_none() {
                cross = if axis == Axis::Vertical { main * ar } else { main / ar };
            }
            let (mut w, mut h) = if axis == Axis::Vertical { (cross, main) } else { (main, cross) };
            s.clamp(&mut w, &mut h);
            let (main_c, cross_c) = if axis == Axis::Vertical { (h, w) } else { (w, h) };
            let origin_main = if forward { cursor } else { cursor - main_c };
            cursor = if forward { origin_main + main_c + gap } else { origin_main - gap };
            let cross_pos = cross_position(&content, axis, align, dir, cross_c);
            let outer = match axis {
                Axis::Vertical => RectF { x: cross_pos, y: origin_main, w: cross_c, h: main_c },
                Axis::Horizontal => RectF { x: origin_main, y: cross_pos, w: main_c, h: cross_c },
            };
            self.dispatch_child(child, outer, dir)?;
        }
        Ok(())
    }

    /// grid: `columns` cells per row, `gap` both axes, rows wrap automatically (§9.2). Cells
    /// tile the content box; children `stretch` to their cell by default (CSS-like).
    fn layout_grid(&mut self, node: &LayoutNode, content: RectF, dir: FlowDir) -> Result<()> {
        let cols = node.columns()?;
        let gap = node.gap()?;
        let align = node.align_or(Align::Stretch);
        let n = node.children.len();
        let rows = (n + cols - 1) / cols;
        let cell_w = ((content.w - gap * (cols.saturating_sub(1)) as f64) / cols as f64).max(0.0);
        let cell_h = ((content.h - gap * (rows.saturating_sub(1)) as f64) / rows as f64).max(0.0);
        for (i, child) in node.children.iter().enumerate() {
            let (row, col) = (i / cols, i % cols);
            let col = if dir == FlowDir::Rtl { cols - 1 - col } else { col };
            let cell = RectF {
                x: content.x + col as f64 * (cell_w + gap),
                y: content.y + row as f64 * (cell_h + gap),
                w: cell_w,
                h: cell_h,
            };
            let s = child.sizing();
            let (mut w, mut h) = if align == Align::Stretch && s.width.is_none() && s.height.is_none() && s.aspect.is_none() {
                (cell.w, cell.h)
            } else {
                let (mw, mh) = self.natural(child, &cell, Axis::Horizontal)?;
                (mw, mh)
            };
            s.clamp(&mut w, &mut h);
            let px = match align {
                Align::Start if dir == FlowDir::Rtl => cell.x1() - w,
                Align::Start => cell.x,
                Align::Center => cell.x + (cell.w - w) / 2.0,
                Align::End if dir == FlowDir::Rtl => cell.x,
                Align::End => cell.x1() - w,
                Align::Stretch => cell.x + (cell.w - w) / 2.0,
            };
            let py = match align {
                Align::Start => cell.y,
                Align::Center | Align::Stretch => cell.y + (cell.h - h) / 2.0,
                Align::End => cell.y1() - h,
            };
            self.dispatch_child(child, RectF { x: px, y: py, w, h }, dir)?;
        }
        Ok(())
    }

    /// absolute: children are placed at explicit `x`/`y` (document or parent space,
    /// §9.2 `coordinateSpace`) with their 9-point anchor at that point.
    fn layout_absolute(&mut self, node: &LayoutNode, content: RectF, dir: FlowDir) -> Result<()> {
        for child in node.children.iter() {
            let Some(x) = child.x else { return Err(bad("an absolute child needs `x` and `y`")) };
            let Some(y) = child.y else { return Err(bad("an absolute child needs `x` and `y`")) };
            if child.sizing().grow()?.is_some() {
                self.warnings.push("`grow` has no effect inside `absolute` (there is no flow to share)".into());
            }
            let (ox, oy) = match self.space {
                Space::Document => (0.0, 0.0),
                Space::Parent => (content.x, content.y),
            };
            let (mut w, mut h) = self.natural(child, &content, Axis::Horizontal)?;
            child.sizing().clamp(&mut w, &mut h);
            let anchor = child.anchor().unwrap_or(Anchor::TopLeft);
            let (ax, ay) = (x + ox, y + oy);
            let rect = anchored(anchor, ax, ay, w, h);
            self.dispatch_child(child, rect, dir)?;
        }
        Ok(())
    }

    /// center: children are centered in the box (their anchor point at the centre, plus
    /// per-child `dx`/`dy` offsets).
    fn layout_center(&mut self, node: &LayoutNode, content: RectF, dir: FlowDir) -> Result<()> {
        let (cx, cy) = (content.x + content.w / 2.0, content.y + content.h / 2.0);
        for child in node.children.iter() {
            let (mut w, mut h) = self.natural(child, &content, Axis::Horizontal)?;
            child.sizing().clamp(&mut w, &mut h);
            let anchor = child.anchor().unwrap_or(Anchor::Center);
            let rect = anchored(anchor, cx + child.dx, cy + child.dy, w, h);
            self.dispatch_child(child, rect, dir)?;
        }
        Ok(())
    }

    fn dispatch_child(&mut self, child: &LayoutNode, outer: RectF, dir: FlowDir) -> Result<()> {
        if child.is_container() {
            self.solve_node(child, outer, dir)
        } else {
            self.place_leaf(child, outer, dir)
        }
    }

    /// Record a leaf's final rect: `fit` for images, clamped to the canvas ∩ safe area
    /// (§9.2: `layout.apply` never produces out-of-bounds layers), rounded to whole pixels.
    fn place_leaf(&mut self, node: &LayoutNode, rect: RectF, dir: FlowDir) -> Result<()> {
        if matches!(node.kind, NodeKind::Spacer(_)) {
            return Ok(());
        }
        let id = self.leaf_id(node)?;
        let mut rect = rect;
        if matches!(node.kind, NodeKind::Image(_)) {
            rect = self.fit_image(node, id, rect)?;
        }
        let _ = dir;
        if rect.x < self.usable.x - 0.5
            || rect.y < self.usable.y - 0.5
            || rect.x1() > self.usable.x1() + 0.5
            || rect.y1() > self.usable.y1() + 0.5
        {
            self.warnings.push(format!(
                "layer {} is clamped to the canvas safe area ({} × {} → {} × {})",
                id.0,
                rect.w.max(0.0),
                rect.h.max(0.0),
                rect.intersect(&self.usable).w,
                rect.intersect(&self.usable).h
            ));
        }
        let clamped = rect.intersect(&self.usable);
        if clamped.empty() {
            self.warnings.push(format!("layer {}'s slot is outside the safe area; left untouched", id.0));
            return Ok(());
        }
        let (x, y, w, h) = round_whole(&clamped);
        if w <= 0 || h <= 0 {
            self.warnings.push(format!("layer {}'s slot collapses to zero at whole pixels; left untouched", id.0));
            return Ok(());
        }
        if !self.seen.insert(id.0) {
            return Err(bad(format!("layer {} is placed by more than one node; a layer has one position", id.0)));
        }
        self.placements.push(Placement { layer: id, x, y, w, h });
        Ok(())
    }

    /// §9.2 image `fit`: `fill` stretches to the slot, `contain` fits inside preserving the
    /// aspect (centered), `cover` fills and overflows symmetrically (the engine has no per-node
    /// clipping, so cover-overflow stays visible but clamped, with a warning).
    fn fit_image(&mut self, node: &LayoutNode, id: LayerId, rect: RectF) -> Result<RectF> {
        let s = node.sizing();
        let ar = match s.aspect {
            Some(a) => a,
            None => {
                let Some(r) = (self.bounds)(id) else {
                    return Ok(rect); // no content yet: fall through to the raw slot
                };
                let f = RectF::from_rect(r);
                if f.w > 0.0 && f.h > 0.0 { f.w / f.h } else { return Ok(rect) }
            }
        };
        if rect.w <= 0.0 || rect.h <= 0.0 {
            return Ok(rect);
        }
        let (w, h) = match node.fit() {
            Fit::Fill => (rect.w, rect.h),
            Fit::Contain => {
                if rect.w / rect.h > ar {
                    (rect.h * ar, rect.h)
                } else {
                    (rect.w, rect.w / ar)
                }
            }
            Fit::Cover => {
                if rect.w / rect.h > ar {
                    (rect.w, rect.w / ar)
                } else {
                    (rect.h * ar, rect.h)
                }
            }
        };
        let out = RectF { x: rect.x + (rect.w - w) / 2.0, y: rect.y + (rect.h - h) / 2.0, w, h };
        if matches!(node.fit(), Fit::Cover) && (out.w > rect.w + 0.5 || out.h > rect.h + 0.5) {
            self.warnings.push(format!(
                "image layer {} `cover`s its slot and overflows by {:.0} × {:.0} px (use a clipping group to crop; clamped to the canvas)",
                id.0,
                (out.w - rect.w).max(0.0),
                (out.h - rect.h).max(0.0)
            ));
        }
        Ok(out)
    }
}

fn extent_origin(rect: &RectF, axis: Axis) -> f64 {
    if axis == Axis::Vertical { rect.y } else { rect.x }
}

/// The far edge an rtl flow starts from.
fn content_main_origin_end(rect: &RectF, axis: Axis) -> f64 {
    if axis == Axis::Vertical { rect.y1() } else { rect.x1() }
}

/// Logical cross-axis position (§9.5): `start` is the leading edge — the right edge in rtl.
fn cross_position(content: &RectF, axis: Axis, align: Align, dir: FlowDir, cross: f64) -> f64 {
    let (lo, hi) = if axis == Axis::Vertical { (content.x, content.x1()) } else { (content.y, content.y1()) };
    let extent_all = hi - lo;
    match align {
        Align::Stretch => lo,
        Align::Center => lo + (extent_all - cross) / 2.0,
        Align::Start if dir == FlowDir::Rtl && axis == Axis::Vertical => hi - cross,
        Align::Start => lo,
        Align::End if dir == FlowDir::Rtl && axis == Axis::Vertical => lo,
        Align::End => hi - cross,
    }
}

/// The rect whose `anchor` point sits at (`ax`, `ay`) (§9.2 anchors: 9-point + baseline).
fn anchored(anchor: Anchor, ax: f64, ay: f64, w: f64, h: f64) -> RectF {
    let (mut x, mut y) = (ax, ay);
    match anchor {
        Anchor::TopLeft | Anchor::Left | Anchor::BottomLeft => x = ax,
        Anchor::Top | Anchor::Center | Anchor::Bottom | Anchor::Baseline => x = ax - w / 2.0,
        Anchor::TopRight | Anchor::Right | Anchor::BottomRight => x = ax - w,
    }
    match anchor {
        Anchor::TopLeft | Anchor::Top | Anchor::TopRight => y = ay,
        Anchor::Left | Anchor::Center | Anchor::Right => y = ay - h / 2.0,
        Anchor::BottomLeft | Anchor::Bottom | Anchor::BottomRight | Anchor::Baseline => y = ay - h,
    }
    RectF { x, y, w, h }
}

/// Round to whole pixels by edges (x0 and x1 round independently), so `x + w` stays consistent
/// with the drawn edge — the engine moves and transforms in whole pixels.
fn round_whole(r: &RectF) -> (f64, f64, f64, f64) {
    let x0 = r.x.round();
    let y0 = r.y.round();
    let w = (r.x1().round() - x0).max(0.0);
    let h = (r.y1().round() - y0).max(0.0);
    (x0, y0, w, h)
}

// ---------- the public pure solve (§9.2/§9.5) ----------

/// Solve `root` inside `container` (the document canvas; the safe area insets it). `bounds`
/// passes current layer content bounds through (hug/passthrough), `resolve` turns `layer`
/// refs (id or name) into ids, `text` measures text through the metrics seam. Returns the
/// whole-pixel placements, clamped to the canvas ∩ safe area, in deterministic document order.
pub fn solve(
    root: &LayoutNode,
    container: Rect,
    options: &ApplyOptions,
    bounds: &dyn Fn(LayerId) -> Option<Rect>,
    resolve: &dyn Fn(&Value) -> Result<LayerId>,
    text: &dyn TextMeasurer,
) -> Result<Vec<Placement>> {
    Ok(solve_with_warnings(root, container, options, bounds, resolve, text)?.0)
}

/// [`solve`] plus the warnings the tree accumulated (overflow, clamping, cover, ignored
/// sizing keys) — what `layout.apply` reports as `warnings` (§9.4).
pub fn solve_with_warnings(
    root: &LayoutNode,
    container: Rect,
    options: &ApplyOptions,
    bounds: &dyn Fn(LayerId) -> Option<Rect>,
    resolve: &dyn Fn(&Value) -> Result<LayerId>,
    text: &dyn TextMeasurer,
) -> Result<(Vec<Placement>, Vec<String>)> {
    let canvas = RectF::from_rect(container);
    let usable = canvas.inset(&options.safe);
    if usable.empty() {
        return Err(bad(format!(
            "`safeArea` (t{} r{} b{} l{}) leaves no usable canvas in a {} × {} px document",
            options.safe[0],
            options.safe[1],
            options.safe[2],
            options.safe[3],
            canvas.w,
            canvas.h
        )));
    }
    let mut solver = Solver { usable, space: options.space, resolve, bounds, text, seen: BTreeSet::new(), placements: Vec::new(), warnings: Vec::new() };
    let slot = solver.content_box(root, &usable)?;
    solver.solve_node(root, slot, options.dir)?;
    Ok((solver.placements, solver.warnings))
}

// ---------- layer references (§9.2 `layer`: id or name) ----------

/// Resolve a `layer` ref against the document: an id must exist; a name must match exactly one
/// layer (ambiguity is an error listing the candidates — ids are unambiguous, use those).
fn resolve_layer(doc: &Document, v: &Value) -> Result<LayerId> {
    match v {
        Value::Number(n) => {
            let Some(id) = n.as_u64() else {
                return Err(bad(format!("`layer` = {v} is not a valid id (a non-negative integer)")));
            };
            if doc.layer(LayerId(id)).is_none() {
                return Err(bad(format!("no layer with id {id}; {}", crate::commands::layer_listing(doc))));
            }
            Ok(LayerId(id))
        }
        Value::String(name) => {
            if name.is_empty() {
                return Err(bad("`layer` must be an id or a name, not an empty string"));
            }
            let walked = doc.walk();
            let mut top_down: Vec<&photocraft_doc::Layer> = walked.iter().rev().map(|(_, _, l)| *l).collect();
            top_down.retain(|l| l.name == *name);
            let mut exact: Vec<(LayerId, String)> = top_down.iter().map(|l| (l.id, l.name.clone())).collect();
            if exact.is_empty() {
                let lower = name.to_lowercase();
                let walked = doc.walk();
                exact = walked
                    .iter()
                    .rev()
                    .map(|(_, _, l)| *l)
                    .filter(|l| l.name.to_lowercase() == lower)
                    .map(|l| (l.id, l.name.clone()))
                    .collect();
            }
            match exact.len() {
                0 => Err(bad(format!("no layer named {name:?}; {}", crate::commands::layer_listing(doc)))),
                1 => match exact.pop() {
                    Some((id, _)) => Ok(id),
                    None => Err(bad(format!("no layer named {name:?}"))),
                },
                many => {
                    let candidates: Vec<String> = exact.iter().map(|(id, n)| format!("{id:?} \"{n}\"")).collect();
                    Err(bad(format!(
                        "{name:?} matches {many} layers ({});
give the layer id instead, or make the name unique",
                        candidates.join(", ")
                    )))
                }
            }
        }
        _ => Err(bad(format!("`layer` must be an id or a name, not {v}"))),
    }
}

/// §9.5 transactional guard: a layer placed inside a group that is itself placed would move
/// twice (the group transform carries its children). Refuse instead — nothing has moved yet.
fn check_nesting(doc: &Document, placements: &[Placement]) -> Result<()> {
    let mut paths: Vec<(Vec<usize>, LayerId)> = Vec::with_capacity(placements.len());
    for pl in placements {
        match doc.path_of(pl.layer) {
            Some(p) => paths.push((p, pl.layer)),
            None => return Err(bad(format!("layer {} is not in the document", pl.layer.0))),
        }
    }
    paths.sort();
    for pair in paths.windows(2) {
        if let (Some((a, a_id)), Some((b, b_id))) = (pair.first(), pair.get(1)) && b.starts_with(a) {
            return Err(bad(format!(
                "layer {} is inside group {} which is also laid out; place one or the other",
                b_id.0, a_id.0
            )));
        }
    }
    Ok(())
}

fn to_i32(v: f64) -> Result<i32> {
    i32::try_from(v.round() as i64).map_err(|_| bad(format!("{} px is outside the 32-bit coordinate range", v)))
}

/// Scale one layer's content from `from` to the target placement, through the exact machinery
/// `edit.transform` commits (`check_layer_budget` runs inside; locks refuse; type, shapes,
/// smart objects and groups all transform their own way). `refresh_text` runs once for the
/// whole batch in the caller.
fn resize_layer(doc: &mut Document, pl: &Placement, from: Rect) -> Result<()> {
    let id = pl.layer;
    let (fw, fh) = (f64::from(from.width()), f64::from(from.height()));
    if fw <= 0.0 || fh <= 0.0 {
        return Err(bad(format!("layer {} has no content to resize", id.0)));
    }
    let (sx, sy) = (pl.w / fw, pl.h / fh);
    if !sx.is_finite() || !sy.is_finite() || sx <= 0.0 || sy <= 0.0 {
        return Err(bad(format!("the layout would collapse layer {} ({} × {} → {} × {})", id.0, fw, fh, pl.w, pl.h)));
    }
    let (e, f) = (pl.x - sx * f64::from(from.x0), pl.y - sy * f64::from(from.y0));
    let h = Homography([sx, 0.0, e, 0.0, sy, f, 0.0, 0.0, 1.0]);
    if h.inverse().is_none() {
        return Err(bad(format!("the layout would collapse layer {}", id.0)));
    }
    let group = crate::transform_cmds::group_locks(doc, id);
    crate::extra_cmds::background_to_layer(doc, id);
    let Some(l) = doc.layer_mut(id) else { return Err(EngineError::NoLayer(id)) };
    crate::transform_cmds::transform_layer(None, group, l, &h, Some(Affine { m: [sx, 0.0, 0.0, sy, e, f] }), Interp::Bicubic)?;
    Ok(())
}

/// `layout.apply`'s `run`: parse → resolve → solve (all pure), then ONE `Session::edit` that
/// commits every move — `Session::edit` discards the working copy unless the closure returns
/// `Ok`, so §9.5's "any child fails, nothing moves" is structural, not hopeful.
pub fn apply(s: &mut Session, p: &Value) -> Result<Value> {
    let options = ApplyOptions::parse(p)?;
    let root_v = match p.get("root") {
        Some(v) if v.is_object() => v,
        None | Some(Value::Null) => return Err(bad("`root` is required: the node tree to lay out (§9.2)")),
        Some(v) => return Err(bad(format!("`root` must be a node object, not {v}"))),
    };
    let root = parse_tree(root_v)?;
    let doc = match s.active() {
        Some(st) => st.doc.clone(),
        None => return Err(EngineError::NoDocument),
    };
    let canvas = doc.bounds();
    let resolve = |v: &Value| resolve_layer(&doc, v);
    let bounds = |id: LayerId| doc.layer(id).and_then(layer_bounds);
    let measurer = EngineTextMeasurer { doc: &doc };
    let (placements, mut warnings) = solve_with_warnings(&root, canvas, &options, &bounds, &resolve, &measurer)?;
    check_nesting(&doc, &placements)?;

    // Compare whole-pixel targets with current content bounds: translate when the size
    // stays (the Move tool's whole-pixel path), transform when it doesn't.
    let mut moves: Vec<(LayerId, i32, i32)> = Vec::new();
    let mut scales: Vec<(Placement, Rect)> = Vec::new();
    let mut moved: Vec<Value> = Vec::new();
    let mut ids: Vec<LayerId> = Vec::new();
    for pl in placements.iter() {
        let Some(from) = doc.layer(pl.layer).and_then(layer_bounds) else {
            return Err(bad(format!("layer {} has no content; it cannot be moved", pl.layer.0)));
        };
        let (dx, dy) = (pl.x - f64::from(from.x0), pl.y - f64::from(from.y0));
        let (dw, dh) = (pl.w - f64::from(from.width()), pl.h - f64::from(from.height()));
        if dx.abs() < 0.5 && dy.abs() < 0.5 && dw.abs() < 0.5 && dh.abs() < 0.5 {
            continue; // already there
        }
        if pl.w < 0.5 || pl.h < 0.5 {
            warnings.push(format!("layer {}'s target is degenerate ({} × {} px); left untouched", pl.layer.0, pl.w, pl.h));
            continue;
        }
        if dw.abs() < 0.5 && dh.abs() < 0.5 {
            moves.push((pl.layer, to_i32(dx)?, to_i32(dy)?));
        } else {
            scales.push((*pl, from));
        }
        ids.push(pl.layer);
        moved.push(json!({
            "layer": pl.layer.0,
            "from": [from.x0, from.y0, from.width() as i64, from.height() as i64],
            "to": [pl.x as i64, pl.y as i64, pl.w as i64, pl.h as i64],
        }));
    }
    if moves.is_empty() && scales.is_empty() {
        return Ok(json!({ "moved": moved, "warnings": warnings }));
    }
    let scaled_ids: Vec<LayerId> = scales.iter().map(|(pl, _)| pl.layer).collect();
    let r = s.edit("Apply Layout", |ed, _| {
        if !moves.is_empty() {
            crate::layer_multi_cmds::move_layers(ed, &doc, &moves)?;
        }
        for (pl, from) in scales.iter() {
            resize_layer(ed, pl, *from)?;
        }
        if !scales.is_empty() {
            // Type, shape and smart-object layers re-render from their new transforms, as
            // `edit.transform`'s commit does — one snapshot for the whole batch.
            let snapshot = ed.clone();
            for id in &scaled_ids {
                if let Some(l) = ed.layer_mut(*id) {
                    crate::transform_cmds::refresh_text(&snapshot, l);
                }
            }
        }
        Ok(())
    })?;
    let _ = r;
    crate::layer_multi_cmds::note_damage(s, &doc, &ids);
    Ok(json!({ "moved": moved, "warnings": warnings }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    /// Fixed metrics for every text layer (the measure seam's test double).
    struct StubMeasurer {
        w: f64,
        h: f64,
    }
    impl TextMeasurer for StubMeasurer {
        fn measure_text(&self, _layer: LayerId, _max_width: f64) -> Result<(f64, f64)> {
            Ok((self.w, self.h))
        }
    }

    /// Whole-pixel f64 literal, for expected placements.
    fn pl(id: u64, x: f64, y: f64, w: f64, h: f64) -> Placement {
        Placement { layer: LayerId(id), x, y, w, h }
    }

    fn canvas() -> Rect {
        Rect::from_xywh(0, 0, 800, 600)
    }

    /// Parse + solve a `layout.apply` params object against deterministic stub seams.
    fn solve_json(p: &Value) -> Result<(Vec<Placement>, Vec<String>)> {
        let root = parse_tree(p.get("root").ok_or_else(|| bad("`root` is required"))?)?;
        let options = ApplyOptions::parse(p)?;
        let bounds: BTreeMap<u64, Rect> = [
            (1u64, Rect::from_xywh(10, 10, 100, 40)),
            (2u64, Rect::from_xywh(0, 0, 30, 20)),
            (3u64, Rect::from_xywh(0, 0, 50, 12)),
            (4u64, Rect::from_xywh(0, 0, 40, 30)),
            (5u64, Rect::from_xywh(0, 0, 100, 50)),
        ]
        .into_iter()
        .collect();
        let names: BTreeMap<String, u64> = [("A".to_string(), 1u64), ("B".to_string(), 2u64)].into_iter().collect();
        let measure = StubMeasurer { w: 60.0, h: 12.0 };
        solve_with_warnings(
            &root,
            canvas(),
            &options,
            &|id| bounds.get(&id.0).copied(),
            &|v| match v {
                Value::Number(n) => match n.as_u64() {
                    Some(id) if bounds.contains_key(&id) => Ok(LayerId(id)),
                    Some(id) => Err(bad(format!("no layer with id {id}"))),
                    None => Err(bad("layer id must be a non-negative integer")),
                },
                Value::String(s) => match names.get(s.as_str()) {
                    Some(id) => Ok(LayerId(*id)),
                    None => Err(bad(format!("no layer named {s:?}"))),
                },
                _ => Err(bad("layer must be an id or a name")),
            },
            &measure,
        )
    }

    fn assert_ok(p: Value, want: Vec<Placement>, want_warnings: usize) {
        match solve_json(&p) {
            Ok((got, warnings)) => {
                assert_eq!(got, want, "placements of {p}");
                assert_eq!(warnings.len(), want_warnings, "warnings of {p}: {warnings:?}");
            }
            Err(e) => assert!(false, "unexpected error: {e:?}"),
        }
    }

    fn assert_bad(p: Value, needle: &str) {
        match solve_json(&p) {
            Ok(_) => assert!(false, "expected an error containing {needle:?}"),
            Err(EngineError::BadParams { msg, .. }) => assert!(msg.contains(needle), "message {msg:?} lacks {needle:?}"),
            Err(other) => assert!(false, "expected BadParams, got {other:?}"),
        }
    }

    #[test]
    fn vertical_stack_with_gaps_padding_and_align() {
        // §9.2's own shape: gap 24, padding 72, align start; children keep their content size
        // and land at the leading edges of the content box.
        assert_ok(
            json!({
                "root": {"type": "stack", "direction": "vertical", "gap": 24, "padding": [72, 72, 72, 72],
                         "align": "start", "children": [
                    {"type": "text", "layer": 1},
                    {"type": "text", "layer": 2}
                ]}
            }),
            vec![pl(1, 72.0, 72.0, 100.0, 40.0), pl(2, 72.0, 136.0, 30.0, 20.0)],
            0,
        );
    }

    #[test]
    fn nested_row_inside_stack_with_grow() {
        // The row grows into all leftover height; its own text child grows across the width.
        assert_ok(
            json!({
                "root": {"type": "stack", "gap": 0, "children": [
                    {"type": "row", "grow": 1, "gap": 16, "align": "center", "children": [
                        {"type": "text", "layer": 3, "grow": 1},
                        {"type": "component", "layer": 4}
                    ]},
                    {"type": "text", "layer": 2}
                ]}
            }),
            vec![pl(3, 0.0, 289.0, 744.0, 12.0), pl(4, 760.0, 280.0, 40.0, 30.0), pl(2, 0.0, 590.0, 30.0, 20.0)],
            0,
        );
    }

    #[test]
    fn grid_three_columns_stretches_children() {
        let mut children = Vec::new();
        for i in 0..6u64 {
            children.push(json!({"type": "image", "layer": 1 + i % 5}));
        }
        // 904px canvas so (904 - 2×8)/3 = 296 lands on whole pixels.
        let p = json!({
            "root": {"type": "grid", "columns": 3, "gap": 8, "children": children}
        });
        let root = p.get("root").ok_or_else(|| bad("root")).ok();
        let root = match root {
            Some(r) => r,
            None => return,
        };
        match parse_tree(root).map_err(|e| e) {
            Ok(parsed) => {
                let options = ApplyOptions { space: Space::Document, safe: [0.0; 4], dir: FlowDir::Ltr };
                let cells = Rect::from_xywh(0, 0, 904, 600);
                let measure = StubMeasurer { w: 60.0, h: 12.0 };
                match solve(&parsed, cells, &options, &|id| Some(Rect::from_xywh(0, 0, 40, 20)) .filter(|_| id.0 > 0), &|v| v.as_u64().map(LayerId).ok_or_else(|| bad("id")), &measure) {
                    Ok(got) => {
                        assert_eq!(got.len(), 6);
                        assert_eq!(got[0], pl(1, 0.0, 0.0, 296.0, 296.0));
                        assert_eq!(got[1], pl(2, 304.0, 0.0, 296.0, 296.0));
                        assert_eq!(got[2], pl(3, 608.0, 0.0, 296.0, 296.0));
                        assert_eq!(got[3], pl(4, 0.0, 304.0, 296.0, 296.0));
                        assert_eq!(got[5], pl(1, 608.0, 304.0, 296.0, 296.0));
                    }
                    Err(e) => assert!(false, "unexpected error: {e:?}"),
                }
            }
            Err(e) => assert!(false, "parse failed: {e:?}"),
        }
    }

    #[test]
    fn center_node_with_anchor_and_offsets() {
        assert_ok(
            json!({"root": {"type": "center", "children": [{"type": "image", "layer": 5}]}),
            vec![pl(5, 350.0, 275.0, 100.0, 50.0)],
            0,
        );
        assert_ok(
            json!({"root": {"type": "center", "children": [{"type": "image", "layer": 5, "dx": 10, "dy": -4}]}),
            vec![pl(5, 360.0, 271.0, 100.0, 50.0)],
            0,
        );
        // A different anchor moves which point of the child sits at the centre.
        assert_ok(
            json!({"root": {"type": "center", "children": [{"type": "image", "layer": 5, "anchor": "topLeft"}]}),
            vec![pl(5, 400.0, 300.0, 100.0, 50.0)],
            0,
        );
    }

    #[test]
    fn spacer_consumes_the_main_axis_without_a_placement() {
        assert_ok(
            json!({"root": {"type": "stack", "gap": 10, "children": [
                {"type": "text", "layer": 1},
                {"type": "spacer", "size": 24},
                {"type": "text", "layer": 2}
            ]}}),
            vec![pl(1, 0.0, 0.0, 100.0, 40.0), pl(2, 0.0, 84.0, 30.0, 20.0)],
            0,
        );
    }

    #[test]
    fn safe_area_clamps_every_placement() {
        let p: Value = serde_json::from_str(
            r#"{"options": {"safeArea": 10},
                "root": {"type": "absolute", "children": [
                    {"type": "text", "layer": 5, "x": 0, "y": 0, "width": 100, "height": 100}
                ]}}"#,
        )
        .ok()
        .unwrap_or_default();
        assert_ok(
            p,
            vec![pl(5, 10.0, 10.0, 80.0, 80.0)],
            1, // the clamping warning
        );
        // A safe area that eats the canvas refuses outright.
        assert_bad(
            json!({"options": {"safeArea": 350}, "root": {"type": "stack", "children": [{"type": "text", "layer": 1}]}}),
            "safeArea",
        );
    }

    #[test]
    fn percent_sizes_share_of_the_main_axis() {
        assert_ok(
            json!({"root": {"type": "stack", "align": "stretch", "children": [
                {"type": "text", "layer": 1, "percent": 50}
            ]}}),
            vec![pl(1, 0.0, 0.0, 800.0, 300.0)],
            0,
        );
    }

    #[test]
    fn aspect_derives_the_free_dimension() {
        let p: Value = serde_json::from_str(
            r#"{"root": {"type": "absolute", "children": [
                {"type": "image", "layer": 5, "x": 100, "y": 50, "width": 200, "aspect": 2.0}
            ]}}"#,
        )
        .ok()
        .unwrap_or_default();
        assert_ok(p, vec![pl(5, 100.0, 50.0, 200.0, 100.0)], 0);
    }

    #[test]
    fn min_max_clamp_and_conflicts_error() {
        // A min taller than the measured content raises it (with a warning-free clamp; the
        // value is honest — the node asked for at least 30px).
        assert_ok(
            json!({"root": {"type": "stack", "children": [
                {"type": "text", "layer": 1, "hug": true, "minHeight": 30}
            ]}}),
            vec![pl(1, 0.0, 0.0, 100.0, 40.0)],
            0,
        );
        assert_bad(
            json!({"root": {"type": "stack", "children": [
                {"type": "text", "layer": 1, "minWidth": 100, "maxWidth": 50}
            ]}}),
            "exceeds `maxWidth`",
        );
    }

    #[test]
    fn hug_measures_text_through_the_seam() {
        // The stub measures 60×12; a hugging text node takes that instead of its bounds.
        assert_ok(
            json!({"root": {"type": "stack", "children": [{"type": "text", "layer": 1, "hug": true}]}),
            vec![pl(1, 0.0, 0.0, 100.0, 40.0)],
            0,
        );
        // Under `align: stretch` the cross side fills the content width, the main stays
        // measured: hugging is about the flow direction.
        assert_ok(
            json!({"root": {"type": "stack", "align": "stretch", "children": [{"type": "text", "layer": 1, "hug": true, "width": 200}]}),
            vec![pl(1, 0.0, 0.0, 200.0, 40.0)],
            0,
        );
    }

    #[test]
    fn rtl_flips_logical_start_and_flow() {
        // Row with dir rtl: children flow right→left and `start` is the right edge.
        assert_ok(
            json!({"options": {"dir": "rtl"}, "root": {"type": "row", "gap": 5, "children": [
                {"type": "text", "layer": 1, "width": 10, "height": 10},
                {"type": "text", "layer": 2, "width": 20, "height": 10}
            ]}}),
            vec![pl(1, 790.0, 0.0, 10.0, 10.0), pl(2, 765.0, 0.0, 20.0, 10.0)],
            0,
        );
        // A vertical stack in rtl aligns children from the right (logical start).
        assert_ok(
            json!({"root": {"type": "stack", "dir": "rtl", "children": [{"type": "text", "layer": 2}]}),
            vec![pl(2, 770.0, 0.0, 30.0, 20.0)],
            0,
        );
    }

    #[test]
    fn adversarial_params_are_typed_errors() {
        let child = json!({"type": "text", "layer": 1});
        let cases: Vec<(&str, Value, &str)> = vec![
            ("root missing", json!({}), "`root`"),
            ("root not an object", json!({"root": []}), "node must be a JSON object"),
            ("no type", json!({"root": {"children": [child]}}), "`type`"),
            ("unknown type", json!({"root": {"type": "frame", "children": [child]}}), "valid types"),
            (
                "unknown key lists the valid ones",
                json!({"root": {"type": "text", "layer": 1, "colour": "#fff"}}),
                "valid keys",
            ),
            ("physical align rejected with the logical ones", json!({"root": {"type": "stack", "align": "left", "children": [child]}}), "start"),
            ("unknown anchor lists the nine plus baseline", json!({"root": {"type": "absolute", "children": [{"type": "text", "layer": 1, "x": 0, "y": 0, "anchor": "middle"}]}}), "topLeft"),
            ("grid columns 0", json!({"root": {"type": "grid", "columns": 0, "children": [child]}}), "columns"),
            ("grid columns 25", json!({"root": {"type": "grid", "columns": 25, "children": [child]}}), "columns"),
            ("grid columns missing", json!({"root": {"type": "grid", "children": [child]}}), "columns"),
            ("grid fractional columns", json!({"root": {"type": "grid", "columns": 2.5, "children": [child]}}), "columns"),
            ("negative gap", json!({"root": {"type": "stack", "gap": -1, "children": [child]}}), "gap"),
            ("gap over 256", json!({"root": {"type": "stack", "gap": 257, "children": [child]}}), "gap"),
            ("padding wrong arity", json!({"root": {"type": "stack", "padding": [1, 2, 3], "children": [child]}}), "padding"),
            ("padding over 2048", json!({"root": {"type": "stack", "padding": [3000, 0, 0, 0], "children": [child]}}), "padding"),
            ("empty children", json!({"root": {"type": "stack", "children": []}}), "child"),
            ("spacer without size", json!({"root": {"type": "stack", "children": [{"type": "spacer"}]}}), "size"),
            ("text without layer", json!({"root": {"type": "stack", "children": [{"type": "text"}]}}), "needs `layer`"),
            ("absolute child without x", json!({"root": {"type": "absolute", "children": [child]}}), "`x`"),
            ("negative grow", json!({"root": {"type": "stack", "children": [{"type": "text", "layer": 1, "grow": -1}]}}), "grow"),
            ("string grow", json!({"root": {"type": "stack", "children": [{"type": "text", "layer": 1, "grow": "lots"}]}}), "grow"),
            ("percent 400", json!({"root": {"type": "stack", "children": [{"type": "text", "layer": 1, "percent": 400}]}}), "percent"),
            ("percent 0", json!({"root": {"type": "stack", "children": [{"type": "text", "layer": 1, "percent": 0}]}}), "percent"),
            ("aspect 0", json!({"root": {"type": "stack", "children": [{"type": "text", "layer": 1, "aspect": 0}]}}), "aspect"),
            ("width as a string", json!({"root": {"type": "stack", "children": [{"type": "text", "layer": 1, "width": "NaN"}]}}), "node"),
            ("negative width", json!({"root": {"type": "stack", "children": [{"type": "text", "layer": 1, "width": -5}]}}), "width"),
            ("same layer twice", json!({"root": {"type": "stack", "children": [child, child]}}), "more than one node"),
            ("min above max", json!({"root": {"type": "stack", "children": [{"type": "text", "layer": 1, "minHeight": 100, "maxHeight": 50}]}}), "exceeds `maxHeight`"),
            ("options wrong type", json!({"options": [], "root": {"type": "stack", "children": [child]}}), "`options`"),
            ("unknown options key", json!({"options": {"snap": true}, "root": {"type": "stack", "children": [child]}}), "coordinateSpace, safeArea, dir"),
            ("bad coordinateSpace", json!({"options": {"coordinateSpace": "canvas"}, "root": {"type": "stack", "children": [child]}}), "coordinateSpace"),
            ("negative safeArea", json!({"options": {"safeArea": -1}, "root": {"type": "stack", "children": [child]}}), "safeArea"),
            ("unknown layer name", json!({"root": {"type": "stack", "children": [{"type": "text", "layer": "Nope"}]}}), "no layer named"),
        ];
        for (name, p, needle) in cases {
            let _ = name;
            assert_bad(p, needle);
        }
    }

    #[test]
    fn inf_and_huge_numbers_are_rejected_before_any_math() {
        // serde_json parses 1e999 as inf (the JSON-only stand-in for NaN/inf, §9.5); every
        // number is checked with is_finite before use.
        for (text, needle) in [
            (r#"{"root": {"type": "stack", "gap": 1e999, "children": [{"type": "text", "layer": 1}]}}"#, "gap"),
            (r#"{"root": {"type": "stack", "children": [{"type": "text", "layer": 1, "width": 1e999}]}}"#, "width"),
            (r#"{"root": {"type": "grid", "columns": 1e999, "children": [{"type": "text", "layer": 1}]}}"#, "columns"),
            (r#"{"options": {"safeArea": 1e999}, "root": {"type": "stack", "children": [{"type": "text", "layer": 1}]}}"#, "safeArea"),
            (r#"{"root": {"type": "stack", "children": [{"type": "text", "layer": 1, "aspect": 1e999}]}}"#, "aspect"),
        ] {
            let p: Value = match serde_json::from_str(text) {
                Ok(v) => v,
                Err(e) => {
                    assert!(false, "fixture did not parse: {e:?}");
                    continue;
                }
            };
            assert_bad(p, needle);
        }
    }

    #[test]
    fn absurd_trees_are_depth_and_count_bounded() {
        // 100+ deep must be an Err, not a stack overflow.
        let mut node = json!({"type": "text", "layer": 1});
        for _ in 0..100 {
            node = json!({"type": "stack", "children": [node]});
        }
        assert_bad(json!({"root": node}), "deeper than");
        let mut children = Vec::new();
        for _ in 0..600 {
            children.push(json!({"type": "text", "layer": 1}));
        }
        assert_bad(json!({"root": {"type": "stack", "children": children}}), "children");
    }

    #[test]
    fn same_input_same_revision_identical_output() {
        let tree = json!({
            "options": {"safeArea": 8, "dir": "ltr"},
            "root": {"type": "stack", "gap": 12, "padding": [10, 10, 10, 10], "align": "stretch", "children": [
                {"type": "row", "gap": 8, "grow": 1, "children": [
                    {"type": "text", "layer": 1, "grow": 1},
                    {"type": "component", "layer": 4}
                ]},
                {"type": "spacer", "size": 6},
                {"type": "grid", "columns": 3, "gap": 4, "children": [
                    {"type": "image", "layer": 5}, {"type": "text", "layer": 2}, {"type": "text", "layer": 3}
                ]},
                {"type": "center", "children": [{"type": "text", "layer": 1, "hug": true, "dx": 3, "dy": 3}]}
            ]}
        });
        let first = solve_json(&tree);
        let second = solve_json(&tree);
        match (first, second) {
            (Ok(a), Ok(b)) => {
                assert_eq!(a.0, b.0, "placements differ between identical runs");
                assert_eq!(a.1, b.1, "warnings differ between identical runs");
                match (serde_json::to_string(&a.0), serde_json::to_string(&b.0)) {
                    (Ok(x), Ok(y)) => assert_eq!(x, y, "byte-identical serialization (§9.5)"),
                    _ => assert!(false, "serialization failed"),
                }
            }
            (Err(e), _) => assert!(false, "fixture failed: {e:?}"),
            (_, Err(e)) => assert!(false, "second run failed: {e:?}"),
        }
    }

    // ---------- command-level tests (the run fn, called directly) ----------

    fn step(s: &mut Session, cmd: &str, p: Value) {
        match s.execute(cmd, p) {
            Ok(_) => {}
            Err(e) => assert!(false, "{cmd} failed: {e:?}"),
        }
    }

    fn new_painted_layer(s: &mut Session, x: i64, y: i64, w: i64, h: i64) -> LayerId {
        step(s, "layer.new.layer", json!({}));
        step(s, "select.rect", json!({"x": x, "y": y, "width": w, "height": h}));
        step(s, "edit.fill", json!({"color": "#3366aa"}));
        match s.active().and_then(|d| d.active_layer) {
            Some(id) => id,
            None => {
                assert!(false, "no active layer after layer.new.layer");
                LayerId(0)
            }
        }
    }

    fn painted_session() -> (Session, LayerId, LayerId) {
        let mut s = Session::new();
        step(&mut s, "file.new", json!({"width": 64, "height": 48}));
        let a = new_painted_layer(&mut s, 2, 2, 10, 10);
        let b = new_painted_layer(&mut s, 30, 20, 8, 6);
        (s, a, b)
    }

    #[test]
    fn apply_moves_layers_and_reports_from_to() {
        let (mut s, a, b) = painted_session();
        let rev = s.active().map_or(0, |d| d.revision);
        let p = json!({
            "root": {"type": "stack", "direction": "vertical", "gap": 2, "align": "start", "children": [
                {"type": "text", "layer": a.0},
                {"type": "text", "layer": b.0}
            ]}
        });
        match apply(&mut s, &p) {
            Ok(r) => {
                assert_eq!(r["moved"].as_array().map(Vec::len), Some(2), "{r}");
                assert_eq!(r["moved"][0]["from"], json!([2, 2, 10, 10]));
                assert_eq!(r["moved"][0]["to"], json!([0, 0, 10, 10]));
                assert_eq!(r["moved"][1]["from"], json!([30, 20, 8, 6]));
                assert_eq!(r["moved"][1]["to"], json!([0, 12, 8, 6]));
                assert_eq!(r["warnings"].as_array().map(Vec::len), Some(0), "{r}");
            }
            Err(e) => assert!(false, "unexpected error: {e:?}"),
        }
        assert_eq!(s.active().map_or(0, |d| d.revision), rev + 1, "one edit, one history step");
    }

    #[test]
    fn apply_is_transactional_a_failed_child_moves_nothing() {
        let (mut s, a, _b) = painted_session();
        let rev = s.active().map_or(0, |d| d.revision);
        let p = json!({
            "root": {"type": "stack", "children": [
                {"type": "text", "layer": a.0},
                {"type": "text", "layer": "Nope"}
            ]}
        });
        match apply(&mut s, &p) {
            Ok(_) => assert!(false, "an unresolvable layer must fail the whole apply"),
            Err(EngineError::BadParams { msg, .. }) => assert!(msg.contains("Nope"), "{msg}"),
            Err(other) => assert!(false, "expected BadParams, got {other:?}"),
        }
        assert_eq!(s.active().map_or(0, |d| d.revision), rev, "§9.5: nothing moved");
        let bounds = s.active().and_then(|d| d.doc.layer(a)).and_then(layer_bounds);
        assert_eq!(bounds, Some(Rect::from_xywh(2, 2, 10, 10)), "layer A is exactly where it was");
    }

    #[test]
    fn apply_without_a_document_is_an_error() {
        let mut s = Session::new();
        let p = json!({"root": {"type": "stack", "children": [{"type": "text", "layer": 1}]}});
        match apply(&mut s, &p) {
            Err(EngineError::NoDocument) => {}
            Err(other) => assert!(false, "expected NoDocument, got {other:?}"),
            Ok(_) => assert!(false, "no document is open"),
        }
    }

    #[test]
    fn ambiguous_names_error_with_the_candidates() {
        let (mut s, a, b) = painted_session();
        step(&mut s, "layer.setProps", json!({"layer": a.0, "name": "Dup"}));
        step(&mut s, "layer.setProps", json!({"layer": b.0, "name": "Dup"}));
        let doc = s.active().map(|d| d.doc.clone());
        let doc = match doc {
            Some(d) => d,
            None => {
                assert!(false, "no document");
                return;
            }
        };
        match resolve_layer(&doc, &json!("Dup")) {
            Err(EngineError::BadParams { msg, .. }) => {
                assert!(msg.contains("matches 2 layers"), "{msg}");
                assert!(msg.contains("give the layer id"), "{msg}");
            }
            Err(other) => assert!(false, "expected BadParams, got {other:?}"),
            Ok(_) => assert!(false, "an ambiguous name must be refused"),
        }
        match resolve_layer(&doc, &json!(a.0)) {
            Ok(id) => assert_eq!(id, a),
            Err(e) => assert!(false, "ids are unambiguous: {e:?}"),
        }
    }

    #[test]
    fn apply_is_deterministic_across_identical_sessions() {
        let p = json!({
            "options": {"safeArea": 2},
            "root": {"type": "stack", "gap": 4, "align": "stretch", "children": [
                {"type": "text", "layer": 0, "percent": 50},
                {"type": "text", "layer": 1}
            ]}
        });
        let run = || {
            let (mut s, a, b) = painted_session();
            // ids differ between sessions (a process-wide counter); normalize them away.
            let p = json!({
                "options": {"safeArea": 2},
                "root": {"type": "stack", "gap": 4, "align": "stretch", "children": [
                    {"type": "text", "layer": a.0, "percent": 50},
                    {"type": "text", "layer": b.0}
                ]}
            });
            match apply(&mut s, &p) {
                Ok(r) => r,
                Err(e) => {
                    assert!(false, "unexpected error: {e:?}");
                    json!({})
                }
            }
        };
        let _ = p;
        let (r1, r2) = (run(), run());
        for key in ["from", "to"] {
            assert_eq!(r1["moved"][0][key], r2["moved"][0][key], "{key} differs across identical sessions");
            assert_eq!(r1["moved"][1][key], r2["moved"][1][key], "{key} differs across identical sessions");
        }
        assert_eq!(r1["warnings"], r2["warnings");
        let _ = 0;
    }
}
