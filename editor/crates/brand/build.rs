//! Read the repo-root `brand.json` (the single source of truth) and emit the
//! `generated` module. If the file is missing (e.g. a bare crate publish),
//! fall back to the committed defaults so the crate still builds.

use std::env;
use std::fs;
use std::path::Path;

fn main() {
    println!("cargo::rerun-if-changed=../../../brand.json");
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR");
    let dest = Path::new(&out_dir).join("brand_generated.rs");

    // Repo root: crates/brand/build.rs -> up 3.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../brand.json");
    let src = fs::read_to_string(&root).ok().and_then(|s| serde_json_min(&s));

    let get = |key: &str, fallback: &str| {
        src.as_ref()
            .and_then(|m| m.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()))
            .unwrap_or_else(|| fallback.to_string())
    };

    let product = get("productName", "Studio");
    let codename = get("codename", "Studio");
    let version = get("version", "0.13.0");
    let code = format!(
        "/// GENERATED from the repo-root brand.json by build.rs — do not edit.\n\
         pub const PRODUCT_NAME: &str = {product:?};\n\
         pub const CODENAME: &str = {codename:?};\n\
         pub const VERSION: &str = {version:?};\n"
    );
    fs::write(&dest, code).expect("write brand_generated.rs");
}

/// Minimal JSON string-value extractor (no serde dependency at build time).
fn serde_json_min(s: &str) -> Option<Vec<(String, String)>> {
    let mut out = Vec::new();
    for line in s.lines() {
        let line = line.trim();
        let Some((k, v)) = line.split_once(':') else { continue };
        let k = k.trim().trim_matches('"').to_string();
        if k.starts_with('$') {
            continue;
        }
        let v = v.trim().trim_end_matches(',').trim().trim_matches('"').to_string();
        if !k.is_empty() && !v.is_empty() {
            out.push((k, v));
        }
    }
    if out.is_empty() { None } else { Some(out) }
}
