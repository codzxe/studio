# Studio UI Design System

Status: **accepted direction** · 2026-10-21 · Implementation not started

The visual target is a **dark, cinematic, editorial SaaS** — the polish of a film title
sequence, the clarity of a serious creative tool. It replaces the current generic
studio dashboard rather than restyling it.

> **Hard boundary:** this design system styles the **SaaS shell and the chat overlay**.
> It does **not** style EffectCraft's editor. The editor UI is frozen upstream. We do
> not inject CSS, change its theme, resize its panels, or “improve” its density. The
> chat is designed to sit naturally over the editor, not to recolour it.

---

## 1. Design principles

1. **Cinema, not dashboard.** The product is about motion, time and composition. The
   shell should feel like a title sequence: deliberate typography, deep blacks, one
   signal colour, and room to breathe.
2. **The work is the hero.** Project thumbnails, frames and renders get the colour and
   scale. Chrome stays quiet.
3. **One accent, used like a laser.** A single warm signal colour for action and state.
   No rainbow gradients, no neon-on-neon, no decorative glow.
4. **Editorial contrast.** A serif display face against a precise sans UI creates the
   film-poster feel without illustration or 3D blobs.
5. **Dense where it matters.** The editor and timeline are dense; the SaaS shell is
   spacious. Do not make the shell look like a spreadsheet.
6. **Motion with intent.** 120–240 ms, ease-out, transform/opacity only. No bounce
   except the agent’s streaming indicator.
7. **Honest surfaces.** Real screenshots and real renders, not fake UI mockups. No fake
   customer logos, no invented metrics, no “AI magic” copy.
8. **Accessible by default.** Contrast, focus, keyboard, reduced motion and touch
   targets are part of every component, not a later audit.

---

## 2. Brand direction

### 2.1 Name and voice

- `Studio` is the codename. The final product name is a token swap in
  `packages/config/brand.ts`; no component hardcodes it.
- Voice: concise, confident, specific. Short sentences. No hype.
- Say “project” and “composition”. Never “document”.
- Do not use EffectCraft, ArtCraft, PhotoCraft, Photoshop or Cursor in user-facing
  copy. Attribution lives in `ATTRIBUTION.md` and the licences page, not the UI.
- Avoid “AI-powered” as a headline. Show what the agent does instead.

### 2.2 Visual references (behaviour, not copying)

- Film title cards: large serif, generous negative space, one warm accent.
- Editorial magazines: rules, captions, asymmetric grids, strong hierarchy.
- Pro creative tools: dark neutral surfaces, precise 1px lines, restrained states.
- Not: generic AI SaaS gradients, glassmorphism, floating 3D orbs, purple-on-black,
  fake terminal windows, stock photos of people at laptops.

### 2.3 Signature elements

1. **The frame line.** A thin horizontal rule with a small timecode label used as a
   section divider (`00:00:12 — WORKFLOW`). It ties the shell to the timeline without
   pretending to be the editor.
2. **The signal dot.** A small accent dot for live/agent/recording state. Never a
   glowing orb.
3. **The slate.** A compact project card header with name, duration and comp count,
   like a film slate.
4. **Warm paper on carbon.** Warm off-white text on near-black surfaces; avoids the
   cold blue-grey of generic dashboards.

---

## 3. Colour

All colours are CSS variables in `packages/ui/src/styles/tokens.css` and mirrored in
Tailwind theme tokens. Components use semantic tokens, never raw hex.

### 3.1 Core palette

| Token | Hex | Use |
|---|---|---|
| `--ink-0` | `#070809` | Page background, editor surround |
| `--ink-1` | `#0C0E10` | App background |
| `--ink-2` | `#121517` | Panel / card |
| `--ink-3` | `#181C1F` | Elevated surface, hover |
| `--ink-4` | `#20262A` | Input, pressed |
| `--line-subtle` | `#232A2E` | Hairlines, dividers |
| `--line-strong` | `#333C41` | Focused borders, strong dividers |
| `--paper` | `#F3F0E8` | Primary text |
| `--paper-dim` | `#C9C6BE` | Secondary text |
| `--ash` | `#8E969C` | Muted text, metadata |
| `--ash-dim` | `#5E686E` | Disabled text |
| `--signal` | `#FF6A3D` | Primary action, live state, selection |
| `--signal-hover` | `#FF805C` | Hover |
| `--signal-press` | `#E8562B` | Pressed |
| `--signal-ink` | `#1A0B06` | Text on signal |
| `--ice` | `#8FD3E8` | Informational, links, focus alternative |
| `--success` | `#7BD88F` | Applied, saved, healthy |
| `--warning` | `#F2C14E` | Warning, credit low |
| `--danger` | `#FF6B6B` | Destructive, failed |
| `--violet` | `#B8A1FF` | Reserved for version/comment accents only |

**Rules**

- The accent is for **one primary action per view**. Do not use it for every link.
- Backgrounds stay within `ink-0..ink-3`; do not introduce blue-grey surfaces.
- No pure `#000` or `#FFF`. The warm paper is deliberate.
- No gradient text. No accent gradients. A single low-opacity radial atmosphere is
  allowed on the landing hero only.
- Status is never colour-only: pair with an icon and a label.

### 3.2 Semantic tokens

| Token | Value | Use |
|---|---|---|
| `--bg-page` | `--ink-0` | Page |
| `--bg-app` | `--ink-1` | App shell |
| `--bg-panel` | `--ink-2` | Cards, chat panel |
| `--bg-elevated` | `--ink-3` | Popovers, menus, hover |
| `--bg-input` | `--ink-4` | Inputs |
| `--text-primary` | `--paper` | Headings, body |
| `--text-secondary` | `--paper-dim` | Supporting copy |
| `--text-muted` | `--ash` | Metadata |
| `--text-disabled` | `--ash-dim` | Disabled |
| `--border` | `--line-subtle` | Default border |
| `--border-strong` | `--line-strong` | Hover/focus border |
| `--focus-ring` | `--signal` | Focus ring (2px offset 2px) |
| `--overlay` | `rgb(0 0 0 / 0.65)` | Modal scrim |

### 3.3 Contrast targets

- Body text on `ink-1`: ≥ 7:1.
- Metadata on `ink-2`: ≥ 4.5:1.
- Accent text on `ink-1`: ≥ 4.5:1; if not, use accent as a fill with `signal-ink`.
- Disabled text may be below 4.5:1 but must still be legible and never the only
  indicator of state.
- Test with APCA where possible; WCAG 2.2 AA is the floor.

---

## 4. Typography

### 4.1 Families

| Role | Family | Fallback | Notes |
|---|---|---|---|
| Display | **Instrument Serif** | Georgia, serif | Hero, section titles, large numbers |
| UI / body | **Instrument Sans** | system-ui, sans-serif | Buttons, nav, forms, chat |
| Mono | **JetBrains Mono** | ui-monospace | Timecode, code, keyboard keys |

Load with `next/font/google`, `display: swap`, subset latin. Self-host in production if
the licence/ops requires it. Do not commit font binaries without a licence file and
attribution.

### 4.2 Scale

| Token | Size / line-height | Use |
|---|---|---|
| `display-xl` | 72 / 0.95, tracking -0.03em | Landing hero only, desktop |
| `display-l` | 56 / 1.0, tracking -0.02em | Landing sections |
| `display-m` | 40 / 1.05, tracking -0.02em | Page titles |
| `title-l` | 28 / 1.15, tracking -0.01em | Panel titles |
| `title-m` | 20 / 1.25 | Card titles |
| `body-l` | 17 / 1.6 | Marketing body |
| `body` | 15 / 1.6 | App body |
| `body-s` | 13 / 1.5 | Dense UI, chat |
| `label` | 12 / 1.2, tracking 0.06em, uppercase | Overlines, table headers |
| `mono` | 12 / 1.5 | Timecode, code |

Rules:

- Display serif is for **short** headings, never body copy or long paragraphs.
- Do not use all-caps for sentences; only labels and timecode.
- Numbers in stats use tabular numerals (`font-variant-numeric: tabular-nums`).
- Max line length: 68ch for prose, 80ch for docs.
- No text smaller than 12px in the app; 11px only for keyboard hints.

### 4.3 Type colour and emphasis

- Headings: `text-primary`.
- Section overlines: `text-muted` + `label`.
- Accent words inside a headline: use `text-signal` sparingly, not a gradient.
- Links: `text-primary` with an underline offset 3px; hover `text-signal`.
- Never use font weight 300 on dark backgrounds; it thins out. Use 400/500.

---

## 5. Space, grid and shape

### 5.1 Spacing scale

`4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128`

- Base unit 4px.
- Component padding: 12–16px compact, 20–24px comfortable.
- Page gutters: 20px mobile, 32px tablet, 48px desktop, 64px wide.
- Marketing max width: 1200px; app max width: 1440px; prose max width: 720px.

### 5.2 Grid

- 12 columns desktop, 24px gutter.
- 8 columns tablet, 20px gutter.
- 4 columns mobile, 16px gutter.
- Asymmetry is allowed on marketing (7/5 or 5/7 splits), not in forms or tables.
- Do not center everything. Editorial layouts use a strong left edge.

### 5.3 Radii

| Token | Value | Use |
|---|---|---|
| `radius-xs` | 3px | Badges, keys |
| `radius-sm` | 6px | Inputs, buttons, tool cards |
| `radius-md` | 10px | Cards, popovers |
| `radius-lg` | 14px | Modals, large panels |
| `radius-pill` | 999px | Pills, avatars |

The editor has its own density; the chat panel uses `radius-md`. Do not use 24px+
rounded cards everywhere.

### 5.4 Borders and elevation

- Default: `1px solid var(--border)`.
- Hover: border `--border-strong`; no size change.
- Elevation 1 (popover): `0 8px 24px rgb(0 0 0 / .35)`.
- Elevation 2 (modal): `0 24px 64px rgb(0 0 0 / .55)`.
- Chat panel: elevation 2 + 1px border; no glass blur.
- Never use a coloured glow as elevation.

---

## 6. Motion

### 6.1 Timing

| Token | Value | Use |
|---|---|---|
| `motion-fast` | 120ms | Hover, press, focus |
| `motion-base` | 180ms | Menus, popovers, tab changes |
| `motion-slow` | 240ms | Sheets, page transitions |
| `ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Entrances |
| `ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | Moves |

### 6.2 Rules

- Animate only `transform`, `opacity`, `filter` (sparingly). Avoid animating layout.
- No page-load choreography that delays content. Hero type may fade/translate 8px once.
- Respect `prefers-reduced-motion`: remove transforms, keep opacity changes ≤ 100ms.
- Streaming text uses a blinking caret, not a typewriter animation.
- Toasts: slide 8px + fade, 180ms; auto-dismiss 5s, pause on hover.
- Never auto-play a heavy video on mobile; use a poster + play button.

### 6.3 Signature motion

- **Frame line draw:** 240ms scaleX from 0 to 1 on scroll into view, once.
- **Slate shuffle:** project cards reveal thumbnail with a 4px upward fade, 40ms stagger,
  max 8 cards.
- **Agent pulse:** a 1.2s opacity pulse on the signal dot while streaming; stops when
  done.

---

## 7. Components

All components live in `packages/ui`. They are headless Radix primitives + Tailwind +
CVA variants. Every component has a Storybook-style example and an axe test.

### 7.1 Button

| Variant | Use | Style |
|---|---|---|
| `primary` | One main action | Signal fill, `signal-ink` text |
| `secondary` | Supporting action | `ink-3` fill, 1px border |
| `ghost` | Toolbar/quiet | Transparent, hover `ink-3` |
| `danger` | Destructive | Danger fill or danger text + border |
| `link` | Inline navigation | Text + underline |

Sizes: `sm` 28px, `md` 36px, `lg` 44px. Icon-only buttons are 32/36px with a tooltip
and `aria-label`. Loading keeps width; spinner replaces icon, label becomes “Working…”.
Disabled uses `opacity: .45` and `cursor: not-allowed`, plus `aria-disabled`.

### 7.2 Input, textarea, select

- Height 36px (sm 32, lg 44); 8px horizontal padding; `radius-sm`.
- Background `--bg-input`; border `--border`; focus ring 2px signal at 2px offset.
- Labels above, 12px `label` style, not placeholder-only.
- Helper text 12px muted; error text danger + icon.
- Textarea min 3 rows, auto-grow in chat.
- Select uses a custom popover, not native on desktop; native on mobile is acceptable.
- Search input has a leading icon and `⌘K` hint.

### 7.3 Card

- Background `--bg-panel`, 1px border, `radius-md`, padding 20–24px.
- No drop shadow at rest; hover raises border and background one step.
- Project cards are the exception: thumbnail dominates, metadata below, hover reveals
  actions. Aspect ratio 16/9 for thumbnails; 4/3 for templates.
- Card title 16–18px medium; metadata 12px muted.

### 7.4 Tabs

- Underline tabs for page sections; pill tabs for filters.
- Active tab uses paper text + 2px signal underline; inactive muted.
- Keyboard: arrow keys move, Home/End jump, focus visible.

### 7.5 Dialog / sheet

- Radix Dialog. Scrim `--overlay`; panel `--bg-panel`, `radius-lg`, max width 560px
  (dialog) or 720px (large).
- Title 20px; description 14px muted; actions right-aligned, primary last.
- Mobile: bottom sheet with drag handle, max-height 90vh, focus trapped.
- Destructive dialogs require the action name, not just “OK”.

### 7.6 Popover / menu / tooltip

- Popover: `--bg-elevated`, 1px border, `radius-md`, 8px padding, elevation 1.
- Menu item height 32px; icon 16px; shortcut right-aligned in mono 11px.
- Tooltip: 250ms delay, 12px, `ink-4` background, paper text, no arrow (or a subtle
  one), never the only source of an accessible name.

### 7.7 Toast

- Bottom-right on desktop, above the chat if open; top-center on mobile.
- Variants: default, success, warning, danger.
- Title + optional description; one action max; close button.
- Never use a toast for an error that requires a decision; use an inline banner/dialog.

### 7.8 Badge / status

- 20px height, 6px horizontal padding, `radius-xs`, 11px uppercase label.
- Variants: neutral, signal, success, warning, danger, ice.
- Status dot + label for live states.
- Risk badges in chat: low = neutral/success, medium = warning, high = danger.

### 7.9 Table

- Header 12px uppercase muted; rows 44–52px; 1px dividers.
- Numeric columns right-aligned, tabular numerals.
- Row hover `--ink-3`; selected row has a 2px signal left border.
- Sticky header on long tables; horizontal scroll with a visible edge fade.
- Empty state inside the table body, not a separate blank page.

### 7.10 Command palette

- `Cmd/Ctrl+K` in the SaaS shell (not while the editor iframe has focus; the editor
  keeps its own shortcuts).
- 560px wide, top 20vh, search + grouped results, keyboard-first.
- Groups: Projects, Actions, Navigation, Help.
- Shows shortcut hints; `Enter` runs, `Esc` closes.

### 7.11 Credit meter

- A compact horizontal meter with used/included and a top-up CTA.
- States: healthy (ice/success), low (warning), exhausted (danger).
- Always show the numeric balance next to the meter; never colour-only.
- In the chat footer, show estimated run cost, not the whole balance.

### 7.12 Empty states

- One clear sentence, one primary action, one secondary link.
- Optional line illustration in 1px `--line-strong`; no 3D characters.
- Example: “No projects yet. Start from a composition or import an `.ecproj`.”

### 7.13 Skeletons

- Use only for content that is actually loading; no skeleton for the whole app.
- Background `--ink-3`, 1px radius, 1.4s shimmer at 6% opacity. Respect reduced motion.
- Preserve final layout dimensions to avoid shift.

---

## 8. Page-by-page design

### 8.1 Landing (`/`)

**Goal:** in five seconds, show that this is a serious motion tool with an agent that
edits real compositions.

```text
┌────────────────────────────────────────────────────────────────────┐
│  ◐ Studio        Product  Agents  Work  Pricing        Sign in  → │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│   MOTION, DIRECTED BY YOU                         [ live editor ]  │
│                                                                    │
│   A composition editor with an agent that understands              │
│   layers, keyframes and taste.                                     │
│                                                                    │
│   [ Start 14-day trial ]   [ Watch the 90s film ]                  │
│   Card required · Cancel anytime · No free tier                    │
│                                                                    │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  real editor capture / looping title-sequence demo         │   │
│   │  with chat overlay visible                                │   │
│   └────────────────────────────────────────────────────────────┘   │
│                                                                    │
│   00:00:01 — THE WORK                                              │
│   Frame-accurate timeline. Real layers. Editable output.           │
└────────────────────────────────────────────────────────────────────┘
```

Sections:

1. **Hero** — serif headline, one sentence, two CTAs, real demo. No gradient text.
2. **Proof strip** — short factual capabilities, not fake logos:
   “Keyframes · 3D · 306 effects · agent edits · version history”.
3. **The agent** — a three-step story: ask → review plan → apply/undo. Show real chat
   cards. Make the approval model visible.
4. **The editor** — full-bleed screenshot with callouts. Say “a full compositing
   editor, unmodified” — **never** use the upstream brand name in the marketing UI.
   Attribution lives in the licences page, not the hero.
5. **Workflow** — import → compose → animate → review → render.
6. **Collaboration** — comments, versions, presence. No fake avatars; use initials.
7. **Performance** — GPU-accelerated, browser-native, no install. Real numbers only.
8. **Pricing** — three plans + top-ups; no “free forever”.
9. **FAQ** — honest answers about browser support, file formats, data, models.
10. **Final CTA** — “Start the 14-day trial.” Card required.
11. **Footer** — product, resources, legal, licences, status, changelog.

Rules:

- Hero art is real product output, not a stylised fake UI.
- No autoplay audio. Video is muted, looped, ≤ 8s, with a pause control.
- Every claim has evidence or is removed.
- Mobile hero: 40px serif, full-width CTA, demo becomes a poster + play.
- LCP element is the headline or poster, never a heavy video.

### 8.2 Auth (`/sign-in`, `/sign-up`, `/invite/:token`)

Split layout: left 55% form on `--bg-app`; right 45% a single cinematic still or a
loop from the demo, with a thin frame line and a short quote. On mobile, the image is a
16/9 banner above the form.

- Heading: “Sign in to Studio.” / “Create your workspace.”
- OAuth buttons: Google, GitHub, full width, 44px, with brand marks in monochrome.
- Divider: “or continue with email”.
- Email + password; show/hide; forgot password.
- Sign-up: name, email, password, terms checkbox. No marketing opt-in pre-checked.
- Invite: show workspace name, inviter, role; accept/decline. If signed out, redirect
  back after auth.
- Error states inline, not toasts.
- Trial copy: “14 days free, then $29/mo. Card required today. Cancel anytime.”
- No social proof carousel on auth. One still is enough.

### 8.3 Workspace creation / onboarding

Three steps, one card, no wizard chrome:

1. **Workspace** — name + URL slug; availability check.
2. **Use case** — motion graphics, title design, social video, product film, other.
3. **Start** — “Create workspace” or “Start trial” (Stripe Checkout). Card required.

- Progress is a 3-segment line, not numbered circles.
- Skip is allowed for use case, not for workspace name.
- After creation, land on the dashboard with a “Create your first project” card.
- Do not ask for a credit card before the workspace exists; do it at trial start.

### 8.4 Dashboard (`/w`)

```text
┌────────────────────────────────────────────────────────────────────┐
│ ◐ Studio   Acme ▾        Search projects…        ⌘K     ◉ 3.2k cr │
├──────────────┬─────────────────────────────────────────────────────┤
│  Projects    │  Good evening, Alex                                 │
│  Assets      │  [ New project ]  [ Import .ecproj ]                │
│  Templates   │                                                     │
│  Renders     │  Recent                                             │
│  Activity    │  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│              │  │ thumbnail│ │ thumbnail│ │ thumbnail│            │
│  ─────────   │  │ Name     │ │ Name     │ │ Name     │            │
│  Settings    │  │ 00:12 · 3│ │ 00:08 · 1│ │ 00:30 · 5│            │
│  Billing     │  └──────────┘ └──────────┘ └──────────┘            │
│              │                                                     │
│  Usage       │  Templates  ·  Continue where you left off          │
│  ▓▓▓▓░░ 64%  │                                                     │
└──────────────┴─────────────────────────────────────────────────────┘
```

- Left rail 240px, collapsible to 64px; icon + label; active item has a 2px signal
  left border and `--ink-3` background.
- Top bar 56px: workspace switcher, search, credits, avatar. Sticky.
- Main: greeting (time-aware, but not cute), primary actions, recent projects,
  templates, activity.
- Project card: 16/9 thumbnail, name, `duration · comps`, updated time; hover reveals
  “Open”, “Duplicate”, “⋯”.
- Empty state: “No projects yet.” + “New project” + “Import `.ecproj`”.
- Loading: 6 skeleton cards, not a spinner.
- Error: inline banner with retry; keep the rest of the page usable.
- No giant stat cards at the top. Usage lives in the rail and billing.
- No fake “trending” or social feed.

### 8.5 Projects list (`/w/projects`)

- Table/grid toggle; default grid.
- Filters: All, Mine, Shared, Archived. Sort: Updated, Created, Name.
- Search with debounce; URL state for filters.
- Bulk select: move, archive, delete (danger dialog).
- Empty search: “No projects match ‘x’.” + clear filters.
- Pagination or infinite scroll with a “Load more” button; no janky auto-load.

### 8.6 Project detail / hub (`/w/projects/:id`)

Tabs: **Overview · Versions · Comments · Renders · Activity**.

- Overview: large preview (poster/frame), name, description, duration, comps, updated,
  owner; primary “Open editor”; secondary “Share”, “Duplicate”, “⋯”.
- Versions: timeline list with version number, label, author, time, size, “Restore”.
  Diff entry point. Restore is a new version, never a rewrite.
- Comments: list + filters (open/resolved, comp, author); click jumps to the editor at
  the anchor if it is open.
- Renders: queue/history with status, format, duration, credits, download.
- Activity: audit-style feed, grouped by day.
- Right rail: members with access, lease status (“Alex is editing”), asset count.
- If a lease is active, “Open editor” becomes “Open read-only” for others, with a
  “Request edit” action.

### 8.7 Editor (`/w/projects/:id/edit`)

**This page must not restyle EffectCraft.** Full-bleed editor, minimal outer chrome.

```text
┌────────────────────────────────────────────────────────────────────┐
│ ◐  Acme / Launch film   ·  Saved 12s ago      [Share]  [◉ 2]  [⋯] │  floating bar, auto-hide
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│              EffectCraft iframe — unmodified UI                    │
│                                                                    │
│                                                ┌────────────────┐  │
│                                                │ Chat overlay    │  │
│                                                │                │  │
│                                                └────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

- The editor is the page. No sidebar by default; no persistent SaaS nav.
- A **floating project bar** at the top-left (or top-center) shows workspace/project
  breadcrumb, save state, presence, Share, and a `⋯` menu. It auto-hides after 2.5s of
  pointer inactivity and returns on move/focus. It must not cover the editor's menu bar
  when visible; place it below the editor's top bar or make it a compact pill.
- A **floating back button** returns to the project hub after confirming unsaved
  changes.
- Chat floats bottom-right by default; sidebar mode shrinks the iframe.
- The editor's own menus, panels, timeline and shortcuts are untouched.
- Browser-level unsaved changes guard; autosave runs regardless.
- Read-only mode: a small “View only” badge; editor remains usable for inspection but
  mutations are blocked by the lease and gateway.
- Unsupported browser/GPU: full-page message with supported browsers and a static
  preview; do not trap the user in a broken canvas.
- Loading: dark frame with the project name, a thin progress line and “Preparing
  editor…”, then the editor. No fake skeleton of the editor UI.

**Absolute don'ts**

- Do not overlay a permanent top nav that reduces editor height.
- Do not inject a theme, CSS variables or fonts into the iframe.
- Do not hide or rearrange EffectCraft panels.
- Do not add a second timeline, toolbar or preview.
- Do not use a modal onboarding tour over the editor; use a dismissible coach mark in
  the chat only.

### 8.8 Billing (`/w/settings/billing`)

Sections:

1. **Plan** — current plan, renewal date, seats, model tier; “Change plan”.
2. **Credits** — balance, included/month, used this cycle, top-up packs, ledger link.
3. **Usage** — stacked bar by model/render/storage for the cycle; table by project.
4. **Payment** — card brand/last4/expiry, “Update card” (Stripe portal).
5. **Invoices** — table with date, amount, status, download.
6. **Cancel** — clear consequences and end date; no dark patterns.

- Trial banner: days left, card on file, “Manage”.
- Low credits: warning banner with “Buy credits”; never auto-charge a top-up.
- Past due: read-only banner with “Update payment”; work is never deleted.
- No fake “save 20%” unless the annual price is real and active.

### 8.9 Settings (`/w/settings`)

Left sub-nav: General, Members, Roles, API keys, Models, Preferences, Security, Audit,
Licences.

- **General:** name, slug, logo, default project visibility.
- **Members:** table with name, email, role, status, last active; invite dialog.
- **Roles:** explain owner/admin/editor/viewer; show what each can do.
- **API keys:** create with name + scopes + expiry; show once; revoke; last used.
- **Models:** default model, allow smart/vision, auto-apply toggle, credit alerts.
- **Preferences:** theme (dark only v1), reduced motion, chat layout reset.
- **Security:** sessions, 2FA (if Better Auth plugin enabled), SSO later.
- **Audit:** filterable log; export CSV.
- **Licences:** open-source notices, EffectCraft attribution, font licences.

### 8.10 Public share / review (`/s/:token`)

- Poster/frame, project name, author, duration.
- Video player with frame stepping and timecode.
- Comments panel (if the share allows comments); name/email required for guests.
- “Open in Studio” CTA for members; “Request access” for others.
- No editor UI for anonymous users in v1.
- Password-protected shares: a minimal gate, no marketing.

### 8.11 States and system pages

- **404:** “This frame doesn’t exist.” + back to projects. Keep it short.
- **500:** “Something broke on our side.” + request id + retry.
- **Maintenance:** status link, ETA if known, no fake countdown.
- **Offline:** “You’re offline. Your last saved version is safe.” + retry.
- **No WebGPU/WebGL2:** explain, link to supported browsers, offer a rendered preview.
- **Permissions:** “You’re a viewer in this workspace.” + request access.

---

## 9. Chat overlay styling

The chat is the one place where the SaaS shell sits directly on the editor. It must
feel native to the dark editor, not like a white card.

- Panel: `--bg-panel`, 1px `--border`, `radius-md`, elevation 2.
- Header 48px; context strip 32px; composer 96–160px; thread flexible.
- Font: Instrument Sans 13–14px. Code: JetBrains Mono 12px.
- User message: `--ink-3` surface, 8px radius, no bubble tail.
- Assistant: transparent, full width, 14px/1.55.
- Plan card: `--bg-elevated`, 1px `--border-strong`; high risk uses danger border.
- Primary Apply button: signal fill; Preview: secondary; Cancel: ghost.
- Tool cards: compact, 1px border, expandable; status icon left.
- Streaming caret: 6×14px signal block, 1s step blink.
- Scrollbar: 8px, `--ink-3` thumb, transparent track; visible on hover.
- Focus ring inside the panel uses the signal colour, 2px offset.
- The panel never uses backdrop-filter, transparency or a gradient border.

---

## 10. Iconography

- Use **Lucide** icons at 16/20/24px, stroke 1.75, round caps.
- Icons are functional, not decorative. Do not put an icon on every heading.
- Custom marks: project slate, agent sparkle, frame line, credit coin. Keep them
  geometric and 1px-stroke, matching Lucide.
- No emoji in UI. No mascots. No 3D icons.
- Every icon-only button has an `aria-label` and tooltip.

---

## 11. Imagery and video

- Use real project frames, renders and editor captures. No stock photography.
- Marketing stills are 16/9 or 2.39/1; use a thin 1px frame, no rounded phone mockups.
- Video: H.264/VP9, muted, loop ≤ 8s, poster, `playsinline`, pause control, reduced
  motion respected. Do not autoplay with sound.
- Thumbnails: WebP/AVIF, 16/9, max 640px wide, lazy loaded below the fold.
- Demo content must be original or public-domain; never personal photos or customer
  work without written permission.
- No AI-generated “art” in the marketing hero. Show the product.

---

## 12. Accessibility

- WCAG 2.2 AA minimum; target AAA for body text where practical.
- Full keyboard access: skip link, visible focus, logical order, no traps.
- Focus ring: 2px signal, 2px offset; never `outline: none` without a replacement.
- Hit targets: 44×44px on touch, 32×32px minimum on desktop.
- Forms: labels, descriptions, errors linked via `aria-describedby`; errors announced.
- Dialogs/sheets: focus trap, `Esc` closes, restore focus.
- Chat: `aria-live="polite"` for assistant messages; `role="log"`; stop button
  reachable; tool cards are buttons with `aria-expanded`.
- Motion: `prefers-reduced-motion`; no flashing > 3 Hz; no parallax.
- Colour: never the only indicator; test protanopia/deuteranopia.
- Zoom: usable at 200%; no horizontal scroll at 320px for the shell.
- Captions for demo video; transcripts for the launch film.
- Alt text for meaningful images; empty alt for decorative.

---

## 13. Responsive rules

| Breakpoint | Shell | Chat |
|---|---|---|
| `< 640` | Single column; bottom nav for 4 primary items | Full-height sheet |
| `640–1023` | Collapsed rail; 8-col grid | Bottom sheet, 70vh |
| `1024–1439` | 240px rail; 12-col grid | Floating or sidebar |
| `≥ 1440` | 280px rail optional; max 1440 content | Floating, max 720×900 |

- The editor is desktop-first. Below 1024px, show a “best on desktop” note but keep it
  usable.
- Tables become stacked cards below 768px, with labels for each value.
- Never hide the primary action on mobile; move it to a sticky bottom bar.
- Test at 320px, 390px, 768px, 1024px, 1280px, 1440px, 1920px.

---

## 14. Content and microcopy

- Buttons: verb + object (“Create project”, “Buy credits”, “Open editor”).
- Empty titles: sentence case, no exclamation.
- Errors: what happened, why, what to do. Include a request id for support.
- Credits: “credits”, never “tokens” in the UI. Tokens are an implementation detail.
- Plans: “Starter”, “Pro”, “Studio”; trial is a state, not a plan.
- Avoid “unlimited” unless it is contractually true.
- Numbers: `1,200` with commas; durations `00:12:04`; file sizes `12.4 MB`.
- Dates: `Oct 21, 2026`; relative time only for “Updated 2h ago”.

---

## 15. Implementation notes

- Tailwind config maps semantic tokens; no arbitrary hex in components.
- `class-variance-authority` for variants; `tailwind-merge` for overrides.
- Radix primitives for dialog, popover, menu, tabs, tooltip, select, toast.
- Use CSS variables for theme; dark is default and only theme in v1.
- `next/font` for fonts; no layout shift.
- Component files: `packages/ui/src/components/<name>.tsx`; stories and tests beside.
- Use `data-state` attributes for open/closed/active states.
- No component may import app code; the package is standalone.
- The chat overlay lives in `apps/web/src/components/editor/chat` and composes
  `packages/ui`, not the other way round.

---

## 16. Quality bar

Before a page is considered done:

1. Screenshot at 1440, 1280, 768 and 390; inspect at 100% and 200% zoom.
2. No layout shift on load; LCP < 2.5s on a throttled profile.
3. All interactive elements reachable by keyboard; focus visible.
4. Axe clean; contrast checked; reduced motion checked.
5. Empty, loading, error, offline and permission states designed.
6. No placeholder copy, fake data, lorem ipsum or dead links.
7. Real project names and renders; no stock photos.
8. Dark surfaces stay within the token palette; one accent per view.
9. Editor page screenshot compared with upstream EffectCraft: identical editor UI.
10. The page works with the chat closed and with the chat open.

---

## 17. What we are deliberately not doing (v1)

- No light theme. Dark is the product.
- No custom editor theme or reskin.
- No glassmorphism, neon glow, gradient text or 3D blobs.
- No marketing chatbot.
- No template marketplace.
- No fake social proof or invented usage numbers.
- No mobile editor; mobile is for review, comments and billing.
- No illustration system; type, frames and real work carry the brand.
