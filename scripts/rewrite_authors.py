#!/usr/bin/env python3
"""Rewrite git fast-export stream: Z User <z@container> -> codzxe <noreply>.

Stateful filter: `data N` blob payloads are copied byte-exact (never
line-filtered), so file content that happens to contain the identity
string cannot be corrupted. Only author/committer/tagger header lines
are rewritten.

Usage: git fast-export ... | python3 rewrite_authors.py | git fast-import --force
"""

import sys

OLD_NAME = b"Z User"
OLD_EMAIL = b"z@container"
OLD_EMAIL2 = b"codzxe@users.noreply.github.com"
NEW_NAME = b"codzxe"
NEW_EMAIL = b"226558024+codzxe@users.noreply.github.com"

PERSON_HEADERS = (b"author ", b"committer ", b"tagger ")


def rewrite_person(line: bytes) -> bytes:
    """Rewrite the name and/or email of a `who Name <email> ts tz` line."""
    head, _, rest = line.partition(b" ")
    lt = rest.rfind(b"<")
    gt = rest.find(b">", lt + 1)
    if lt == -1 or gt == -1:
        return line  # malformed / placeholder — leave untouched
    name = rest[:lt].rstrip()
    email = rest[lt + 1 : gt]
    if name == OLD_NAME:
        name = NEW_NAME
    if email in (OLD_EMAIL, OLD_EMAIL2):
        email = NEW_EMAIL
    tail = rest[gt + 1 :]
    return head + b" " + name + b" <" + email + b">" + tail


def main() -> None:
    inp = sys.stdin.buffer
    out = sys.stdout.buffer
    changed = 0
    while True:
        line = inp.readline()
        if not line:
            break
        if line.startswith(b"data "):
            n = int(line[5:].strip())
            out.write(line)
            remaining = n
            while remaining > 0:
                chunk = inp.read(min(1 << 16, remaining))
                if not chunk:
                    break
                out.write(chunk)
                remaining -= len(chunk)
            continue
        if line.startswith(PERSON_HEADERS):
            new_line = rewrite_person(line)
            if new_line != line:
                changed += 1
            out.write(new_line)
            continue
        out.write(line)
    out.flush()
    print(f"rewrote {changed} person header(s)", file=sys.stderr)


if __name__ == "__main__":
    main()
