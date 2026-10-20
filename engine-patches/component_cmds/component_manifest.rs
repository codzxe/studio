//! Component manifests (spec §8.2) — pure, validated data. No I/O lives here: the
//! components directory, master files and command wiring are [`super`]'s business.
//!
//! A manifest is the component's *schema*: identity, version, tags, the design size,
//! the variables (name → kind/default/maxChars), the named 9-point anchors, the layer
//! comps it ships and its license. The *binding* of a variable to a layer lives in the
//! component's master document (its `variables.defs`, the §8.1 primitive), not here.
//!
//! Unknown values are errors, never silent defaults: an unknown variable kind, license,
//! or a default that does not match its kind all refuse the whole manifest. Anchors are
//! the one sanctioned clamp: §8.4 says normalized coordinates are "validated and
//! clamped before use", so non-finite anchors are errors and out-of-range fractions
//! clamp into the [0, 1] grid at [`ComponentManifest::anchor`].

use std::collections::BTreeMap;

use photocraft_color::Color;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The longest a text variable may run when the manifest sets no `maxChars`.
pub const MAX_VAR_CHARS: usize = 4096;
/// Manifests with more variables than this refuse to parse (allocation guard).
pub const MAX_VARS: usize = 64;
/// At most this many tags per component.
pub const MAX_TAGS: usize = 32;
/// At most this many named anchors (the 9-point grid plus a few aliases).
pub const MAX_ANCHORS: usize = 16;
/// At most this many layer comps.
pub const MAX_COMPS: usize = 32;
/// Component id: `a-z`, `0-9`, `-`; must start with a letter or digit.
pub const MAX_ID_CHARS: usize = 64;
/// Human name length cap.
pub const MAX_NAME_CHARS: usize = 128;
/// Per-side design size cap.
pub const MAX_SIDE_PX: u32 = 8192;
/// 64 MP, the automation canvas ceiling (spec §2.3): `defaultSize` never plans bigger.
pub const MAX_DEFAULT_PIXELS: u64 = 64_000_000;

/// What a variable drives (spec §8.2: `text | color | visibility`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VarKind {
    Text,
    Color,
    Visibility,
}

/// Who may use the component (spec §8.4: every component carries a license).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum License {
    Workspace,
    Public,
}

/// One declared variable. `default` is kept as raw JSON and validated against `kind`,
/// so a text variable defaulting to a number refuses the manifest.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VariableSpec {
    pub kind: VarKind,
    pub default: Value,
    /// Text variables only: the longest value accepted (defaults to [`MAX_VAR_CHARS`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<u32>,
}

/// The component's design size (`defaultSize`, spec §8.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestSize {
    pub width: u32,
    pub height: u32,
}

/// A component manifest (spec §8.2). Top-level unknown fields are tolerated so the
/// schema can grow; nested structs are strict (`deny_unknown_fields`) because a typo
/// like `colour` must fail loudly.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentManifest {
    pub id: String,
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub default_size: ManifestSize,
    #[serde(default)]
    pub variables: BTreeMap<String, VariableSpec>,
    /// Named 9-point anchors as `[x, y]` fractions of the design box.
    #[serde(default)]
    pub anchors: BTreeMap<String, [f64; 2]>,
    /// Layer comps the component ships (`layerComp.*` states, §8.1).
    #[serde(default)]
    pub comps: Vec<String>,
    pub license: License,
}

/// Everything that can go wrong with a manifest, with a message an agent can act on.
#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("the id must be 1..{MAX_ID_CHARS} characters of a-z, 0-9 and -, starting with a letter or digit (path characters are refused)")]
    Id,
    #[error("the version must be 1 or greater")]
    Version,
    #[error("the name must be 1..{MAX_NAME_CHARS} characters")]
    Name,
    #[error("at most {MAX_TAGS} tags, each 1..32 characters")]
    Tags,
    #[error("at most {MAX_VARS} variables, each named with 1..64 characters")]
    Vars,
    #[error("variable `{var}`: {why}")]
    Default { var: String, why: String },
    #[error("variable `{var}`: maxChars must be 1..={MAX_VAR_CHARS}")]
    MaxChars { var: String },
    #[error("defaultSize must be 1..={MAX_SIDE_PX} per side and at most 64 MP (the automation ceiling, §2.3)")]
    Size,
    #[error("at most {MAX_ANCHORS} anchors, each named with 1..32 characters")]
    AnchorName,
    #[error("anchor `{name}` must be two finite numbers (out-of-range fractions clamp into [0, 1])")]
    Anchor { name: String },
    #[error("at most {MAX_COMPS} layer comps, each a non-empty name; names are unique")]
    Comps,
    #[error("the license must be \"workspace\" or \"public\"")]
    License,
    #[error("unknown variable `{name}`; allowed variables: {allowed}")]
    UnknownVar { name: String, allowed: String },
    #[error("`{var}` must be {expected}")]
    VarType { var: String, expected: &'static str },
    #[error("`{var}` is longer than its maxChars of {max}")]
    TooLong { var: String, max: usize },
    #[error("`{var}` must be a #rgb, #rgba, #rrggbb or #rrggbbaa colour string")]
    BadColor { var: String },
}

/// The component-id grammar: lowercase kebab-case, no path characters, no dots — a valid
/// id can never traverse out of the components directory (`../x`, `a/b`, `..` all fail).
pub fn validate_id(id: &str) -> Result<(), ManifestError> {
    let ok_char = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-';
    let first = id.chars().next();
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS
        || !first.is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        || !id.chars().all(ok_char)
    {
        return Err(ManifestError::Id);
    }
    Ok(())
}

impl ComponentManifest {
    /// Parse and validate manifest bytes. Parse errors (an unknown `kind` or `license`
    /// among them) and rule violations are both [`ManifestError`].
    pub fn parse(bytes: &[u8]) -> Result<ComponentManifest, ManifestError> {
        let m: ComponentManifest = serde_json::from_slice(bytes)?;
        m.validate()?;
        Ok(m)
    }

    /// Enforce every §8.2/§8.4 rule that serde cannot (ranges, counts, cross-checks).
    pub fn validate(&self) -> Result<(), ManifestError> {
        validate_id(&self.id)?;
        if self.version == 0 {
            return Err(ManifestError::Version);
        }
        if self.name.trim().is_empty() || self.name.chars().count() > MAX_NAME_CHARS {
            return Err(ManifestError::Name);
        }
        if self.tags.len() > MAX_TAGS || self.tags.iter().any(|t| t.trim().is_empty() || t.chars().count() > 32) {
            return Err(ManifestError::Tags);
        }
        if self.variables.len() > MAX_VARS {
            return Err(ManifestError::Vars);
        }
        for (name, spec) in &self.variables {
            if name.trim().is_empty() || name.chars().count() > 64 {
                return Err(ManifestError::Vars);
            }
            if let Some(max) = spec.max_chars {
                if max == 0 || usize::from(max) > MAX_VAR_CHARS {
                    return Err(ManifestError::MaxChars { var: name.clone() });
                }
            }
            // A default that would not pass check_var refuses the manifest.
            self.check_var(name, &spec.default)
                .map_err(|e| ManifestError::Default { var: name.clone(), why: e.to_string() })?;
        }
        let s = self.default_size;
        if s.width == 0 || s.height == 0 || s.width > MAX_SIDE_PX || s.height > MAX_SIDE_PX
            || u64::from(s.width) * u64::from(s.height) > MAX_DEFAULT_PIXELS
        {
            return Err(ManifestError::Size);
        }
        if self.anchors.len() > MAX_ANCHORS
            || self.anchors.keys().any(|n| n.trim().is_empty() || n.chars().count() > 32)
        {
            return Err(ManifestError::AnchorName);
        }
        for (name, f) in &self.anchors {
            if !f[0].is_finite() || !f[1].is_finite() {
                return Err(ManifestError::Anchor { name: name.clone() });
            }
        }
        if self.comps.len() > MAX_COMPS || self.comps.iter().any(|c| c.trim().is_empty()) {
            return Err(ManifestError::Comps);
        }
        let mut seen = std::collections::BTreeSet::new();
        for c in self.comps.iter().map(|c| c.to_lowercase()) {
            if !seen.insert(c) {
                return Err(ManifestError::Comps);
            }
        }
        Ok(())
    }

    /// Validate one variable value against its declaration and return the canonical
    /// stored form: text as the string itself, visibility as the bool, colours as an
    /// uppercase `#RRGGBB(AA)` string. Unknown names carry the allowed list (§8.4).
    pub fn check_var(&self, name: &str, value: &Value) -> Result<Value, ManifestError> {
        let Some(spec) = self.variables.get(name) else {
            let allowed: Vec<&str> = self.variables.keys().map(String::as_str).collect();
            let allowed = if allowed.is_empty() { "(none)".to_string() } else { allowed.join(", ") };
            return Err(ManifestError::UnknownVar { name: name.to_string(), allowed });
        };
        match spec.kind {
            VarKind::Text => {
                let Some(s) = value.as_str() else {
                    return Err(ManifestError::VarType { var: name.to_string(), expected: "a string" });
                };
                let max = spec.max_chars.map_or(MAX_VAR_CHARS, usize::from);
                if s.chars().count() > max {
                    return Err(ManifestError::TooLong { var: name.to_string(), max });
                }
                Ok(Value::String(s.to_string()))
            }
            VarKind::Visibility => {
                let Some(b) = value.as_bool() else {
                    return Err(ManifestError::VarType { var: name.to_string(), expected: "true or false" });
                };
                Ok(Value::Bool(b))
            }
            VarKind::Color => {
                let Some(s) = value.as_str() else {
                    return Err(ManifestError::VarType { var: name.to_string(), expected: "a #rgb, #rrggbb or #rrggbbaa colour string" });
                };
                let c = parse_hex(s).ok_or_else(|| ManifestError::BadColor { var: name.to_string() })?;
                Ok(Value::String(hex_of(&c)))
            }
        }
    }

    /// Every declared variable at its default, in canonical form.
    pub fn default_state(&self) -> BTreeMap<String, Value> {
        self.variables.iter().map(|(k, spec)| (k.clone(), spec.default.clone())).collect()
    }

    /// The named anchor, clamped into the [0, 1] grid (§8.4: validate and clamp).
    pub fn anchor(&self, name: &str) -> Option<[f64; 2]> {
        let f = *self.anchors.get(name)?;
        Some([f[0].clamp(0.0, 1.0), f[1].clamp(0.0, 1.0)])
    }

    /// The declared anchor names, in manifest order, for "unknown anchor" messages.
    pub fn anchor_names(&self) -> Vec<&str> {
        self.anchors.keys().map(String::as_str).collect()
    }

    /// The manifest as JSON (camelCase, as authored) for `component.inspect`.
    pub fn to_json(&self) -> Result<Value, ManifestError> {
        serde_json::to_value(self).map_err(ManifestError::Json)
    }
}

/// A colour from a strict `#rgb`, `#rgba`, `#rrgbb`-style hex string (3, 4, 6 or 8 hex
/// digits after the `#`). Everything else — bare hex, names, `rgb(…)` — is `None`.
pub fn parse_hex(s: &str) -> Option<Color> {
    let s = s.strip_prefix('#')?;
    let unit = |i: usize| {
        let b = s.as_bytes().get(i).copied()?;
        let d = char::from(b).to_digit(16)?;
        Some(f32::from(d) / 15.0)
    };
    let byte = |i: usize| u8::from_str_radix(s.get(i..i + 2)?, 16).ok();
    let q = |i: usize| byte(i).map(|v| f32::from(v) / 255.0);
    match s.len() {
        3 => Some(Color::rgb(unit(0)?, unit(1)?, unit(2)?)),
        4 => Some(Color::rgba(unit(0)?, unit(1)?, unit(2)?, unit(3)?)),
        6 => Some(Color::rgb(q(0)?, q(2)?, q(4)?)),
        8 => Some(Color::rgba(q(0)?, q(2)?, q(4)?, q(6)?)),
        _ => None,
    }
}

/// The canonical stored form of a colour: `#RRGGBB` when opaque, else `#RRGGBBAA`.
pub fn hex_of(c: &Color) -> String {
    let [r, g, b] = c.to_rgb();
    let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    if (c.alpha - 1.0).abs() < 1.0 / 512.0 {
        format!("#{:02X}{:02X}{:02X}", q(r), q(g), q(b))
    } else {
        format!("#{:02X}{:02X}{:02X}{:02X}", q(r), q(g), q(b), q(c.alpha))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The §8.2 example, verbatim in structure.
    fn example() -> String {
        r#"{
            "id": "offer-badge",
            "version": 2,
            "name": "Offer Badge",
            "tags": ["badge", "promo"],
            "defaultSize": { "width": 180, "height": 180 },
            "variables": {
                "label":      { "kind": "text", "default": "SALE", "maxChars": 12 },
                "bg":         { "kind": "color", "default": "#D96C3B" },
                "textColor":  { "kind": "color", "default": "#FFF7EE" },
                "showRibbon": { "kind": "visibility", "default": false }
            },
            "anchors": { "center": [0.5, 0.5], "topRight": [1, 0], "bottomLeft": [0, 1] },
            "comps": ["default", "light", "dark"],
            "license": "workspace"
        }"#.to_string()
    }

    fn bad(json: String) -> String {
        ComponentManifest::parse(json.as_bytes()).err().map(|e| e.to_string()).unwrap_or_default()
    }

    #[test]
    fn parses_the_spec_example_and_round_trips() {
        let m = ComponentManifest::parse(example().as_bytes()).expect("the §8.2 example must parse");
        assert_eq!(m.id, "offer-badge");
        assert_eq!(m.version, 2);
        assert_eq!(m.name, "Offer Badge");
        assert_eq!(m.default_size, ManifestSize { width: 180, height: 180 });
        assert_eq!(m.variables.len(), 4);
        assert_eq!(m.variables["label"].max_chars, Some(12));
        assert_eq!(m.license, License::Workspace);
        // The canonical state starts from the declared defaults.
        let state = m.default_state();
        assert_eq!(state["label"], json!("SALE"));
        assert_eq!(state["bg"], json!("#D96C3B"));
        assert_eq!(state["showRibbon"], json!(false));
        // Serializes back camelCase.
        let back = m.to_json().expect("manifest serializes");
        assert_eq!(back["defaultSize"]["width"], 180);
        assert!(back.get("defaultsize").is_none(), "camelCase only");
    }

    #[test]
    fn validate_table() {
        // A patch over the §8.2 example, and what its error must mention.
        let table: [(fn(&mut Value), &str); 6] = [
            (|v| v["id"] = json!("UPPER"), "id"),
            (|v| v["id"] = json!("a/b"), "id"),
            (|v| v["id"] = json!(".."), "id"),
            (|v| v["id"] = json!("-x"), "id"),
            (|v| v["version"] = json!(0), "version"),
            (|v| v["name"] = json!("  "), "name"),
        ];
        for (patch, needle) in table {
            let mut v: Value = serde_json::from_str(&example()).expect("fixture");
            patch(&mut v);
            let msg = bad(v.to_string());
            assert!(!msg.is_empty() && msg.to_lowercase().contains(needle), "expected `{needle}` in `{msg}`");
        }
    }

    #[test]
    fn ids_reject_paths_and_case() {
        for id in ["", "..", "../x", "a/b", "A", "a b", "-x", "x-", &"x".repeat(65)] {
            assert!(validate_id(id).is_err(), "`{id}` must be refused");
        }
        for id in ["a", "offer-badge", "badge-2", "x9-y"] {
            assert!(validate_id(id).is_ok(), "`{id}` must be accepted");
        }
    }

    #[test]
    fn unknown_kind_license_and_missing_license_are_errors() {
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["variables"]["label"]["kind"] = json!("colour");
        assert!(ComponentManifest::parse(v.to_string().as_bytes()).is_err(), "unknown kind");
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["license"] = json!("secret");
        assert!(ComponentManifest::parse(v.to_string().as_bytes()).is_err(), "unknown license");
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v.as_object_mut().expect("object").remove("license");
        assert!(ComponentManifest::parse(v.to_string().as_bytes()).is_err(), "missing license (§8.4)");
    }

    #[test]
    fn defaults_must_match_their_kind() {
        let cases: [(Value, &str); 4] = [
            (json!("SALE"), "text default"),
            (json!(false), "visibility default"),
            (json!("#FFF7EE"), "color default"),
            (json!("#FFF"), "short color default"),
        ];
        for (good, why) in cases {
            let mut v: Value = serde_json::from_str(&example()).expect("fixture");
            v["variables"]["label"] = json!({ "kind": "text", "default": good });
            let _ = why;
        }
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["variables"]["label"]["default"] = json!(12);
        assert!(bad(v.to_string()).contains("default"), "a numeric text default must refuse");
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["variables"]["showRibbon"]["default"] = json!("no");
        assert!(bad(v.to_string()).contains("default"), "a string visibility default must refuse");
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["variables"]["bg"]["default"] = json!("red");
        assert!(bad(v.to_string()).contains("default"), "a named colour default must refuse");
    }

    #[test]
    fn max_chars_and_sizes_have_bounds() {
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["variables"]["label"]["maxChars"] = json!(0);
        assert!(bad(v.to_string()).contains("maxChars"));
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["variables"]["label"]["maxChars"] = json!(4097);
        assert!(bad(v.to_string()).contains("maxChars"));
        for (w, h) in [(0u32, 180u32), (180, 0), (8193, 8), (9000, 9000)] {
            let mut v: Value = serde_json::from_str(&example()).expect("fixture");
            v["defaultSize"] = json!({ "width": w, "height": h });
            assert!(bad(v.to_string()).contains("defaultSize"), "{w}x{h} must refuse");
        }
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["defaultSize"] = json!({ "width": 8192, "height": 8192 });
        assert!(bad(v.to_string()).contains("defaultSize"), "268 MP must refuse (64 MP ceiling)");
    }

    #[test]
    fn anchors_must_be_finite_and_clamp_at_use() {
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["anchors"]["center"] = json!([1e999, 0.5]);
        let msg = bad(v.to_string());
        assert!(msg.contains("anchor") && msg.contains("center"), "non-finite anchor: {msg}");
        let m = ComponentManifest::parse(example().as_bytes()).expect("fixture");
        // Out-of-range finite fractions parse and clamp (§8.4: validate and clamp).
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["anchors"]["past"] = json!([1.2, -0.5]);
        let m2 = ComponentManifest::parse(v.to_string().as_bytes()).expect("finite out-of-range anchors parse");
        assert_eq!(m2.anchor("past"), Some([1.0, 0.0]), "clamped to the grid");
        assert_eq!(m.anchor("center"), Some([0.5, 0.5]));
        assert_eq!(m.anchor("nope"), None);
        assert_eq!(m.anchor_names().len(), 3);
    }

    #[test]
    fn comps_must_be_unique_nonempty_and_bounded() {
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["comps"] = json!(["a", "A"]);
        assert!(bad(v.to_string()).contains("comp"), "case-insensitive duplicates refuse");
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["comps"] = json!(["a", ""]);
        assert!(bad(v.to_string()).contains("comp"), "empty names refuse");
    }

    #[test]
    fn counts_are_bounded() {
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        v["tags"] = json!((0..33).map(|i| format!("t{i}").to_string()).collect::<Vec<_>>());
        assert!(bad(v.to_string()).contains("tag"));
        let mut v: Value = serde_json::from_str(&example()).expect("fixture");
        let mut vars = serde_json::Map::new();
        for i in 0..65 {
            vars.insert(format!("v{i}"), json!({ "kind": "text", "default": "x" }));
        }
        v["variables"] = Value::Object(vars);
        assert!(bad(v.to_string()).contains("variable"));
    }

    #[test]
    fn check_var_table() {
        let m = ComponentManifest::parse(example().as_bytes()).expect("fixture");
        // Text: canonical as the string, maxChars enforced in characters not bytes.
        assert_eq!(m.check_var("label", &json!("20% OFF")).ok(), Some(json!("20% OFF")));
        assert!(m.check_var("label", &json!("twelve chars!")).is_ok(), "exactly 12");
        let msg = m.check_var("label", &json!("thirteen chars")).err().map(|e| e.to_string()).unwrap_or_default();
        assert!(msg.contains("maxChars"), "{msg}");
        let astral: String = "é".repeat(12);
        assert!(m.check_var("label", &json!(astral)).is_ok(), "12 characters, not bytes");
        // Visibility: bools only.
        assert_eq!(m.check_var("showRibbon", &json!(true)).ok(), Some(json!(true)));
        assert!(m.check_var("showRibbon", &json!("true")).is_err(), "strings refuse");
        // Colour: hex only, canonicalized.
        assert_eq!(m.check_var("bg", &json!("#d96c3b")).ok(), Some(json!("#D96C3B")));
        assert_eq!(m.check_var("bg", &json!("#fff")).ok(), Some(json!("#FFFFFF")));
        assert!(m.check_var("bg", &json!("D96C3B")).is_err(), "bare hex refuses");
        assert!(m.check_var("bg", &json!("#GGGGGG")).is_err(), "non-hex refuses");
        assert!(m.check_var("bg", &json!("#12345")).is_err(), "odd length refuses");
        assert!(m.check_var("bg", &json!(false)).is_err(), "wrong type refuses");
        // Unknown names carry the allowed list (§8.4).
        let msg = m.check_var("nope", &json!("x")).err().map(|e| e.to_string()).unwrap_or_default();
        assert!(msg.contains("unknown variable `nope`") && msg.contains("allowed variables: label, bg, showRibbon, textColor"), "{msg}");
    }

    #[test]
    fn hex_parser_table() {
        assert_eq!(parse_hex("#000"), Some(Color::rgb(0.0, 0.0, 0.0)));
        assert_eq!(parse_hex("#fff"), Some(Color::rgb(1.0, 1.0, 1.0)));
        assert_eq!(parse_hex("#0f08"), Some(Color::rgba(0.0, 1.0, 0.0, 8.0 / 15.0)));
        assert_eq!(parse_hex("#D96C3B"), Some(Color::rgb(217.0 / 255.0, 108.0 / 255.0, 59.0 / 255.0)));
        assert_eq!(parse_hex("#d96c3b80").map(|c| c.to_rgba8()), Some([217, 108, 59, 128]));
        for s in ["", "#", "#1", "#12", "#1234", "#12345", "#1234567", "D96C3B", "#GGGGGG", "#fff ", "rgb(1,2,3)", "red", "#😀"] {
            assert!(parse_hex(s).is_none(), "`{s}` must refuse");
        }
        // Round trip through the canonical form.
        for s in ["#abc", "#abcd", "#AABBCC", "#aabbccdd"] {
            let c = parse_hex(s).expect("valid");
            assert_eq!(parse_hex(&hex_of(&c)).map(|b| b.to_rgba8()), Some(c.to_rgba8()), "{s} round-trips");
        }
    }
}
