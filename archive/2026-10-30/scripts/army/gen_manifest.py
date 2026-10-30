#!/usr/bin/env python3
"""scripts/army/gen_manifest.py — generate army/manifest-w1.md (Wave-1 audit scopes).

Round 13. Idempotent; prints the scope count so the lead can calibrate.
"""
from __future__ import annotations

import glob
import os

ROOT = "/home/z/my-project"
scopes: list[tuple[str, list[str]]] = []  # (title, files-or-notes)


def rels(base: str, pat: str, exclude: tuple[str, ...] = ()) -> list[str]:
    out = []
    always_skip = ("node_modules", ".turbo", "/dist/", "/build/", "/coverage/")
    for p in sorted(glob.glob(os.path.join(ROOT, base, pat), recursive=True)):
        r = os.path.relpath(p, ROOT)
        if any(x in r for x in always_skip):
            continue
        if any(x in r for x in exclude):
            continue
        out.append(r)
    return out


def chunk(base: str, pat: str, size: int, title: str, exclude: tuple[str, ...] = ()) -> int:
    fs = rels(base, pat, exclude)
    n = 0
    for i in range(0, len(fs), size):
        n += 1
        total = (len(fs) + size - 1) // size
        scopes.append((f"{title} — part {n} of {total}", fs[i : i + size]))
    return n


def one(title: str, files: list[str]) -> None:
    scopes.append((title, files))


def special(title: str, notes: list[str]) -> None:
    scopes.append((title, notes))


# ---------------- editor: Rust crates ----------------
chunk("editor/crates/ui-egui/src", "*.rs", 2, "ui-egui core", exclude=("panels", "i18n"))
one("ui-egui i18n", rels("editor/crates/ui-egui/src/i18n", "*.rs"))
chunk("editor/crates/ui-egui/src/panels", "*.rs", 4, "ui-egui panels")
chunk("editor/crates/ui-egui/tests", "*.rs", 30, "ui-egui tests (wrong-test audit)")
chunk("editor/crates/engine/src", "*.rs", 4, "engine core", exclude=("commands", "menus", "doc_path"))
chunk("editor/crates/engine/src/commands", "*.rs", 5, "engine commands")
one("engine menus + doc_path", rels("editor/crates/engine/src/menus", "**/*.rs") + rels("editor/crates/engine/src/doc_path", "**/*.rs"))
chunk("editor/crates/engine", "tests_*.rs", 12, "engine inline tests (wrong-test audit)")
chunk("editor/crates/engine/tests", "*.rs", 3, "engine integration tests (wrong-test audit)")
one("engine presets + scripts content (JSON/JSX data audit)", [p for p in rels("editor/crates/engine/presets", "**/*") + rels("editor/crates/engine/scripts", "**/*") if ".attribution" not in p])
chunk("editor/crates/effects/src", "*.rs", 5, "effects", exclude=("puppet",))
one("effects puppet + tests", rels("editor/crates/effects/src/puppet", "*.rs") + rels("editor/crates/effects/tests", "*.rs"))
chunk("editor/crates/gpu/src", "*.rs", 6, "gpu")
chunk("editor/crates/render/src", "*.rs", 6, "render")
chunk("editor/crates/script/src", "*.rs", 5, "script (boa JS runtime)")
chunk("editor/crates/expr/src", "*.rs", 6, "expr")
chunk("editor/crates/text/src", "*.rs", 4, "text (fonts/sfnt/layout)")
one("text tests", rels("editor/crates/text/tests", "*.rs"))
chunk("editor/crates/track/src", "*.rs", 6, "track core", exclude=("roto", "camtrack"))
one("track roto", [p for p in rels("editor/crates/track/src/roto", "*.rs") if "tests" not in p])
one("track camtrack + tests", rels("editor/crates/track/src/camtrack", "*.rs") + rels("editor/crates/track/src", "tests.rs"))
one("keyframe crate", rels("editor/crates/keyframe/src", "*.rs"))
one("path crate", rels("editor/crates/path/src", "*.rs"))
one("geom + color crates", rels("editor/crates/geom/src", "*.rs") + rels("editor/crates/color/src", "*.rs"))
one("media crate", rels("editor/crates/media/src", "*.rs"))
one("segment crate", rels("editor/crates/segment/src", "*.rs"))
one("project crate", rels("editor/crates/project/src", "*.rs"))
one("host crate src", rels("editor/crates/host/src", "*.rs"))
one("host crate tests", rels("editor/crates/host/tests", "*.rs"))
one("export crate src", rels("editor/crates/export/src", "*.rs"))
one("export crate tests", rels("editor/crates/export/tests", "*.rs"))
chunk("editor/crates/av1enc/src", "*.rs", 6, "av1enc")
one("vp9enc crate", rels("editor/crates/vp9enc/src", "*.rs"))
chunk("editor/crates/hevcenc/src", "*.rs", 6, "hevcenc")
one("opusenc crate", rels("editor/crates/opusenc/src", "*.rs"))
one("pdf crate src", rels("editor/crates/pdf/src", "*.rs"))
one("pdf crate tests", rels("editor/crates/pdf/tests", "*.rs"))
one("model crate src", rels("editor/crates/model/src", "*.rs"))
one("model crate tests", rels("editor/crates/model/tests", "*.rs"))
one("psd crate src", rels("editor/crates/psd/src", "*.rs"))
one("svg crate src + tests", rels("editor/crates/svg/src", "*.rs") + rels("editor/crates/svg/tests", "*.rs"))
one("lottie crate src", [p for p in rels("editor/crates/lottie/src", "*.rs") if "tests" not in p])
one("lottie tests + fixtures", [p for p in rels("editor/crates/lottie/src/tests", "*.rs") + rels("editor/crates/lottie/tests", "*.rs") if ".attribution" not in p])
one("raster crate", rels("editor/crates/raster/src", "*.rs"))
one("automation crate src", [p for p in rels("editor/crates/automation/src", "*.rs") if "tests" not in p])
one("automation crate tests", rels("editor/crates/automation/tests", "**/*.rs"))
one("plugin crate", rels("editor/crates/plugin/src", "*.rs") + rels("editor/crates/plugin/tests", "*.rs"))
chunk("editor/apps/effectcraft-web/src", "*.rs", 4, "effectcraft-web app (wasm)")
one("effectcraft-web web/ js + html + tests", rels("editor/apps/effectcraft-web/web", "*") + rels("editor/apps/effectcraft-web/tests", "*.mjs"))
one("effectcraft-cli app", rels("editor/apps/effectcraft-cli/src", "*.rs") + rels("editor/apps/effectcraft-cli/tests", "*.rs"))
one("effectcraft native app (deletion-candidate audit)", rels("editor/apps/effectcraft/src", "*.rs") + ["editor/apps/effectcraft/Cargo.toml", "editor/apps/effectcraft/build.rs"])
one("xtask build tool", rels("editor/xtask/src", "*.rs"))
_tomls = ["editor/Cargo.toml"] + [os.path.relpath(p, ROOT) for p in sorted(glob.glob(f"{ROOT}/editor/crates/*/Cargo.toml") + glob.glob(f"{ROOT}/editor/apps/*/Cargo.toml") + glob.glob(f"{ROOT}/editor/xtask/Cargo.toml"))]
one("editor workspace Cargo.tomls (deps hygiene, feature flags, profiles)", _tomls)

# ---------------- editor: cross-cutting rust hunters ----------------
special("RUST census: panics in wasm-graph crates A–M", ["Grep the `editor/crates` tree (crates: automation, av1enc, color, effects, engine, export, expr, geom, gpu, host, keyframe, lottie, media, model) for `unwrap()`, `.expect(`, `panic!`, `unreachable!`, `todo!`, `unimplemented!`, and unguarded slice indexing in NON-test code.", "For each hit: is it reachable from the wasm web build (effectcraft-web dep graph) or the cli? A panic in wasm = tab death. Report each with reachability verdict and fix suggestion (proper error handling). Tests get a pass unless the panic masks a missing assertion."])
special("RUST census: panics in wasm-graph crates N–Z", ["Same mission as the A–M census but crates: path, pdf, plugin, project, psd, raster, render, script, segment, svg, text, track, ui-egui, vp9enc, hevcenc, opusenc + apps/effectcraft-web.", "ui-egui is UI code — panics there are directly user-reachable. Be thorough."])
special("RUST census: todo!/stub sweep + fake-success commands", ["Grep `editor/` for: `todo!`, `unimplemented!`, `TODO`, `FIXME`, `HACK`, `XXX`, `not implemented`, `placeholder`, `stub`, `dummy`, `fake`, `coming soon`.", "For each: real or cosmetic? Does any engine command report success while doing nothing (the agent harness would then believe work happened)? That class is CRIT."])
special("RUST census: brand leakage + hardcoded strings/URLs", ["Grep `editor/crates` + `editor/apps` + `editor/xtask` src for: `effectcraft`, `EffectCraft`, `ArtCraft`, `PhotoCraft`, `Photoshop`, `storytold`, `github.com`, `discord`, `http://`, `https://`, hardcoded emails, and home-dir paths.", "Classify each: user-visible UI string / internal identifier / doc comment / URL constant. Internal crate names are a known accepted set — focus on strings that leak to users or hardcode what belongs in config."])
special("RUST census: hot-path allocation + algorithm audit", ["Targeted perf hunt across engine/render/gpu/effects/raster: allocations inside per-frame/per-pixel loops (`Vec::new()` in iteration bodies, `format!`/`to_string()` in hot paths, `clone()` per item), O(n²) scans over layers/keys, repeated linear searches that should be maps, full-buffer copies per frame.", "Only report when the path is plausibly hot (render loop, timeline scrub, paint stroke, tracking). Cite file:line + the loop context."])

# ---------------- editor: non-rust ----------------
_part1 = ["architecture.md", "web.md", "control-protocol.md", "agents.md", "mcp.md", "gaps.md", "roadmap.md"]
one("editor docs/ part 1 (architecture, web, control-protocol, agents, mcp, gaps, roadmap)", [f"editor/docs/{n}" for n in _part1 if os.path.exists(f"{ROOT}/editor/docs/{n}")])
_skip = [f"editor/docs/{n}" for n in _part1] + ["editor/docs/contributors.md", "editor/docs/README.md"]
one("editor docs/ part 2 (parity + fidelity + releasing + testing + plugins)", [p for p in rels("editor/docs", "*.md") if p not in _skip] + rels("editor/docs/fidelity", "*.md") + rels("editor/docs/fidelity", "*.json"))
one("editor docs/ images + brand assets (dead-asset census)", [p for p in rels("editor/docs/images", "*") + rels("editor/docs/brand", "*") if ".attribution" not in p])
_root_files = ["editor/README.md", "editor/UPSTREAM.md", "editor/NOTICE", "editor/ATTRIBUTION.md", "editor/CLAUDE.md", "editor/AGENTS.md", "editor/ROADMAP.md", "editor/rustfmt.toml", "editor/clippy.toml", "editor/patches/README.md", "editor/patches/0001-debrand.patch"]
one("editor root files (README, UPSTREAM, NOTICE, ATTRIBUTION, CLAUDE, AGENTS, ROADMAP, rustfmt, clippy, patches)", [p for p in _root_files if os.path.exists(f"{ROOT}/{p}")])
special("editor packaging/ + assets/ + contributors/ + examples/ + extensions/ — DELETION MAP", ["Mission: produce an evidence-based deletion map of upstream leftovers. For every directory under editor/packaging/, editor/assets/ (fonts excepted — they are build inputs), editor/contributors/, editor/examples/, editor/extensions/, editor/assets/app-icon/: determine what actually references it (grep the whole repo: Cargo builds, xtask, the web dist pipeline in editor/apps/effectcraft-web/web + editor/xtask/src/main.rs, tests, docs that matter).", "The product is WEB-ONLY: desktop packaging (flatpak/msi/dmg/nfpm), desktop icons, native-app assets are dead weight IF nothing references them. BUT: xtask copies icons from assets/app-icon/studio into the dist — verify which icon files are load-bearing.", "Output: for each subtree — KEEP (load-bearing, cite the consumer) / DELETE (nothing references) / KEEP-LEGAL (license/attribution obligation). Also list editor/apps/effectcraft (the native desktop app) consumers."])
special("LICENSE obligations audit (what MUST survive a rename/purge)", ["Read editor/LICENSE-MIT, editor/LICENSE-APACHE, editor/NOTICE, editor/ATTRIBUTION.md, editor/docs/brand/LICENSE-brand.txt, and the .attribution sidecar pattern.", "Determine the minimal legally-required set when we (a) rename crates/globals away from effectcraft, (b) delete packaging/docs trees, (c) restyle ui-egui. MIT/Apache-2.0 requirements: license text + state changes. Which attribution files are legal necessity vs project convention?", "Output: a KEEP-LEGAL list (exact files) + what may go. This decides the deletion wave."])
special("i18n catalog integrity (ui-egui/src/i18n/ui.rs + effects.rs)", ["Audit the localization tables: all 10 locales. Hunt: keys present in one locale but missing in others (panic/fallback risk at lookup), stale upstream strings (EffectCraft/ArtCraft/community links) surviving in values, keys whose lookup site no longer exists (dead entries), obviously broken UI strings.", "This is a big table file — sample systematically per locale section, and grep for the forbidden brand words in values."])
special("RENAME blast-radius map (effectcraft → config-driven)", ["Mission: enumerate EVERY occurrence class of the `effectcraft` token repo-wide and design the rename. Classes to map with exact file lists: (1) crate names (Cargo.toml [package].name + dir names + `use` paths), (2) `window.effectcraft` + `effectcraftLoad` JS globals (editor web/ html+js, apps/web bridge + tests + e2e + warmup + docs), (3) dist file names (effectcraft_web.js, effectcraft_web_bg.wasm — produced by wasm-bindgen from crate name; referenced in next.config comments, sw.js FILES list, xtask), (4) storage/cache keys (grep persist/store/diskcache in effectcraft-web, OPFS/IndexedDB names, SW cache prefix `effectcraft-`), (5) file-format identifiers (.ecproj, `<EffectCraftProject>` in engine xml_project.rs — where are they read/written?), (6) docs/tests/scripts mentions, (7) services/worker + gateway references to effectcraft-cli, (8) apps/web/public/editor committed dist names.", "For each class: exact files + whether renaming breaks stored user data (acceptable pre-launch — flag it) or external contract. Recommend the new token set (engine global via ONE brand config, crate names neutral like `engine-web`)."])
special("STORAGE KEY audit (browser-persisted state)", ["Map every browser storage key the editor + host write: localStorage, sessionStorage, OPFS, IndexedDB (names + versions), SW cache names. Files: editor/apps/effectcraft-web/src/{persist,store,diskcache,storage,files}.rs, web/sw.js, apps/web/src/lib/editor-*.ts, editor-gpu-fallback keys.", "Find: legacy/dead keys nothing reads anymore (e.g. `studio_force_webgl` — the poison pill), version-skew risks after rename, unbounded growth (caches never pruned), keys storing stale config."])

# ---------------- apps/web ----------------
chunk("apps/web/src/lib/chat", "**/*.ts", 4, "web chat lib (controller/run-state/provider/apply/tools)")
chunk("apps/web/src/lib", "**/*.ts", 4, "web lib non-chat (editor-session, warmup, gpu-fallback, gateway, api)", exclude=("chat",))
chunk("apps/web/src/components/chat", "**/*.tsx", 3, "web chat components")
chunk("apps/web/src/components/editor-host", "**/*.{ts,tsx}", 4, "web editor-host components")
chunk("apps/web/src/components", "**/*.{ts,tsx}", 5, "web components non-chat/editor-host (ui, marketing, presence, render)", exclude=("chat", "editor-host"))
chunk("apps/web/src/app", "**/*.{ts,tsx,css}", 5, "web app routes/pages", exclude=("api",))
chunk("apps/web/src/app/api", "**/*.ts", 2, "web api routes + v1")
chunk("apps/web/e2e", "*.spec.ts", 4, "web e2e specs (wrong-test audit)")
chunk("apps/web/tests", "**/*.{ts,tsx}", 2, "web unit tests (wrong-test audit)")
_webcfg = ["apps/web/next.config.ts", "apps/web/api/gateway.ts", "apps/web/api/gateway.mjs", "apps/web/vercel.json", "apps/web/playwright.config.ts", "apps/web/package.json", "apps/web/tsconfig.json"]
one("web config surface (next.config, vercel adapter, playwright, package)", [p for p in _webcfg if os.path.exists(f"{ROOT}/{p}")])
one("web src root + hooks/providers", rels("apps/web/src", "*.ts*") + rels("apps/web/src/hooks", "**/*.ts*") + rels("apps/web/src/providers", "**/*.ts*"))

# ---------------- packages ----------------
chunk("packages/editor-bridge", "**/*.ts", 3, "editor-bridge package (bridge, batch, fake, errors)")
one("packages/config", [p for p in rels("packages/config", "**/*.ts") if "node_modules" not in p])
chunk("packages/contracts", "**/*.ts", 3, "contracts package (command registry, routes, engine-batch)")
one("packages/storage", [p for p in rels("packages/storage", "**/*.ts") if "node_modules" not in p])
_db = [p for p in rels("packages/db", "**/*.ts") if "node_modules" not in p and "migrations" not in p] + (["packages/db/prisma/schema.prisma"] if os.path.exists(f"{ROOT}/packages/db/prisma/schema.prisma") else [])
one("packages/db (schema + src)", _db)
chunk("packages/api-client", "**/*.ts", 2, "api-client package")
one("packages/ui (design system)", [p for p in rels("packages/ui/src", "**/*.{ts,tsx,css}") if "node_modules" not in p])

# ---------------- services ----------------
chunk("services/gateway/src/routes", "*.ts", 2, "gateway routes")
chunk("services/gateway/src/litellm", "*.ts", 2, "gateway litellm (runner, prompt, openai, tools)")
one("gateway core (plan-compiler, auto-apply, credits, middleware, db, handler)", [p for p in rels("services/gateway/src", "*.ts") if "/routes/" not in p and "/litellm/" not in p])
chunk("services/gateway/tests", "*.ts", 3, "gateway tests (wrong-test audit)")
chunk("services/worker/src", "*.ts", 3, "worker src")
one("worker tests + scripts", [p for p in rels("services/worker/tests", "**/*.ts") + rels("services/worker/scripts", "*.ts") if "node_modules" not in p])

# ---------------- scripts / infra / ci / docs ----------------
chunk("scripts", "*.mjs", 4, "repo scripts mjs (build, probes, perf, dev-ready)")
chunk("scripts", "*.{sh,py}", 3, "repo scripts sh/py (editor build, debrand, assets, cleanup)")
one("infra (caddy, docker, deploy)", [p for p in rels("infra", "**/*") if ".git" not in p] + [p for p in ["Caddyfile"] if os.path.exists(f"{ROOT}/{p}")])
one("CI workflows", rels(".github/workflows", "*.yml") + rels(".github/workflows", "*.yaml"))
chunk("docs", "**/*.md", 4, "repo docs (stale-doc audit: contradictions with current code, dead references)")
_rootcfg = ["package.json", "turbo.json", "biome.json", "tsconfig.base.json", "knip.json", "renovate.json", ".github/dependabot.yml", "pnpm-workspace.yaml", ".env.example"]
one("root config files (package.json, turbo, biome, tsconfig, knip, renovate, dependabot, pnpm-workspace)", [p for p in _rootcfg if os.path.exists(f"{ROOT}/{p}")])

# ---------------- special planners ----------------
special("PLAN: single-source brand config (TS + Rust + CI from ONE file)", ["Design the ONE-file brand/product config for the whole repo. Read: packages/config/src/brand.ts (today's TS tokens), editor/patches/0001-debrand.patch (how Rust was hardcoded), editor/crates/ui-egui/src/theme.rs, editor/apps/effectcraft-web/web/index.html, editor/UPSTREAM.md, docs/adr/0006-effectcraft-editor-pivot.md.", "Deliverable: concrete design — file format (JSON at repo root), field list (product name, codename, engine global name, title/tagline, domains, contact, social, forbidden names, theme: fonts + palette tokens, feature toggles like promo-links-off), generator mechanics (script emitting packages/config/src/brand.generated.ts + a Rust `brand` crate via build.rs reading the same JSON; xtask reads it for dist naming; CI freshness gate).", "Include: exact file tree of changes, how `window.<engine-global>` gets generated into index.html, how storage-key prefixes + SW cache prefix flow from it, and the migration/compat notes (breaking stored browser data is acceptable pre-launch — list what breaks)."])
special("PLAN: Rust brand crate + build-time injection", ["Design the Rust-side mechanism only: a new `editor/crates/brand` crate whose build.rs parses the root brand JSON (path via env with a sane default) and emits consts (product name, engine global, cache/storage prefixes, file-format ids, promo-link emptiness).", "Read editor/crates/engine/src/links.rs (the emptied promo constants — the pattern to generalize), xml_project.rs (file-format ids), ui-egui theme.rs, apps/effectcraft-web (storage keys), xtask (dist naming + sw version).", "Deliverable: the crate skeleton (build.rs + lib.rs API), the exact call-site rewrites needed (file:line list), and how tests keep working (tests must not depend on the JSON — provide defaults)."])
special("PLAN: seamless app+editor merge (UX + UI)", ["Mission: make the Next.js SaaS shell and the egui WASM editor feel like ONE product. Read: apps/web/src/components/editor-host/* (editor-host.tsx, project-bar.tsx, banners, capability-gate), the app shell layout apps/web/src/app/(app)/w/(shell)/layout.tsx + its top nav, packages/ui theme tokens, editor/crates/ui-egui/src/theme.rs (current egui palette + fonts), editor/apps/effectcraft-web/web/index.html loading screen.", "Deliverable: a concrete plan — (1) ProjectBar → full app-style top bar: back-to-dashboard chevron + workspace crumb, project name, saved chip, share, presence, styled ONLY with existing design tokens; (2) egui theme alignment: map SaaS tokens (ink-0 #070809 bg, borders, accent) to the egui Color32 palette in theme.rs + Instrument Sans font swap; (3) boot overlay continuity (same background/fonts as app so the iframe never flashes foreign UI); (4) what must NOT change (bridge contract, canvas rendering).", "Note ADR-0006 froze ui-egui for visual reasons — that freeze is NOW SUPERSEDED by explicit user directive (round 13). Record the decision text to add to DECISIONS.md."])
special("ANALYZE: wasm-in-web load path + optimization", ["Read: apps/web/public/editor/{index.html,sw.js,worker.js}, apps/web/src/lib/editor-warmup.ts, apps/web/src/components/editor-host/use-editor-session.ts + capability-gate.tsx, apps/web/next.config.ts (headers/rewrites), editor/apps/effectcraft-web/src/{app.rs,worker.rs,frames.rs}, editor/xtask/src/main.rs (web build), scripts/perf/prewarm-diagnose.mjs + scripts/perf/results/editor-ready-2026-10-25T06-47-31.json, docs/performance.md.", "Deliverable: (1) full boot-path diagram with every network request + cache layer (HTTP cache, SW cache, warmup compile); (2) every failure mode (SW serving stale wasm after deploy, COOP/COEP loss, wasm MIME, 49MB download on cold cache, WebGL2-only machines, worker spawn failures) with detection + fix; (3) concrete optimization list ranked by impact (wasm-opt flags, stripping, caching headers for the flat dist, warmup improvements, brotli)."])
special("PROBE: live editor boot against production", ["Mission: empirically test the EDITOR boot on production https://motiongra.vercel.app. Steps: (1) curl HEAD/GET with `-H 'Accept-Encoding: br, gzip'` every dist file: /editor/ , /editor/index.html, /editor/effectcraft_web.js, /editor/effectcraft_web_bg.wasm, /editor/worker.js, /editor/sw.js, /editor/manifest.webmanifest — record status, content-type, content-encoding, cache-control, COOP/COEP headers, sizes; (2) if a headless browser is available (check `npx playwright --version`; browsers may be missing — if missing, skip), open /editor/?empty and watch window.effectcraftLoad up to 90s; (3) report raw evidence + verdict: does the editor boot on prod today, and what is slowest/broken.", "If browsers are missing, pure curl evidence is an acceptable deliverable — say so explicitly."])
special("TRIAGE: round-12 known-red tests", ["Known debt from the round-12 worklog: (1) auto-apply assertions RED until the plan-route run-status write lands (routes/apply.ts applyable gate vs routes/turn.ts:374); (2) 6 stale 'chat wiring' boot tests in tests/auto-apply.test.ts against the retired /chat route; (3) m5 'editor-autoapplied-m5-readonly' Playwright baseline never shipped.", "Read those files + tests, work out EXACTLY what each failure is, and write the precise fix plan (code-level, file:line) so the fix wave can execute it. Do not fix — plan only."])
special("PLAN: font unification (Instrument family into the editor)", ["SaaS fonts: Instrument Serif (display), Instrument Sans (UI), JetBrains Mono (mono) — self-hosted via next/font, fetched by `pnpm fonts:web` (scripts/fetch-web-fonts.mjs). Editor egui fonts today: Inter Regular/Medium/SemiBold + JetBrains Mono + NotoSerif, embedded from editor/assets/fonts/ (gitignored, on disk).", "Deliverable: exact plan to (1) source static-weight TTFs of Instrument Sans (400/500/600) — the variable font must be instanced via fonttools (check `python3 -c 'import fonttools'`; if missing, `pip install fonttools` is allowed — it is a user-local tool, not a repo change) or downloaded from a pinned source; (2) place them in editor/assets/fonts with OFL + attribution sidecars following the existing convention (read one .attribution file for the format); (3) rewrite the ui-egui theme.rs font constants (find where INTER_REGULAR / INTER_MEDIUM / INTER_SEMIBOLD / JETBRAINS_MONO / NOTO_SERIF come from — likely crates/text/src/fonts.rs include_bytes! — and the exact consts to change); (4) keep JetBrains Mono; (5) what happens to the CJK/NotoSerif fallback (install_script_fallbacks). Include the exact file changes + a build-verification recipe."])

# ---------------- write manifest ----------------
lines = ["# Wave-1 audit manifest (round 13)", "", f"Generated by scripts/army/gen_manifest.py. {len(scopes)} scopes.", ""]
for i, (title, entries) in enumerate(scopes, 1):
    lines.append(f"## S{i:03d} — {title}")
    for e in entries:
        lines.append(f"- {e}")
    lines.append("")
out = os.path.join(ROOT, "army", "manifest-w1.md")
with open(out, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print(f"scopes: {len(scopes)} -> {out}")
