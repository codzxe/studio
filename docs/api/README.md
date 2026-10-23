# API documentation index

**The wire contract is `@studio/contracts`, and the typed browser client is
`@studio/api-client`** — those two packages (not this file) are the source of
truth. This page only points at them and records the invariants that hold
across every route. It was rewritten post-pivot by W5-08 (2026-10-23); the
pre-pivot version described `apps/gateway/**`, a flat `{ ok:false, … }`
envelope and `docs/BUILD_PROMPT.md` §13 — all superseded by the layout,
envelope and schemas below (see git history).

## Where the truth lives

| Surface | Source of truth |
|---|---|
| Per-route request/response Zod schemas | `packages/contracts/src/routes/*` (one module per domain: activity, api-keys, apply, assets, audit, billing, chat, comments, credits, invites, leases, me, members, models, presence, projects, renders, runs, settings, share, threads, versions, workspaces) |
| Route implementations (Hono) | `services/gateway/src/routes/*`, mounted by `services/gateway/src/app.ts` |
| Response envelope | `packages/contracts/src/envelope.ts` |
| SSE event union + run-state reducer | `packages/contracts/src/events.ts` |
| Error catalog + HTTP status map | `packages/config/src/errors.ts` (`ERROR_CATALOG`, add-only codes) |
| Typed browser client (ports + impls) | `packages/api-client/src/client.ts`, runtime validators in `response-schemas.ts`, SSE in `sse.ts`, test doubles in `fixtures.ts` |

Everything rides under `/v1/*` (auth mount excepted). No hand-written spec is
maintained in parallel: the Zod schemas above are the single source of truth,
and any generated OpenAPI document must be emitted from them, never typed by
hand (none exists yet — the publication milestone is still open).

## Envelope (§7.3 — exact)

Every `/v1` JSON response is wrapped by `packages/contracts/src/envelope.ts`:

- success → `{ "data": …, "meta"?: … }`
- failure → `{ "error": { "code", "message", "hint"?, "retryable", "requestId" } }`

`code` values are stable UPPER_SNAKE_CASE strings, **add-only** (never renamed
or reused): the envelope-level registry is `WIRE_ERROR_CODES` in
`envelope.ts`; the full catalog with default message/hint/retryable per code
and the code → HTTP status map live in `packages/config/src/errors.ts`
(`StudioError`/`ERROR_CATALOG`). Envelopes never carry stack traces, absolute
paths, object keys or internal ids — `message` is safe to show to any tenant.

## SSE (§7.4)

Chat runs stream from `POST /v1/threads/:id/chat` as an AI SDK UI stream;
product events ride as data parts typed by the `StudioStreamEvent` union in
`packages/contracts/src/events.ts`. Invariants:

- Events are ordered per run; every event carries `runId` and a monotonic
  per-run `seq` (the client reducer deduplicates by `seq`, so replays are
  idempotent).
- Reconnect with `Last-Event-ID`; the server replays from the run log.
- Client-side tool results are accepted only with the run token and only for
  the expected `toolCallId`.
- Cancel via abort; the run then settles `run.cancelled`.

The browser-facing client for all of this is `packages/api-client` (`sse.ts`
implements the transport; `fixtures.ts` provides deterministic test doubles).

## Auth & conventions

Session cookie (Better Auth, mounted at `/v1/auth/*`) or hashed, scoped,
revocable API keys (Bearer — minted/rotated via
`/v1/workspaces/:id/api-keys`, `services/gateway/src/routes/api-keys.ts`).
Every mutating endpoint takes an `Idempotency-Key` header; every repository
call is workspace-scoped first (cross-tenant looks like **404**, never 403).
Rate limits are per IP/user/workspace (`services/gateway/src/middleware.ts`).
Schema-validation failures map to `VALIDATION_FAILED` → HTTP 400
(`packages/config/src/errors.ts` `fromUnknown` on `ZodError`;
`services/gateway/src/errors.ts` carries the code → status table).
