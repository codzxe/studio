# components/comments — canvas review comments (W8-H)

Spec anchors: §12.1 `comments` (x/y canvas px, `resolved_at`, presence-light),
§15.2 RBAC ("viewer (read + comment)"), §19 Phase 3 ("comments with
positions, notifications"). UI mounting rides the editor panels built by
**W8-F** (@studio/ui `Panel` + `PanelContent`).

## Files

| File | Job |
|---|---|
| `comments-panel.tsx` | Thread list (author · body · time · resolve/reopen), new-comment composer (≤ 2000 chars, live counter), "Show resolved" filter toggle. |
| `comment-pin.tsx` | `CommentPinOverlay` (pins + drag placeholder + click-to-place surface) and `CommentPin`. |
| `use-comments.ts` | `useComments` / `useAddComment` (optimistic + rollback) / `useResolveComment`; the wire schemas + expected endpoints. |
| `comment-utils.ts` | Pure math/validation/time helpers (coordinate model lives here). |
| `comment-utils.test.ts` | Table-driven vitest for the above (deterministic, no network, node env). |

## ⚠ Status flag — the API does not exist yet (schema-only)

§13.1's endpoint table has **no comments routes**, and
`apps/gateway/src/openapi.ts` has **no comments paths at all** — the W4-O
audit's `x-studio-status` vocabulary (`implemented` | `wired-in-W4-R` |
`partial` | `not-implemented`) never even gets to name them, so the honest
flag is **PARTIAL-beyond-the-audit's-vocabulary: schema-only**.
`docs/devlog.md` records it verbatim: *"comments table in schema (`4800ccf`
W1-D — no routes yet)"*.

Until the gateway wave lands, the hooks target this expected contract
(`use-comments.ts` mirrors it in zod — the gateway routes must mirror those
schemas and add the §13.1 + OpenAPI rows):

```
GET  /v1/documents/:id/comments          → { ok: true, comments: CommentDto[] }
POST /v1/documents/:id/comments          → { ok: true, comment: CommentDto }
     body { body ≤ 2000, x ≥ 0 int, y ≥ 0 int }   (Idempotency-Key auto)
POST /v1/comments/:id/resolve            → { ok: true, comment: CommentDto }
     body { resolved?: boolean = true }           (false reopens)
```

`CommentDto` = the shipped DB row (`packages/db/src/schema/content.ts`) plus
an optional `author_name` the gateway is expected to join from the auth user
table (no user-lookup endpoint exists, §13.1). Unknown extra fields (a
future `thread_id`, §12.1's sketch) are stripped, not fatal. **Open
decisions for the gateway owner:** resolve permission (assumed here: any
commenter, i.e. viewer+; §15.2 pins "read + comment" only) and the resolve
route shape chosen above.

## W8-F wiring (the contract this folder exposes)

The **editor** owns three pieces of transient state — `placementMode`,
`pendingPosition`, `activeCommentId` — and mediates panel ↔ overlay:

```
┌ editor (W8-F) ─────────────────────────────────────────────┐
│                                                            │
│  <PanelContent>            canvas viewport (relative)     │
│   <CommentsPanel            <CommentPinOverlay …/>        │
│     documentId              comments  ← same useComments   │
│     pendingPosition ──────▶ onPlace() → set pendingPosition│
│     onStartPlacement ─────▶ (toolbar "comment" → mode on)  │
│     onCancelPlacement ◀──── Esc / Cancel button           │
│     activeCommentId ⇄───── onSelectComment                │
└────────────────────────────────────────────────────────────┘
```

Placement flow: panel "Add a comment" → `onStartPlacement()` → editor sets
`placementMode` → user clicks/drags the canvas → overlay `onPlace({x, y})`
(canvas px, clamped) → editor stores it as `pendingPosition` and clears
`placementMode` → panel composer opens → "Post" → `useAddComment` → list and
pins update together (both render the same React Query cache entry,
`commentsQueryKey(documentId)` — the optimistic insert and its rollback
move both views atomically). Escape at any placement moment →
`onCancelPlacement()`.

Mount rules:

- `CommentPinOverlay` renders `absolute inset-0` — mount it directly inside
  the canvas viewport wrapper so it is **the same box as the displayed
  canvas** at any zoom/size (percentage positioning depends on it).
- Outside placement mode the overlay surface is `pointer-events-none` — it
  never steals canvas interactions; pins re-enable pointer events per pin.
  In placement mode the surface becomes a focusable `role="button"`:
  **Esc cancels; Enter/Space places at canvas center** — the interim keyboard
  affordance (fine-grained keyboard placement is W8-F's to add).
- The panel is chrome-agnostic; wrap it in W8-F's `PanelContent`.
- Everything here is `"use client"` and must run under the root
  `Providers` (React Query) — already mounted in `app/layout.tsx`.

## Coordinate model (defined in `comment-utils.ts`)

DB stores **canvas px** (`comments.x/y` int + `documents.width_px/height_px`);
the overlay is zoom-agnostic via fractions clamped to **[0, 1]**:

```
f  = (pointer − rect.origin) / rect.size      ← clamped per axis
px = round(f × canvasSize)                    ← wire shape (POST body)
style left/top = f × 100 %                    ← pin render position
```

Pins survive zoom/resize/remount; pointer capture keeps drags tracking
outside the surface while the clamp pins the ghost to the canvas edge.

## Notifications (§19 Phase 3) — interim

Comment fan-out is designed for the realtime layer (§16.2: "SSE first",
Centrifugo for "comment notifications"), which has no comment events yet.
`useComments({ refetchIntervalMs })` (exposed as a panel prop) is the
stopgap; when realtime lands, invalidate `commentsQueryKey(documentId)` on
the document channel and drop the polling option.

## Tests

`comment-utils.test.ts` covers the pure logic (clamps, round-trips, body
validation, relative time) and runs in vitest's default node environment.
Component/hook tests need jsdom + @testing-library — **not in
`@studio/web` devDependencies today** (package.json is outside W8-H
ownership); flagged for the web package owner.
