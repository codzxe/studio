# Chat UI + Client Tool Executor Audit (Task 12-w1-a2)

Date: 2026-10-23 · Scope: `apps/web` chat stack (AUDIT ONLY — no product code changed).

**Headline finding:** the "Cursor-style panel" the task asks us to *design* is already
~90% built. `ChatPanel` (components/chat/panel.tsx) is a real floating/draggable/
resizable/dockable/collapsible window with localStorage persistence, pointer-capture
gestures, drop-to-dock with preview, and sidebar detach. The real gaps vs Cursor are
**thread history on reload**, **multi-panel / left-bottom docking**, and
**message-level affordances** — not layout plumbing.

---

## 1. Inventory: feature → exists? → where → gap vs Cursor

| Feature | Exists? | Where | Notes / gap vs Cursor |
|---|---|---|---|
| Message list | ✅ | `components/chat/thread.tsx` (ChatThread) | `role="log"` + `aria-live=polite`; bottom-anchored scroll (32px threshold, never yanks a scrolled-up reader); windowed rendering past 50 msgs (last 40 + spacer). **No per-message copy/edit; no scroll-to-bottom button; no in-thread search.** |
| Markdown | ✅ (safe subset) | `components/chat/markdown.tsx` | Paragraphs, **bold**, *italic*, `code`, fenced blocks, `- ` lists, h1–h3. NO links (rendered text-only), NO tables, no images from model text. Cursor renders full GFM w/ links. |
| Streaming text | ✅ | `run-state.ts` reducer + `message.tsx` caret (`chat-caret`), `data-streaming`, `aria-busy` | Text deltas + steering (queued mid-run messages) + `reconnecting` phase w/ backoff → RUN_PAUSED banner. No elapsed-time/queue-depth indicator. |
| Plan cards | ✅ (rich) | `components/chat/plan-card.tsx` (726 ln), wired in `message.tsx` via `PlanMessageWiring` | status proposed/applying/applied/undoing/undone/failed; risk (low/med/high + danger chrome), intent, `requiresApproval` checkbox + confirm dialog; steps disclosure (`plan-steps`); affected layers; credit estimate; PlanPreview (probe-apply-undo, low/med only); DiffCard (old→new per prop, all risks); View-in-timeline; version-history link; Undo/Reapply (drift-gated)/candidate pick. **AUTO-APPLY drive** at run.completed (round-10 v2, once per runId, live-folded only). |
| Tool cards | ✅ | `components/chat/tool-card.tsx` | Collapsed one-line + expandable args/result JSON + Copy; running spinner/done/failed; `render_preview` PNG rendered as `<img>` (base64 redacted from text). Labels for the 5 curated tools. **No per-tool timing/duration display.** |
| Step indicators | ✅ (plan steps) | plan-card `plan-steps` | Steps are plan-batch steps, not a live agent progress list. Cursor shows a live agent "thinking/tool" stream w/ per-step status; here tool cards serve that role. |
| Model picker | ✅ | `components/chat/model-picker.tsx` via header | From `GET /v1/models`; plan-locked rows; Settings default (`studio.chat.model.v1`). Single-model trial plan pins one locked row (e2e-asserted). |
| Stop button | ✅ | `components/chat/composer.tsx` (Send⇄Stop "Stop streaming"), `⌘.` | Fused cancel via controller.stop(). e2e stop test exists but is skipped under MOCK_MODEL (instant stream). |
| Retry | ✅ (partial) | thread error banner, RUN_PAUSED banner, `EditErrorCard`, plan-card Try-again | Try-again only for PRE-execution failures (post-execution retry would double non-idempotent batches — M5-L F-L1). Cursor has per-message regenerate; here retry is run-level only. **No per-message retry.** |
| History load on reload | ❌ | — | **Biggest gap.** Thread is created lazily on first send (`provider.tsx` `ensureThread`); `threadId` is in-memory only. `ApiClient.threads.messages(threadId, query)` (GET /threads/:id/messages) EXISTS in packages/api-client but is called NOWHERE in apps/web. Reload ⇒ blank thread; plans/tool calls never reconstructed (auto-apply guard explicitly skips runs not folded live). Cursor restores full conversation + checkpoints on reload. |
| Thread list / switcher | ❌ | — | `newThread()` resets; no UI to see past threads of a project. |
| Context attach | ✅ | `lib/chat/context.ts` + `components/chat/context-*.tsx` | 9 `ContextSelection` flags (comments block dormant/unwired): projectSummary, activeComp, selection (≤8 layers, depth-2 trees), selectedProperties (≤12 reads), playhead, focusedPanel, currentFrame (chip only), recentCommands (last 10) + pinned chips. Popover toggles, strip, token estimates (`JSON.length/4`), credit estimate in footer. Auto-flags from a 1Hz `bridge.inspect()` poll (only while panel visible). |
| Agent mode / inline edit / quick actions | ✅ | `chat-panel-slot.tsx` | ⌘I agent chip, ⌘K InlineEditBar (`inlineEdit: true` tag), selection-seeded quick-action chips, empty-state chips; clarify card + error card above composer. |
| Composer | ✅ | `composer.tsx` | Textarea, Enter send, ⌘↵ send, stop, credit hint, disabled states (credits/plan). **No image/file drop, no @-layer mentions, no slash commands.** |
| Shortcuts | ✅ | `chat-shortcut-bus.ts` + slot listener | ⌘L cycle, ⌘K inline, ⌘I agent, ⌘↵ send, ⌘. stop, Esc layering (inline→popover→transients→collapse), ⌘⇧U undo agent run. Bus records last 16 events; host publishes L/K/I (iframe wasm→host bridge silent for layout cycle). |
| Collapse affordance | ✅ | `pill.tsx` ChatCollapsedPill | 36px bottom-right pill, streaming pulse dot, z-35. Panel renders `null` when collapsed. |
| Drag | ✅ | `panel.tsx` | Header + visible `chat-drag-grip` handle in both open modes; pointer events + `setPointerCapture` (progressive); interactive descendants excluded (`INTERACTIVE_SELECTOR`); sidebar detach-to-float after 8px travel (grab offset preserved, no jump). |
| Resize | ✅ | `panel.tsx` | Floating: 8px SE corner grip (`cursor-se-resize`). Sidebar: internal left-edge width grip (280–560px). Min 280×320, max 720×900 / 90% viewport. |
| Dock | ✅ (right only) | `panel.tsx` + `editor-host.tsx` | Drop within 32px of right edge docks (dashed `chat-dock-zone` preview at z-36, pointer-events-none); host resizes viewport wrapper to `calc(100% - Npx)` — iframe only ever sees a window resize (D-18). Header has explicit dock toggle + reset-position. **No left/bottom dock, no editor-pane docking, no snap/magnet.** |
| Position/size persistence | ✅ | `layout.ts` + `use-layout.ts` | localStorage `studio.chat.layout.v1` (per USER, not per project — D-10), validated + re-clamped on load AND live on window resize; SSR-hydration-safe via `useSyncExternalStore` server snapshot. |
| z-index discipline | ✅ | `panel.tsx` header comment | banners z-20 → project bar z-30 → **panel z-35** → dock zone z-36 → blocking overlays z-40 → Radix portals z-50 (Esc order portal-first by construction). |

## 2. Exact engine-handle seam (what the tool executor calls)

There is **no `engineRef.current.batch()` pattern**. The seam is the
`EditorBridge` interface (packages/editor-bridge/src/types.ts), attached to the
same-origin editor iframe by `attachEditorBridge(iframe)` and lease-gated via
`wrapReadOnlyBridge(bridge, gate)` (editor-host.tsx).

`createToolExecutor(deps: ToolExecutorDeps)` (lib/chat/tool-executor.ts) returns
`(call: ClientToolCall) => Promise<void>`; `ClientToolCall = { runId, toolCallId, name, args }`;
`ToolExecutorDeps = { bridge: EditorBridge, client: ApiClient, workspaceId, flags: ContextSelection, guardTimeoutMs? (20s), retrySleepMs? (250) }`.

Read tools → bridge calls (exact command/param names, verified vs engine query.rs + fake registry):

- `bridge.inspect(): Promise<UiInspect>` → `{ activeComp, selectedLayers, time, playing, focusedPanel }`
- `bridge.query("project.summary", {})`
- `bridge.query("comp.info", { comp })` — comp id or name; `{}` = active comp
- `bridge.query("layer.tree", { comp, layer, depth })` — PER-LAYER (fails w/o layer)
- `bridge.query("prop.get", { layer, path })` — layer id/name/`#n`
- `bridge.query("edit.history.list", {})`
- `bridge.renderFrame({ comp, time, max_side })` → `{ comp, time, width, height, pngBase64 }` (long side capped 1200)

Write path (NOT the tool executor — the ApplyController, lib/chat/apply.ts):
`bridge.execute("engine.batch", payload)` (ONE atomic batch = ONE undo = ONE version) and
`bridge.execute("edit.undo")`. Raw surface (`engine.batch`, `engine.execute`, `edit.undo`,
`edit.redo`) is REFUSED as a model tool (`RAW_ENGINE_TOOL_IDS` → `TOOL_FORBIDDEN`, zero
bridge calls); write tools refused client-side (server executes them); server-side tools
(`studio.plan_edit`) skipped. Per-call bridge timeout 15s; whole-call guard 20s → `TOOL_TIMEOUT`.
Never throws — every outcome is a posted result; per-item failures degrade to
`{error:"NOT_FOUND"}`/nulls; null-prototype accumulators vs model-chosen keys.

Result POST: `client.runs.postEvent(runId, { type: "tool.result", toolCallId, result }, { idempotencyKey: "toolresult:<runId>:<toolCallId>" })`
→ `POST /v1/runs/:id/events` (RUN_EVENT_REQUEST_SCHEMA, strictObject); 3 attempts on
status 0/408/429/5xx, 250ms apart, then silent (runner's 30s `waitForToolResult` fails
the run EDITOR_DISCONNECTED server-side). Duplicate toolCallIds never re-execute
(`createToolExecutor` id set + provider-level `executedToolIdsRef`).

Executor dispatch: the controller has NO emitter; provider diffs the snapshot's
`toolCards` for `status === "running"` (M4-B observation pattern) and hands each to the
executor (provider.tsx ~L528).

## 3. Context the client attaches today

`collectContextSnapshot(bridge, { flags, pinned })` (context.ts) runs on panel open,
on flags/pinned change, and right before EVERY send (fresh-at-send doctrine §5). One
`bridge.inspect()` + bounded queries (concurrency 4); failed calls → "(unavailable)"
blocks, never abort. Flags ride the send body (`ChatSendInput.context`); `block.data`
is display/transport only. Token estimate = `JSON.stringify(value).length / 4`
(tokens.ts), labeled "~". Effective flags = `autoFlags(inspect)` overlaid with user
popover overrides (removed STAYS removed). Comments flag deliberately dormant.

## 4. Provider wiring + where the panel renders

`EditorHost` (editor-host.tsx, route `/w/[slug]/editor`) mounts a second bridge
after the wasm editor reports open, wraps it with the read-only/lease gate, and
renders: `<div class="pointer-events-none absolute inset-0 z-30" data-testid="chat-layer">`
→ `ChatProvider` (render-prop) → `ChatPanelSlot` → `ChatPanel`. The slot root is
`pointer-events-none absolute inset-0`; the panel/pill layers re-enable pointer events
on their subtrees. The host is `fixed inset-0`, so window == clamp viewport. Sidebar
docking reports up via `onSidebarDock(docked, widthPx)`; the HOST resizes the editor
viewport wrapper (`calc(100% - Npx)`), never the iframe (D-18).

**Styling system:** Tailwind CSS **v4**, CSS-first config — `globals.css` has
`@import "tailwindcss"; @import "@studio/ui/src/styles/theme.css"; @source "../../../../packages/ui/src"`;
NO `tailwind.config.*`. Design tokens are CSS vars in `@studio/ui` theme.css
(`--bg-panel`, `--line-subtle`, `--radius-md`, `--elevation-modal`, `--signal`),
surfaced as Tailwind utilities (`bg-panel`, `border-border`, `rounded-md`,
`shadow-modal`, `z-[35]` literals). `@studio/ui` = Radix-based primitives
(Tooltip, Badge, Button, Spinner) + lucide-react icons. No CSS modules anywhere in chat.

## 5. e2e-pinned UX (must not regress)

`e2e/chat.spec.ts`: floating default; ⌘L cycle floating→sidebar→collapsed; pill
↔ panel swap; "What's on this comp?" journey (tool-card `studio.get_context` done,
mock answer text verbatim, `chat-status[data-phase=done]`, plan-card proposed with
Apply/Cancel); Context 4 chips + popover rows + token estimates; model picker single
locked row; Esc closes popover w/o collapsing panel; **editor-pixel screenshots in
both states** (chat chrome masked, maxDiffPixelRatio 0.01); stop test skipped under
MOCK_MODEL. `e2e/m5-agent-edits.spec.ts` (round-10 v2): mock plan AUTO-APPLIES (applied
card + Undo, no click); scripted high-risk SSE plan renders danger chrome and keeps
Apply gated; full high-risk journey checkbox→confirm→applied→undo→reapply-blocked;
editor chrome at M3 baseline (canvas masked). Any layout change ⇒ re-baseline snapshots.

## 6. Persistence on reload

Server-side threads/messages/runs/plans all persist (gateway + DB; api-client exposes
`threads.messages(...)`), but the client never reads them: `threadId` starts `null`,
thread is created on first send, everything else is in-memory. Reload = fresh thread,
zero reconstruction of tool calls/plans (deliberate for auto-apply safety — a reloaded
page must never resurrect old plans — but it also means the user loses the visible
conversation). The editor page itself wires NO threadId (RSC payload is manifest-only).

## 7. What must change for the floating/draggable/resizable/dockable panel

**Mostly nothing — it ships.** Already in place: 3-mode layout store
(`useChatLayout` singleton, `useSyncExternalStore`), pointer-event drag w/ capture,
SE resize + sidebar width grip, drop-to-dock + detach-to-float, localStorage
persistence w/ clamp-on-load and live window-resize re-clamp, Esc/⌘L mode cycling,
z-index map, dock→viewport-resize host contract. For anything still wanted:

1. **State management:** extend `ChatLayout` (layout.ts) — keep the external-store +
   `useSyncExternalStore` pattern; new fields (e.g. docked side `left|right`, per-project
   key) flow through `clampLayout`/`loadLayout`/`saveLayout` unchanged. Per-PROJECT
   geometry = new storage key (current `studio.chat.layout.v1` is per-user by design, D-10).
2. **Pointer events:** reuse `onGripPointerDown/Move/End` machinery — `DragState.origin`
   capture + `setPointerCapture` + `INTERACTIVE_SELECTOR` exclusion are the load-bearing
   parts; add edge zones by generalizing `isDockDrop` (currently right-edge-only, 32px).
3. **Persistence of position/size:** already best-effort localStorage; if layout should
   follow the project, either a second key or a server user-preference — do not widen
   the existing key's schema blindly (`isStoredLayout` rejects unknown shapes).
4. **z-index:** panel z-35 sits below blocking overlays z-40 and Radix z-50 by design;
   a second concurrent panel needs its own layer literal + focus-order policy.
5. **Collapse:** collapsed = `null` panel + pill (slot owns the swap); keep the
   geometry memory in the STORE, never in the component.
6. **Layout surgery:** NOT needed — the panel is already an absolutely-positioned
   overlay inside a `pointer-events-none` full-bleed layer; sidebar mode already
   resizes the editor through the host callback. Multi-panel would need the slot to
   render N providers/panels (today: exactly one ChatProvider per page).

## 8. Priority gap list (Cursor-parity candidates, ordered)

1. **History/reload reconstruction** — load latest thread + messages
   (`client.threads.messages`) on editor open; rebuild read-only cards (plans stay
   unactionable after reload — matches the auto-apply guard). Thread list/switcher next.
2. **Left/bottom dock zones** (generalize `isDockDrop`) + optional per-project geometry.
3. **Message-level affordances** — copy, per-message retry/regenerate, scroll-to-bottom.
4. **Composer power** — @-layer mentions (bridge layer list already fetched by tools),
   image/file attach (bridge `addFile` exists), slash commands.
5. **Live agent progress strip** — unified per-run step indicator above tool cards
   (Cursor-style), incl. elapsed time and cancel.
6. Markdown links/tables if the product wants them (current subset is a deliberate
   injection posture — links are text-only by design).
