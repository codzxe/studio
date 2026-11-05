"use client";

/**
 * StudioWelcome — the chat-first studio's HERO: the "What are we making?"
 * landing a fresh thread opens on. Fully presentational — the composer stack
 * arrives as `children`, every gesture reports upward (`onPickSuggestion`,
 * `onOpenThread`); no state, no wire, no engine.
 *
 * Voice (the PauseVFX look): the parent owns `bg-page` and the `horizon-glow`
 * wash rising from the bottom, so this component stays transparent and lets
 * the glow show through. It contributes the signal-orange accent (the italic
 * display word, the icon slots, the ✦), Instrument-Serif display type and
 * hairline suggestion cards.
 *
 * Layout contract: one full-height centered column —
 *   1. the eyebrow ("STUDIO — {PROJECT}") — `text-hint tracking-wide`
 *   2. the FIXED display headline (`What are we making?`, signal italic)
 *   3. the sub copy (the agent builds layers/keyframes/effects; the engine
 *      stays out of sight)
 *   4. `children` — the composer stack, in the middle
 *   5. the suggestion grid (1 col, `sm:grid-cols-2` hairline cards)
 *   6. the "Recent" chip row — max 3 threads, hidden while the list is empty
 *
 * Testids: `studio-welcome`, `studio-welcome-suggestion-{testid}` (the suffix
 * each suggestion carries), `studio-welcome-recent` (+ per-chip
 * `data-thread-id`).
 */

import type { CSSProperties, ReactElement, ReactNode } from "react";

export interface StudioWelcomeSuggestion {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly detail: string;
  /** Suffix for the rendered testid: `studio-welcome-suggestion-{testid}`. */
  readonly testid: string;
}

export interface StudioWelcomeRecentThread {
  readonly id: string;
  readonly title: string;
}

export interface StudioWelcomeProps {
  readonly projectName: string;
  readonly suggestions: readonly StudioWelcomeSuggestion[];
  readonly onPickSuggestion: (testid: string) => void;
  readonly recentThreads: readonly StudioWelcomeRecentThread[];
  readonly onOpenThread: (threadId: string) => void;
  /** The composer stack, rendered between the sub copy and the suggestions. */
  readonly children?: ReactNode;
}

/** The Recent row never grows past three chips (the recency glance, not a list). */
const MAX_RECENT = 3;

/** Kinetic-word stagger index → the CSS custom property the motion layer reads. */
function wordDelay(index: number): CSSProperties {
  return { "--mo-w": index } as CSSProperties;
}

/** A masked kinetic word (the AE headline reveal — see styles/motion.css). */
function KineticWord({
  index,
  children,
  className,
}: {
  readonly index: number;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <span className="mo-kw" aria-hidden="true">
      <span className={`mo-kw-inner ${className ?? ""}`} style={wordDelay(index)}>
        {children}
      </span>
    </span>
  );
}

export function StudioWelcome({
  projectName,
  suggestions,
  onPickSuggestion,
  recentThreads,
  onOpenThread,
  children,
}: StudioWelcomeProps): ReactElement {
  const recent = recentThreads.slice(0, MAX_RECENT);

  return (
    <div
      data-testid="studio-welcome"
      className="relative flex h-full flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-10"
    >
      {/* -- eyebrow ---------------------------------------------------------- */}
      <p
        data-testid="studio-welcome-eyebrow"
        className="mo-fade-soft text-hint text-muted uppercase tracking-wide select-none"
      >
        <span aria-hidden="true" className="text-signal">
          ✦{" "}
        </span>
        STUDIO — {projectName.toUpperCase()}
      </p>

      {/* -- the fixed display headline (kinetic masked word reveal) ----------- */}
      <h1
        className="max-w-2xl text-center font-display text-display-xl text-primary"
        aria-label="What are we making?"
      >
        <KineticWord index={0}>What</KineticWord> <KineticWord index={1}>are</KineticWord>{" "}
        <KineticWord index={2}>we</KineticWord>{" "}
        <KineticWord index={3}>
          <em className="italic text-signal">making</em>
        </KineticWord>
        <KineticWord index={4}>?</KineticWord>
      </h1>

      <p
        className="mo-rise-in max-w-xl text-center text-body-s text-secondary"
        style={{ animationDelay: "560ms" }}
      >
        Describe the motion piece. The agent builds every layer, keyframe and effect — the engine
        stays out of sight until you want it.
      </p>

      {/* -- the composer stack (the caller's stack, in the middle) ------------ */}
      {children}

      {/* -- suggestion grid (staggered cascade + hover lift + light sweep) ----- */}
      <div className="mo-stagger grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.testid}
            type="button"
            data-testid={`studio-welcome-suggestion-${suggestion.testid}`}
            onClick={() => onPickSuggestion(suggestion.testid)}
            className="mo-hover-lift mo-press mo-sweep group flex items-start gap-3 rounded-md border border-subtle bg-panel/70 px-3.5 py-3 text-left duration-120 ease-out hover:border-strong hover:bg-panel"
          >
            {suggestion.icon !== undefined ? (
              <span aria-hidden="true" className="mt-0.5 shrink-0 text-signal">
                {suggestion.icon}
              </span>
            ) : null}
            <span className="min-w-0">
              <span className="block text-label text-primary">{suggestion.title}</span>
              <span className="mt-0.5 block text-caption text-secondary">{suggestion.detail}</span>
            </span>
          </button>
        ))}
      </div>

      {/* -- Recent chips (max 3; hidden while empty) ---------------------------- */}
      {recent.length > 0 ? (
        <div
          data-testid="studio-welcome-recent"
          className="mo-stagger-pop flex flex-wrap items-center justify-center gap-1.5"
        >
          <span className="text-caption text-muted">Recent</span>
          {recent.map((thread) => (
            <button
              key={thread.id}
              type="button"
              data-testid="studio-welcome-recent-chip"
              data-thread-id={thread.id}
              onClick={() => onOpenThread(thread.id)}
              className="mo-press rounded-pill border border-subtle px-2.5 py-1 text-caption text-secondary duration-120 ease-out hover:bg-elevated hover:text-primary"
            >
              {thread.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
