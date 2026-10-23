/**
 * OSS_ATTRIBUTIONS (W2-B4) — the ONE copy of the open-source attribution
 * table (source of truth: docs/legal/license-audit.md + ATTRIBUTION.md +
 * editor/UPSTREAM.md), consumed by BOTH licence surfaces:
 *
 * - the marketing page `app/(marketing)/legal/licences/page.tsx`, and
 * - the in-app page `app/(app)/w/(shell)/settings/licences/page.tsx`.
 *
 * The rows include the vendored editor's exact upstream pin — bump it HERE
 * (one edit point) when `editor/UPSTREAM.md` re-pins; the per-page tests pin
 * the three rows so drift fails fast.
 *
 * Brand law (ADR-0006 + packages/config brand.ts): these licence surfaces
 * are the one place in the commercial UI where the upstream editor's real
 * name legitimately appears.
 */

/** One attribution row: component, role, licence, upstream link and pin. */
export interface OssAttribution {
  readonly component: string;
  readonly role: string;
  readonly license: string;
  readonly upstream: string;
  readonly pin: string;
}

export const OSS_ATTRIBUTIONS: readonly OssAttribution[] = [
  {
    component: "EffectCraft",
    role: "The compositing editor and engine — used unmodified (UI-frozen)",
    license: "MIT OR Apache-2.0",
    upstream: "https://github.com/storytold/effectcraft",
    pin: "9db7f3b21700fd821f215782ed1c82afe077880f (v0.13.0)",
  },
  {
    component: "Instrument Serif · Instrument Sans",
    role: "Display and UI typefaces",
    license: "SIL Open Font License 1.1",
    upstream: "https://github.com/Instrument/instrument-serif",
    pin: "n/a — fonts are never committed to this repository",
  },
  {
    component: "JetBrains Mono",
    role: "Monospace — timecode, code, keyboard hints",
    license: "SIL Open Font License 1.1",
    upstream: "https://github.com/JetBrains/JetBrainsMono",
    pin: "n/a — fonts are never committed to this repository",
  },
];
