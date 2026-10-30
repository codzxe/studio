#!/usr/bin/env python3
"""Provision apps/editor/assets/fonts/ static weights for the wasm build.

The editor embeds STATIC font weights via include_bytes! (crates/text/src/fonts.rs,
crates/ui-egui/src/theme.rs) but the pinned google/fonts repo (pin
e7db6ca603fd4862010383ff17ffd6cc4ffac1c0, the same provenance scripts/fetch-web-fonts.mjs
uses for the web app) only ships Instrument Sans and JetBrains Mono as VARIABLE fonts.
The static instances are produced here with fonttools varLib.instancer —
deterministic axis pinning (wdth=100 + wght=400/500/600) — plus the static-only
Instrument Serif copied as-is. Font binaries are never committed (spec §1.5 rule 9;
apps/editor/assets/fonts/ is gitignored) — this script re-provisions them on fresh boxes.
"""

import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "apps/web/src/app/fonts"          # fetch-web-fonts.mjs output (sha256-verified)
OUT = REPO / "apps/editor/assets/fonts"             # include_bytes! targets (gitignored)

# (source, axis overrides, output name)
JOBS = [
    ("InstrumentSans-Variable.ttf", {"wght": 400, "wdth": 100}, "InstrumentSans-Regular.ttf"),
    ("InstrumentSans-Variable.ttf", {"wght": 500, "wdth": 100}, "InstrumentSans-Medium.ttf"),
    ("InstrumentSans-Variable.ttf", {"wght": 600, "wdth": 100}, "InstrumentSans-SemiBold.ttf"),
    ("JetBrainsMono-Variable.ttf", {"wght": 400}, "JetBrainsMono-Regular.ttf"),
]


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []
    for src_name, axes, out_name in JOBS:
        src = SRC / src_name
        dst = OUT / out_name
        if not src.exists():
            failures.append(f"missing source {src}")
            continue
        args = ["fonttools", "varLib.instancer", str(src)]
        for axis, value in axes.items():
            args.append(f"{axis}={value}")
        args += ["-o", str(dst)]
        proc = subprocess.run(args, capture_output=True, text=True)
        if proc.returncode != 0 or not dst.exists():
            failures.append(f"{out_name}: {proc.stderr.strip()[-300:]}")
            continue
        # Sanity: a real sfnt starts with 00 01 00 00 (or 'OTTO'/'true'/'ttcf').
        magic = dst.read_bytes()[:4]
        if magic not in (b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf"):
            failures.append(f"{out_name}: bad sfnt magic {magic!r}")
            continue
        size = dst.stat().st_size
        print(f"ok  {out_name}  {size}B  axes={axes}")
    serif_src = SRC / "InstrumentSerif-Regular.ttf"
    serif_dst = OUT / "InstrumentSerif-Regular.ttf"
    if serif_src.exists() and serif_src.stat().st_size > 10_000:
        shutil.copyfile(serif_src, serif_dst)
        print(f"ok  InstrumentSerif-Regular.ttf  {serif_dst.stat().st_size}B  (static family, copied)")
    else:
        failures.append("missing InstrumentSerif-Regular.ttf source")
    if failures:
        for f in failures:
            print(f"FAIL {f}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
