"use client";

import { UnsupportedGpuState } from "@/components/system/system-states";
import { probeEditorGpu, warmEditorWasm } from "@/lib/editor-warmup";
import { Spinner } from "@studio/ui";
import { X } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";

import { EditorTopBar } from "./editor-top-bar";

/**
 * EditorCapabilityGate — §8.7/§8.11 (UI_DESIGN_SYSTEM) + §13 responsive rule.
 *
 * The EffectCraft compositor needs WebGPU or WebGL2 — and "has WebGPU" means
 * an adapter actually ANSWERS, not just that `navigator.gpu` exists: a
 * browser with hardware acceleration off still exposes `navigator.gpu` and
 * refuses every adapter request (the machine can have a fine discrete GPU —
 * the dist would otherwise boot into "failed to create wgpu surface"). The
 * probe lives in `@/lib/editor-warmup` (`probeEditorGpu`) and its verdict is
 * cached for the page session — when the shell's prewarm (W3-D) already
 * probed, this gate re-uses that answer instead of issuing a second adapter
 * request:
 *
 *   navigator.gpu.requestAdapter() answers → children
 *   canvas.getContext("webgl2") answers         → children
 *   neither → the §8.7 full-page UnsupportedGpuState (whose copy now names
 *             the usual fixable cause: hardware acceleration off in the
 *             browser) PLUS the static-preview offer: the project's version
 *             history (`/w/[slug]/history`) — previews render server-side,
 *             no GPU needed (§8.11 "offer a rendered preview").
 *
 * The probe is async (one adapter request — or an already-cached answer), so
 * the first client frame(s) render the CHECKING SHELL — the persistent top
 * bar plus an empty canvas area — and supported machines mount the editor a
 * few milliseconds later, at which point the engine's 49 MB download +
 * compile starts (`warmEditorWasm`) so it overlaps the iframe's own load
 * instead of waiting behind it. When the shell's prewarm already started the
 * download, `warmEditorWasm` is its own one-shot no-op — the gate's call is
 * just the direct-visit fallback.
 *
 * ROUND-13 LCP FIX: the checking arm used to render an EMPTY <main> — the
 * whole page body, including the top bar's project-name breadcrumb (the
 * page's LCP text element), was invisible until the entire client bundle
 * (~1.7MB across 21 chunks) had downloaded, compiled and executed, React
 * had hydrated, AND the async GPU probe had answered: a measured 816ms
 * render delay on an LCP of 878ms. The checking arm now renders the SAME
 * top bar the host renders once supported (the swap is visually seamless —
 * identical markup), so the breadcrumb paints with the SSR HTML + CSS,
 * before a single chunk executes. Only the canvas area stays dark while
 * probing, and on unsupported machines the full-page swap to the §8.7 state
 * replaces the shell (a brief chrome flash on machines that cannot run the
 * editor at all — the right trade: every supported visit paints instantly).
 *
 * §13: below 1024px the editor stays usable but shows a DISMISSIBLE
 * "best on desktop" note (never a blocking overlay — the editor is
 * desktop-first, not desktop-only).
 */

/** §13 breakpoint: the editor is desktop-first below 1024px. */
const NARROW_EDITOR_QUERY = "(max-width: 1023px)";

export interface EditorCapabilityGateProps {
  /** The project slug — routes the static-preview offer to its history page. */
  readonly slug: string;
  /**
   * The project's display name — SSRs the top-bar breadcrumb chrome during
   * the GPU probe (the ROUND-13 LCP fix; see the component docblock).
   */
  readonly projectName: string;
  /** The editor host — mounted only when the browser can run the canvas. */
  readonly children: ReactNode;
}

export function EditorCapabilityGate({
  slug,
  projectName,
  children,
}: EditorCapabilityGateProps): ReactElement | null {
  // "checking" until the client probe decides (SSR renders this too).
  const [supported, setSupported] = useState<boolean | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [noteDismissed, setNoteDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    void probeEditorGpu().then((supported) => {
      if (!live) return;
      setSupported(supported);
      // The engine download + compile starts the moment the browser is known
      // to be able to run it — never on unsupported machines (they never
      // mount the iframe, so nothing would fetch it). One-shot: a no-op when
      // the shell's prewarm already started the download (W3-D).
      if (supported) warmEditorWasm();
    });
    return () => {
      live = false;
    };
  }, []);

  // §13 — live <1024px tracking (the note follows a rotated/resized window).
  useEffect(() => {
    const query = window.matchMedia(NARROW_EDITOR_QUERY);
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  if (supported === false) {
    // §8.7 full-page state: explain, supported browsers, static preview.
    // `id="main"` keeps the skip-link target intact while the editor host
    // (which owns it in the supported arm) is absent.
    return (
      <main
        id="main"
        data-testid="editor-capability-gate"
        data-gate-state="unsupported"
        className="flex min-h-svh flex-col items-center justify-center gap-4 bg-app px-5"
      >
        <UnsupportedGpuState />
        {/* §8.11 static-preview offer: rendered previews need no GPU. */}
        <a
          data-testid="editor-gate-preview-link"
          href={`/w/${encodeURIComponent(slug)}/history`}
          className="text-body text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
        >
          Open version history
        </a>
      </main>
    );
  }

  // Checking (first client frame) → the SSR'd shell: the persistent top bar
  // (the LCP text paints with the HTML, before any chunk executes) + the
  // boot overlay's own "Preparing…" copy, so the LARGEST text (the overlay
  // paragraph, not the small breadcrumb) ALSO paints server-side — the
  // measured LCP element. When the host mounts, its real BootOverlay renders
  // the same words in the same place: a seamless handoff. The iframe
  // deliberately does NOT mount yet: unsupported machines must never fetch
  // the 49MB engine dist (see ROUND-13 LCP FIX above).
  if (supported === null) {
    return (
      <main
        id="main"
        data-testid="editor-capability-gate"
        data-gate-state="checking"
        className="fixed inset-0 flex flex-col overflow-hidden bg-app"
      >
        <EditorTopBar projectName={projectName} projectSlug={slug} />
        <div data-testid="editor-gate-surface" className="relative min-h-0 flex-1">
          {/* The BootOverlay's exact markup (banners.tsx) minus the live
              progress seam — the host's real overlay takes over on mount. */}
          <output
            className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-app"
            aria-label={`Preparing the editor for ${projectName}`}
          >
            <Spinner size={24} label={`Preparing the editor for ${projectName}`} />
            <p className="text-body text-secondary">Preparing “{projectName}”…</p>
            <p className="text-caption text-muted">The editor loads once per session.</p>
          </output>
        </div>
      </main>
    );
  }

  return (
    <>
      {children}
      {/* §13 — dismissible desktop-first note; the editor stays usable. */}
      {narrow && !noteDismissed ? (
        <div
          role="note"
          data-testid="editor-best-on-desktop-note"
          className="fixed bottom-4 left-4 z-40 flex max-w-[68ch] items-start gap-3 rounded-md border border-border bg-panel px-4 py-3 shadow-pop"
        >
          <p className="text-caption text-secondary">
            The editor is best on a desktop screen. You can keep working — panels may be cramped on
            this size.
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            data-testid="editor-best-on-desktop-dismiss"
            onClick={() => setNoteDismissed(true)}
            className="shrink-0 text-muted transition-colors duration-120 hover:text-primary"
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
}
