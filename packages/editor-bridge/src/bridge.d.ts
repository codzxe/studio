/**
 * `attachEditorBridge` — the typed wrapper around the frozen editor iframe's
 * `window.effectcraft` global (PRODUCT_ARCHITECTURE §6.2).
 *
 * Verified against the shipped dist (READ-ONLY sources, v0.13.0):
 * - `window.effectcraft` + `window.effectcraftLoad = {}` are defined synchronously
 *   by the inline module script in `apps/web/public/editor/index.html` (from
 *   `editor/apps/effectcraft-web/web/index.html`) before the wasm runs.
 * - `effectcraftLoad.wasmMs` is set once the module compiles, `readyMs` once
 *   `ec.start()` returns; on failure the page sets `effectcraftLoad.error =
 *   String(e)` (and never `readyMs`). The upstream smoke test
 *   (`editor/apps/effectcraft-web/tests/smoke.mjs`) waits for
 *   `effectcraftLoad.readyMs || effectcraftLoad.error`.
 * - `effectcraft.request`/`execute` reject with plain STRINGS
 *   (`editor/apps/effectcraft-web/src/api.rs`): "Studio is not running yet"
 *   (de-branded dist string) when the control channel is not up (transient,
 *   retry), "request dropped" when it disconnects. Errors from the control
 *   channel itself reject with that channel's `error` message.
 * - Upstream documents a 60 s control-request timeout
 *   (`editor/docs/control-protocol.md`); the web dist keeps requests pending
 *   until they are answered or dropped, so the bridge enforces its own
 *   `callTimeoutMs` (default 15 s) client-side and normalizes to `BridgeError`.
 */
import { type EditorBridge, type EditorEventName } from "./types";
export interface AttachOptions {
    /** Per-call timeout in ms (default 15 s). */
    readonly callTimeoutMs?: number;
    /** Handshake timeout in ms (default 60 s). */
    readonly readyTimeoutMs?: number;
    /** Expected editor version prefix; a mismatch emits an "error" event (attach still resolves). */
    readonly version?: string;
    /**
     * Pre-attach event handler: sees the early "ready" emission, the
     * version-mismatch "error" and the handshake "error"s (`EDITOR_LOAD_FAILED`
     * when the dist's wasm failed to boot, `EDITOR_NOT_READY` on timeout) that
     * fire before `attachEditorBridge` resolves. Routed into the same bus as
     * `on(…)`.
     */
    readonly onEvent?: (event: EditorEventName, payload: unknown) => void;
}
/** The editor wasm's boot phase, read from the dist's `effectcraftLoad`. */
export type EditorLoadStatus = "loading" | "ready" | "failed";
/**
 * A snapshot of the editor's boot state, taken from the shipped dist's
 * `window.effectcraftLoad` (`apps/web/public/editor/index.html`):
 * `{}` while loading, `wasmMs` once the module compiled, `readyMs` once
 * `ec.start()` returned, `error` when the wasm failed to boot.
 */
export interface EditorLoadState {
    /** `loading` until `readyMs`/`error` appears (or the globals are not yet visible). */
    readonly status: EditorLoadStatus;
    /** Present when `status === "failed"` — the dist's `String(e)`. */
    readonly error?: string;
    /** Set once the wasm module compiled (present on both ready and failed boots). */
    readonly wasmMs?: number;
    /** Set once `ec.start()` returned (present only on a ready boot). */
    readonly readyMs?: number;
}
/**
 * Read the editor's boot state synchronously — the public seam for "the wasm
 * failed to boot" (M3.7). Works before (and without) `attachEditorBridge`:
 * the host page can poll this while it shows its loading screen, then render
 * the failure + retry UI the moment `status === "failed"`, and call
 * `attachEditorBridge` once `status === "ready"`.
 *
 * - Returns `{ status: "loading" }` while the iframe has not exposed the
 *   dist globals yet (including cross-origin reads, which throw and are
 *   swallowed — the state is genuinely unknowable from this frame).
 * - Same-origin only, like the rest of the bridge (§6.1).
 *
 * The `attachEditorBridge` rejection is the async counterpart: it fails with
 * `BridgeError` code `EDITOR_LOAD_FAILED` carrying the same `error` string.
 */
export declare function editorLoadState(iframe: HTMLIFrameElement): EditorLoadState;
/** Where the editor is loaded relative to the current origin. Same-origin only (§6.1). */
export declare function sameOrigin(iframe: HTMLIFrameElement): boolean;
/**
 * A stable, filesystem-safe asset name (§6.3). The path the editor actually
 * assigns is what callers must keep — upstream `addFile` basename-es the
 * request (`editor/apps/effectcraft-web/src/files.rs` `path_for`).
 *
 * Exported (additive, M8-F) so the render worker writes hydrated asset files
 * under EXACTLY the name the browser editor assigned — the `.ecproj` it must
 * render references that name (docs/phases/m8-cli-spike.md §4). Pure function;
 * hoisting it from `attachEditorBridge` changes no behavior.
 */
export declare function sanitizeAssetName(name: string): string;
/**
 * Attach to the editor iframe. Resolves once `window.effectcraft` exists and
 * reports ready (`effectcraftLoad.readyMs`, or an optional `ready()` hook).
 *
 * Rejects with a `BridgeError` when the editor cannot boot:
 * - `EDITOR_LOAD_FAILED` — the dist's `effectcraftLoad.error` is set (the wasm
 *   failed to boot; the `error` string is in the message). Use
 *   {@link editorLoadState} to observe this without awaiting the handshake.
 * - `EDITOR_NOT_READY` — the handshake timed out (default 60 s).
 *
 * A load failure or handshake timeout is also emitted on the event bus as an
 * `"error"` event (visible pre-attach via `AttachOptions.onEvent`).
 *
 * Every resolved method call is wrapped with a timeout (default 15 s), a
 * single retry on transient "not ready" rejections, and `BridgeError`
 * normalization (`EDITOR_TIMEOUT` | `EDITOR_CALL_FAILED` | `EDITOR_NOT_READY`
 * | `EDITOR_LOAD_FAILED` | `EDITOR_DISCONNECTED`).
 */
export declare function attachEditorBridge(iframe: HTMLIFrameElement, opts?: AttachOptions): Promise<EditorBridge>;
export type EditorShortcutName = "toggleChat" | "inlineEdit" | "agent" | "stop" | "newChat" | "undoAgentRun" | "escape" | "send";
export interface EditorShortcutEvent {
    readonly shortcut: EditorShortcutName;
    readonly key: string;
    readonly window: Window;
    readonly native: KeyboardEvent;
    preventDefault(): void;
    stopPropagation(): void;
}
export type EditorShortcutHandler = (event: EditorShortcutEvent) => boolean | void;
export interface ShortcutHandlers {
    readonly toggleChat?: EditorShortcutHandler;
    readonly inlineEdit?: EditorShortcutHandler;
    readonly agent?: EditorShortcutHandler;
    readonly stop?: EditorShortcutHandler;
    readonly newChat?: EditorShortcutHandler;
    readonly undoAgentRun?: EditorShortcutHandler;
    readonly escape?: EditorShortcutHandler;
    readonly send?: EditorShortcutHandler;
}
/**
 * Attach a same-origin key listener on the iframe's `contentWindow` and
 * forward the chat shortcuts (EDITOR_CHAT_UX §9.2): the parent handles
 * L / K / I / `.` and their Shift combos while the editor keeps every other
 * shortcut. `Cmd/Ctrl+Enter` (send/apply) and `Esc` (close popover) forward
 * too — the editor is not asked to know about the chat.
 *
 * A handler that returns `false` explicitly declines the event (nothing is
 * prevented, the editor sees it as usual); anything else — `undefined` or
 * `true` — marks it handled for the parent and the native event gets
 * `preventDefault()` + `stopPropagation()`.
 *
 * Returns a detach function.
 */
export declare function forwardShortcut(iframe: HTMLIFrameElement, handlers: ShortcutHandlers): () => void;
