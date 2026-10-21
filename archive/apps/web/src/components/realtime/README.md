# components/realtime — presence + activity feed (W8-R)

Spec anchors: §3.1 `realtime` row ("Centrifugo (optional at start; SSE
first)"), §16.2 (SSE fallback first), §19 Phase 3 ("Presence via Centrifugo
(cursors optional), run sharing, workspace activity feed").

## v1 boundary — READ THIS BEFORE EXTENDING

**This folder ships presence and notifications ONLY.** Spec §25 rule 3 is
explicit: *"Do not build CRDT collaboration in v1. Server-authoritative
command log; presence and comments only. Revisit after beta."*

In scope (v1):  who is viewing a document (roster + join/leave), and a
read-only workspace activity feed.

**Out of scope — deliberately not built:**

- ❌ **Cursors** (mouse pointers on canvas). §19 marks them "optional"; v1
  ships without them.
- ❌ **Collaborative painting / CRDT / OT / yjs** — document edits stay
  server-authoritative; presence data never feeds document state.
- ❌ **Presence-gated editing** (locking, "X is editing this layer") — the
  roster is display-only.
- ❌ **Comment notifications** — the fan-out channel lands with the gateway
  realtime wave (see W8-H's comments README "Notifications (§19) interim").

## Files

| File | Job |
|---|---|
| `../../lib/realtime/presence.ts` | The seam: `PresenceClient` interface (`subscribe`/`unsubscribe`/`destroy`), `CentrifugoPresence` (CDN dynamic import, no dep added), `SseFallbackPresence` (poll-based), `NoopPresenceClient`, `createPresenceClient()` mode auto-selection, zod pins + pure roster helpers. **All gateway contracts live in that file's header.** |
| `presence-bar.tsx` | Avatars (initials) of who's viewing, "you" ring + `(you)` label, `+N` overflow, inline join/leave toasts (aria-live). Pure presentational. |
| `use-presence.ts` | React glue: owns the default client's lifecycle (lazy env read, destroy on unmount), exposes `{ members, lastDelta, status }`. Injected clients are caller-owned and never destroyed here. |
| `activity-feed.tsx` | Recent workspace events (runs finished, exports ready, members joined). Pure presentational + the SSE wiring TODO. |
| `activity-model.ts` | Pure mappers + wire pins: §13.2 run events → rows, expected audit-tail route → rows, `mergeActivity` (dedupe/newest/cap), relative-time bands. |
| `activity-model.test.ts`, `../../lib/realtime/presence.test.ts` | Vitest, node env, deterministic (<5 s), no network — fake fetch + fake timers (SSE impl) and injected loader fakes (Centrifugo impl). |

## Transport selection

```
NEXT_PUBLIC_REALTIME=centrifugo|sse|off     (unset → "sse", §3.1 "SSE first")
NEXT_PUBLIC_CENTRIFUGO_URL=wss://…           (required for centrifugo mode)
NEXT_PUBLIC_API_BASE_URL=http://…/v1         (existing; SSE heartbeat base)
```

`createPresenceClient()` resolves lazily (first subscribe — never at render,
per the W1-K env contract):

- `off` → `NoopPresenceClient` (reports `disabled`, emits nothing).
- `sse` (default) → `SseFallbackPresence` — heartbeat poll (below).
- `centrifugo` → `CentrifugoPresence` when `NEXT_PUBLIC_CENTRIFUGO_URL` is
  set, else the SSE poll client (config-level fallback). At runtime the
  `centrifuge` module comes from a CDN via a guarded dynamic import
  (`webpackIgnore`/`turbopackIgnore` — **no `centrifuge` entry is added to
  package.json**); if that import or the transport fails, every channel
  degrades to `SseFallbackPresence` and status reports the fallback
  (`state: "error"` once, then SSE's own statuses).

### SSE fallback contract (routes TODO(gateway))

```
POST   /v1/documents/:id/presence/heartbeat   → 200 { ok: true, viewers: PresenceViewerDto[], ttl_ms? }
       body {} · session cookie · Idempotency-Key: stable UUID per subscription session
DELETE /v1/documents/:id/presence/heartbeat   → 204 best-effort leave (server TTL covers crashed tabs)
PresenceViewerDto = { id: string, name?: string | null, self?: boolean }
```

zod mirrors: `presenceHeartbeatResponseSchema` / `presenceViewerSchema` in
`lib/realtime/presence.ts` — **the gateway routes must mirror these and add
§13.1 + OpenAPI rows.** One round trip per tick (default 10 s; floor 1 s);
recommended server TTL ≈ 2–3 × the interval.

### Centrifugo configuration (infra — §3.1 realtime row)

Infra owns the service (`infra/compose/docker-compose.yml` — add a
`centrifugo` service per §3.1; client is MIT, server per repo licenses).
Needed so `CentrifugoPresence` works as designed:

- **Namespace `doc`** (channel format `doc:<documentId>`, from
  `documentPresenceChannel`): enable `presence: true` and `join_leave: true`
  so the client gets snapshots (`presence()` RPC) and join/leave events.
- **Connection tokens**: the durable contract is gateway-minted JWTs —
  TODO(gateway): `GET /v1/realtime/centrifugo/connection-token`. v1 accepts
  a static dev `token` option only, so local Centrifugo can run tokenless.
- **Client URL**: `NEXT_PUBLIC_CENTRIFUGO_URL`
  (e.g. `ws://localhost:8008/connection/websocket`).
- The `centrifuge` JS client is loaded from
  `https://cdn.jsdelivr.net/npm/centrifuge@4/+esm` (pin in
  `CENTRIFUGE_CDN_URL`) — the structural v4 surface the code relies on is
  mirrored in `lib/realtime/presence.ts` (`CentrifugeLike` …). The import is
  covered only by injected-fake tests; the first live smoke test belongs to
  infra when the compose service lands.

## Wiring (W8-F / dashboard)

Presence bar (editor topbar):

```tsx
const { members, lastDelta } = usePresence({
  channel: documentPresenceChannel(documentId),
  selfId: session.user?.id ?? null,
});
<PresenceBar members={members} selfId={session.user?.id ?? null}
             selfName={session.user?.name} lastDelta={lastDelta} />
```

Activity feed (dashboard): merge the two sources and render —

```tsx
<ActivityFeed events={mergeActivity([runRows, auditRows])} />
```

`runRows` come from the existing §13.1 run stream (`client.streamRunEvents`,
W1-K) via `runEventToActivity`; `auditRows` from the audit-tail route above
via `auditEntryToActivity`. Full SSE wiring steps: the TODO note in
`activity-feed.tsx`.

## Tests

`presence.test.ts` + `activity-model.test.ts` are pure logic (node env, fake
fetch/timers, injected loaders — no network, no CDN). Component tests for
the two `.tsx` files need jsdom + @testing-library — **not in `@studio/web`
devDependencies today** (package.json is outside this task's ownership);
same flag as W8-H.
