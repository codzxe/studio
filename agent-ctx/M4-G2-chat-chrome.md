# M4-G2 — chat header + model picker + footer (work record)

Task ID: M4-G2 · Wave 2 · Status: COMPLETE (my slice green; see fleet notes for peers' in-flight state)

## What I built

`apps/web/src/components/chat/` (all NEW, mine only):

1. **model-picker.tsx** (`'use client'`) — the entitlement-driven picker, fed
   ONLY by the injected `models` prop (M4-J calls `client.models.list()` and
   maps the wire; this file never imports the api-client — law + brief).
   - `ModelsListEntry { id; tier; use; creditsPer1kInput; creditsPer1kOutput }`
     — Wave-2 pinned contract, defined here, re-exported from header.tsx.
   - `ModelPickerProps { models: readonly ModelsListEntry[] | null;
     activeModelId: string | null; onPick(id: string): void }` → `ModelPicker`.
   - `models === null` → inert disabled trigger labelled "Model…" (surface
     loading); `models === []` → picker hidden ENTIRELY (empty/failed surface);
     ONE model → picker still opens, the option renders as a locked selected
     row (never a button) + note "Your plan includes this model".
   - Popover (@studio/ui Radix popover, tokens only): per entry — display name,
     tier tag (Badge), use string, rate `≈<in>–<out> cr /1k tokens` (flat
     `≈<in> cr /1k tokens` when equal); active row gets `ring-1 ring-signal`
     + check glyph; click → `onPick(id)` + close; Esc/outside close. Off-plan
     models never appear — the gateway filters (trust the wire).
   - Tier glyphs: fast→Zap, smart→Sparkles, vision→Eye, fallback→Sparkles.
   - **`modelDisplayName(id)`**: studio-fast→"Fast", studio-smart→"Smart",
     studio-vision→"Vision", fallback = prettified id ("gpt-4o-mini" →
     "Gpt 4o Mini"), "" → "".
   - **`modelTierLabel(tier)`**: "fast"→"Fast" …, unknown → prettified
     ("experimental" → "Experimental"). M4-J reuses both for the footer label.

2. **header.tsx** (`'use client'`) — `ChatHeaderProps` (Wave-2 pinned,
   verbatim) → `ChatHeader`. Left: @studio/ui `StatusDot` + truncated title
   (`idle`→dim/bg-muted, `sending|streaming`→signal + `animate-pulse-dot`
   pulse, `reconnecting`→warning + pulse, `done`→success, `failed|cancelled`
   →danger; NO spinners; the pulse is CSS-only and dies under the theme's
   global prefers-reduced-motion override → reduced-motion safe). Then
   `ModelPicker`; flex spacer; `Context N` button (hidden at 0); action row of
   three 28px ghost icon buttons — cycle-mode Maximize2 "Cycle panel mode
   (⌘/Ctrl+L)", dock toggle PanelRight "Dock panel to sidebar / float", close X
   "Close chat (Esc)" — each with a Tooltip; `⋯` more menu (@studio/ui Radix
   DropdownMenu): New chat (⌘⇧L), Reset position, Keyboard shortcuts (?).
   History/Clear context NOT rendered (M5/M4-H — per pinned props).
   Re-exports for M4-J's single-import surface: `ModelsListEntry`,
   `ModelPickerProps` (types), `ModelPicker`, `modelDisplayName`,
   `modelTierLabel`.

3. **footer.tsx** (no directive needed — purely presentational) —
   `ChatFooterProps { modelLabel; creditEstimate; shortcutHint }` →
   `ChatFooter`: one 28px (`h-7`) line `<modelLabel> · <creditEstimate> ·
   <shortcutHint>` in 13px `text-muted`; the credit span carries
   `title="Estimate; actual usage is metered"`; shortcut hint pinned right.

4. **Colocated tests** (deterministic RTL + user-event, real Radix, no
   network/fake timers): model-picker.test.tsx (13), header.test.tsx (13),
   footer.test.tsx (2) — **28 tests / 81 `expect` assertions, ~1.2s**. Covers:
   dot class per phase (idle/streaming/done/failed/cancelled + no-spinner),
   picker open/entries-with-rates/pick+close/Esc, signal ring on the right
   row only, [] → absent, null → "Model…", single-model lock (no buttons in
   popover, click is inert, note rendered), off-list activeModelId → "Model…",
   flat-rate format, Context 0 hidden / Context 3 click, three actions + three
   menu callbacks (+ History/Clear-context absence), header↔picker onModelPick
   propagation, footer three segments + separators + metering title attr +
   h-7/text-muted classes, modelDisplayName/modelTierLabel vectors.

## Gates (my slice)

- `pnpm --filter @studio/web typecheck`: **0 errors in my 6 paths** (verified
  by grepping the error list for my files — the repo-wide run reports errors
  ONLY in peers' in-flight files, listed below).
- `vitest run` scoped to my 3 test files: **28/28 green**, 3 consecutive runs,
  ~1.2s test time.
- Full-suite context: my files pass inside every full run; the red remainder is
  peers' mid-flight work (see fleet notes).
- `biome check` scoped to my 6 files: **clean** (formatter + organizeImports
  applied via `--write`, then verified clean).

## Fleet notes (integrator)

- Peers' IN-FLIGHT red at my gate times (NOT my paths, verified: M4-E
  `layout.ts` TS2322, `panel.tsx`/`ChatCollapsedPill` mid-write; M4-F
  `banners.test.tsx` RunPausedBanner + `markdown.test.tsx` failures; M4-H
  `context-strip`/`context-popover` 1 failure each; M4-J
  `chat-panel-slot.tsx` import errors + `provider.test.tsx` syntax errors
  mid-write; editor-host.test.tsx transiently showed 0 tests during one of
  M4-J's writes but passes 10/10 in isolation). Expected global-lock fleet
  behavior — owners' own syncs land the fixes.
- Wiring facts for M4-J (see also worklog stage summary): render
  `<ChatHeader …models={…}>` with the mapped `client.models.list()` result
  (`null` while loading, `[]` on failure → picker vanishes gracefully);
  `activeModelId` = the chat send's `model` state; footer `modelLabel` =
  `modelDisplayName(activeModelId ?? defaultModelForPlan(plan))`;
  `creditEstimate` from the M4-C tokens surface; `shortcutHint` = "⌘↵ to
  send" (mac) / "Ctrl+↵ to send" (others).
