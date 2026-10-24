"use client";

import { UnsupportedGpuState } from "@/components/system/system-states";
import { warmEditorWasm } from "@/lib/editor-warmup";
import { X } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";

/**
 * EditorCapabilityGate — §8.7/§8.11 (UI_DESIGN_SYSTEM) + §13 responsive rule.
 *
 * The EffectCraft compositor needs WebGPU or WebGL2 — and "has WebGPU" means
 * an adapter actually ANSWERS, not just that `navigator.gpu` exists: a
 * browser with hardware acceleration off still exposes `navigator.gpu` and
 * refuses every adapter request (the machine can have a fine discrete GPU —
 * the dist would otherwise boot into "failed to create wgpu surface"). The
 * probe mirrors the dist's own boot pre-flight (`public/editor/index.html`):
 *
 *   navigator.gpu.requestAdapter() answers → children
 *   canvas.getContext("webgl2") answers         → children
 *   neither → the §8.7 full-page UnsupportedGpuState (whose copy now names
 *             the usual fixable cause: hardware acceleration off in the
 *             browser) PLUS the static-preview offer: the project's version
 *             history (`/w/[slug]/history`) — previews render server-side,
 *             no GPU needed (§8.11 "offer a rendered preview").
 *
 * The probe is async (one adapter request), so the first client frame(s)
 * render NOTHING while "checking" — a one-frame dark page instead of a
 * broken-canvas flash; supported machines mount the editor a few
 * milliseconds later, and the moment the verdict lands the engine's 49 MB
 * download + compile starts (`warmEditorWasm`) so it overlaps the iframe's
 * own load instead of waiting behind it.
 *
 * §13: below 1024px the editor stays usable but shows a DISMISSIBLE
 * "best on desktop" note (never a blocking overlay — the editor is
 * desktop-first, not desktop-only).
 */

/** §13 breakpoint: the editor is desktop-first below 1024px. */
const NARROW_EDITOR_QUERY = "(max-width: 1023px)";

/** A structural stand-in for the not-yet-typed `navigator.gpu`. */
type GpuLike = {
  readonly requestAdapter?: (options?: {
    readonly powerPreference?: "low-power" | "high-performance" | undefined;
  }) => Promise<unknown>;
};

/**
 * Browser capability probe (§8.7): a working WebGPU adapter (the dist's
 * preferred backend, asked for the high-performance GPU — the same request
 * its own boot pre-flight makes) or the WebGL2 floor. Pure DOM read — no
 * side effects beyond the throwaway probe canvas.
 */
async function probeEditorGpuSupport(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { readonly gpu?: GpuLike | undefined };
  const gpu = nav.gpu;
  if (typeof gpu?.requestAdapter === "function") {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter != null) return true;
    } catch {
      // A broken WebGPU (blocklisted driver, crashed GPU process) falls
      // through to the WebGL2 floor.
    }
  }
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
    let live = true;
    void probeEditorGpuSupport().then((supported) => {
      if (!live) return;
      setSupported(supported);
      // The engine download + compile starts the moment the browser is known
      // to be able to run it — never on unsupported machines (they never
      // mount the iframe, so nothing would fetch it).
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
