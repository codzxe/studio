# Web E2E — Playwright skeleton (W10-L)

Playwright home for the §21 E2E row (**docs/BUILD_PROMPT.md §21**):

> Sign-up → invite → upload → prompt → stream → preview → undo → chat edit →
> export; billing in Stripe test mode.

**Status: skeleton.** Selectors and gateway wire-shapes are documented
placeholders (§Selectors, §Assertable); every spec skips loudly — never fails —
while its dependency is missing.

## Layout

```
apps/web/e2e/
  playwright.config.ts    env-driven config: webServer (dev|standalone|custom|none), chromium default
  tsconfig.json            local-only; NOT part of apps/web `pnpm typecheck`
  fixtures/png.ts          zero-dep synthetic PNG generator (mirrors apps/mock-engine grayPng())
  helpers/gateway.ts       mock-mode reachability probe → skipIf
  helpers/auth.ts          UI sign-up driver + session-bootstrap note
  tests/onboarding.spec.ts      the §21 journey (mock mode)
  tests/billing-testmode.spec.ts Stripe test-mode plans + checkout redirect
```

## §Contract — the mock-mode requirement

This suite runs against **MOCK MODE ONLY**: the compose **`local` profile** =
gateway wired with **MockEngineAdapter** (engine → `apps/mock-engine`:
protocol-faithful NDJSON; `doc.render` returns the same 8×8 gray PNG this
suite uploads) + **NoopStripe** (`apps/gateway/src/services/stripe.ts` — the
dev/test seam; §4 fail-fast forbids it in production).

Current repo state vs that contract:

| Piece | State |
|---|---|
| `NoopStripe` billing seam | EXISTS (`apps/gateway/src/services/stripe.ts`, dev/test only) |
| `MockEngineAdapter` in the gateway | **OWED** — gateway has no engine-mock seam yet (W10-L grep) |
| compose `local` profile | **OWED** — compose has only `profiles: ["obs"]` today |
| worker mock knob | `MOCK_ENGINE=1` exists (`apps/worker/src/processor.ts`) — reference for the gateway seam |

**Owner flags:** the gateway/compose owner should add the `local` profile
(gateway + web + db + valkey, engine → mock-engine, billing → NoopStripe).
Until it exists, `probeGateway()` skips the journey with
`GATEWAY_SKIP_REASON` (default probe `E2E_GATEWAY_URL=http://localhost:3001`,
the §22 bridge-only port). Tests skipped ≠ green journey: enabling this suite
for real is a CI-milestone item, not a silent pass.

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `E2E_BASE_URL` | `http://localhost:3000` | web app origin under test |
| `E2E_GATEWAY_URL` | `http://localhost:3001` | gateway origin for the probe + skipIf |
| `E2E_WEB_COMMAND` | — | run any command verbatim as the web server |
| `E2E_WEB_STANDALONE=1` | — | serve `next build` output via `.next/standalone/server.js` |
| `E2E_NO_WEB_SERVER=1` | — | never spawn; BASE_URL already served (preview stack) |
| `E2E_BROWSERS` | `chromium` | extend to `chromium,firefox,webkit` |
| `CI` | — | forbids `.only`, 1 retry, strict webServer, list+html reporters |

## §Run — locally

`@playwright/test` is deliberately **NOT** in `apps/web/package.json`
(W10-L task rule: CI installs it; keeps the box install-free per AGENTS.md).
Ad-hoc local install (never commit the package.json change):

```bash
pnpm --filter @studio/web add -D @playwright/test   # local only — do NOT commit
pnpm --filter @studio/web exec playwright install chromium
# terminal 1: the mock-mode gateway (once the compose "local" profile exists):
#   docker compose --env-file ../../.env --profile local up -d
# terminal 2 — the suite (spawns `next dev` itself):
pnpm --filter @studio/web exec playwright test --config e2e
```

With no gateway running, only the web-only smoke runs; everything else skips
with the fix-it message.

## §Run — in CI

Suggested CI job (wire into `infra/ci-staged/ci.yml`; flagged for the CI owner)
against the preview compose stack (§21 CI row: "Playwright on a preview
compose stack"):

```yaml
- run: pnpm --filter @studio/web add -D @playwright/test
- run: pnpm --filter @studio/web exec playwright install --with-deps chromium
- run: pnpm --filter @studio/web exec playwright test --config e2e
  env:
    E2E_BASE_URL: http://localhost:3000      # or the preview stack origin
    E2E_GATEWAY_URL: http://gateway:3001      # compose service DNS
    E2E_NO_WEB_SERVER: "1"                   # the stack already serves :3000
```

License: `microsoft/playwright` is Apache-2.0 — already allowed by the §16
dependency table ("The full user journey in CI"); add the
`@playwright/test` row to `licenses.overrides.json`/`ATTRIBUTION.md` when the
devDependency lands for real.

## §Assertable — what runs without a live gateway

| Spec | Needs gateway? | Why |
|---|---|---|
| onboarding › "sign-up form renders" | **no** | pure (auth) shell render — the always-green smoke |
| onboarding journey (sign-up → … → export) | **yes** | auth posts to gateway `/v1/auth/*`; every later hop mutates via it |
| onboarding › run timeline | **yes** | SSE rows come from the gateway; offline state → skip, missing both → fail |
| billing › plans $30/$60/$120 | session only | plans fetch is route-mocked; the session still needs the gateway |
| billing › checkout redirect | session only | checkout fetch + stripe.com are route-mocked; session needs the gateway |
| billing › success/cancelled pages | session only | static (app) routes behind the auth gate |

`(app)` pages are session-gated, so **nothing** inside the (app) group runs
gateway-free; that is why the probe skips the whole serial describes rather
than individual hops.

## §Selectors — the `data-e2e` contract

Specs prefer these hooks; fallbacks are generic and brittle by design (so the
UI owner tightens them). Add to the web UI:

| Hook | Where | Used by |
|---|---|---|
| `workspace-create`, `workspace-name-input` | dashboard | journey step 2 |
| `asset-row` / `asset-card` | assets | journey step 3 |
| `prompt-input`, `prompt-submit` | compose | journey step 4 |
| `run-step` (one per streamed step) | run timeline | journey step 5 |
| `run-offline` / `timeline-offline` | run timeline | graceful-offline skip |
| `preview` (on the `<img>`) | run/compose | journey step 6 |
| `toast` | global toaster | undo toast |
| `chat-input`, `chat-reply`, `quick-edit` | run chat | journey step 8 |
| `export-dialog` | run/compose | journey step 9 |

## §Deferred

- **Invite hop** (§21 "→ invite →"): `POST /v1/workspaces/:id/invites` +
  `POST /v1/invites/:token/accept` (§13 API table) must mint a token first;
  then a spec can drive `/invite/[token]` (accept-invite card exists).
- **Session bootstrap** (`storageState`) — recipe documented in
  `helpers/auth.ts`; needs the Better Auth cookie shape confirmed.
- **Export file truth** (§20 #9 PNG + `.pcraft` hash-verified reopen) stays
  in the gateway integration layer; E2E only asserts the dialog opens.
