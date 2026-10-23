"use client";

import { UnsupportedGpuState } from "@/components/system/system-states";
import { X } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";

/**
 * EditorCapabilityGate — §8.7/§8.11 (UI_DESIGN_SYSTEM) + §13 responsive rule.
 *
 * The EffectCraft compositor needs WebGPU or WebGL2. This client wrapper
 * probes the browser BEFORE mounting the editor host, so an unsupported
 * machine never boots the wasm canvas at all ("do not trap the user in a
 * broken canvas" — §8.7):
 *
 *   navigator.gpu (WebGPU)  → children
 *   canvas.getContext("webgl2") (WebGL2 floor) → children
 *   neither → the §8.7 full-page UnsupportedGpuState (supported-browsers
 *             link) PLUS the static-preview offer: the project's version
 *             history (`/w/[slug]/history`) — previews render server-side,
 *             no GPU needed (§8.11 "offer a rendered preview").
 *
 * The probe runs in an effect (SSR cannot see navigator), so the first
 * client frame renders NOTHING while "checking" — a one-frame dark page
 * instead of a broken-canvas flash; supported machines mount the editor
 * on the very next paint.
 *
 * §13: below 1024px the editor stays usable but shows a DISMISSIBLE
 * "best on desktop" note (never a blocking overlay — the editor is
 * desktop-first, not desktop-only).
 */

/** §13 breakpoint: the editor is desktop-first below 1024px. */
const NARROW_EDITOR_QUERY = "(max-width: 1023px)";

/**
 * Browser capability probe (§8.7). Pure DOM read — no async, no side
 * effects beyond the throwaway probe canvas. WebGPU first (the editor's
 * preferred backend), WebGL2 as the floor.
 */
function hasEditorGpuSupport(): boolean {
  if (typeof navigator === "undefined") return false;
  // navigator.gpu is not in the TS DOM lib yet — probe it structurally.
  const nav = navigator as Navigator & { readonly gpu?: unknown };
  if (nav.gpu !== undefined) return true;
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    // Some hardened browsers throw on context creation — treat as absent.
    return false;
  }
}

export interface EditorCapabilityGateProps {
  /** The project slug — routes the static-preview offer to its history page. */
  readonly slug: string;
  /** The editor host — mounted only when the browser can run the canvas. */
  readonly children: ReactNode;
}

export function EditorCapabilityGate({
  slug,
  children,
}: EditorCapabilityGateProps): ReactElement | null {
  // "checking" until the client probe decides (SSR renders this too).
  const [supported, setSupported] = useState<boolean | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [noteDismissed, setNoteDismissed] = useState(false);

  useEffect(() => {
    setSupported(hasEditorGpuSupport());
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

  // Checking (first client frame) → nothing: never flash a broken canvas.
  if (supported === null) {
    return <main id="main" data-testid="editor-capability-gate" data-gate-state="checking" />;
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
