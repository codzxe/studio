#!/usr/bin/env python3
"""Audit every commit on GitHub codzxe/studio for identity attribution.

Fetches all commits (100/page), tallies git author name/email and the
GitHub account each commit is attributed to. Exit 1 if any commit still
carries the z@container identity or is not attributed to codzxe.
"""

import json
import os
import subprocess
import sys
import urllib.request

REPO = "codzxe/studio"


def token() -> str:
    url = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return url.split("https://", 1)[1].split("@", 1)[0]


def fetch_page(tok: str, page: int) -> list:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/commits?per_page=100&page={page}",
        headers={"Authorization": f"token {tok}", "User-Agent": "audit-script"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main() -> None:
    tok = token()
    total = z_left = not_mine = 0
    breakdown: dict = {}
    for page in range(1, 10):
        batch = fetch_page(tok, page)
        if not batch:
            break
        for c in batch:
            total += 1
            a = c["commit"]["author"]
            login = (c.get("author") or {}).get("login")
            breakdown[login] = breakdown.get(login, 0) + 1
            if a["name"] == "Z User" or "z@container" in a["email"]:
                z_left += 1
            if login != "codzxe":
                not_mine += 1
        if len(batch) < 100:
            break
    print(f"total commits on GitHub: {total}")
    print(f"z-identity remaining:    {z_left}")
    print(f"not attributed to codzxe: {not_mine}")
    print(f"breakdown: {breakdown}")
    sys.exit(0 if (z_left == 0 and not_mine == 0 and total > 0) else 1)


if __name__ == "__main__":
    main()
