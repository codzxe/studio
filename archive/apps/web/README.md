# @studio/web — Next.js 15 App Router shell (W1-K)

Marketing site **and** product UI live in this one Next app (spec §16.2
option (a), ADR-0002 — one deploy). The browser never talks to the engine,
DB or Valkey directly: every backend call goes to the separate **gateway**
(spec §13) through the typed client in `src/lib/api.ts` (§3.1).

Wave-1 scope: app shell, config, health, marketing stub, placeholder auth
forms, gateway client + SSE helper. Everything else is tracked under
**Wave-8 TODOs** below.

## Layout

```
src/app/layout.tsx            root layout: metadata, base providers, tokens via globals.css
src/app/page.tsx              marketing home stub (§0 value prop; §16.2 TODOs below)
src/app/health/route.ts       { ok: true, service: "web" } — Docker healthcheck (§17.2)
src/app/(auth)/sign-in|up/    placeholder forms → gateway /v1/auth/* (TODO(W4))
src/app/providers.tsx         React Query provider (server-state layer for gateway calls)
src/app/globals.css           Tailwind v4 CSS-first tokens (no tailwind.config.js)
src/lib/env.ts                NEXT_PUBLIC_ env contract — zod, fail fast (§4)
src/lib/api.ts                gateway client: envelope→ApiError, Idempotency-Key, SSE
src/components/auth-form.tsx  client component boundary for the auth stubs
tests/api.test.ts             pure SSE-parser + client + resume/dedupe tests (vitest)
```

## Env

Copy the repo root `.env.example` to `.env` (chmod 0600). The web app reads
exactly two browser-visible vars (see `.env.example` → *Web section*):

| Var | Meaning |
|---|---|
| `NEXT_PUBLIC_APP_URL` | public origin of this app (metadata/sitemap wave) |
| `NEXT_PUBLIC_API_BASE_URL` | gateway base **including `/v1`**, e.g. `http://localhost:8787/v1` |

`src/lib/env.ts` is the one typed home for these (zod, fail fast at first
use — never at `next build`, so CI builds don't need secrets). Server-only
web env (PORT, Stripe publishable key, DB URL) belongs to `@studio/config`'s
`parseWebEnv` and is wired in Wave 4.

## Dev / build / verify

```sh
# at repo root, once:
pnpm install
cp .env.example .env   # then edit

pnpm --filter @studio/web dev        # http://localhost:3000
pnpm --filter @studio/web build      # output: 'standalone' → Docker §17.2
pnpm --filter @studio/web typecheck  # tsc --noEmit
pnpm --filter @studio/web test       # vitest (hermetic, no network)
pnpm --filter @studio/web lint       # biome check src
```

The standalone build output (`.next/standalone`) is what the future web
Docker image copies (§17.2 compose file — infra wave).

## Gateway transport contract (§13)

- Errors: both the flat `{ ok:false, code, message, hint, retryable,
  docs_url }` envelope (gateway W1-H / docs/AGENTS.md) and the nested
  `{ error: { … } }` shape (§13.3 sketch) are unwrapped into thrown
  `ApiError` (`src/lib/api.ts`) — reconcile to one shape in the contract wave.
- Mutating requests auto-generate an `Idempotency-Key` header (§13); pass
  `idempotencyKey` to reuse one across retries.
- Runs stream via `client.streamRunEvents({ runId, lastSeq, onEvent })`:
  `GET /v1/runs/:id/events`, dedupe by `seq`, resume with `Last-Event-ID`,
  terminal event stops the stream, exponential backoff reconnects (§13.2).
- The run-event wire schema in `api.ts` mirrors `@studio/config`
  `constants/events.ts` (§13.2). TODO(sync, contract wave): import
  `SSE_EVENT_SCHEMA` from `@studio/config` once TS-source workspace packages
  are wired into the browser bundle (`transpilePackages`) and Vitest aliases.

## Branding rules (§1.5)

`Layerly` is a **temporary neutral working name** — every occurrence carries a
`TODO(branding)` comment. Never put the forbidden names
(PhotoCraft/ArtCraft/Photoshop/Cursor) or the internal codename in
user-facing strings; marketing copy must keep the §16.2 truthfulness rules
(no competitor comparisons, no "unlimited", PSD stays "experimental", pricing
numbers only on a page that mirrors §14 exactly).

## Wave-8 TODOs (per §13 + §16.2)

Marketing build-out (§16.2 section order):
- [ ] hero: 20–40 s looping prompt→layered-result capture showing the
      **layers panel**, not just pixels
- [ ] "watch it build layers" proof strip
- [ ] template gallery with real outputs downloadable as `.pcraft`
- [ ] before/after: flat image vs editable layers
- [ ] pricing table mirroring §14 **exactly** ($30/$60/$120 + packs + credit
      cost per action, trial 30 credits, no card)
- [ ] FAQ (editable? PSD experimental? refunds? data usage?)
- [ ] security + privacy pages, changelog, footer with legal pages
- [ ] interactive demo: static wasm editor + capped demo-workspace agent runs
      (§18.4) with watermark + global kill switch
- [ ] plumbing: OG/meta images, `sitemap.ts`, `robots.ts`, favicon,
      no-cookie analytics (Umami/PostHog EU), public status-page link
- [ ] real CSP via nonce middleware; dark-mode token variant

Product UI (§13 surface):
- [ ] Wave 4: Better Auth client wiring (`better-auth/react`) replacing the
      `auth-form.tsx` fetch stub; protected app routes; workspace switching
- [ ] dashboard: documents list, create-from-template (§13.1 documents API)
- [ ] editor shell: layers panel, chat, run timeline driven by
      `streamRunEvents` (§13.2), undo/redo of whole runs
- [ ] versions timeline, comments, exports, credits/billing pages
      (Stripe publishable key via `@studio/config` `parseWebEnv`)
- [ ] `next/image` remotePatterns for gateway/S3 signed preview URLs
- [ ] typedRoutes: graduate `experimental.typedRoutes` to the top-level key
      once the Next pin moves ≥ 15.5
