# @studio/ui

Presentational base kit for the web app — shadcn/ui-style accessible primitives (Radix
heads + full ownership of styles) paired with a CSS-variable design-token theme
(spec §16.3). TypeScript strict, ESM, React 19. No data fetching, no state libraries —
pure rendering + props in, pixels out.

## Usage

```tsx
import "@studio/ui/tokens.css"; // once, in the app root (or via your global CSS entry)
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@studio/ui";
```

Components: `Button`, `Input` (+ `useFieldIds`), `Label`, `Dialog` (Header/Footer/Title/
Description/Close/Overlay), `Panel` (Header/Content + `PanelResizeHandle`), `Tabs`
(List/Trigger/Content), `Badge` (+ `STATUS_BADGE_VARIANT` / `statusBadgeVariant`),
`Skeleton`, `Tooltip`, and the `cn()` class combiner.

`className` is always accepted and merged last — overrides win via `tailwind-merge`.

## Design tokens & theming

`src/tokens.css` ships a **neutral template default** palette. The **final palette —
including the single accent slot (`--accent`) — comes from the workspace's brand tokens
(spec §7.5)**; these defaults are only the fallback until a workspace sets its brand
tokens. To re-theme: override the custom properties at `:root` (e.g. inside a
`[data-workspace-theme]` block) — no component edits needed.

Colors are raw HSL channel triplets consumed as `hsl(var(--token) / <alpha-value>)`.
Map them once in the app's Tailwind config:

```ts
// tailwind.config.ts (app-side — the kit does not own a Tailwind config)
colors: {
  background: "hsl(var(--background) / <alpha-value>)",
  foreground: "hsl(var(--foreground) / <alpha-value>)",
  card: "hsl(var(--card) / <alpha-value>)",
  popover: "hsl(var(--popover) / <alpha-value>)",
  primary: "hsl(var(--primary) / <alpha-value>)",
  secondary: "hsl(var(--secondary) / <alpha-value>)",
  muted: "hsl(var(--muted) / <alpha-value>)",
  accent: "hsl(var(--accent) / <alpha-value>)",
  destructive: "hsl(var(--destructive) / <alpha-value>)",
  success: "hsl(var(--success) / <alpha-value>)",
  warning: "hsl(var(--warning) / <alpha-value>)",
  info: "hsl(var(--info) / <alpha-value>)",
  border: "hsl(var(--border) / <alpha-value>)",
  input: "hsl(var(--input) / <alpha-value>)",
  ring: "hsl(var(--ring) / <alpha-value>)",
},
borderRadius: { sm: "var(--radius-sm)", md: "var(--radius-md)", lg: "var(--radius-lg)" },
```

Dark mode is class-driven (`.dark`), with a `prefers-color-scheme: dark` fallback for
class-less embedding and a `.light` force-switch. The file also defines the radius scale,
the 4px spacing scale, the panel layout tokens (`--panel-width` etc.) and the Skeleton
shimmer keyframes.

## Run states → Badge

`STATUS_BADGE_VARIANT` maps every `agent_runs.status` value (spec §5.1 / §13.2 stream
aliases) to a Badge variant — non-terminal phases → `running`, `succeeded` →
`succeeded`, `succeeded_with_warnings` → `warning`, `failed` → `failed`, `queued` /
`cancelled` → neutral. `statusBadgeVariant(unknown)` degrades to the neutral variant, so
new statuses never break rendering:

```tsx
<Badge variant={statusBadgeVariant(run.status)}>{run.status.replace(/_/g, " ")}</Badge>
```

The map mirrors `RUN_STATUSES` from `@studio/db` by hand (kept dependency-free on
purpose) — update both sides if statuses change.

## Accessibility contract

- **Keyboard reachable, focus visible.** Every interactive element is a native control
  (or a Radix head) reachable via Tab with an enforced `focus-visible` ring.
- **Button:** `type` defaults to `"button"` (pass `"submit"` explicitly); disabled uses
  the native `disabled` attribute. Icon-only buttons (`size="icon"`) MUST pass
  `aria-label`.
- **Input/Label:** bind with `useFieldIds()` → `Label htmlFor={ids.inputId}`,
  `Input id=…` + `aria-describedby={ids.errorId}` when there is a message. Error
  styling is driven by `aria-invalid`.
- **Dialog:** focus trap, Escape-to-close, scroll lock and `aria-labelledby`/
  `aria-describedby` wiring come from Radix — always render a `DialogTitle` inside
  `DialogContent`.
- **Tabs:** arrow-key roving focus comes from Radix; render a `TabsContent` for every
  tab value.
- **Panel:** collapse toggle is a labelled button with `aria-expanded`/`aria-controls`;
  collapsed content is removed from the DOM (no hidden focus traps). The resize handle
  is a focusable `role="separator"` movable with ArrowLeft/ArrowRight — pointer-drag
  wiring is the layout's job (`onResize(deltaPx)` seam).

## Testing

`pnpm --filter @studio/ui test` (Vitest + Testing Library, jsdom — installed from the
lockfile by CI, not on dev boxes). `data-testid` convention: `ui-<component>[-qualifier]`,
e.g. `ui-button-save`, `ui-panel-layers` — pass `data-testid` like any other prop.

## Content rules

Visible strings rendered by this kit are user-facing product copy (e.g. the Dialog
"Close dialog" label). Never place third-party product names in any string here —
they are forbidden (spec §1.5). The `@studio` import scope is internal tooling naming
only, never user-visible.
