#!/usr/bin/env python3
"""Generate the Studio brand assets (original work, MIT OR Apache-2.0) in an EffectCraft tree.

Usage: python3 make_studio_assets.py <tree-root>

Creates (with .attribution sidecars + ATTRIBUTION.md rows, per the xtask assets gate):
- docs/brand/studio-mark.png          512 px header/About mark (keyframe diamond, signal accent)
- assets/app-icon/studio/icon-256.png PWA icon
- assets/app-icon/studio/icon-512.png PWA icon
- apps/effectcraft-web/web/favicon.svg rewritten + its .attribution updated

The upstream EffectCraft mark stays untouched at docs/brand/artcraft-mark.png and the
upstream app icons stay under assets/app-icon/hicolor/ (attribution preserved); this
build simply stops using them.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(sys.argv[1]).resolve()

TILE = (0x1B, 0x1C, 0x1F, 0xFF)      # editor background
SIGNAL = (0xFF, 0x6A, 0x3D, 0xFF)    # studio signal accent (packages/ui tokens.css --signal)
ADDED = "2026-10-22 by the studio project (original work, keyframe-diamond mark)"


def draw_mark(size: int) -> Image.Image:
    """The Studio mark: signal-orange keyframe diamond on a dark rounded tile."""
    s = 4  # supersample
    w = size * s
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Tile: rounded square, radius 22% (matches the product's soft radii).
    d.rounded_rectangle([0, 0, w - 1, w - 1], radius=int(w * 0.22), fill=TILE)
    # Outer diamond (rotated square), margins 20%.
    m = w * 0.20
    d.polygon([(w / 2, m), (w - m, w / 2), (w / 2, w - m), (m, w / 2)], fill=SIGNAL)
    # Inner diamond cut-out -> keyframe ring.
    h = w * 0.125
    d.polygon([(w / 2, w / 2 - h), (w / 2 + h, w / 2), (w / 2, w / 2 + h), (w / 2 - h, w / 2)], fill=TILE)
    return img.resize((size, size), Image.LANCZOS)


def sidecar(asset: str, title: str) -> str:
    return (
        f"asset:        {asset}\n"
        f"title:        {title}\n"
        "author:       studio project (original work)\n"
        "source:       original work for the studio product; the upstream EffectCraft mark is not used\n"
        "license:      MIT OR Apache-2.0\n"
        f"added:        {ADDED}\n"
        "notes:        Signal-orange keyframe diamond on the editor's dark tile (#1b1c1f bg, #ff6a3d accent).\n"
    )


def main() -> None:
    print(f"assets: writing Studio brand assets into {ROOT}")

    # 1. The mark itself (header + About dialog).
    brand = ROOT / "docs/brand"
    brand.mkdir(parents=True, exist_ok=True)
    draw_mark(512).save(brand / "studio-mark.png", optimize=True)
    (brand / "studio-mark.png.attribution").write_text(sidecar("docs/brand/studio-mark.png", "Studio mark, 512 px"), encoding="utf-8")

    # 2. PWA icons (xtask copies these into the flat dist).
    icons = ROOT / "assets/app-icon/studio"
    icons.mkdir(parents=True, exist_ok=True)
    draw_mark(256).save(icons / "icon-256.png", optimize=True)
    (icons / "icon-256.png.attribution").write_text(sidecar("assets/app-icon/studio/icon-256.png", "Studio app icon, 256 px"), encoding="utf-8")
    draw_mark(512).save(icons / "icon-512.png", optimize=True)
    (icons / "icon-512.png.attribution").write_text(sidecar("assets/app-icon/studio/icon-512.png", "Studio app icon, 512 px"), encoding="utf-8")

    # 3. The favicon (SVG, same composition).
    fav = ROOT / "apps/effectcraft-web/web/favicon.svg"
    fav.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
        '  <rect width="64" height="64" rx="14" fill="#1b1c1f"/>\n'
        '  <path d="M32 13 L51 32 L32 51 L13 32 Z" fill="#ff6a3d"/>\n'
        '  <path d="M32 25 L39 32 L32 39 L25 32 Z" fill="#1b1c1f"/>\n'
        "</svg>\n",
        encoding="utf-8",
    )
    (ROOT / "apps/effectcraft-web/web/favicon.svg.attribution").write_text(
        "asset:        favicon.svg\n"
        "title:        Studio web app icon (favicon)\n"
        "author:       studio project (original work)\n"
        "source:       original work for the studio product; the upstream EffectCraft icon is not used\n"
        "license:      MIT OR Apache-2.0\n"
        f"added:        {ADDED}\n"
        "notes:        Keyframe-diamond mark, vector; same composition as docs/brand/studio-mark.png.\n",
        encoding="utf-8",
    )

    # 4. ATTRIBUTION.md: refresh the favicon row, append the new rows (keep the table valid).
    att = ROOT / "ATTRIBUTION.md"
    text = att.read_text(encoding="utf-8")
    old_fav_row = "| `apps/effectcraft-web/web/favicon.svg` | EffectCraft contributors | Original work: web app icon, a copy of `assets/app-icon/effectcraft-small.svg` (the unicorn app icon) | MIT OR Apache-2.0 (`assets/app-icon/LICENSE.txt`) |"
    new_fav_row = "| `apps/effectcraft-web/web/favicon.svg` | studio project | Original work: the Studio keyframe-diamond mark for the studio product (replaces the upstream icon, which stays credited above) | MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`) |"
    if old_fav_row not in text:
        raise SystemExit("assets: ATTRIBUTION.md favicon row not found (format changed?)")
    text = text.replace(old_fav_row, new_fav_row)
    marker = "## Screenshots"
    new_rows = (
        "| `docs/brand/studio-mark.png` | studio project | Original work: the Studio mark, 512 px (keyframe diamond, signal accent #ff6a3d on the #1b1c1f tile) | MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`) |\n"
        "| `assets/app-icon/studio/icon-256.png` | studio project | Original work: Studio app icon, 256 px (PWA) | MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`) |\n"
        "| `assets/app-icon/studio/icon-512.png` | studio project | Original work: Studio app icon, 512 px (PWA) | MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`) |\n"
        "\n"
    )
    if marker not in text:
        raise SystemExit("assets: ATTRIBUTION.md '## Screenshots' marker not found")
    text = text.replace(marker, new_rows + marker)
    att.write_text(text, encoding="utf-8")

    for p in [brand / "studio-mark.png", icons / "icon-256.png", icons / "icon-512.png", fav]:
        print(f"  wrote {p.relative_to(ROOT)} ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
