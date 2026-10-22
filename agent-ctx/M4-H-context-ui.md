# M4-H — chat context UI (strip + popover), wave 2

Task: apps/web/src/components/chat/{context-strip.tsx, context-popover.tsx} — the
CONTEXT UI of Seam 7 (M4-SEAMS.md Wave-2 pinned contract + the brief's optional
pinned extensions): the removable-chips strip under the header (ECUX §3.2) and
the "Context for this message" popover listing exactly what will be sent with
~token estimates (§5.3). Committed 5f9716d; final state green.

## Exports (M4-J consumes; verbatim from the pinned contract + extensions)

```ts
// context-strip.tsx
export interface ContextStripProps {
  readonly blocks: readonly ContextBlock[];
  readonly totalTokenEstimate: number;
  onRemoveBlock(kind: keyof ContextSelection): void;
  onAddContext(): void;
  pinned?: readonly PinnedContextItem[];   // brief's optional extension
}
export function ContextStrip(props: ContextStripProps): ReactElement | null;

// context-popover.tsx
export interface ContextPopoverProps {
  readonly blocks: readonly ContextBlock[];
  readonly totalTokenEstimate: number;
  onToggleBlock(kind: keyof ContextSelection, on: boolean): void;
  onRemoveAll(): void;
  onDone(): void;
  pinned?: readonly PinnedContextItem[];   // brief's optional extension
  onRemovePinned?(index: number): void;   // brief's optional extension
}
export function ContextPopover(props: ContextPopoverProps): ReactElement;
```

- `ContextBlock` is imported type-only from `@/lib/chat/context` (M4-C, wave-1
  landed); `ContextSelection` / `PinnedContextItem` / `PinnedContextKind`
  type-only from `@studio/contracts`; `formatTokenEstimate` from
  `@/lib/chat/tokens` is THE estimate formatter (never re-formatted).
- Strip: renders null when blocks empty AND pinned empty/absent. Expanded =
  single-line ul: removable `[✓ label]` chips (✕ → onRemoveBlock(kind)),
  display-only pinned chips (glyphs frame ▣ selection ◉ composition ▤ asset ⬡
  comment ✎), trailing "+" → onAddContext. Pinned removal is NOT possible from
  the strip (per the brief's PIN) — the popover's ✕ owns it via onRemovePinned.
- Popover: Radix modal (@studio/ui Popover/PopoverAnchor/PopoverContent):
  focus trap, Esc + outside-click → onDone, background aria-hidden, body
  pointer-events none while open, role="dialog" + aria-label="Chat context"
  (Radix provides the role). Rows = native checkboxes (accent-signal) +
  labels + estimates; currentFrame shows "1 image" while data === undefined;
  optional pinned section with ✕; footer "~N tokens total" + [Remove all]
  (secondary) + [Done] (primary). Optimistic pending-uncheck overlay makes
  on↔off instant; pruned against incoming blocks (parent state wins).

## Narrow-collapse contract (§3.2) — for M4-J

- The strip measures ITSELF (ResizeObserver on its own ul, contentRect.width =
  the container width). Mount it in a container that tracks the panel width
  (a plain slot div is fine).
- width < 480 → renders the single "Context N" summary button (N = blocks +
  pinned count) which fires onAddContext (picker stays reachable) and carries
  title "~N tokens total". width === 480 → expanded. No measurement yet →
  expanded (deterministic in jsdom: the vitest setup's ResizeObserver stub
  never fires; tests install a width-firing mock for the collapsed branch).

## Mounting contract — for M4-J

- Render ContextPopover as a direct child of the chat panel's POSITIONED root
  (relative/absolute), next to the strip. The anchor span inside it pins to
  `absolute top-12 right-3` (below the 48px header, 12px inset), align="end",
  sideOffset 8; Radix portals the card to document.body and collision-flips.
- Esc inside the popover is stopPropagation'd (§9: popovers close first — your
  panel-level Esc handler never sees the keystroke while the popover is open).
- Radix modal has no trigger to restore focus to: refocus the "Context N"
  header button inside onDone if you want the keyboard trail preserved.
- Wire: blocks = snapshot.blocks (active only — removed blocks are absent;
  the popover prunes its optimistic state against incoming blocks);
  totalTokenEstimate = snapshot.totalTokenEstimate; onToggleBlock(kind,on)
  flips the flag (re-collect via collectContextSnapshot; the executor already
  reports user-removed flags as "removed by user"); onRemoveAll clears every
  present flag; onAddContext and onDone both toggle your popover-open state
  (Done/Esc/outside-click all funnel through onDone — one dismissal path).
- Pinned chip token estimates are NOT in the snapshot (M4-C note): call
  estimateTokens(item) if you ever need per-chip numbers.

## data-testids (for M4-M E2E)

context-strip, context-chip-<kind>, context-chip-remove-<kind>,
context-pinned-<index>, context-strip-add, context-strip-summary,
context-popover, context-row-<kind>, context-toggle-<kind>,
context-pinned-list, context-pinned-remove-<index>, context-remove-all,
context-done, context-total.

## Tests (26, deterministic, real timers, ~1.5s)

- context-strip.test.tsx (12): chips per block + collector labels; trust-props;
  ✕ callback args + accessible names; + callback; pinned glyphs + display-only
  + chip counts; pinned-without-blocks; null rules (undefined + [] pinned);
  narrow collapse ("Context 4", chips absent, title, summary → onAddContext);
  480px boundary; no-measurement default.
- context-popover.test.tsx (14): dialog role/name; rows + "~420 tokens"…"
  "~1.2k tokens"; "1 image" frame row; on→off→on toggle args + checked flips;
  Remove all; Done; total line; Esc → onDone; outside click → onDone; focus
  trap (initial focus, Shift+Tab wrap, Tab wrap, 8×Tab containment); pinned ✕
  by index; pinned display-only without callback; no pinned section when
  absent/empty; block.data sentinel NEVER in the DOM; empty-context state.

## Deviations / notes

- Pinned chips display-only in the strip (brief's PIN); popover owns removal.
- Collapsed "Context N" is a button (fires onAddContext); visible text exact.
- The popover's "overlay" = Radix modal outside-dismissal layer, no painted
  scrim (§10 no-glass). Clicking anywhere outside the card dismisses → onDone.
- PINNED_GLYPHS duplicated in both component files (keep-in-sync comments) —
  M4-H owns exactly two paths; a shared module would need a third.
- role="dialog" comes from Radix PopoverContent (explicit attr dropped for
  biome a11y useSemanticElements; the tests assert getByRole("dialog")).
- Strip chips are ul/li (biome a11y); accessible name "Chat context, ~N tokens
  total" lives on the list — totalTokenEstimate's strip surface.
- Peers' concurrent syncs: M4-G2's sweep (91c21a5) carried my pre-fix
  intermediate state; my 5f9716d landed the final state and carried peers' next
  in-flight deltas per the add -A fleet pattern (tracked since M3-C).
- Gates at commit: typecheck 0 errors in my paths (repo-wide red only from
  M4-J's in-flight files); my tests 26/26; biome clean on all 4 files;
  full-suite spot-check 383/384 (the 1 failure = M4-J's in-flight chat-layer
  integration test).
