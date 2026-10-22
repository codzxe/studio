# M4-E — Chat panel shell (layout modes / drag / resize / persist / pill)

Task ID: M4-E · Wave 2 · 2026-10-23
Paths owned (all landed): `apps/web/src/components/chat/{layout.ts, layout.test.ts, use-layout.ts, use-layout.test.tsx, panel.tsx, panel.test.tsx, pill.tsx, pill.test.tsx}`

## Deliverable

The chat overlay SHELL over the frozen editor iframe (ECUX §2/§9/§10, D-10/D-18):

- **layout.ts** (pure) — pinned contract VERBATIM: `ChatMode`, `ChatLayout`,
  `LAYOUT_STORAGE_KEY = "studio.chat.layout.v1"`, `DEFAULT_LAYOUT`
  ({floating, 1044, 364, 380, 520} = 380×520 at the 1440×900 design viewport's
  bottom-right 16px margin; clampLayout pulls it in-bounds on any viewport),
  `MIN_PANEL = {w:280, h:320}`, `clampLayout(l, viewport)` (size-first:
  MIN_PANEL → min(720×900, 90% of viewport, viewport); then position
  [0, viewport−size]; viewport wins below MIN — never off-screen), `loadLayout()`
  (parse + shape-validate + clamp, null on absent/corrupt, never throws),
  `saveLayout(l)` (quota-safe try/catch). PLUS the mapping helpers:
  `cycleMode(m)` (collapsed→floating→sidebar→collapsed) and
  `nextLayoutAction(current, incoming)` → `{type:"setMode";mode} | {type:"noop"}`
  for the M3 shortcut-bus events. `ChatLayoutAction` + `CHAT_MODES` additive.
- **use-layout.ts** ('use client') — ONE module singleton store +
  `useChatLayout(store?)` → `{layout, setMode, move, resize, reset}` (pinned).
  setMode NEVER clears geometry (memory across sidebar/collapsed/floating);
  every commit clamps + persists (localStorage) + notifies on value change;
  live window-resize re-clamp listener (window == editor viewport: host is
  `fixed inset-0`); hydration-safe getServerSnapshot. `createChatLayoutStore
  ({viewport?, initial?})` = test seam. Re-exports `ChatLayout`/`ChatMode` types.
- **panel.tsx** ('use client') — pinned `ChatPanelProps` slots
  (header/strip?/thread/composer/footer? + onCycleMode/onClose).
  Floating: box at x/y/w/h, 1px `--line-subtle` (border-border), `--bg-panel`,
  rounded-lg, `--elevation-modal`, header drag region (interactive children
  excluded via `closest(...)` — button/a/input/textarea/select/summary/role
  variants/[data-no-chat-drag]), 8px SE resize grip, pointer capture guarded.
  Sidebar: right rail 100% height, `width = max(MIN_PANEL.w, layout.w)`,
  internal left-edge width grip ([280, 560], store viewport cap wins — D-18).
  Collapsed → returns `null`. `<aside aria-label="Agent">` = the complementary
  landmark (explicit role dropped: lint-redundant, same semantics), aria-busy,
  tabIndex -1 (global :focus-visible 2px --signal ring). Unclaimed Esc inside
  the panel tree → `onClose()` (peer popovers live in Radix portals → their Esc
  never bubbles here → popovers close FIRST; the §9 order for free).
  Re-exports `ChatCollapsedPill` from ./pill (M4-J imports it from panel —
  both paths work).
- **pill.tsx** ('use client') — `ChatCollapsedPill({onExpand, streaming})`:
  bottom-right 36px pill, Sparkles mark, `aria-label="Agent"` + tooltip
  "Agent", streaming → signal dot with `animate-pulse-dot` (§6.3 agent pulse;
  CSS-only, tokens-only), native button (keyboard), z-[35].

## Stacking decision (documented in file headers)

| layer | z |
|---|---|
| non-blocking banners (ReadOnly/Lease/SaveChip/MissingAssets) | 20 |
| auto-hide project bar | 30 |
| **chat panel + collapsed pill** | **35** |
| boot/load-failure overlays + conflict banner | 40 |
| Radix popovers/menus/tooltips (body portal) | 50 |

Above the editor-host chrome (ECUX §2.1 "above the editor iframe"), below the
blocking overlays (a failed wasm boot / version conflict must cover the chat);
Radix portals above the panel = the §9 Esc popovers-first dismissal order.

## M4-J wiring facts (verified against its landed chat-panel-slot.tsx)

- Bus → layout: `bus.subscribe(ev => { const a = nextLayoutAction(layout,
  ev.shortcut); if (a.type === "setMode") setMode(a.mode); })`.
  - toggleChat = the 3-mode cycle (geometry remembered).
  - agent: collapsed → expand to floating, then M4-J focuses the composer;
    open → noop.
  - escape = shell-level NOOP BY DESIGN: M4-J owns the escalation (close its
    popover state first; only when none is open → setMode("collapsed")). Its
    landed slot already implements exactly this with its own cyclePanelMode
    (mapping identical to cycleMode).
- M4-J MUST feed `ChatPanel layout={...}` from `useChatLayout()` — the panel's
  internal drags call the SAME singleton's move/resize, so drags persist +
  re-render through M4-J's props. (Its slot does this.)
- `reset()` (more-menu "Reset position") keeps the mode, restores DEFAULT
  geometry clamped to the current viewport.
- Sidebar dock: the slot reports `layout.w` up to the host (its
  onSidebarDock); the panel never touches the iframe (D-18).
- Tests may drive the shell bus-free: render `ChatPanel` with stub slots +
  `useChatLayout` (see panel.test.tsx harness — resetModules + seeded
  localStorage when the singleton must be deterministic).

## Tests (48, deterministic, <1s units, no fake timers, no network)

- layout.test.ts (19): clamp vectors (off-screen/negatives/DEFAULT-on-small/
  tiny-viewport/MIN/720+90% caps/non-finite), storage (round-trip, corrupt,
  wrong shape, off-screen restore, quota throw swallowed), cycleMode,
  nextLayoutAction (toggleChat ×3 modes, agent rule, 6 non-layout shortcuts
  × 3 modes).
- use-layout.test.tsx (14): store init ×3 sources, setMode geometry memory +
  same-mode no-op, move/resize clamps, reset keeps mode, persistence, live
  window-resize re-clamp + dispose, subscribe/unsubscribe, renderHook wiring,
  singleton shared across consumers (resetModules pattern), and the M4-J
  bus→nextLayoutAction→store wiring pattern end-to-end with the REAL
  createChatShortcutBus.
- panel.test.tsx (12): slots/landmark/aria-busy/geometry per mode, sidebar MIN
  floor, collapsed → empty DOM, Esc → onClose, pointer drag/resize/width-grip
  through the shared store (jsdom PointerEvent shim; the interactive-child
  exclusion test caught a real missing-check bug in my first draft — fixed),
  interactive-child exclusion.
- pill.test.tsx (3): button role/name "Agent", 36px, click → onExpand,
  streaming dot iff streaming.

## Gates

- `pnpm --filter @studio/web typecheck`: 0 errors in my files.
- `pnpm --filter @studio/web test`: my 48/48 green; 178 pre-existing stay
  green. Full-suite reds at my close are M4-J's in-flight integration slice
  (editor-host "M4-J chat layer" mount test + scratch/provider typecheck
  errors) — their syncs own those; M4-F/G/G2/H landed green around mine.
- Biome: all 8 of my files clean (2 lint fixes: noDelete → Reflect.deleteProperty,
  noRedundantRoles → aside carries the implicit complementary role).
