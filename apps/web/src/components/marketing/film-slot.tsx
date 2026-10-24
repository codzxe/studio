"use client";

import { DEMO_FILM } from "@/lib/demo";
import { Brand } from "@studio/config";
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The hero film slot (§8.1 hero CTA target) — the REAL demo loop
 * (`/marketing/demo-loop.webm`), captured from the live build (W5-02):
 * the wasm editor opening the seeded project, the agent's plan exchange
 * and a timeline scrub. Per §11: muted, looped ≤ 8s, poster, `playsinline`,
 * and a pause control; the loop auto-starts only when motion is allowed AND
 * the viewport is desktop-wide — otherwise the poster + play control stand
 * in (§11: never autoplay a heavy video on mobile).
 */
export function FilmSlot() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const desktop = window.matchMedia("(min-width: 768px)").matches;
    if (reduced || !desktop) return; // poster + play control stand in
    video
      .play()
      .then(() => setPlaying(true))
      .catch(() => {
        // Autoplay refused — the poster + play control stand in.
      });
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div
        id={DEMO_FILM.anchorId}
        data-testid="hero-film"
        className="relative aspect-video overflow-hidden rounded-lg border border-border bg-page"
      >
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          src="/marketing/demo-loop.webm"
          poster="/marketing/demo-loop-poster.webp"
          muted
          loop
          playsInline
          preload="metadata"
          aria-label={DEMO_FILM.caption}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />

        {/* Slate corner — editorial marker, honest about what this is. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-4 left-4 flex items-center gap-2 text-mono text-muted"
        >
          <span className="tabular">REEL 01</span>
          <span>—</span>
          <span className="uppercase tracking-[0.06em]">{Brand.productName} tour</span>
        </div>

        <div
          aria-hidden="true"
          className="tabular pointer-events-none absolute bottom-4 left-4 flex items-center gap-2 text-mono text-muted"
        >
          <span>RUNTIME</span>
          <span>{DEMO_FILM.runtimeLabel}</span>
        </div>

        {/* §11: pause/play control — 44px hit target (§12), always reachable. */}
        <button
          type="button"
          data-testid="hero-film-toggle"
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            if (video.paused) {
              video.play().catch(() => {});
            } else {
              video.pause();
            }
          }}
          className="absolute right-4 bottom-4 flex h-11 w-11 items-center justify-center rounded-pill border border-strong bg-app/90 text-primary outline-offset-2 backdrop-blur-sm transition-colors hover:bg-app focus-visible:outline-2 focus-visible:outline-signal"
          aria-label={playing ? "Pause the demo loop" : "Play the demo loop"}
        >
          {playing ? <Pause size={18} strokeWidth={1.75} /> : <Play size={18} strokeWidth={1.75} />}
        </button>
      </div>

      {/* Caption — the honest claim, kept from the placeholder era. */}
      <p className="text-caption text-muted">{DEMO_FILM.caption}</p>
    </div>
  );
}
