# @studio/gateway

Hono API server (Node 22, TypeScript strict, ESM): REST + SSE surface of the
SaaS per spec **§13**. Stateless; scale horizontally (§3.1). This is the **W1-H
skeleton** — health endpoints, middleware stack, typed error envelopes and the
bootstrap/shutdown lifecycle. Auth/workspace/document/run routers land in later
waves (see `src/routes/index.ts` TODOs).

## Run

There is **no build/dev runner wired yet** (CI verifies via
`turbo run typecheck/test`; the compose file arrives with the infra wave):

```bash
pnpm install                                   # once, at the repo root
pnpm --filter @studio/gateway test             # vitest — app.request(), no network
pnpm --filter @studio/gateway typecheck
pnpm --filter @studio/gateway lint
```

Production shape (§17.2): `infra/compose/docker-compose.yml` builds this app,
Caddy fronts it on 443, and the container is started from compiled output. For
local runs the same image listens on `0.0.0.0:8787`.

- **Liveness:** `GET /v1/health` → `{ ok, service, version, uptime_seconds }`
- **Deep health:** `GET /v1/health/deep` → runs injected probes (db, valkey,
  storage, engine pool, model providers); `503` when any is down. W1-H ships
  **stub probes** (`stub: true`) — TODO(W2+): wire real checks.
- **Sentry-less failure story:** SIGTERM/SIGINT → stop accepting → drain
  keep-alives → force-close after 10 s.

## Environment

Full matrix: **`.env.example` (ADR-0002)** — parsed once by
`packages/config`; a missing required secret makes the process refuse to start.
`src/index.ts` calls `parseGatewayEnv(process.env)` (verified W1-B contract:
`(env = process.env) => GatewayEnv`) as the fail-fast gate, then reads its
transport fields via a local Zod projection (`src/env.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_PORT` (fallback `PORT`) | `8787` | Listen port (behind Caddy in prod). |
| `LOG_LEVEL` | `info` | pino floor: trace/debug/info/warn/error. |
| `SERVICE_VERSION` | `0.1.0` | Reported by `/v1/health`. Local knob — **not yet in `.env.example`** (flag for the config wave). |

Bind host is the constant `0.0.0.0` (container); exposure is Caddy's job (§17.2).

## API contract

Authoritative source: **`docs/BUILD_PROMPT.md` §13** — endpoints (§13.1), SSE
event types (§13.2), error semantics (§13.3). Everything versioned under
`/v1`. Until a wave mounts a router, spec'd paths answer `501 not_implemented`;
non-`/v1` paths answer a typed `404`.

### Error envelope (AGENTS.md code style)

```json
{ "ok": false, "code": "validation_failed", "message": "…", "hint": "…", "retryable": true }
```

Stable `code` strings, human-safe `message`, optional `hint`/`docs_url`,
`retryable`, and `details[]` on `validation_failed`. Stack traces and internal
ids go to **logs only**. Note: §13.3 sketches a nested `error: { … }` wire shape
while AGENTS.md mandates the flat `ok:false` envelope — this skeleton ships the
flat shape; the API-contract wave must reconcile before the public docs ship.

## Layout

```
src/index.ts             bootstrap: env fail-fast, pino, listen, graceful shutdown
src/app.ts               buildApp(deps) — pure factory (app.request()-testable)
src/env.ts               transport-env Zod projection (hermetic; no side effects)
src/types.ts             shared Hono AppEnv (requestId + request logger on context)
src/middleware/          request-id · logger (redaction list) · error-mapper
src/routes/              health (liveness + injectable deep probes) · /v1 registry
tests/app.test.ts        vitest: health, request-id, envelopes (404/422/501/500/503)
```
