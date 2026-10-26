#!/usr/bin/env node
// Web fonts for apps/web — next/font/local SELF-HOSTED builds (CI + dev).
//
// Why: `next/font/google` fetched from fonts.googleapis.com at BUILD time,
// which is flaky on GitHub runners (the 2026-10-25/26 CI web-job failures:
// "next/font/google queries have exactly one entry" — Turbopack cannot
// generate the font module when the fetch flakes; 2 of 3 runs died). layout.tsx
// now compiles against the .ttf binaries this script provisions via
// next/font/local: no Google dependency at build time, the SAME next/font
// variable names (globals.css stacks unchanged), same no-layout-shift
// semantics.
//
// Spec §1.5 rule 9: font binaries are NEVER committed — .gitignore covers
// *.ttf and fonts/, and the licence gate walks TRACKED files only. This
// script fetches from the pinned google/fonts commit (the canonical Google
// Fonts repository), sha256-verified, into apps/web/src/app/fonts/
// (gitignored). Idempotent + offline-friendly: a file whose hash already
// matches is never re-downloaded, so CI after a cache hit and `pnpm dev:ready`
// on an offline box stay fast.
//
// Run: pnpm fonts:web   (also embedded in dev:ready stage [3/4] + CI web/e2e jobs)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PIN = "e7db6ca603fd4862010383ff17ffd6cc4ffac1c0"; // google/fonts @ 2026-10-23

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "apps/web/src/app/fonts");

export const WEB_FONTS = [
  {
    file: "InstrumentSans-Variable.ttf",
    remote: "ofl/instrumentsans/InstrumentSans%5Bwdth%2Cwght%5D.ttf", // wdth+wght variable
    sha256: "b24f1812584816958afcf22e22d08e44318c5e51651e25d2438efdde389b33b1",
  },
  {
    file: "InstrumentSerif-Regular.ttf",
    remote: "ofl/instrumentserif/InstrumentSerif-Regular.ttf",
    sha256: "498efd461f6ddfcb7a111bf9a565709d2085d48201d501ead960d93e84ffbb88",
  },
  {
    file: "JetBrainsMono-Variable.ttf",
    remote: "ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf", // wght variable
    sha256: "48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda",
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Provision one font; resolves 'fetched' (downloaded + verified) or 'kept' (hash already correct). */
async function provisionOne(font) {
  const dest = join(OUT_DIR, font.file);
  if (existsSync(dest)) {
    try {
      if (sha256(readFileSync(dest)) === font.sha256) return "kept";
    } catch {
      // unreadable on-disk file — fall through to a fresh download
    }
  }
  const res = await fetch(`https://raw.githubusercontent.com/google/fonts/${PIN}/${font.remote}`, {
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${font.file}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== font.sha256) throw new Error(`sha256 mismatch for ${font.file}: got ${got}`);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(dest, buf);
  return "fetched";
}

/** Provision all three fonts. `log` receives one dim progress line per font. */
export async function ensureWebFonts({ log = () => {} } = {}) {
  let fetched = 0;
  let kept = 0;
  for (const font of WEB_FONTS) {
    const outcome = await provisionOne(font);
    if (outcome === "fetched") fetched += 1;
    else kept += 1;
    log(`${font.file} — ${outcome === "fetched" ? "fetched" : "hash ok (kept)"}`);
  }
  return { total: WEB_FONTS.length, fetched, kept };
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  try {
    const result = await ensureWebFonts({
      log: (line) => process.stdout.write(`      ${line}\n`),
    });
    process.stdout.write(
      `web fonts ready: ${result.kept} kept, ${result.fetched} fetched (${result.total} total) — apps/web/src/app/fonts/\n`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `web fonts: ${reason}
  next build / next dev need these files (layout.tsx next/font/local).
  Check the network and re-run: pnpm fonts:web
`,
    );
    process.exit(1);
  }
}
