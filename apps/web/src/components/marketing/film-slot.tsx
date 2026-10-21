import { DEMO_FILM } from "@/lib/demo";
import { Brand } from "@studio/config";
import { Play } from "lucide-react";

/**
 * The hero film slot (§8.1 hero CTA target).
 *
 * HONEST PLACEHOLDER — capture owed from the real build: there is no video
 * asset yet (§16: real product output only; nothing stands in for it). Until
 * the real capture lands, this renders a deliberate poster frame — a film
 * slate with the play affordance and a truthful caption — never a fake
 * looping "demo", never a stylised fake UI.
 *
 * When the capture arrives: replace the inner placeholder with a muted,
 * looping, playsinline <video> (poster + play control per §11) or the 90s
 * film with captions (§12), and flip DEMO_FILM.captureOwed to false.
 */
export function FilmSlot() {
  return (
    <div
      id={DEMO_FILM.anchorId}
      data-testid="hero-film"
      className="relative aspect-video overflow-hidden rounded-lg border border-border bg-page"
      aria-label={`${DEMO_FILM.caption} Capture in progress.`}
      role="img"
    >
      {/* Poster frame: slate label + play affordance + honest caption. */}
      <div className="absolute top-4 left-4 flex items-center gap-2 text-mono text-muted">
        <span className="tabular">REEL 01</span>
        <span aria-hidden="true">—</span>
        <span className="uppercase tracking-[0.06em]">{Brand.productName} tour</span>
      </div>

      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        {/* Play affordance — decorative in the placeholder (there is no film
            yet, so it is not an interactive control; the caption says so). */}
        <span
          aria-hidden="true"
          className="flex h-16 w-16 items-center justify-center rounded-pill border border-strong bg-elevated text-primary"
        >
          <Play size={24} strokeWidth={1.75} />
        </span>
        <p className="max-w-[52ch] text-balance text-body text-secondary">{DEMO_FILM.caption}</p>
        <p className="text-caption text-muted">
          This reel is being captured from the real build and lands here at launch.
        </p>
      </div>

      <div
        className="tabular absolute bottom-4 left-4 flex items-center gap-2 text-mono text-muted"
        aria-hidden="true"
      >
        <span>RUNTIME</span>
        <span>{DEMO_FILM.runtimeLabel}</span>
      </div>
    </div>
  );
}
