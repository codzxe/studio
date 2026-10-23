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
import { z } from "zod";
import { MAX_BATCH_TIMEOUT_MS, normalizeAgentBatch } from "./batch";
import { BridgeError, messageOf } from "./errors";
import { AppCapabilitiesSchema, BatchResultSchema, CommandInfoSchema, CommandSchemaSchema, EditorInfoSchema, EffectcraftLoadInfoSchema, RenderFrameResultSchema, SaveResultSchema, ScreenshotResultSchema, UiInspectSchema, } from "./types";
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 100;
const RETRY_DELAY_MS = 250;
/** Transient startup rejections from api.rs ("Studio is not running yet" in the shipped dist) — retried once. */
const NOT_READY_RE = /not running yet|not ready|still (loading|starting)|starting up/i;
const DISCONNECTED_RE = /request dropped/i;
class EventBus {
    listeners = new Map();
    /** "ready" is sticky: late subscribers get the (single) emission replayed. */
    stickyReady = null;
    on(event, cb) {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(cb);
        if (event === "ready" && this.stickyReady)
            cb(this.stickyReady.payload);
        return () => {
            set?.delete(cb);
        };
    }
    emit(event, payload) {
        if (event === "ready")
            this.stickyReady = { payload };
        for (const cb of [...(this.listeners.get(event) ?? [])])
            cb(payload);
    }
    clear() {
        this.listeners.clear();
        this.stickyReady = null;
    }
}
function contentWindowOf(iframe) {
    // The upstream surface is unknown-shaped; the structural cast only adds optional members.
    return iframe.contentWindow;
}
function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
function zodMessage(err) {
    if (err instanceof z.ZodError) {
        return err.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
    }
    return messageOf(err);
}
function parseOr(schema, label, value) {
    try {
        return schema.parse(value);
    }
    catch (err) {
        throw new BridgeError("EDITOR_CALL_FAILED", `${label}: unexpected editor result (${zodMessage(err)})`, false, err);
    }
}
function isNotReadyMessage(message) {
    return NOT_READY_RE.test(message);
}
function classify(label, err) {
    if (err instanceof BridgeError)
        return err;
    const message = messageOf(err);
    if (DISCONNECTED_RE.test(message)) {
        return new BridgeError("EDITOR_DISCONNECTED", `${label}: ${message}`, true, err);
    }
    if (isNotReadyMessage(message)) {
        return new BridgeError("EDITOR_NOT_READY", `${label}: ${message}`, true, err);
    }
    return new BridgeError("EDITOR_CALL_FAILED", `${label}: ${message}`, false, err);
}
function withTimeout(label, promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new BridgeError("EDITOR_TIMEOUT", `${label}: timed out after ${timeoutMs} ms`, true));
        }, timeoutMs);
        const settle = (fn, value) => {
            clearTimeout(timer);
            fn(value);
        };
        promise.then((value) => settle(resolve, value), (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
/**
 * Poll for `effectcraftLoad.readyMs` (the dist sets it once `ec.start()`
 * returns) or fail fast on `effectcraftLoad.error` — the exact two signals
 * the shipped host page writes (`apps/web/public/editor/index.html`), and the
 * same pair the upstream smoke test waits for.
 *
 * The handshake is the one place the bridge polls: the dist exposes no ready
 * event, and `window.effectcraft` exists before the app runs. The `on(…)`
 * event bus below never polls.
 */
async function waitForReady(iframe, readyTimeoutMs) {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
        const w = contentWindowOf(iframe);
        const ec = w?.effectcraft;
        const load = w?.effectcraftLoad;
        if (ec && load) {
            // Order matters: the dist sets `error` on any boot failure and never
            // `readyMs`; if both are somehow present, the failure wins.
            if (load.error !== undefined) {
                throw new BridgeError("EDITOR_LOAD_FAILED", `editor failed to start: ${load.error}`, false);
            }
            if (load.readyMs !== undefined)
                return;
            // A ready() hook (not in upstream v0.13): awaited once, bounded by the deadline.
            const ready = ec.ready;
            if (typeof ready === "function") {
                const remaining = Math.max(deadline - Date.now(), 0);
                try {
                    await withTimeout("ready()", Promise.resolve(ready.call(ec)), remaining);
                    return;
                }
                catch (err) {
                    throw classify("ready()", err);
                }
            }
        }
        if (Date.now() >= deadline) {
            throw new BridgeError("EDITOR_NOT_READY", `editor did not become ready within ${readyTimeoutMs} ms`, true);
        }
        await delay(READY_POLL_MS);
    }
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
export function editorLoadState(iframe) {
    let load;
    try {
        load = iframe.contentWindow?.effectcraftLoad;
    }
    catch {
        return { status: "loading" }; // cross-origin: the dist's globals are not readable
    }
    if (!load)
        return { status: "loading" };
    if (load.error !== undefined) {
        return { status: "failed", error: load.error, wasmMs: load.wasmMs, readyMs: load.readyMs };
    }
    if (load.readyMs !== undefined) {
        return { status: "ready", wasmMs: load.wasmMs, readyMs: load.readyMs };
    }
    return { status: "loading", wasmMs: load.wasmMs };
}
/** Where the editor is loaded relative to the current origin. Same-origin only (§6.1). */
export function sameOrigin(iframe) {
    const src = iframe.getAttribute("src") ?? "";
    try {
        const url = new URL(src, globalThis.location.href);
        return url.origin === globalThis.location.origin;
    }
    catch {
        return true; // no/relative src → same origin
    }
}
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
export function sanitizeAssetName(name) {
    const cleaned = name
        .replace(/[/\\]/g, "-")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^[.-]+/, "")
        .slice(0, 120);
    return cleaned.length > 0 ? cleaned : "asset";
}
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
export function attachEditorBridge(iframe, opts = {}) {
    const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const bus = new EventBus();
    if (opts.onEvent) {
        for (const event of ["ready", "focus", "resize", "error"]) {
            bus.on(event, (payload) => opts.onEvent?.(event, payload));
        }
    }
    let disposed = false;
    /** The handshake, shared by attach and `bridge.ready()`: emits bus "error"s. */
    async function awaitReady() {
        try {
            await waitForReady(iframe, readyTimeoutMs);
        }
        catch (err) {
            const bridgeErr = err instanceof BridgeError ? err : classify("ready", err);
            bus.emit("error", bridgeErr);
            throw bridgeErr;
        }
    }
    async function call(label, fn, timeoutMs = callTimeoutMs) {
        try {
            if (disposed) {
                throw new BridgeError("EDITOR_DISCONNECTED", `${label}: bridge is disposed`, false);
            }
            const w = contentWindowOf(iframe);
            if (!w) {
                throw new BridgeError("EDITOR_DISCONNECTED", `${label}: iframe contentWindow is gone`, false);
            }
            const ec = w.effectcraft;
            if (!ec) {
                throw new BridgeError("EDITOR_NOT_READY", `${label}: window.effectcraft is missing (editor reloading?)`, true);
            }
            let lastErr = undefined;
            for (let attempt = 0;; attempt++) {
                if (attempt > 0)
                    await delay(RETRY_DELAY_MS);
                try {
                    // fn may throw synchronously (readFile/info are sync upstream) — Promise.resolve captures it.
                    return await withTimeout(label, Promise.resolve(fn(ec, w)), timeoutMs);
                }
                catch (err) {
                    lastErr = err;
                    const retryable = !(err instanceof BridgeError) && isNotReadyMessage(messageOf(err));
                    if (attempt >= 1 || !retryable)
                        break;
                }
            }
            throw lastErr;
        }
        catch (err) {
            const bridgeErr = classify(label, err);
            bus.emit("error", bridgeErr);
            throw bridgeErr;
        }
    }
    function rawInfo() {
        if (disposed) {
            throw new BridgeError("EDITOR_DISCONNECTED", "info(): bridge is disposed", false);
        }
        const w = contentWindowOf(iframe);
        const ec = w?.effectcraft;
        if (!w || !ec) {
            throw new BridgeError("EDITOR_NOT_READY", "info(): window.effectcraft is missing", true);
        }
        // info() is synchronous upstream; validate the bits the bridge relies on.
        const parsed = parseOr(EditorInfoSchema, "info", ec.info());
        const load = parseOr(EffectcraftLoadInfoSchema, "info.load", w.effectcraftLoad ?? {});
        return { ...parsed, load };
    }
    // -- window event wiring (no DOM polling; §6.2 event bus) ----------------
    function attachWindowEvents(w) {
        const onFocus = () => bus.emit("focus", { focused: true, window: w });
        const onBlur = () => bus.emit("focus", { focused: false, window: w });
        const onResize = () => bus.emit("resize", { width: w.innerWidth, height: w.innerHeight, window: w });
        w.addEventListener("focus", onFocus);
        w.addEventListener("blur", onBlur);
        w.addEventListener("resize", onResize);
        detachFns.push(() => {
            w.removeEventListener("focus", onFocus);
            w.removeEventListener("blur", onBlur);
            w.removeEventListener("resize", onResize);
        });
    }
    const detachFns = [];
    return (async () => {
        await awaitReady();
        const w = contentWindowOf(iframe);
        if (!w) {
            throw new BridgeError("EDITOR_DISCONNECTED", "iframe contentWindow is gone", false);
        }
        attachWindowEvents(w);
        const info = rawInfo();
        bus.emit("ready", {
            readyMs: w.effectcraftLoad?.readyMs,
            wasmMs: w.effectcraftLoad?.wasmMs,
            version: info.version,
        });
        if (opts.version !== undefined && !info.version.startsWith(opts.version)) {
            bus.emit("error", new Error(`editor version ${JSON.stringify(info.version)} does not match expected ${JSON.stringify(opts.version)}`));
        }
        const bridge = {
            async ready() {
                if (disposed) {
                    throw new BridgeError("EDITOR_DISCONNECTED", "bridge is disposed", false);
                }
                await awaitReady();
            },
            inspect() {
                return call("inspect", (ec) => ec.inspect()).then((v) => parseOr(UiInspectSchema, "inspect", v));
            },
            commands(filter) {
                const params = filter === undefined ? {} : { filter };
                return call("commands", (ec) => ec.request("engine.commands", params)).then((v) => parseOr(z.array(CommandInfoSchema), "commands", v));
            },
            describe(command) {
                return call("describe", (ec) => ec.execute("command.describe", { command })).then((v) => parseOr(CommandSchemaSchema, "describe", v));
            },
            query(command, params) {
                return call(`query ${command}`, async (ec) => (await ec.execute(command, params ?? {})));
            },
            execute(command, params) {
                return call(`execute ${command}`, async (ec) => (await ec.execute(command, params ?? {})));
            },
            request(method, params) {
                return call(`request ${method}`, async (ec) => (await ec.request(method, params ?? {})));
            },
            async batch(input) {
                let parsed;
                try {
                    // §8.5 bounds, `$N.key` refs and the 2 MB cap — via @studio/contracts
                    parsed = normalizeAgentBatch(input);
                }
                catch (err) {
                    const bridgeErr = new BridgeError("EDITOR_CALL_FAILED", `invalid agent batch: ${zodMessage(err)}`, false, err);
                    bus.emit("error", bridgeErr);
                    throw bridgeErr;
                }
                const payload = { label: parsed.label, atomic: true, steps: parsed.steps };
                const timeoutMs = Math.min(parsed.timeoutMs ?? callTimeoutMs, MAX_BATCH_TIMEOUT_MS);
                return call(`batch ${JSON.stringify(parsed.label)}`, (ec) => ec.execute("engine.batch", payload), timeoutMs).then((v) => parseOr(BatchResultSchema, "batch", v));
            },
            renderFrame(params) {
                return call("renderFrame", (ec) => ec.renderFrame(params)).then((v) => parseOr(RenderFrameResultSchema, "renderFrame", v));
            },
            addFile(file, name) {
                return call("addFile", async (ec) => parseOr(z.string(), "addFile", await ec.addFile(file, name)));
            },
            async addAsset(asset) {
                const virtualPath = `/assets/${encodeURIComponent(asset.assetId)}/${sanitizeAssetName(asset.name)}`;
                let blob;
                if (asset.bytes !== undefined) {
                    blob =
                        asset.bytes instanceof Blob
                            ? asset.bytes
                            : new Blob([new Uint8Array(asset.bytes)], { type: "application/octet-stream" });
                }
                else if (asset.url !== undefined) {
                    try {
                        const res = await fetch(asset.url);
                        if (!res.ok) {
                            throw new BridgeError("EDITOR_CALL_FAILED", `addAsset: fetching ${asset.url} failed with HTTP ${res.status}`, false);
                        }
                        blob = await res.blob();
                    }
                    catch (err) {
                        if (err instanceof BridgeError)
                            throw err;
                        throw new BridgeError("EDITOR_CALL_FAILED", `addAsset: fetching ${asset.url} failed (${messageOf(err)})`, false, err);
                    }
                }
                else {
                    const bridgeErr = new BridgeError("EDITOR_CALL_FAILED", "addAsset: CloudAsset needs `url` or `bytes`", false);
                    bus.emit("error", bridgeErr);
                    throw bridgeErr;
                }
                return call("addAsset", (ec) => ec.addFile(blob, virtualPath)).then((v) => parseOr(z.string(), "addAsset", v));
            },
            saveToBrowser(path) {
                return call("saveToBrowser", (ec) => ec.saveToBrowser(path)).then((v) => parseOr(SaveResultSchema, "saveToBrowser", v));
            },
            readFile(path) {
                return call("readFile", (ec) => ec.readFile(path)).then((v) => {
                    if (!(v instanceof Uint8Array)) {
                        const bridgeErr = new BridgeError("EDITOR_CALL_FAILED", `readFile: no file at ${JSON.stringify(path)}`, false);
                        bus.emit("error", bridgeErr);
                        throw bridgeErr;
                    }
                    return v;
                });
            },
            screenshot(params) {
                return call("screenshot", (ec) => ec.screenshot(params ?? {})).then((v) => parseOr(ScreenshotResultSchema, "screenshot", v));
            },
            on(event, cb) {
                return bus.on(event, cb);
            },
            version() {
                return rawInfo().version;
            },
            info() {
                return rawInfo();
            },
            capabilities() {
                return call("capabilities", (ec) => ec.execute("app.capabilities")).then((v) => parseOr(AppCapabilitiesSchema, "capabilities", v));
            },
            dispose() {
                if (disposed)
                    return;
                disposed = true;
                for (const detach of detachFns)
                    detach();
                detachFns.length = 0;
                bus.clear();
            },
        };
        return bridge;
    })();
}
function matchShortcut(e) {
    const mod = e.metaKey || e.ctrlKey; // `command` is ⌘ on macOS, Ctrl elsewhere (control-protocol.md)
    const key = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey) {
        if (key === "l")
            return "toggleChat";
        if (key === "k")
            return "inlineEdit";
        if (key === "i")
            return "agent";
        if (key === ".")
            return "stop";
        if (key === "enter")
            return "send";
    }
    if (mod && e.shiftKey && !e.altKey) {
        if (key === "l")
            return "newChat";
        if (key === "u")
            return "undoAgentRun";
    }
    if (!mod && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && key === "escape") {
        return "escape";
    }
    return undefined;
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
export function forwardShortcut(iframe, handlers) {
    const w = contentWindowOf(iframe);
    if (!w)
        return () => { };
    const onKeyDown = (e) => {
        if (e.repeat)
            return;
        const shortcut = matchShortcut(e);
        const handler = shortcut !== undefined ? handlers[shortcut] : undefined;
        if (shortcut === undefined || handler === undefined)
            return;
        let used = false;
        const event = {
            shortcut,
            key: e.key,
            window: w,
            native: e,
            preventDefault: () => {
                used = true;
                e.preventDefault();
            },
            stopPropagation: () => {
                used = true;
                e.stopPropagation();
            },
        };
        const handled = handler(event);
        if (handled !== false) {
            used = true;
            e.preventDefault();
            e.stopPropagation();
        }
        else if (used) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    w.addEventListener("keydown", onKeyDown);
    return () => {
        w.removeEventListener("keydown", onKeyDown);
    };
}
//# sourceMappingURL=bridge.js.map