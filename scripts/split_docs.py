#!/usr/bin/env python3
"""Split the pasted docs file into individual markdown docs in studio/docs/."""
import os

SRC = "/home/z/my-project/upload/Pasted Content_1792600947265.txt"
REPO = "/home/z/my-project/studio"

# (start_line, end_line) inclusive, 1-indexed; target path relative to repo root
DOCS = [
    (1, 169, "README.root.md"),  # root README (compare before replacing)
    (170, 255, "docs/adr/0006-effectcraft-editor-pivot.md"),
    (256, 277, "docs/adr/README.md"),
    (278, 1119, "docs/BUILD_PLAN.md"),
    (1120, 2025, "docs/PRODUCT_ARCHITECTURE.md"),
    (2026, 2666, "docs/EDITOR_CHAT_UX.md"),
    (2667, 3410, "docs/UI_DESIGN_SYSTEM.md"),
    (3411, 3457, "docs/README.md"),
]

with open(SRC, "r", encoding="utf-8") as f:
    lines = f.readlines()

for start, end, rel in DOCS:
    content = "".join(lines[start - 1 : end]).rstrip() + "\n"
    path = os.path.join(REPO, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"wrote {rel}: {len(content)} bytes")

print("done")
