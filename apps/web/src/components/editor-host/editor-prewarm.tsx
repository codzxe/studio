"use client";

import { prewarmEditor } from "@/lib/editor-warmup";
import { useEffect } from "react";

/**
 * EditorPrewarm (W3-D) — the app-start editor boot accelerator.
 *
 * Renders nothing; mounts ONCE in the AppShell so the editor engine starts
 * loading the moment the user is anywhere in the authenticated app (dashboard,
 * projects, billing, the project hub) instead of when they click "Open
 * editor". By the time they do, the 49 MB wasm is downloaded AND compiled
 * (`window.__studioEditorWasm` — the dist's bootstrap adopts the compiled
 * module through the same-origin parent) and the dist's small files sit in
 * the HTTP cache, so the editor-open critical path is only the iframe boot +
 * engine init + project open.
 *
 * Everything is a pure accelerator: the prewarm probes the GPU first (shared
 * with the editor route's capability gate) and never fetches anything on
 * machines that cannot run the editor, and any failure falls back to the
 * dist's own fetch path. Client-side navigation into the editor (the
 * hub/history CTAs are `<Link>`s) keeps this window — and therefore the
 * compiled module — alive; a full reload simply re-warms (HTTP-cache hits).
 *
 * Idempotent by construction: `prewarmEditor` is one-shot per page session
 * (React StrictMode double-mount safe), and remounts across shell pages are
 * no-ops.
 */
export function EditorPrewarm(): null {
  useEffect(() => {
    prewarmEditor();
  }, []);
  return null;
}
