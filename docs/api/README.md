# API documentation index

**Spec §13 is the contract.** Until the generated spec exists, this file is the only
pointer you need: `docs/BUILD_PROMPT.md` §13 (endpoints §13.1, SSE event types §13.2,
errors §13.3, "the public API is the agent API" §13.4) is authoritative for every
gateway route, status code and event name. Route implementations live in
`apps/gateway/src/routes/`; the error catalog + HTTP status map live in
`packages/config/src/errors.ts` (21 stable string codes); SSE event strings and their
Zod wire schema live in `packages/config/src/constants/events.ts`.

## OpenAPI (Wave 4)

The machine-readable OpenAPI 3 document is **generated, not hand-written**, and lands in
Wave 4 (§19 Phase 3 lists "Public API keys + docs + OpenAPI spec"; generation work is
scheduled with the docs/publication milestone). It is emitted from the same Zod schemas
the gateway validates with (single source of truth; no drift), validated in CI, and
published alongside the public docs site. Do not maintain a parallel hand-written spec
in the meantime — §13 is the contract.

## Error envelope (read this before writing a client)

Fleet law (`docs/AGENTS.md` code style) is the **flat** envelope:

```json
{ "ok": false, "code": "quota_exceeded", "message": "…", "hint": "…", "retryable": false }
```

`code` values are stable strings (`quota_exceeded`, `plan_limit`, `engine_unavailable`,
`text_overflow`, `invalid_slots`, `rate_limited`, …); optional `docs_url` and
`details` (field-level Zod problems) may be present. The gateway implementation
(`apps/gateway/src/middleware/error-mapper.ts`, W1-H) already ships this shape, plus a
`retryable` flag clients must respect for backoff.

> **Reconcile note (for the API-contract wave owner / gateway owner):** §13.3 sketches a
> *nested* envelope `{ error: { code, message, hint?, retryable, docs_url? } }`. The
> repo-wide code-style law and the landed gateway middleware use the flat `ok:false`
> shape. One of the two must be amended before the public API is documented externally
> (Wave 4): either §13.3's wire example is updated to the flat shape, or the gateway
> adds a response-transform layer. Also flagged: Zod validation currently maps to
> **422** `validation_failed` (W1-H) while §13.3 lists 400 for validation. Until then,
> clients should treat the flat envelope as de-facto and tolerate `error`-nested
> shapes never appearing in `/v1`.

## SSE (§13.2)

Run progress streams from `GET /v1/runs/:id/events`: backfill from `run_events` (per-run
`seq`), then live. 13 event types (exact strings — never rename):
`run.queued`, `run.started`, `run.plan`, `step.started`, `step.finished`,
`preview.updated`, `validate.report`, `critique.report`, `credits.reserved`,
`credits.charged`, `run.succeeded`, `run.failed`, `run.cancelled`.
Every event carries `{ seq, run_id, at, type, payload }`; clients dedupe by `seq` and
resume with `Last-Event-ID`. Types: `SseEventType` + `SSE_EVENT_TYPE_SCHEMA` +
`isSseEventType()` guard in `@studio/config`.

## Auth & conventions (§13 preamble)

Session cookie (web app) or hashed, scoped, revocable API key (public API); roles and
scopes per ADR-0003. Every mutating endpoint takes an `Idempotency-Key` header (or a
client UUID). Errors never leak internal identifiers, stack traces or absolute paths
(§13.3). Rate limits per IP/user/workspace (§15.2).
