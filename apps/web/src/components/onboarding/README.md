# components/onboarding — the 5-minute first-success flow (§19 Phase 4)

Onboarding kit for the phase-4 goal: a new user goes from empty workspace to an
exported design in about five minutes, with a checklist, a guided spotlight tour,
and a one-click coffee demo (§24.1 worked example).

## Files

| File | What it is |
|---|---|
| `checklist-model.ts` | Pure step definitions, parse/serialize, progress math (tested) |
| `onboarding-storage.ts` | Injectable `SafeStorage`, persistence + same-tab sync event (tested) |
| `trial-grant.ts` | Step 0: GET `/v1/credits` trial-grant check (tested) |
| `use-first-success.ts` | React hook wiring storage + credits check + overrides |
| `first-success-checklist.tsx` | The 5-step card: progress bar, retry, celebration state |
| `tour-model.ts` | Tour steps, persisted tour state, spotlight geometry math (tested) |
| `guided-tour.tsx` | Spotlight overlay: 3 tooltips, keyboard a11y, dismissible |
| `demo-project.ts` | §24.1 constants, compose URL builder, POST /v1/documents seed (tested) |
| `demo-project-card.tsx` | "Try the coffee demo" card |
| `empty-workspace-state.tsx` | Big first screen: checklist + tour + demo + create button |
| `index.ts` | Barrel export |

## Checklist contract (5 steps)

Step 0 is the trial-credit grant (GET `/v1/credits`), step 1 is "Create
workspace" (auto-done: the user is inside one). Steps 2–4 are user actions that
persist in localStorage and are marked **on the page where the action happens**:

```ts
import { markChecklistStepDone } from "@/components/onboarding";

// compose page, after the first run is submitted:
markChecklistStepDone("first-prompt");
// export UI, after the first export job is created:
markChecklistStepDone("export-design");
```

`DemoProjectCard` already marks `"pick-template"` when the demo seeds. Hosts can
also pass completion overrides (real session signals win over storage):

```tsx
<FirstSuccessChecklist steps={{ "trial-grant": sessionCreditsLoaded }} />
```

Celebration fires once per browser profile
(`onboarding.checklist.celebrated.v1`), then the card self-hides.

## Guided tour contract — `data-tour` attributes

The tour targets elements by attribute; pages must add:

| Attribute | Page | Put it on |
|---|---|---|
| `data-tour="composer"` | `/compose` | The prompt composer box |
| `data-tour="timeline"` | `/runs/[id]` | The run timeline container |
| `data-tour="layers"` | document editor | The layers tree panel |

Mount `<GuidedTour />` on those routes (or once in the `(app)` layout) — tour
state persists (`onboarding.tour.v1`), so it resumes across client-side
navigation. If a target isn't on the current page, the tooltip dims the screen
and links to the step's route.

Positioning is pure CSS: fixed-position rectangles computed from the target's
bounding box (`tour-model.ts`), re-measured on resize/scroll and polled until
late-mounting targets appear. Keyboard: `Esc` dismisses (persisted), `←/→`
navigate, focus is trapped inside the tooltip and restored on close.

Restart it from any button via the remount pattern (`startPolicy="always"` +
`key` bump), as `EmptyWorkspaceState`'s "Show me around" does.

## Compose prefill URL — contract with the compose page (W8-D)

`buildComposeUrl()` produces:

```
/compose?template=instagram-post%403&brief=<percent-encoded §24.1 brief>
```

- `template` — template id, URL-encoded (`@` → `%40`)
- `brief` — free text, URL-encoded (`URLSearchParams` encoding, spaces → `+`)

The compose page should `useSearchParams()`, decode both, prefill the composer,
and mark `"first-prompt"` done on the first submitted run. `parseComposeUrl()` in
`demo-project.ts` is the reference reader for parity tests.

## Demo seed — POST /v1/documents

`seedDemoDocument()` POSTs `{ name, template: "instagram-post@3", project_id? }`
(§13 create shape) with same-origin credentials, then the card routes to the
compose prefill URL above. Failures are typed envelopes
(`{ ok: false, code, message, hint, retryable }`); the card disables itself while
seeding so double-clicks can't double-create. Pass `projectId` from the session
when available, and inject `createDocument` if you have a session-aware gateway
client (the default is plain `fetch`).

## localStorage keys (namespaced, user-profile-local)

- `onboarding.checklist.v1` — `{ "<step-id>": true }` for completed user steps
- `onboarding.checklist.celebrated.v1` — ISO timestamp, celebration shown
- `onboarding.tour.v1` — `{ status, stepIndex, dismissedAt?, completedAt? }`

Same-tab instances sync via the `onboarding:checklist-changed` window event;
cross-tab via the native `storage` event.

## Notes for other owners

- **Styling**: explicit Tailwind palette + `dark:` variants, no dependency on
  globals.css tokens — re-skin freely once the app token set settles.
- **Gateway**: `/v1/credits` may still be unimplemented; the checklist shows a
  subtle retryable "couldn't verify" state and accepts a `checkTrialGrant`
  override — wire the session hook's credits once the route lands.
- **Dashboard/`documents` owners**: render `<EmptyWorkspaceState />` when the
  document list is empty; `onCreateClick` should open your create-document
  modal (default button links to `/documents?new=1`).
- All tests are pure (no DOM, no network); fetch and storage are injected.
