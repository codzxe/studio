import { Brand } from "@studio/config";

/**
 * The hero demo film — a REAL capture from the live build (W5-02): an
 * eight-second muted loop of the editor opening the seeded project, the
 * agent's plan exchange and a timeline scrub, plus a poster frame from the
 * same capture. Per §11: VP9, muted, looped ≤ 8s, poster, `playsinline`,
 * pause control. The 90-second launch film (§12 transcript) is still a
 * launch-time asset — the honest caption below describes what is here.
 */
export const DEMO_FILM = {
  /** In-page anchor for the hero's "Watch the demo" CTA. */
  anchorId: "film",
  /** Honest runtime label — shown as timecode next to the slot. */
  runtimeLabel: "00:00:08",
  caption: `An eight-second loop of the ${Brand.productName.toLowerCase()} editor and its agent, captured from the real build.`,
  /** False since W5-02: demo-loop.webm + poster are real captures. */
  captureOwed: false,
} as const;
