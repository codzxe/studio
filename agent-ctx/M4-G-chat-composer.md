# M4-G — Chat Composer (apps/web/src/components/chat/composer.tsx)

Task ID: M4-G · Agent: M4-G · Scope: the chat COMPOSER only (seam 8 of
docs/phases/M4-SEAMS.md wave-2). Peers own every other file under
apps/web/src/components/chat/; apps/web/src/lib/** is read-only for me.

## Deliverables

- `apps/web/src/components/chat/composer.tsx` (NEW, 'use client') — exports the
  pinned `ChatComposerProps` verbatim + `ChatComposer`. 233 lines.
- `apps/web/src/components/chat/composer.test.tsx` (NEW, colocated) — 16 tests /
  85 `expect` assertions, 356 ms file time, deterministic (no network, no fake
  timers, no layout dependency). Pattern copied from editor-host.test.tsx
  (RTL render/fireEvent + afterEach cleanup; user-event only for the
  Shift+Enter default-action insertion).

## Contract (exported EXACTLY, M4-SEAMS "Wave-2 UI contract")

```ts
export interface ChatComposerProps {
  streaming: boolean;
  disabled?: { reason: "credits" | "plan" | "editor"; message: string } | null;
  quickActions?: readonly { label: string; prompt: string }[];
  creditHint?: string;
  onSend(message: string): void;
  onStop(): void;
}
export function ChatComposer(props: ChatComposerProps): ReactElement;
```

## Wiring facts for M4-J (panel)

- **Window events emitted (prop-free wiring, both documented in the component JSDoc):**
  - `studio:chat-quick-action` — `detail: string` = the chip's `prompt`. Fired on
    quick-action chip click; the composer then focuses its own textarea. Chips
    render ABOVE the textarea only when `quickActions` is a non-empty array —
    the PARENT decides the thread is empty (the thread's own chips are separate;
    coordinate via props, never via reading the thread).
  - `studio:chat-upgrade` — NO detail. Fired on the Upgrade CTA click
    (`disabled.reason === "credits"`). Navigation is the panel's job.
- **Keyboard law (ECUX §3.4/§9):**
  - Plain Enter sends (trimmed) when non-empty + not locked + ≤8,000 chars —
    INCLUDING while `streaming === true` (§3.4 steer: the composer stays
    enabled; the button is Stop but Enter still appends to the run queue —
    M4-J maps `onSend` to `controller.send` which owns the steer semantics).
  - Cmd/Ctrl+Enter also sends, but only from the composer's own textarea
    (the panel-level Cmd/Ctrl+Enter listener is M4-J's, independent).
  - Shift+Enter → newline (handler returns BEFORE preventDefault so the
    browser default action runs).
  - Escape → deliberately NOTHING inside the composer (dismissal order
    popovers → panel is M4-E/M4-J's, pinned in the seam).
  - IME: Enter with `nativeEvent.isComposing` OR `keyCode === 229` never sends
    (and is not prevented — the IME keeps the Enter to confirm composition).
- **Send button** (absolute bottom-right, `iconSm` 32px, `data-testid="chat-composer-send"`):
  - streaming → Stop (Square icon, `aria-label="Stop streaming"`, calls
    `onStop`). Precedence decision: while streaming, Stop outranks even the
    credits lock (§8.3 — the user can always cancel a live run). Clicking Stop
    never calls `onSend`.
  - `disabled.reason === "credits"` (and not streaming) → link-styled
    "Upgrade" button that dispatches `studio:chat-upgrade`.
  - otherwise → Send (ArrowUp icon, `aria-label="Send"`), disabled when the
    trimmed draft is empty or >8,000 chars.
- **Disabled semantics:** `disabled != null` → textarea has the `disabled`
  attribute and every send path (Enter/Cmd+Enter/button) is dead;
  `disabled.message` renders in the bottom row as `<output>` (implicit
  `role="status"`, aria-live polite). Lock message outranks the length hint
  while locked.
- **onSend receives the TRIMMED message**; the draft clears and the textarea
  keeps focus (explicit `.focus()` after send); `rows` resets to 1.
- **Length guard:** `CHAT_MESSAGE_SCHEMA` max (8,000, packages/contracts/src/
  routes/chat.ts) — sends beyond it are DISABLED (never sliced) with a
  "Message too long — 8,000 characters max." hint (danger tint). The bound is
  evaluated on the TRIMMED value (what would actually be sent). No
  `maxLength` attribute, so the over-limit state is reachable and visible.
- **Auto-grow (§3.4 1–6 rows then scroll):** two-layer —
  1. `rows` attribute = deterministic newline-count math clamped 1..6 (the
     jsdom-testable truth);
  2. `@studio/ui` `useAutoGrow` hook (scrollHeight sizing) + a mount-time
     computed `max-height` (6 × computed line-height + padding) covers
     soft-wrapped lines in real browsers, with `overflow-y-auto` for the
     internal scroll at the cap. The max-height effect no-ops in jsdom (no
     computed line-height), so tests stay deterministic.
- **Builds on `@studio/ui`:** `Textarea` + `useAutoGrow` + `Button` (primary
  send / secondary stop / link upgrade / sm chips). `Textarea` is used with
  `autoGrow={false}` + a composed callback ref (its `ref` prop is ignored when
  its own `autoGrow` branch is on), calling the design-system hook directly
  from the composer. Tokens only; textarea `bg-input`, focus ring
  `outline-signal`, 13–14px text — all inherited from the Textarea base classes.
- **a11y:** textarea `aria-label="Message the agent"`; placeholder exactly
  "Ask for an edit, or describe what you want to build…" (§3.4).
- **`data-testid`s (stable for M4-J's integration tests):** `chat-composer`
  (root), `chat-composer-send` (the single send/stop/upgrade button),
  `chat-composer-quick-action` (chips).

## Deviations / notes

- `Kbd` NOT used: the shortcut hint slot is pinned to M4-G2's `ChatFooter`
  (`shortcutHint` prop); rendering a second hint inside the composer would
  duplicate the footer. The composer's bottom row carries only the
  `creditHint` slot + the lock/length messages.
- Stop-vs-Upgrade precedence (streaming wins) is a documented decision; the
  seam/brief do not pin the combined `streaming && disabled.credits` state and
  §8.3 cancellation is a hard user right.

## Gates (run 2026-10-23, this box)

- `pnpm --filter @studio/web test` → **207/207 green** (18 files) at my run
  (178 wave-1 + 16 mine + peers' landed banners/footer/header/markdown/
  model-picker tests).
- `pnpm --filter @studio/web typecheck` → **0 errors in MY files**. The
  package gate is currently RED from two peers' in-flight files that landed
  while I built (mid-flight race, M4-A2 precedent): `chat/header.tsx(53,20)`
  TS2304 `ModelsListEntry` (M4-G2) and `chat/layout.ts(65,35)` TS2322 (M4-E).
  Both were verified absent at 17:33 and present at 17:36 — not mine to fix
  (law #12); their owners' syncs land the fixes.
- Biome scoped to my two files: **clean** (`pnpm -C apps/web exec biome check
  src/components/chat/composer.tsx src/components/chat/composer.test.tsx`).
  Pre-existing lint drift in peers' `banners.tsx` / `markdown.tsx` (organize
  imports, noArrayIndexKey, useImportType) is theirs — untouched.
- No pnpm install, no dev servers, no turbo (scoped pnpm --filter only).

## Commits (git-sync protocol, add -A sweeps documented)

- `61fa22f` "M4-G: chat composer — auto-grow/Enter-CmdEnter semantics/stop/
  credits-disabled/quick-action chips + tests" — my 2 files + swept peers'
  in-flight WIP: banners{,.test}.tsx, context-popover.tsx, context-strip.tsx,
  footer{,.test}.tsx, header{,.test}.tsx, layout.ts, markdown{,.test}.tsx,
  message.tsx, model-picker{,.test}.tsx, panel.tsx, pill.tsx, plan-card.tsx,
  thread.tsx, tool-card.tsx, use-layout.ts, lib/chat/provider.tsx + 8
  tool-results/* scratch files (pre-existing fleet pattern — tracked since
  M3-C/M4-D commits).
- `e87f069` "M4-G: chat composer — retry push (composer already committed at
  61fa22f)" — first push failed after the script's 6 retries (remote
  contention); the retry committed the peers' next deltas that had landed in
  the shared tree (context-strip.test.tsx, footer/header/model-picker edits,
  plan-card.test.tsx, tool-card.test.tsx, editor-host.tsx/types.ts edits,
  provider.tsx rework) and pushed clean: **git-sync: OK**.
