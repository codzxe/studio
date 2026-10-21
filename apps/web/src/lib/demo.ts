import { Brand } from "@studio/config";

/**
 * The hero demo film slot — the ONE marketing asset that is still owed from
 * the real build (§16: no fake screenshots, no invented metrics, no fake
 * customer logos — so nothing stands in for the capture).
 *
 * `DEMO_FILM` is the single switch a later wave flips: point `poster`/`src`
 * at a real 16:9 capture (muted, looped ≤ 8s per §11, or the 90s film with a
 * poster + play control), drop the placeholder styling in
 * `src/components/marketing/film-slot.tsx`, and every claim below stays true
 * because there are none — only the honest description.
 */
export const DEMO_FILM = {
  /** In-page anchor for the hero's "Watch the 90s film" CTA. */
  anchorId: "film",
  /** Honest runtime label — shown as timecode next to the slot. */
  runtimeLabel: "00:01:30",
  caption: `A 90-second tour of the ${Brand.productName.toLowerCase()} editor and its agent, captured from the real build.`,
  /** True until the real capture is wired up (see film-slot.tsx). */
  captureOwed: true,
} as const;
