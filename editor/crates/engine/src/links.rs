//! Community and project links (shown in Help ▸, the About dialog, the start screen and the
//! header's community button). The studio product ships every URL empty: each surface that
//! reads one hides itself when the constant is empty (editor/patches/, UPSTREAM.md).

pub const APP_NAME: &str = "Studio";
pub const APP_SLUG: &str = "studio";
pub const DISCORD: &str = "";
pub const WEBSITE: &str = "";
pub const APP_PAGE: &str = "";
pub const GITHUB: &str = "";
pub const ISSUES: &str = "";

/// Sibling apps of the upstream Studio family: (name, slug). Empty in the studio product,
/// which hides the start screen's cross-promotion rows.
pub const SIBLINGS: &[(&str, &str)] = &[];

pub fn github_of(slug: &str) -> String {
    format!("https://github.com/storytold/{slug}")
}
pub fn page_of(slug: &str) -> String {
    format!("https://getartcraft.com/apps/{slug}")
}
