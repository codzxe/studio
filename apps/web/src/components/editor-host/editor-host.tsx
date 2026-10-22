"use client";

import { Brand } from "@studio/config";
import {
  BootFailureBanner,
  BootOverlay,
  ConflictBanner,
  LeaseWarningBanner,
  LoadFailedBanner,
  MissingAssetsBanner,
  ReadOnlyBanner,
  SaveErrorBanner,
  SavedChip,
} from "./banners";
import type { ChatShortcutBus } from "./chat-shortcut-bus";
import { ProjectBar } from "./project-bar";
import type { EditorHostPayload, EditorSessionFactory } from "./types";
import { useEditorSession } from "./use-editor-session";

/**
 * `EditorHost` — the editor page body (M3.5/M3.6/M3.7, BUILD_PLAN §M3 tasks
 * 3–7): a full-bleed same-origin iframe of the frozen editor dist
 * (`/editor/?empty` — the `?empty` flag skips the dist's local-session
 * restore), a CSS-only floating project bar, additive banners, and the save
 * trigger wiring. HARD RULES 7/12: no injected CSS, no editor restyle, no
 * persistent top nav, no presence — Share is a disabled M7 placeholder.
 *
 * The iframe URL keeps its trailing slash (`skipTrailingSlashRedirect`) so
 * every relative asset URL in the upstream dist resolves; COOP/COEP come from
 * `next.config.ts` headers. `allow` stays minimal (plain same-origin).
 */
export interface EditorHostProps {
  /** The RSC-resolved manifest slice (single fetch; no client re-fetch). */
  readonly payload: EditorHostPayload;
  /** Test seam for the session client + lease port. */
  readonly sessionFactory?: (payload: EditorHostPayload) => EditorSessionFactory;
  /** Test seam for the shortcut bus (default: the module singleton). */
  readonly shortcutBus?: ChatShortcutBus;
}

export function EditorHost({ payload, sessionFactory, shortcutBus }: EditorHostProps) {
  const session = useEditorSession({ payload, sessionFactory, shortcutBus });
  const { state } = session;
  const projectName = payload.manifest.project.name;

  const savedLabel =
    state.savedVersion === undefined
      ? null
      : state.savedVersion.label === null
        ? state.savedVersion.id
        : state.savedVersion.label;

  const bootFailed = state.boot === "failed";
  const loadFailed = state.phase === "load-failed";

  return (
    <main
      id="main"
      data-testid="editor-host"
      data-editor-phase={state.phase}
      data-editor-boot={state.boot}
      className="fixed inset-0 overflow-hidden bg-app"
    >
      {/* The editor: full-bleed, same-origin, restyled by NOBODY (rule 7).
          Keyed by bootAttempt so Retry remounts a fresh wasm boot. */}
      <iframe
        key={session.bootAttempt}
        ref={session.iframeRef}
        src="/editor/?empty"
        title={`${Brand.productName} editor`}
        data-testid="editor-iframe"
        className="absolute inset-0 h-full w-full border-0"
      />

      {/* M3.5 chrome — floating, auto-hides via CSS (hover sliver / focus). */}
      <ProjectBar projectName={projectName} readOnly={state.readOnly} />

      {/* M3.7 boot UI (covers the iframe while the wasm boots / fails). */}
      {state.phase === "booting" && state.boot === "loading" ? (
        <BootOverlay projectName={projectName} />
      ) : null}
      {bootFailed && <BootFailureBanner bootError={state.bootError} onRetry={session.retryBoot} />}

      {/* Hard load failure (manifest/download/open) — reload is the remedy. */}
      {loadFailed && !bootFailed && (
        <LoadFailedBanner loadError={state.loadError} onReload={() => window.location.reload()} />
      )}

      {/* §9.3 read-only (lease refused) — non-blocking, the iframe stays usable. */}
      {state.phase === "open" && state.readOnly ? (
        <ReadOnlyBanner holderName={state.readOnlyHolder} />
      ) : null}

      {/* Permissive lease-warning fallback (still saving). */}
      {state.phase === "open" && state.leaseWarning && !state.conflict ? (
        <LeaseWarningBanner />
      ) : null}

      {/* 409 park (D-6/§9.3): blocking — never a silent overwrite. */}
      {state.conflict ? <ConflictBanner onReload={session.reloadServerVersion} /> : null}

      {/* M3.3: missing assets never block the open. */}
      {state.phase !== "load-failed" ? <MissingAssetsBanner missing={state.missingAssets} /> : null}

      {/* D-6 save feedback — transient, bottom-right. */}
      {state.saveError && !state.conflict ? <SaveErrorBanner /> : null}
      {!state.saveError && savedLabel !== null ? <SavedChip label={savedLabel} /> : null}
    </main>
  );
}
