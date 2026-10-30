//! Single-source product identity for the Rust editor.
//!
//! Every user-facing name in the editor (window titles, export metadata,
//! script `app.version`, format roots, log identities) reads from THIS crate,
//! which reads the repo-root `brand.json` at build time. Renaming the product
//! is a one-file change; the TS side (`@studio/config` Brand tokens) is
//! drift-guarded against the same file by packages/config tests.

#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

include!(concat!(env!("OUT_DIR"), "/brand_generated.rs"));
