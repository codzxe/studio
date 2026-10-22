# M4-A2 — model-entitlements read surface (work record)

Task ID: M4-A2 · Wave 1 · Status: COMPLETE (all gates green)

## What I built
End-to-end `GET /v1/models` entitlement read so the wave-2 model picker renders
from plan entitlements with zero hardcoding (M4-SEAMS Seam 1, read side):

1. `packages/contracts/src/routes/models.ts` (NEW) — `MODELS_RESPONSE_SCHEMA`
   (zod: `{ plan: PLAN_ID_SCHEMA, models: [{ id: MODEL_ID_SCHEMA, tier:
   enum(fast|smart|vision), use, creditsPer1kInput, creditsPer1kOutput }] }`)
   + `export type ModelsResponse = z.infer<…>`. Barrel line went in
   `packages/contracts/src/routes/index.ts` (`export * from "./models.js";`)
   because contracts re-exports routes via that file — NOT src/index.ts
   (deviation-1, anticipated by the brief).
2. `services/gateway/src/routes/models.ts` (NEW) — `modelsRoutes(deps)`:
   `requireAuth()` + `GET /v1/models` with `requireWorkspace("viewer")` →
   `resolvePlan(c.get("workspace").id)` (the plan.ts seam, used AS-IS) →
   `allowedModelsForPlan(plan)` filter over `MODEL_CATALOG` → `ok(c, { plan,
   models })` with descriptors cut down to the wire shape (`allowedPlans`
   never sent). Mount line in `services/gateway/src/app.ts`
   (`app.route("/", modelsRoutes(deps));`) because index.ts has no
   route-mounting code at all — all mounts live in buildApp (deviation-2).
3. `packages/api-client` — `response-schemas.ts`: `MODELS_RESPONSE_SCHEMA`
   (`satisfies z.ZodType<ModelsResponse>` pin, same pattern as
   CREDITS_SUMMARY_SCHEMA); `client.ts`: readonly `models: { list(options?:
   CallOptions): Promise<ModelsResponse> }` on ApiClient + impl via
   `impl.get("/models", undefined, MODELS_RESPONSE_SCHEMA, options?.signal)` +
   `export type { ModelsResponse };` (re-exported through the api-client barrel).
4. `services/gateway/tests/models.test.ts` (NEW, stub deps, no DB) — 6 tests:
   viewer lists; unauth → exact 401 AUTH_REQUIRED; unknown workspace → 404
   WORKSPACE_NOT_FOUND (§12.1); trial → exactly [studio-fast]; exact wire keys
   + no `allowedPlans` leak (string-level); real payload parses through
   MODELS_RESPONSE_SCHEMA (the api-client validator's contracts twin).

## Gates (verified green before AND after M4-A's runner WIP landed)
- contracts: typecheck 0 errors, 105/105 tests
- gateway: typecheck 0 errors, 48/48 tests (42 prior + 6 new) with
  `DATABASE_URL=postgres://studio:studio@127.0.0.1:5432/studio`
- api-client: typecheck 0 errors, 102/102 at my gate time (suite has since
  grown to 117 via other agents' files — still green)
- biome: all my files clean; PRE-EXISTING drift NOT mine: gateway `biome check`
  exits 1 from app.ts import-order/format nits (identical on HEAD, verified
  via stash) + ~15 other files; api-client's 8 noConsole = tests/_smoke.test.ts

## Fleet notes for the integrator
- My files were swept into commit **80c642a** (M4-D's git-sync, `git add -A`
  per fleet protocol); content verified identical to my tree (`git diff HEAD`
  empty for all 7 paths). My own git-sync carries the worklog + this record.
- Mid-gate race: M4-A was writing runner.ts/litellm/** while I gated; the
  brief gateway typecheck errors were ALL in their files (missing
  ./litellm/runner.js). After their runner landed, the full gate went green
  with both slices in-tree. Zero shared files.

## Wire contract for wave-2 (M4-G2 model picker, M4-J page integration)
`GET /v1/models` (auth cookie + `x-workspace-id` header, viewer floor) →
Ok envelope: `{ data: { plan: "trial", models: [ { id: "studio-fast",
tier: "fast", use: "Cheap planning, classification, quick edits",
creditsPer1kInput: 0.01, creditsPer1kOutput: 0.03 } ] } }`
- trial ⇒ exactly `[studio-fast]`; smart/vision filtered server-side.
- Client: `client.models.list(options?)` (AbortSignal via CallOptions);
  type `ModelsResponse` importable from `@studio/api-client` or
  `@studio/contracts`; `MODELS_RESPONSE_SCHEMA` exported from both.
- The chat POST (M4-A) enforces the same entitlements with
  `MODEL_NOT_ENTITLED` when `request.model` is set but not allowed — the
  picker's option list is exactly `models[].id`.
