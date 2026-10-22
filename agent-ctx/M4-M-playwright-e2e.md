# M4-M — Playwright E2E for the M4 chat loop (CI-owned)

Task: `apps/web/e2e/chat.spec.ts` + `apps/web/playwright.config.ts` +
`apps/web/e2e/README.md` (the CI boot recipe) + the `apps/web/tsconfig.json`
include/exclude edit (only the exclude array gained `e2e` +
`playwright.config.ts`). No devDep added on this box (no browsers, no dev
servers, no lockfile sync — CI owns that).

## What the suite proves (6 tests, sequential chromium)

1. **editor loads and chat opens** — `data-editor-phase="open"` → chat layer
   mounts; D-5 keyboard cycle via iframe focus + `ControlOrMeta+l`
   (floating→sidebar→collapsed), pill click back to floating.
2. **read-only agent answers** — sign-in as the seeded demo user, ask
   "What's on this comp?", Enter; asserts the MockRunner stream verbatim
   ("I'll rename that layer for you — it's a one-property change." /
   "Planning a single atomic batch so undo stays one step."), the
   `studio.get_context` tool card reaching `data-status="done"`, its expanded
   result naming comp "Main", the plan card (`data-applied="false"`, note
   "Apply arrives with M5 — this plan is a preview."), and **zero** Apply
   buttons anywhere (read-only proof).
3. **context chips reflect what is sent** — "Context 4" → popover rows
   (`Comp: Main`, `Playhead \d\d:\d\d.\d`) with `~N tokens` estimates, toggles
   checked, total line, Done closes.
4. **model picker respects the plan** — trial ⇒ exactly one locked
   `chat-model-option-studio-fast` (a div, `data-locked="true"`), the
   "Your plan includes this model" note, zero buttons in the popover, Esc
   closes.
5. **stop cancels a streaming run** — `test.skip` with the reason inline:
   the MOCK_MODEL runner completes in milliseconds (`yieldToStream` =
   setImmediate between events), so the Send→Stop window is unobservable;
   the unskip recipe (gateway pacing knob or real LiteLLM) is documented in
   the test body. No flaky test written.
6. **editor UI unchanged by the chat overlay** — two `toHaveScreenshot`
   baselines (chat-collapsed + chat-open states), the chat chrome masked
   (`chat-panel-layer` + `chat-collapsed-layer`), `animations: "disabled"`,
   `caret: "hide"`, `maxDiffPixelRatio: 0.01`, mouse parked mid-canvas.

## Boot architecture (why the config looks like this)

The browser talks same-origin `/v1/*` (Caddy fronts gateway+web in
production — infra/caddy/Caddyfile). The webServer command therefore boots
THREE things in one process group: an inline `node -e` reverse proxy (edge,
default :3100 — `/v1/*` → gateway :8787, rest → next dev :3000), the
gateway, and the web app, under `trap 'kill 0' EXIT TERM INT` for teardown.
**The edge pattern was smoke-tested live on this box**: routing + host
rewrite + 502-while-booting + unbuffered SSE (a 300ms-gapped event stream
survived the pipe at exactly 0.324s) + zero orphans after the group kill.

Env contract for CI (README §4): `APP_URL` = `NEXT_PUBLIC_APP_URL` = the
EDGE origin — better-auth signs URLs and checks origins against APP_URL,
and the local storage driver builds download URLs from it.

## The project-fixture bootstrap (README §3)

The seed's `.ecproj` placeholder bytes are NOT openable by the real engine
(`Project` serde requires `schema/settings/items/next_id`; the seed's
`{"format":"ecproj",...}` fails `from_json_repaired`). The README embeds a
~60-line Rust generator with path deps into the repo's vendored editor
crates (tracks the engine pin), round-trip-verified on THIS box against the
current pin (9db7f3b2): comp "Main" (1920×1080, Background solid + Headline
text layer), 3 items, 47,997 bytes,
sha256 `aec54404efd423674555df2388bbf8b0ed59f378dbb3e3fe20684c818351f91d`.
Output staged at
`services/gateway/.local/storage/workspaces/org_demo/projects/prj_demo/versions/ver_demo_{1,2,3}/project.ecproj`
(gateway cwd = services/gateway under `pnpm --filter`). The DB sha256/size
rows keep their placeholder values deliberately: immutable rows (§9.3) and
nothing in the open path re-verifies them.

## Auth deviation (documented in spec header + README §6)

The brief suggested fresh-user sign-up as primary; verified against the
product: a fresh sign-up owns NO workspace/project (the seed creates the
demo user's rows manually; `src/app/(app)/onboarding/` is empty), so no
editor URL is reachable for one. Implemented primary = the real `/sign-in`
UI form as the seeded demo user; sign-up-variant constraints + raw
session-cookie alternative documented.

## Gates (all green on this box)

- `pnpm --filter @studio/web typecheck` — 0 errors (the tsconfig exclude is
  the whole point; rerun clean after all files).
- `pnpm --filter @studio/web test` — 430/430 green, 35 files; my
  `e2e/chat.spec.ts` is NOT among them (vitest include is
  `tests/**/*.test.{ts,tsx}` + `src/**/*.test.{ts,tsx}` — different tree AND
  different suffix; no vitest.config edit needed — that file is not owned
  and not touched).
- biome — clean on all three owned TS/JSON files after `--write` (quote-style
  fixes in the config's embedded JS literals + the one-line exclude array).
- dev.log tail — only the sandbox's pre-existing `scandir /home/z/my-project/src/app`
  ENOENT noise (the auto dev server can't run this monorepo); nothing from
  this work.

## Test IDs used (verified against source before use)

editor-host(+data-editor-phase), editor-viewport, editor-iframe, chat-layer,
chat-slot(+data-chat-mode), chat-panel-layer, chat-collapsed-layer,
chat-header, chat-status(+data-phase), chat-close-button, chat-panel,
chat-collapsed-pill, chat-empty-state, chat-thread-list,
chat-composer(textarea aria-label "Message the agent"),
tool-card(+data-tool/data-status), tool-card-toggle, tool-card-details,
tool-card-result, chat-message(+data-role), plan-card(+data-applied),
chat-context-button, context-popover, context-row-<kind>,
context-toggle-<kind>, context-total, context-done, chat-model-button,
chat-model-popover, chat-model-option-studio-fast(+data-locked/data-active),
chat-model-locked-note + #sign-in-email/#sign-in-password.
