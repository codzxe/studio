# @studio/ui

Dark cinematic design system for **Studio** — the implementation of
`docs/UI_DESIGN_SYSTEM.md`. Tokens, Tailwind v4 theme mapping and the core
component library. **Dark-only** (v1), **standalone** (never imports app code),
semantic-token driven (no raw hex in components).

- Tokens: `src/styles/tokens.css` (palette §3.1, semantic §3.2, type §4.2,
  spacing §5.1, radii §5.3, elevation §5.4, motion §6, chat §9)
- Tailwind mapping + base layer: `src/styles/theme.css`
- Signature utilities (`.frame-line`, `.slate`, `.hero-atmosphere`, `.tabular`,
  `.scrollbar-thin`, `.text-balance`) + keyframes: `src/styles/utilities.css`

## 1. Wiring it into the app (the CSS contract)

The app consumes this package as **workspace source** (no build step). In the
app's `globals.css`:

```css
@import "tailwindcss";
@import "@studio/ui/src/styles/theme.css";
@source "../../../../packages/ui/src"; /* adjust relative to your css file */
```

- `theme.css` imports `tokens.css` and `utilities.css` itself — that **single**
  `@import` line is the whole contract.
- The `@source` line is required: Tailwind v4 skips `node_modules` during source
  scanning, and under pnpm the workspace package is symlinked from
  `node_modules/@studio/ui`. Point `@source` at the real path
  (`packages/ui/src`) so every utility used by our components is generated.
- This gives the app the semantic utilities used throughout the components:
  `bg-page bg-app bg-panel bg-elevated bg-input`, `text-primary text-secondary
  text-muted text-disabled`, `border-border border-subtle border-strong`,
  `text-signal text-signal-ink text-ice text-success text-warning text-danger`,
  `rounded-xs rounded-sm rounded-md rounded-lg rounded-pill`,
  `font-display font-sans font-mono`,
  `text-display-xl … text-title-m text-body-l text-body text-body-s text-label
  text-caption text-mono text-hint`,
  `shadow-pop shadow-modal`, `bg-overlay`,
  `duration-120 duration-180 duration-240`, `ease-out ease-in-out`,
  and the `animate-*` entrance/exit utilities Radix states hook into.
- Spacing uses Tailwind's default 4px numeric scale, which is identical to the
  doc's §5.1 scale (4→`p-1`, 8→`p-2`, … 128→`p-32`). The `--space-*` custom
  properties exist for raw CSS only; we deliberately do not remap
  `--spacing-*` (that would silently break default semantics).

### Selections, focus, scrollbars, reduced motion

`theme.css` also installs the base layer:

- `body` defaults: `bg-app`, `text-primary`, Instrument Sans at `body` size.
- `:focus-visible` → 2px `signal` outline, 2px offset (§12). Never set
  `outline: none` in app code.
- Default border colour for any `border-*` width utility = `--border` (§5.4).
- `::selection` = signal fill with `signal-ink` text.
- Scrollbars: 8px, `ink-3` thumb, transparent track (§9).
- `prefers-reduced-motion`: transforms/animations removed globally (§6.2).

## 2. Fonts (loaded by the app, referenced by tokens)

The package never loads fonts itself. It defines three CSS-variable stacks
(§4.1):

```css
--font-display-stack: "Instrument Serif", Georgia, serif;
--font-sans-stack:    "Instrument Sans", system-ui, sans-serif;
--font-mono-stack:    "JetBrains Mono", ui-monospace, monospace;
```

In the app, load the faces with `next/font/google` and override the three
stacks — this is the **font contract**:

```tsx
// app/layout.tsx
import { Instrument_Serif, Instrument_Sans, JetBrains_Mono } from "next/font/google";

const display = Instrument_Serif({ subsets: ["latin"], display: "swap", variable: "--font-instrument-serif" });
const sans = Instrument_Sans({ weight: ["400", "500", "600"], subsets: ["latin"], display: "swap", variable: "--font-instrument-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], display: "swap", variable: "--font-jetbrains-mono" });

// <body className={`${display.variable} ${sans.variable} ${mono.variable}`}>
```

```css
/* globals.css — after the theme.css import */
:root {
  --font-display-stack: var(--font-instrument-serif), Georgia, serif;
  --font-sans-stack: var(--font-instrument-sans), system-ui, -apple-system, sans-serif;
  --font-mono-stack: var(--font-jetbrains-mono), ui-monospace, "SF Mono", monospace;
}
```

`next/font` guarantees no layout shift (§15). Use `font-display` for short
headings only; never weight 300 on dark (§4.3).

## 3. Components

`Button`, `Input`, `SearchInput`, `Textarea`, `Select*`, `Field`, `Card`,
`ProjectCard`, `Tabs*`, `Dialog*`, `ConfirmDialog`, `Popover*`, `Menu*`,
`Tooltip*`, `Toast*`, `Badge`, `StatusDot`, `RiskBadge`, `Table*`,
`CommandPalette`, `CreditMeter`, `EmptyState`, `Skeleton`, `Spinner`,
`FrameLine`, `Slate`, `Avatar`, `Kbd` — all named exports from `@studio/ui`.

```tsx
import { Button, ProjectCard } from "@studio/ui";

<Button variant="primary" size="md">Create project</Button>
<ProjectCard
  name="Launch film"
  duration="00:12"
  comps={3}
  updated="Updated 2h ago"
  stagger={40}            // §6.3 slate shuffle: parent passes index * 40
  onOpen={() => router.push(`/w/projects/${id}`)}
/>
```

Conventions:

- **Semantic tokens only.** No raw hex, no gradients (the single
  `hero-atmosphere` radial on the landing hero is the one exception).
- **Status is never colour-only** — every status surface pairs an icon and a
  label (`StatusDot`, `RiskBadge`, toast variants, `CreditMeter`).
- **Icons**: `lucide-react` at 16/20/24, `strokeWidth 1.75`, no emoji.
- **Icon-only buttons** require `aria-label` + a tooltip (§10).
- Radix primitives carry focus trapping, roving focus, Esc handling, type-ahead.
- One primary (signal) action per view (§3.1).

## 4. Tests & checks

```sh
pnpm --filter @studio/ui test        # vitest (jsdom + @testing-library/react)
pnpm --filter @studio/ui exec tsc --noEmit
pnpm --filter @studio/ui lint        # biome
```

## 5. Component examples & accessibility coverage (M9-A)

**Examples.** Every one of the 23 primitives ships a Storybook-style example
gallery beside its source: `src/components/<name>.example.tsx`. Each is a
single-file, default-exported showcase rendering canonical usage of every
variant / size / state in a token-styled wrapper — documentation-as-code: a
developer reads one file to see every state. Examples are typecheck-only
docs: the package tsconfig picks up all `.tsx` (so they must typecheck
clean) while the vitest include pattern (`src/**/*.test.{ts,tsx}`) never
matches them, so they do not run as tests. They are not exported from the
package entry (`src/index.ts`) and never ship to the app.

**Accessibility floor (what is covered here, honestly).** The spec
(`docs/UI_DESIGN_SYSTEM.md` §7) says "Every component has a Storybook-style
example and an axe test." Full **axe-core scans are CI-owed**: the
`@axe-core/*` devDependency is **not installable on this build box** (the
no-install environment law, `docs/AGENTS.md` — dependencies are pinned and
installing is forbidden), so the on-box floor is unit-level a11y assertions
in each `<name>.test.tsx`: semantic roles, `aria-*` wiring
(`aria-describedby` / `aria-invalid` / `aria-required` / `aria-expanded` /
`aria-selected` / `aria-disabled`), accessible names (labels above controls,
icon-only buttons carrying `aria-label`), keyboard journeys (arrows, Home /
End, Enter, Escape), focus behaviour, disabled states, and `data-state`
attributes (§15). A **Playwright + axe pass is specced for the CI wave**
(§16.4 "Axe clean") and must run against these components before M10.

Two jsdom limitations are covered by the app's Playwright e2e instead of
the unit suite: Radix Select's pointer-capture open path (keyboard open is
pinned in `select.test.tsx`) and Radix Tooltip's pointerleave close (Escape
close is pinned in `tooltip.test.tsx`).

