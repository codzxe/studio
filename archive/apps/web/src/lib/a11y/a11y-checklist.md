# a11y checklist — the page contract (W8-S)

Every route/page in `apps/web` must satisfy this before review. Utilities live
in `src/lib/a11y/` (focus, keyboard, announce) and `src/lib/i18n/` (locale,
translation). Spec refs: §7 (template quality checks incl. `contrast>=4.5`),
§9.5 (logical layout), §10.2 (lang-suffixed variant names), §11.1 (validator
blockers), §16.3 (the ui kit).

## 1. Skip link (owned by the shell)

- The app shell (`components/shell/app-shell.tsx`) renders a **skip-to-content
  link as the first focusable element in the DOM**; pages must not remove or
  shadow it. The target `<main>`/landmark must exist and be reachable — one
  `<main id>` per route.

## 2. Keyboard reachability

- Interactive = native elements (`<a href>`, `<button>`, `<input>`, …).
  Custom widgets get `role` + `tabIndex={0}` — never a positive `tabIndex`.
- Every action works with keyboard alone: `Enter`/`Space` activate,
  `Escape` closes overlays and cancels placement modes, arrows move in menus
  (use `src/lib/a11y/keyboard.ts`: `isEnter`/`isEscape`/`isSpace`/`isTab`/
  `isArrowKey` — they normalize legacy key spellings).
- Modals/drawers/menus **trap and restore focus** via
  `createFocusTrap(container, { onEscape })` from `src/lib/a11y/focus.ts`
  (Dialog conventions: focus in on open, Tab cycles inside, focus returns to
  the trigger on close).
- No `console`-driven debugging in shipped paths; no focus outlines removed
  as a "style fix" (see §3).

## 3. Focus is visible — recommended tokens.css block (packages/ui owner)

W8-S does **not** own `packages/ui/src/tokens.css`. The ui owner should add
this block (or equivalent) so keyboard focus rings are always painted from the
`--ring` token:

```css
/* Keyboard focus ring — always visible for keyboard users (W8-S checklist §3) */
:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
}
/* Mouse/touch users keep the quiet look without losing keyboard rings. */
:focus:not(:focus-visible) {
  outline: none;
}
```

Notes: the ring must hit ≥3:1 non-text contrast against the surface behind it
(`--ring` vs `--background` in both `.dark` and light sets — currently passes);
never replace with `outline: none` alone.

## 4. Forms

- Every input has a `<label htmlFor={id}>` (or `aria-label` for icon-only
  controls); `placeholder` is never the only label.
- Errors are programmatically associated: `aria-describedby` + `aria-invalid`,
  message text from the i18n dictionary (`useT()`), user-safe (§15.2: no
  internal ids/paths/stacks).

## 5. Async states announce themselves

- Loading/saving/SSE run-status changes go through
  `<AriaLive>` (`src/lib/a11y/announce.tsx`): `polite` for progress/toasts,
  `assertive` only for errors that block work. Mount the region eagerly
  (empty) and stream content into it; render no children to clear.
- Loading states never steal focus; skeletons are decoration (`aria-hidden`).

## 6. Color contrast

- Body text/background ≥ **4.5:1**; large display text ≥ **3:1** — the same
  bar the template validator enforces (§7 checks `contrast>=4.5`; §11.1 blocker
  "Text/background contrast ≥ 4.5:1 for body, ≥ 3:1 for large display text").
- Prefer token pairs (`foreground` on `background`, `*-foreground` on its
  surface); be careful with `muted-foreground` on `muted` and brand accent
  overrides (§7.5) — re-check contrast when a workspace retheming lands.

## 7. Reduced motion

- No non-essential animation without a `prefers-reduced-motion` escape hatch.
  Recommended for `packages/ui/src/tokens.css` (ui owner):

```css
@media (prefers-reduced-motion: reduce) {
  .ui-shimmer {
    animation: none;
  }
}
```

- Page-level transitions/parallax must ship their own reduce query; the
  skeleton shimmer is the only token-level animation today.

## 8. i18n / logical alignment (§9.5, §10.2)

- Alignment is **logical** — `start`/`end`, never bare `left`/`right` (JSX:
  `ms-*`/`me-*`/`text-start`/`start-*`; CSS: `*-inline-*`). Physical sides only
  where a template explicitly needs them (§9.5 carve-out).
- User-visible strings come from `src/lib/i18n/messages.ts` via `useT()`
  (dictionary + `{var}` interpolation; missing keys fall back to `en`).
  Locale codes are the same identifiers as §10.2's lang-suffixed layer
  variants (`Headline — es` ↔ `es` bundle).
- `<I18nProvider>` keeps `<html lang>`/`<html dir>` in sync — don't hand-set
  those attributes per page.

## 9. Landmarks, headings, images

- One `h1` per route; no skipped heading levels; landmarks (`header`, `nav`,
  `main`, `aside`) used where the shell hasn't already provided them.
- Informative images get `alt`; decorative ones get `alt=""` + `aria-hidden`
  where appropriate.

**Owner notes for W8-S follow-ups (flagged, not owned here):**
`@studio/ui` tokens.css focus-visible + reduced-motion blocks (§3, §7 above),
`jsdom`/testing-library devDeps for component-level a11y tests, root
providers tree should mount `<I18nProvider>`.
