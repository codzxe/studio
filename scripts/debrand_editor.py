#!/usr/bin/env python3
"""De-brand the vendored EffectCraft tree (patch 0001, ADR-0006 decision 10).

Usage: python3 debrand_editor.py <tree-root>   # tree root = editor/ or effectcraft-upstream/

Policy (see editor/patches/ + editor/UPSTREAM.md):
- Mechanical, word-boundary, case-sensitive rename: EffectCraft/ArtCraft -> Studio,
  over the engine + ui-egui + effectcraft-web source sets (labels, catalogs, tests,
  user-visible strings and comments move together so i18n keys stay aligned).
- Technical identifiers are NOT touched: window.effectcraft (bridge contract, ADR-0006 §4),
  the .ecproj XML root <EffectCraftProject> (file-format identity), lowercase crate/module
  names, canvas ids, cache prefixes.
- Upstream promo surfaces are feature-gated off by emptying the links.rs constants:
  Discord pill, GitHub/website header buttons, Home community foot + sibling rows,
  About dialog link buttons, Help menu promo/docs entries. Empty constant = surface hidden.
- Attribution is preserved, never renamed: *.attribution sidecars, LICENSE files, the
  untouched upstream mark at docs/brand/artcraft-mark.png.
"""

import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()

MECH_GLOBS = [
    "crates/engine/src/**/*.rs",
    "crates/ui-egui/src/**/*.rs",
    "crates/ui-egui/tests/*.rs",
    "crates/effects/src/catalog.rs",
    "apps/effectcraft-web/src/**/*.rs",
    "apps/effectcraft-web/js/host.js",
    "apps/effectcraft-web/tests/smoke.mjs",
    "apps/effectcraft-web/web/index.html",
    "apps/effectcraft-web/web/manifest.webmanifest",
    "apps/effectcraft-web/web/sw.js",
    "apps/effectcraft-web/web/worker.js",
    "apps/effectcraft-web/web/audio-worklet.js",
]

WORD = re.compile(r"\b(EffectCraft|ArtCraft)\b")
GRAMMAR_AN = re.compile(r"\ban Studio\b")
GRAMMAR_AN_UP = re.compile(r"\bAn Studio\b")


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def read(relpath: str) -> str:
    p = ROOT / relpath
    if not p.is_file():
        raise SystemExit(f"debrand: missing file {relpath}")
    return p.read_text(encoding="utf-8")


def write(relpath: str, text: str) -> None:
    (ROOT / relpath).write_text(text, encoding="utf-8")


def edit(relpath: str, old: str, new: str, expect: int = 1) -> None:
    """Exact-string replacement; asserts the pattern occurs exactly `expect` times."""
    text = read(relpath)
    n = text.count(old)
    if n != expect:
        raise SystemExit(f"debrand: {relpath}: expected {expect} occurrence(s), found {n}:\n---\n{old[:400]}\n---")
    write(relpath, text.replace(old, new))
    print(f"  targeted {relpath} ({n}x)")


def main() -> None:
    print(f"debrand: applying patch to {ROOT}")

    # ---- 1. links.rs: empty the upstream promo URLs; rename the app -----------------------
    write("crates/engine/src/links.rs", '''//! Community and project links (shown in Help \u25b8, the About dialog, the start screen and the
//! header's community button). The studio product ships every URL empty: each surface that
//! reads one hides itself when the constant is empty (editor/patches/, UPSTREAM.md).

pub const APP_NAME: &str = "Studio";
pub const APP_SLUG: &str = "studio";
pub const DISCORD: &str = "";
pub const WEBSITE: &str = "";
pub const APP_PAGE: &str = "";
pub const GITHUB: &str = "";
pub const ISSUES: &str = "";

/// Sibling apps of the upstream ArtCraft family: (name, slug). Empty in the studio product,
/// which hides the start screen's cross-promotion rows.
pub const SIBLINGS: &[(&str, &str)] = &[];

pub fn github_of(slug: &str) -> String {
    format!("https://github.com/storytold/{slug}")
}
pub fn page_of(slug: &str) -> String {
    format!("https://getartcraft.com/apps/{slug}")
}
''')
    print("  rewrote crates/engine/src/links.rs")

    # ---- 2. menus.rs TREE: keep the in-app Help items, drop the upstream promo/docs ------
    tree_help_old = """Help
  EffectCraft Help... | help.docs {"page":"help"} | F1
  Scripting Help... | help.docs {"page":"scripting"}
  Expression Reference... | help.docs {"page":"expressions"}
  Effect Reference... | help.docs {"page":"effects"}
  Animation Presets... | anim.browsePresets
  Keyboard Shortcuts... | app.keyboardShortcuts
  ---
  In-App Tutorials... | help.inAppTutorials
  Online Tutorials... | help.onlineTutorials
  ---
  System Compatibility Report... | help.systemReport
  Enable Logging | help.enableLogging
  Reveal Logging File | help.revealLogFile
  ---
  Join the ArtCraft Discord... | help.discord
  Provide Feedback... | help.reportIssue
  ---
  ArtCraft Website | help.website
  EffectCraft Home Page | help.appPage
  EffectCraft on GitHub | help.github
  Open Demo Project | file.openDemoProject
"""
    tree_help_new = """Help
  Animation Presets... | anim.browsePresets
  Keyboard Shortcuts... | app.keyboardShortcuts
  ---
  In-App Tutorials... | help.inAppTutorials
  ---
  System Compatibility Report... | help.systemReport
  Enable Logging | help.enableLogging
  Reveal Logging File | help.revealLogFile
  ---
  Open Demo Project | file.openDemoProject
"""
    edit("crates/engine/src/menus.rs", tree_help_old, tree_help_new)

    # ---- 3. help.rs: hide the promo commands from menus, drop the F1 binding -------------
    h = "crates/engine/src/commands/help.rs"
    edit(h, '[], Some("F1"),', "[], None,")
    edit(h, 'cmd!("help.discord", "Join the ArtCraft Discord...", ["Help"]', 'cmd!("help.discord", "Join the ArtCraft Discord...", []')
    edit(h, 'cmd!("help.website", "ArtCraft Website", ["Help"]', 'cmd!("help.website", "ArtCraft Website", []')
    edit(h, 'cmd!("help.appPage", "EffectCraft Home Page", ["Help"]', 'cmd!("help.appPage", "EffectCraft Home Page", []')
    edit(h, 'cmd!("help.github", "EffectCraft on GitHub", ["Help"]', 'cmd!("help.github", "EffectCraft on GitHub", []')
    edit(h, 'cmd!("help.onlineTutorials", "Online Tutorials...", ["Help"]', 'cmd!("help.onlineTutorials", "Online Tutorials...", []')
    edit(h, 'cmd!("help.reportIssue", "Provide Feedback...", ["Help"]', 'cmd!("help.reportIssue", "Provide Feedback...", []')

    # ---- 4. header.rs: swap the mark, gate the promo buttons ------------------------------
    hdr = "crates/ui-egui/src/header.rs"
    edit(hdr, '''/// The ArtCraft mark as supplied in `docs/brand` (the README's and getartcraft.com's logo; used
/// unmodified, see `docs/brand/LICENSE-brand.txt`).
static ARTCRAFT_MARK: &[u8] = include_bytes!("../../../docs/brand/artcraft-mark.png");''',
         '''/// The studio mark (original work, MIT OR Apache-2.0, see the .attribution sidecar). The
/// upstream mark stays untouched at `docs/brand/artcraft-mark.png` with its own licence
/// (LICENSE-brand.txt), unused by this build.
static STUDIO_MARK: &[u8] = include_bytes!("../../../docs/brand/studio-mark.png");''')
    edit(hdr, "image::load_from_memory_with_format(ARTCRAFT_MARK, image::ImageFormat::Png)",
         "image::load_from_memory_with_format(STUDIO_MARK, image::ImageFormat::Png)")
    edit(hdr, 'let id = egui::Id::new("artcraft-mark");', 'let id = egui::Id::new("studio-mark");')
    edit(hdr, 'ctx.load_texture("artcraft-mark", ci,', 'ctx.load_texture("studio-mark", ci,')

    edit(hdr, """    // The pill fits its label (icon, gap, text) with even padding: it was a fixed 104 px with the
    // text at its left, which left a wide gap on the right (#581).
    let label = p.layout_no_wrap(tr("Discord").to_string(), Tokens::semibold(12.0), Color32::WHITE);
    let discord = Rect::from_min_max(pos2(rx - (10.0 + 14.0 + 6.0 + label.size().x + 12.0), cy - 13.0), pos2(rx, cy + 13.0));
    let dresp = ui.interact(discord, egui::Id::new("hdr-discord"), Sense::click());
    let dc = Color32::from_rgb(0x58, 0x65, 0xf2);
    p.rect_filled(discord, 13.0, if dresp.hovered() { dc.gamma_multiply(1.2) } else { dc });
    icons::paint(&p, Rect::from_center_size(pos2(discord.min.x + 17.0, cy), vec2(14.0, 14.0)), Icon::Chat, Color32::WHITE);
    p.galley(pos2(discord.min.x + 30.0, cy - label.size().y / 2.0), label, Color32::WHITE);
    app.auto.add("header.discord", discord, "Join the ArtCraft Discord");
    if dresp.on_hover_text(tr("Join the ArtCraft community on Discord")).clicked() {
        let _ = app.session.execute("help.discord", json!({}));
    }
    rx = discord.min.x - 6.0;
    for (id, icon, tip, cmd) in
        [("hdr-github", Icon::Code, "EffectCraft on GitHub", "help.github"), ("hdr-web", Icon::Globe, "EffectCraft on getartcraft.com", "help.appPage")]
    {""",
         """    // The pill fits its label (icon, gap, text) with even padding: it was a fixed 104 px with the
    // text at its left, which left a wide gap on the right (#581). Hidden when the constant is
    // empty (studio ships the community links off).
    if !effectcraft_engine::links::DISCORD.is_empty() {
        let label = p.layout_no_wrap(tr("Discord").to_string(), Tokens::semibold(12.0), Color32::WHITE);
        let discord = Rect::from_min_max(pos2(rx - (10.0 + 14.0 + 6.0 + label.size().x + 12.0), cy - 13.0), pos2(rx, cy + 13.0));
        let dresp = ui.interact(discord, egui::Id::new("hdr-discord"), Sense::click());
        let dc = Color32::from_rgb(0x58, 0x65, 0xf2);
        p.rect_filled(discord, 13.0, if dresp.hovered() { dc.gamma_multiply(1.2) } else { dc });
        icons::paint(&p, Rect::from_center_size(pos2(discord.min.x + 17.0, cy), vec2(14.0, 14.0)), Icon::Chat, Color32::WHITE);
        p.galley(pos2(discord.min.x + 30.0, cy - label.size().y / 2.0), label, Color32::WHITE);
        app.auto.add("header.discord", discord, "Join the community");
        if dresp.on_hover_text(tr("Join the community on Discord")).clicked() {
            let _ = app.session.execute("help.discord", json!({}));
        }
        rx = discord.min.x - 6.0;
    }
    let mut header_links: Vec<(&str, Icon, &str, &str)> = Vec::new();
    if !effectcraft_engine::links::GITHUB.is_empty() {
        header_links.push(("hdr-github", Icon::Code, "Source code on GitHub", "help.github"));
    }
    if !effectcraft_engine::links::APP_PAGE.is_empty() {
        header_links.push(("hdr-web", Icon::Globe, "Home page", "help.appPage"));
    }
    for (id, icon, tip, cmd) in header_links
    {""")

    # ---- 5. home.rs: gate the community foot on non-empty links ---------------------------
    home = "crates/ui-egui/src/panels/home.rs"
    edit(home, """    // Community links at the foot (below the pages when the window is short).
    let links = [
        (Icon::Chat, "Join the ArtCraft Discord", "help.discord"),
        (Icon::Globe, "getartcraft.com", "help.website"),
        (Icon::Globe, "EffectCraft home page", "help.appPage"),
        (Icon::Code, "EffectCraft on GitHub", "help.github"),
    ];
    let sib = effectcraft_engine::links::SIBLINGS;
    let sib_rows = sib.len().div_ceil(2) as f32;
    let foot_h = 22.0 + links.len() as f32 * 30.0 + 22.0 + sib_rows * 26.0;
    let mut cy = (rail.max.y - 16.0 - foot_h).max(y + 16.0);
    p.line_segment([pos2(x0, cy - 10.0), pos2(x0 + w, cy - 10.0)], Stroke::new(1.0, t.separator));
    p.text(pos2(x0, cy + 6.0), Align2::LEFT_CENTER, tr("Community"), Tokens::semibold(12.0), t.text_dim);
    cy += 22.0;
    for (icon, label, cmd) in links {
        let r = Rect::from_min_size(pos2(x0, cy), vec2(w, 26.0));
        let resp = ui.interact(r, egui::Id::new(("home-link", cmd)), Sense::click());
        let discord = cmd == "help.discord";
        if discord {
            p.rect_filled(r, 13.0, Color32::from_rgb(0x58, 0x65, 0xf2));
        } else if resp.hovered() {
            p.rect_filled(r, 13.0, t.hover);
        }
        let col = if discord { Color32::WHITE } else { t.text };
        icons::paint(p, Rect::from_center_size(pos2(r.min.x + 16.0, r.center().y), vec2(13.0, 13.0)), icon, col);
        p.text(pos2(r.min.x + 30.0, r.center().y), Align2::LEFT_CENTER, tr(label), Tokens::medium(12.0), col);
        app.auto.add(&format!("home.{cmd}"), r, label);
        if resp.clicked() {
            let _ = app.session.execute(cmd, json!({}));
        }
        cy += 30.0;
    }
    p.text(pos2(x0, cy + 8.0), Align2::LEFT_CENTER, tr("More ArtCraft apps"), Tokens::ui(11.0), t.text_faint);
    cy += 20.0;
    let sw = (w - 6.0) / 2.0;
    for (i, (name, slug)) in sib.iter().enumerate() {
        let r = Rect::from_min_size(pos2(x0 + (i % 2) as f32 * (sw + 6.0), cy + (i / 2) as f32 * 26.0), vec2(sw, 22.0));
        let resp = ui.interact(r, egui::Id::new(("sib", *slug)), Sense::click());
        p.rect_filled(r, 11.0, if resp.hovered() { t.hover } else { t.field_bg });
        p.text(r.center(), Align2::CENTER_CENTER, *name, Tokens::ui(11.0), t.text);
        app.auto.add(&format!("home.sibling.{slug}"), r, name);
        if resp.clicked() {
            let _ = app.session.execute("help.sibling", json!({"app": slug}));
        }
    }
}""",
         """    // Community links at the foot (below the pages when the window is short): every entry
    // shows only while its links.rs constant is non-empty (studio ships them all empty).
    let mut links: Vec<(Icon, &str, &str)> = Vec::new();
    if !effectcraft_engine::links::DISCORD.is_empty() { links.push((Icon::Chat, "Join the community", "help.discord")); }
    if !effectcraft_engine::links::WEBSITE.is_empty() { links.push((Icon::Globe, "Website", "help.website")); }
    if !effectcraft_engine::links::APP_PAGE.is_empty() { links.push((Icon::Globe, "Home page", "help.appPage")); }
    if !effectcraft_engine::links::GITHUB.is_empty() { links.push((Icon::Code, "Source code on GitHub", "help.github")); }
    let sib = effectcraft_engine::links::SIBLINGS;
    if !links.is_empty() {
        let sib_rows = sib.len().div_ceil(2) as f32;
        let foot_h = 22.0 + links.len() as f32 * 30.0 + 22.0 + sib_rows * 26.0;
        let mut cy = (rail.max.y - 16.0 - foot_h).max(y + 16.0);
        p.line_segment([pos2(x0, cy - 10.0), pos2(x0 + w, cy - 10.0)], Stroke::new(1.0, t.separator));
        p.text(pos2(x0, cy + 6.0), Align2::LEFT_CENTER, tr("Community"), Tokens::semibold(12.0), t.text_dim);
        cy += 22.0;
        for &(icon, label, cmd) in &links {
            let r = Rect::from_min_size(pos2(x0, cy), vec2(w, 26.0));
            let resp = ui.interact(r, egui::Id::new(("home-link", cmd)), Sense::click());
            let discord = cmd == "help.discord";
            if discord {
                p.rect_filled(r, 13.0, Color32::from_rgb(0x58, 0x65, 0xf2));
            } else if resp.hovered() {
                p.rect_filled(r, 13.0, t.hover);
            }
            let col = if discord { Color32::WHITE } else { t.text };
            icons::paint(p, Rect::from_center_size(pos2(r.min.x + 16.0, r.center().y), vec2(13.0, 13.0)), icon, col);
            p.text(pos2(r.min.x + 30.0, r.center().y), Align2::LEFT_CENTER, tr(label), Tokens::medium(12.0), col);
            app.auto.add(&format!("home.{cmd}"), r, label);
            if resp.clicked() {
                let _ = app.session.execute(cmd, json!({}));
            }
            cy += 30.0;
        }
        if !sib.is_empty() {
            p.text(pos2(x0, cy + 8.0), Align2::LEFT_CENTER, tr("More apps"), Tokens::ui(11.0), t.text_faint);
            cy += 20.0;
            let sw = (w - 6.0) / 2.0;
            for (i, (name, slug)) in sib.iter().enumerate() {
                let r = Rect::from_min_size(pos2(x0 + (i % 2) as f32 * (sw + 6.0), cy + (i / 2) as f32 * 26.0), vec2(sw, 22.0));
                let resp = ui.interact(r, egui::Id::new(("sib", *slug)), Sense::click());
                p.rect_filled(r, 11.0, if resp.hovered() { t.hover } else { t.field_bg });
                p.text(r.center(), Align2::CENTER_CENTER, *name, Tokens::ui(11.0), t.text);
                app.auto.add(&format!("home.sibling.{slug}"), r, name);
                if resp.clicked() {
                    let _ = app.session.execute("help.sibling", json!({"app": slug}));
                }
            }
        }
    }
}""")

    # ---- 6. dialogs.rs: About blurb + link buttons ------------------------------------------
    dlg = "crates/ui-egui/src/panels/dialogs.rs"
    edit(dlg,
         'ui.label(tr("A clean-room, open-source compositor for motion graphics and visual effects: native on macOS, Windows and Linux, and in the browser. Part of the ArtCraft family of creative apps."));',
         'ui.label(tr("A clean-room, open-source compositor for motion graphics and visual effects: native on macOS, Windows and Linux, and in the browser."));')
    edit(dlg, """    let links: [(Icon, &str, &str, &'static str); 4] = [
        (Icon::Chat, "Join the ArtCraft Discord", effectcraft_engine::links::DISCORD, "help.discord"),
        (Icon::Globe, "ArtCraft website", effectcraft_engine::links::WEBSITE, "help.website"),
        (Icon::Sparkle, "EffectCraft home page", effectcraft_engine::links::APP_PAGE, "help.appPage"),
        (Icon::Code, "Source code on GitHub", effectcraft_engine::links::GITHUB, "help.github"),
    ];
    for (icon, label, url, c) in links {""",
         """    let all_links: [(Icon, &str, &str, &'static str); 4] = [
        (Icon::Chat, "Join the community", effectcraft_engine::links::DISCORD, "help.discord"),
        (Icon::Globe, "Website", effectcraft_engine::links::WEBSITE, "help.website"),
        (Icon::Sparkle, "Home page", effectcraft_engine::links::APP_PAGE, "help.appPage"),
        (Icon::Code, "Source code on GitHub", effectcraft_engine::links::GITHUB, "help.github"),
    ];
    let links: Vec<(Icon, &str, &str, &'static str)> = all_links.into_iter().filter(|l| !l.2.is_empty()).collect();
    for (icon, label, url, c) in links {""")

    # ---- 7. effect_controls.rs: honest licence line (not "Studio-licensed") -----------------
    edit("crates/ui-egui/src/panels/effect_controls.rs",
         '"EffectCraft built-in effect (MIT OR Apache-2.0)".to_string(),',
         '"Built-in effect (MIT OR Apache-2.0)".to_string(),')

    # ---- 8. xtask: PWA icons come from the studio mark --------------------------------------
    edit("xtask/src/main.rs",
         'let src = format!("assets/app-icon/hicolor/{n}x{n}/apps/ai.storyteller.effectcraft.png");',
         'let src = format!("assets/app-icon/studio/icon-{n}.png");')

    # ---- 9. Mechanical word-boundary rename over the whole scope ---------------------------
    files = []
    for g in MECH_GLOBS:
        files.extend(ROOT.glob(g))
    seen: set[Path] = set()
    touched = 0
    for p in sorted(set(files)):
        if not p.is_file() or p in seen:
            continue
        seen.add(p)
        text = p.read_text(encoding="utf-8")
        new = WORD.sub("Studio", text)
        new = GRAMMAR_AN.sub("a Studio", new)
        new = GRAMMAR_AN_UP.sub("A Studio", new)
        if new != text:
            p.write_text(new, encoding="utf-8")
            touched += 1
    print(f"  mechanical rename touched {touched} files ({len(seen)} scanned)")

    # ---- 10. Verify: what brand strings remain in scope (should be none) --------------------
    residual = []
    for p in sorted(seen):
        if not p.is_file():
            continue
        text = p.read_text(encoding="utf-8")
        for i, line in enumerate(text.splitlines(), 1):
            if WORD.search(line):
                residual.append(f"{rel(p)}:{i}: {line.strip()[:120]}")
    if residual:
        print(f"debrand: {len(residual)} residual brand lines in scope:")
        for r in residual[:40]:
            print("   ", r)
    else:
        print("debrand: scope is clean (0 residual EffectCraft/ArtCraft strings)")

    # Out-of-scope verification (attribution stays intact):
    attr = (ROOT / "apps/effectcraft-web/web/favicon.svg.attribution")
    if attr.is_file() and "EffectCraft" in attr.read_text(encoding="utf-8"):
        print("debrand: note - favicon.svg.attribution still credits the upstream mark (replaced by make_studio_assets.py)")


if __name__ == "__main__":
    main()
