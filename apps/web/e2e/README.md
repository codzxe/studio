# `apps/web/e2e` — the M4 chat-loop E2E (CI-owned)

`chat.spec.ts` is the CI-side proof of the M4 chat loop (BUILD_PLAN §M4 task
7: *"open editor → ask 'what's on this comp?' → receive a correct summary"*):
a real browser, the real editor wasm dist (`/editor/`, committed under
`public/editor/`), the real gateway in `MOCK_MODEL=true` mode, the real
better-auth session — and the read-only agent answering through the mock
runner's deterministic stream.

`m5-agent-edits.spec.ts` is the §M5 task-8 companion (prompt → plan →
preview → apply → undo → redo) over the same boot recipe — **no extra setup
steps**: the high-risk leg cannot come from `MOCK_MODEL` (whose one plan is
low-risk by construction), so the spec installs its own scripted-gateway
leg via `page.route("**/v1/threads/*/chat", …)` and fulfills the SSE POST
with §7.4-exact frames; everything else (auth, editor, fixture project,
models, threads) stays real. Its apply → undo → re-apply journey is
`test.fixme` until the M5 thread-layer wiring lands (the spec header
documents the flip); the two ACTIVE scenarios + the editor-unchanged
baseline run on every CI pass.

`m7-collab.spec.ts` is the §M7 companion (comments journey, presence +
lease banner, the `/w/:slug/history` surface, the public `/s/:token` review
page, and the read-only editor state) over the same boot recipe **plus one
extra data-plane step — the share-link fixture (§10)**: the share page's
first read (`GET /v1/share/:token`) happens server-side in the RSC route, so
no browser-level scripted gateway can serve it. With the fixture rows the
whole public journey runs against the REAL gateway (password gate included).
Everything the single-member seed cannot produce is scripted at the browser
boundary with `page.route` in the spec itself (presence viewers, another
member's lease-state + request queue, the activity pages); everything else
is real gateway + Postgres. The spec adds **no screenshot baselines** and
needs no env or config changes.

`m8-renders.spec.ts` is the §M8 companion (the "Render…" dialog + history
drawer over the editor, the live estimate, the queue → poll → cancel →
download journey, and the `/w/:slug/history` Renders tab) over the same boot
recipe — **no extra setup steps, no new baselines, no env or config changes**.
No render worker runs on the CI browser box, so **every renders-API leg is
scripted at the browser boundary** (`page.route`, schema-exact §7.3 envelopes
that parse against the api-client's runtime validators: queue 201,
estimate 200/402/415, the query-stringed history list, the per-id poll,
cancel) — while the REAL queue → render → settle → download journeys (real
worker + real effectcraft-cli + real ledger) are proven at the gateway level
by `services/gateway/tests/render-e2e.test.ts`. Everything else in the spec
is real: sign-in, the editor wasm, the render region's lazy workspace +
project scope resolution (`/v1/me` + `/v1/projects`), the lease, and the
hub's version-pin resolution through the real versions timeline. Route-
matching note: Playwright glob patterns anchor at the end of the full URL
(query string included), so the `GET /v1/renders?projectId=…` list is matched
with a regex; the query-less routes use exact-path globs, and the estimate
route registers last (the most recently registered match wins).

`m9-visual.spec.ts` + `m9-axe.spec.ts` are the §M9 task-7 companions (the
M9.7 visual-QA harness): the §13 viewport sweep (320→1920) with screenshot
SMOKES — not baselines —, the no-horizontal-scroll gates at 320/390, the
200% zoom (deviceScaleFactor 2) and reduced-motion arms, an LCP/CLS
recording, and the guarded axe sweeps over the public marketing + auth
routes. They add NO new boot steps and NO new baselines: same recipe, same
env, same ports — plus ONE CI-owned devDep for axe (§11c). The
editor-unchanged baselines stay in chat/m5, untouched by the M9 wave.

It is **not runnable on the build-fleet box**: that box has no browsers and
no dev servers (docs/AGENTS.md), which is why `@playwright/test` is not a
devDependency there. `apps/web/tsconfig.json` therefore **excludes** `e2e/`
and `playwright.config.ts` from typecheck (excluded files are not checked,
so the suite stays typecheck-clean without the package), and the web vitest
config never picks the spec up (its `include` is
`tests/**/*.test.{ts,tsx}` + `src/**/*.test.{ts,tsx}` — this file is under
`e2e/` and a `.spec.ts`, so it matches neither pattern; no vitest config
change was needed). CI owns the devDependency, the lockfile sync and the
baselines — this README is the exact recipe.

---

## 1. One-time CI setup

### 1a. The devDep + scripts (CI-owned; do NOT sync the lockfile elsewhere)

```sh
pnpm --filter @studio/web add -D @playwright/test
```

Optional script entries for `apps/web/package.json` (the quality-bar
command `pnpm --filter @studio/web e2e` needs the first one):

```json
"e2e": "playwright test",
"e2e:headed": "playwright test --headed",
"e2e:update-snapshots": "playwright test --update-snapshots"
```

### 1b. Browsers

```sh
pnpm --filter @studio/web exec playwright install --with-deps chromium
```

Chromium only — the suite runs a single deterministic engine for the wasm
editor and the visual baselines (`projects: [{ name: "chromium" }]` in
`playwright.config.ts`).

---

## 2. Data plane

```sh
# PostgreSQL 17 on 127.0.0.1:5432 — compose (infra/compose) or scripts/dev-postgres.sh
pnpm db:migrate
pnpm db:seed          # demo user + workspace + project (idempotent)
```

The seed (`packages/db/scripts/seed.ts`) creates:

| Thing | Value |
|---|---|
| user | `demo@studio.test` / `demo-password-12345` (dev fixture creds) |
| workspace | `org_demo` ("Demo Workspace") |
| project | `prj_demo`, **slug `demo-project`** → editor at `/w/demo-project/editor` |
| versions | `ver_demo_1..3`, current = `ver_demo_3` |
| credits | 1,000 granted (the mock run reserves a few per test) |

Note: the grant is idempotency-keyed (replays, never re-adds) while every
chat run *commits* credits — a long-lived CI database eventually drains the
balance and tests start failing on `INSUFFICIENT_CREDITS`. Recreate the DB
(`pnpm db:migrate && pnpm db:seed` against a fresh volume) or re-grant
through the ledger before that happens.

## 3. Project fixture — the one custom step

The seed documents its `.ecproj` bytes as a placeholder the **engine cannot
open** (`{"format":"ecproj",...}` — the real `Project` serde needs
`schema`/`settings`/`items`/`next_id`; see `editor/crates/project/src/lib.rs`).
The editor would park on the load-failure banner, the chat would never mount.
So before the first run, stage **real, engine-verified project bytes** at the
seeded object keys of the gateway's local storage driver.

The generator below is ~60 lines of Rust built against the repo's **vendored
editor crates** (path deps — it tracks the engine pin for free) and
round-trips its output through `Project::from_json_repaired` before printing.
It produces a 1920×1080 comp **"Main"** with a `Background` solid and a
`Headline` text layer (the mock plan's rename target). Run it once:

```sh
REPO="$(pwd)"                       # repo root, on any CI box
mkdir -p /tmp/ecf-fixture/src
cat > /tmp/ecf-fixture/Cargo.toml <<'EOF'
[package]
name = "ecf-fixture"
version = "0.1.0"
edition = "2021"

[dependencies]
effectcraft-project = { path = "REPO_PATH/editor/crates/project" }
effectcraft-time = { path = "REPO_PATH/editor/crates/time" }
effectcraft-keyframe = { path = "REPO_PATH/editor/crates/keyframe" }
effectcraft-color = { path = "REPO_PATH/editor/crates/color" }
serde_json = "1.0.151"
EOF
sed -i "s|REPO_PATH|$REPO|g" /tmp/ecf-fixture/Cargo.toml

cat > /tmp/ecf-fixture/src/main.rs <<'EOF'
use effectcraft_project::build;
use effectcraft_color::Label;
use effectcraft_project::{Comp, ItemId, ItemKind, LayerSource, Project, Solid};
use effectcraft_time::{FrameRate, Tick};

fn main() {
    let mut p = Project::default();
    let folder: ItemId = p.add_item("Solids", Label::Blue, None, ItemKind::Folder);
    let mut comp = Comp::new(1920, 1080, FrameRate::FPS_29_97, Tick::from_seconds_f64(5.0));

    let solid = p.add_item(
        "Background",
        Label::Red,
        Some(folder),
        ItemKind::Solid(Solid { color: [0.07, 0.08, 0.10], width: comp.width, height: comp.height, pixel_aspect: 1.0 }),
    );
    let mut bg = build::layer(&mut p, &comp, "Background", LayerSource::Solid { item: solid }, (comp.width, comp.height), None);
    if let Some(prop) = bg.props.prop_mut("transform/position") {
        prop.value = effectcraft_keyframe::Value::Vec3([960.0, 540.0, 0.0]);
    }
    comp.layers.push(bg);

    let mut title = build::layer(&mut p, &comp, "Headline", LayerSource::Text, (comp.width, comp.height), None);
    if let Some(prop) = title.props.prop_mut("text/sourceText") {
        prop.value = effectcraft_keyframe::Value::Text(Box::new(effectcraft_keyframe::TextDoc {
            text: "Studio".into(),
            size: 120.0,
            ..Default::default()
        }));
    }
    if let Some(prop) = title.props.prop_mut("transform/position") {
        prop.value = effectcraft_keyframe::Value::Vec3([960.0, 540.0, 0.0]);
    }
    comp.layers.push(title);

    p.add_item("Main", Label::Yellow, Some(folder), ItemKind::Comp(comp.into()));

    let json = p.to_json();
    let (reparsed, notes) = Project::from_json_repaired(&json).expect("round-trip");
    assert!(notes.is_empty(), "repair notes: {notes:?}");
    assert_eq!(reparsed.to_json_compact(), p.to_json_compact(), "round-trip drift");
    let comps: Vec<String> = reparsed
        .comps()
        .map(|(id, _)| reparsed.items.get(&id).map(|i| i.name.clone()).unwrap_or_default())
        .collect();
    eprintln!("verified: comps={comps:?} items={} next_id={}", reparsed.items.len(), reparsed.next_id);
    print!("{json}");
}
EOF

(cd /tmp/ecf-fixture && cargo run --offline -q 2>fixture.log) > demo-project.ecproj
```

`--offline` works once the cargo registry cache is warm (any box that builds
the editor dist has it; drop the flag otherwise). Determinism check for the
output — recorded from a verified run against the current pin
(`9db7f3b2`, schema 2):

```text
comp "Main" · 3 items · next_id 66
47997 bytes · sha256 aec54404efd423674555df2388bbf8b0ed59f378dbb3e3fe20684c818351f91d
```

Stage the bytes at the seeded object keys (the gateway's local driver reads
`<cwd>/.local/storage/<key>`, and `pnpm --filter @studio/gateway dev` runs
with cwd `services/gateway`):

```sh
for v in ver_demo_1 ver_demo_2 ver_demo_3; do
  d="services/gateway/.local/storage/workspaces/org_demo/projects/prj_demo/versions/$v"
  mkdir -p "$d" && cp demo-project.ecproj "$d/project.ecproj"
done
```

Notes:

- `file.open` opens the comp automatically (`Session::replace_project` opens
  the first comp), so the chat's context collector reports **"Comp: Main"**.
- The `project_versions.sha256/size_bytes` rows keep the seed's placeholder
  values on purpose: the rows are immutable (§9.3), and nothing in the open
  path re-verifies them — `loadProjectSession` (apps/web/src/lib/editor-session)
  downloads via the signed URL and checks only that the file opens and the
  engine reports it as the open project.

## 4. Env

```sh
cp .env.example .env
# then set exactly these (the rest of the 34-var contract can stay as the template):
#
#   APP_URL=http://127.0.0.1:3100          # the EDGE origin — better-auth signs
#                                           # URLs + checks origins against it,
#                                           # and the local storage driver builds
#                                           # download URLs from it
#   NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100   # must match APP_URL (auth-client)
#   APP_ENV=local
#   MOCK_MODEL=true                        # MockRunner — deterministic answers
#   DATABASE_URL=postgres://studio:studio@127.0.0.1:5432/studio
#   AUTH_SECRET=$(openssl rand -base64 32) # ≥ 32 chars
#   GATEWAY_INTERNAL_URL=http://127.0.0.1:8787    # default is fine (RSC → gateway)
#
# LITELLM_* / S3_* / STRIPE_* / AUTH_GOOGLE_* etc. keep their template values:
# the env schema requires their presence, but MOCK_MODEL=true never contacts
# LiteLLM and APP_ENV=local falls back to the filesystem storage driver.

set -a; source .env; set +a               # no dotenv loader — export everything
```

The three ports (override if occupied — keep them consistent with APP_URL):

| Port | Process | Knob |
|---|---|---|
| **3100** | dev edge (`/v1/*` → 8787, rest → 3000) | `E2E_EDGE_PORT` |
| 3000 | `next dev` (apps/web) | `E2E_WEB_PORT` |
| 8787 | gateway (services/gateway) | `E2E_GATEWAY_PORT` |

## 5. Run

```sh
pnpm --filter @studio/web e2e          # or: pnpm --filter @studio/web exec playwright test
```

That's the whole boot: the config's single `webServer` starts the edge proxy
+ the gateway + `next dev` in one supervised process group (killed with the
run), waits for `http://127.0.0.1:3100/` to answer, then runs the suite
against `baseURL` = the edge. The suite is sequential (`workers: 1`),
retries twice on CI, and keeps traces/videos for failures.

### First run: baselines

The last test (`editor UI unchanged by the chat overlay`) needs two baseline
PNGs. Generate them on the first run and **commit** them:

```sh
pnpm --filter @studio/web e2e:update-snapshots
# → apps/web/e2e/chat.spec.ts-snapshots/editor-unchanged-chat-{collapsed,open}-chromium-<platform>.png
# → apps/web/e2e/m5-agent-edits.spec.ts-snapshots/editor-unchanged-m5-{readonly,journey}-chromium-<platform>.png
git add apps/web/e2e/chat.spec.ts-snapshots apps/web/e2e/m5-agent-edits.spec.ts-snapshots
```

The M5 spec's baselines follow the same policy/mask style: the ACTIVE
`editor-unchanged-m5-readonly.png` is taken after a plan-bearing read-only
run; `editor-unchanged-m5-journey.png` (chat chrome **and** the canvas
viewport masked — "editor unchanged outside the canvas area") is generated
alongside but only asserted once the fixme'd apply → undo journey flips
active.

Baseline policy:

- The chat chrome (panel layer + collapsed pill) is **masked** in the shots;
  everything else is the editor's pixels — any change to the editor's
  rendering (or the wasm pin) fails the suite in both states.
- WebGL output is GPU/driver-dependent: **baselines are per runner image**.
  Regenerate (`--update-snapshots`) when the CI runner image, the editor
  dist, or the design tokens change — and only then.
- `maxDiffPixelRatio: 0.01` absorbs benign antialias jitter; anything real
  exceeds it.

### 5b. Run-3 recipe — `E2E_BASE_URL=http://localhost:3000` (Next 16 dev-origin rule)

`next` is 16.4.2 (Turbopack) and its dev server treats **any origin other
than its own bind origin (`localhost:3000`) as cross-origin and silently
blocks the client bootstrap — pages never hydrate** (the run-2/run-3
"eye-toggle canary timed out" signature: React DevTools logs, chunks 200,
zero `__react*` keys on the document). `127.0.0.1` counts as cross-origin,
and the config's node edge (`:3100`, Host-rewritten) is cross-origin at any
port. Until `next.config.ts` grows `allowedDevOrigins` (app-code change,
Wave 3), boot the stack yourself and point the suite straight at `next dev`
— its own `/v1/:path*` rewrite (next.config.ts, W5-01) already proxies to
the gateway, so no edge is needed:

```sh
cd /home/z/my-project
# orphan cleanup (a previous run's gateway/next can hold :8787/:3000)
for port in 3000 8787; do pid=$(ss -tlnp "sport = :$port" | grep -o 'pid=[0-9]*' | head -1 | grep -o '[0-9]*'); [ -n "$pid" ] && kill -9 "$pid"; done

export DATABASE_URL="file:/home/z/my-project/.local/e2e.db" \
  APP_URL=http://localhost:3000 NEXT_PUBLIC_APP_URL=http://localhost:3000 \
  APP_ENV=local MOCK_MODEL=true GATEWAY_INTERNAL_URL=http://127.0.0.1:8787 \
  AUTH_SECRET="dev-local-secret-0123456789abcdef0123456789abcdef" \
  AUTH_GOOGLE_ID=replace-me AUTH_GOOGLE_SECRET=replace-me \
  AUTH_GITHUB_ID=replace-me AUTH_GITHUB_SECRET=replace-me \
  STRIPE_WEBHOOK_SECRET=whsec_replace_me \
  STRIPE_PRICE_IDS='{"starter":"price_starter","pro":"price_pro","studio":"price_studio"}' \
  LITELLM_BASE_URL=http://localhost:4000 LITELLM_API_KEY=sk-litellm-replace-me \
  ASSET_MAX_BYTES=524288000 PROJECT_MAX_BYTES=262144000 CHAT_MAX_STEPS=50

setsid bash -c 'cd /home/z/my-project && PORT=8787 corepack pnpm --filter @studio/gateway dev' >/tmp/e2e-gw.log 2>&1 &
setsid bash -c 'cd /home/z/my-project && corepack pnpm --filter @studio/web exec next dev --port 3000' >/tmp/e2e-web.log 2>&1 &
for i in $(seq 1 60); do curl -sf http://127.0.0.1:3000/sign-in >/dev/null && break; sleep 2; done

cd apps/web && E2E_BASE_URL=http://localhost:3000 corepack pnpm exec playwright test <spec> --reporter=line
# mint/refresh baselines: add --update-snapshots
```

`E2E_BASE_URL` switches the config to external-stack mode (the `webServer`
block is skipped — the caller owns the stack), and `localhost` (never
`127.0.0.1`) keeps Next's dev-origin check happy so hydration works. Keep
boot + test inside ONE shell invocation when the sandbox reaps background
processes between calls.

### Edge alternatives

- **Caddy (production shape).** `infra/caddy/Caddyfile` is the real edge;
  for CI, a minimal equivalent:

  ```caddyfile
  :3100 {
      handle /v1/* {
          reverse_proxy 127.0.0.1:8787 { flush_interval -1 }   # SSE: flush upstream bytes
      }
      handle {
          reverse_proxy 127.0.0.1:3000
      }
  }
  ```

  Run `caddy run --config <file> &` and start Playwright with
  `E2E_EDGE_PORT` matching; also use this variant if the editor ever needs
  top-level COOP/COEP (add a `header` block for `/`), which the node edge
  does not inject.

- **Hand-booted stack.** Start the three processes yourself; the config
  reuses a live edge (`reuseExistingServer: !CI`) — handy for `--headed`.

## 6. Auth in this suite

Primary (implemented, in the spec's `beforeEach`): the **real `/sign-in`
form** as the seeded demo user — better-auth email+password, session cookie,
`?next=` round-trip to the editor URL. This is a full UI auth flow; it is the
sign-*in* rather than the sign-up path for a structural reason:

- **Why not sign-up (documented deviation):** a freshly signed-up user owns
  **no workspace and no project** in this product — the seed creates the
  demo user's workspace/project rows explicitly, and workspace onboarding
  has no UI yet (`src/app/(app)/onboarding/` is empty). A fresh user cannot
  reach ANY editor URL, let alone the seeded one. Suites that want the
  sign-up flow must also drive workspace+project+version creation (M2/M6
  flows); this M4 suite targets the seeded project, so sign-in is the only
  first-run-ready UI path.

- **Raw session cookie (alternative, documented not implemented):** skip the
  form by minting the cookie once and adding it to the browser context:

  ```sh
  curl -si http://127.0.0.1:3100/v1/auth/sign-in/email \
    -H 'content-type: application/json' \
    -d '{"email":"demo@studio.test","password":"demo-password-12345"}'
  # copy the better-auth.session_token Set-Cookie value, then in the spec:
  # await context.addCookies([{ name: "better-auth.session_token", value, url: baseURL }]);
  ```

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| sign-in shows "That email and password combination doesn't match an account." | seed not run, or the gateway rejected the POST: `APP_URL` must equal the origin the browser uses (the edge), and `AUTH_SECRET` must be ≥ 32 chars on both sides of a restart. |
| `chat-model-button` stays disabled ("Model…") | `GET /v1/models` failed through the edge — check the edge is up on the `baseURL` port and the gateway answered (provider retries once, then hides the picker). |
| context rows read "… (unavailable)" | the fixture bytes were not staged (§3) or the editor never reached `data-editor-phase="open"` — check the wasm dist exists at `public/editor/`. |
| `ControlOrMeta+l` does nothing | focus must be INSIDE the editor iframe — the spec clicks it first. Chat shortcuts forward from the iframe's window (D-5), never from the page. |
| editor boots to the failure banner | `/editor/` not served (missing `public/editor/` dist) or COOP/COEP headers stripped by a custom edge — use the Caddy variant. |
| screenshot diffs on a new runner | expected: WebGL antialiasing is per-GPU. Regenerate baselines when the runner image changes (§ First run). |
| `webServer` timeout (240s) | cold Turbopack first compile + wasm download on a slow box; rerun, or hand-boot the stack (§5). |

## 8. Selector source map (every id the spec uses)

| testid / locator | Source (verified) |
|---|---|
| `editor-host` (+ `data-editor-phase`) | components/editor-host/editor-host.tsx |
| `editor-viewport`, `editor-iframe`, `chat-layer` | components/editor-host/editor-host.tsx |
| `chat-slot` (+ `data-chat-mode`) | components/editor-host/chat-panel-slot.tsx |
| `chat-panel-layer`, `chat-collapsed-layer` | components/editor-host/chat-panel-slot.tsx |
| `chat-header`, `chat-status` (+ `data-phase`), `chat-close-button` | components/chat/header.tsx |
| `chat-collapsed-pill` | components/chat/pill.tsx |
| `chat-empty-state`, `chat-thread-list` | components/chat/thread.tsx |
| `chat-composer` (textarea `aria-label="Message the agent"`) | components/chat/composer.tsx |
| `tool-card` (+ `data-tool`, `data-status`), `tool-card-toggle`, `tool-card-details`, `tool-card-result` | components/chat/tool-card.tsx |
| `chat-message` (+ `data-role`) | components/chat/message.tsx |
| `plan-card` (+ `data-applied`), plan note | components/chat/plan-card.tsx |
| `chat-context-button` ("Context N") | components/chat/header.tsx |
| `context-popover`, `context-row-<kind>`, `context-toggle-<kind>`, `context-total`, `context-done` | components/chat/context-popover.tsx |
| `chat-model-button`, `chat-model-popover`, `chat-model-option-<id>` (+ `data-locked`), `chat-model-locked-note` | components/chat/model-picker.tsx |
| `#sign-in-email`, `#sign-in-password` | components/auth/sign-in-form.tsx |

Mock-answer facts asserted by scenario 2 (all from
`services/gateway/src/runner.ts` `createMockRunner`, `MOCK_MODEL=true`):
deltas "I'll rename that layer for you — it's a one-property change." and
"Planning a single atomic batch so undo stays one step."; plan summary
"Rename the selected layer" (plan card is informational-only — M4.6: no
write tools, no Apply button anywhere); one `studio.get_context` call whose
result names comp "Main".

## 9. Boundaries recap (why nothing on the build-fleet box breaks)

- **typecheck**: `apps/web/tsconfig.json` `exclude` gains `e2e` +
  `playwright.config.ts` — the spec/config import `@playwright/test`, which
  is not installed there; excluded files are not type-checked. Everything
  else (`src/`, `tests/`, `next-env.d.ts`, `.next/types/**`) stays included.
  (Applies unchanged to `m7-collab.spec.ts` and `m8-renders.spec.ts` — they
  live under `e2e/` and are `.spec.ts` files, so they are excluded from
  typecheck and never matched by vitest.)
- **vitest**: `apps/web/vitest.config.ts` includes only
  `tests/**/*.test.{ts,tsx}` + `src/**/*.test.{ts,tsx}` — the spec
  (`e2e/chat.spec.ts`) matches neither the directories nor the `*.test.*`
  suffix, so the 384-test suite is untouched.
- **biome**: the web `lint` script covers `src tests` only, but the root
  `pnpm lint` parses everything — both new TS files are biome-clean.
- **package.json / lockfile**: untouched here, by design — CI owns the
  `@playwright/test` devDep + lockfile sync (§1a).

---

## 10. Share-link fixture (the `m7-collab.spec.ts` public journey)

`m7-collab.spec.ts` drives the real `/s/:token` page, whose **first read is
server-side** (the RSC route fetches `GET /v1/share/:token` through the
gateway seam — `page.route` can never see it). The seed creates **no**
`share_tokens` rows, so before the first run stage two fixture links for the
seeded project — one open, one password-protected. The tokens and the
password are pinned in the spec:

| Token (URL path)                       | Password         | Notes |
|---|---|---|
| `e2e-share-open-7f3d92b1c4`           | — (open link)    | never expires, never revoked |
| `e2e-share-locked-2a6e8d41f9`         | `review-pass-1234` | scrypt gate, verified by the real route |

The rows store ONLY `sha256(raw token)` and the gateway's own
`scrypt$salt$hash` format — exactly what `POST /v1/projects/:id/share-links`
would have written; nothing here invents a schema. Idempotent: re-running
keeps the existing rows (`ON CONFLICT (id) DO NOTHING`), and because the
password never changes, a re-run's fresh salt is irrelevant — the stored
(old-salt) hash keeps verifying the same password.

```sh
# from the repo root, with DATABASE_URL exported (§4)
cat > packages/db/scripts/share-fixture.ts <<'EOF'
import { createHash, randomBytes, scryptSync } from "node:crypto";
import postgres from "postgres";

const sha = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

const salt = randomBytes(16);
const passwordHash = `scrypt$${salt.toString("hex")}$${scryptSync(
  "review-pass-1234",
  salt,
  64,
).toString("hex")}`;

const rows = [
  { id: "shr_e2e_open", raw: "e2e-share-open-7f3d92b1c4", passwordHash: null },
  { id: "shr_e2e_locked", raw: "e2e-share-locked-2a6e8d41f9", passwordHash },
];

const sql = postgres(process.env.DATABASE_URL);
for (const row of rows) {
  await sql`
    INSERT INTO share_tokens
      (id, project_id, token_hash, password_hash, expires_at, revoked_at, created_by, created_at)
    VALUES
      (${row.id}, 'prj_demo', ${sha(row.raw)}, ${row.passwordHash}, NULL, NULL,
       (SELECT id FROM "user" WHERE email = 'demo@studio.test'), now())
    ON CONFLICT (id) DO NOTHING
  `;
}
await sql.end();
console.log("[share-fixture] ok (2 rows)");
EOF
pnpm --filter @studio/db exec tsx scripts/share-fixture.ts
rm packages/db/scripts/share-fixture.ts
```

Notes:

- The temp script lives inside `packages/db/scripts/` ONLY for module
  resolution (the `postgres` driver resolves from that package's
  node_modules) and is deleted right after — nothing is committed.
- `expires_at` is NULL, so the fixture never goes stale; revoke cleanup is
  unnecessary for CI databases recreated per pipeline (§2 note).
- The guest-comment and request-access posts in the spec write REAL rows
  (a `comments` row with `share_token_id`, a `share.request_access` audit
  row) — expected, harmless, and swept away with a fresh DB.

---

## 11. M9 visual QA (`m9-visual.spec.ts` + `m9-axe.spec.ts`)

The §M9 task-7 harness (BUILD_PLAN): the viewport sweep with screenshot
smokes, the no-horizontal-scroll gates, 200% zoom, reduced motion, axe, and
an LCP/CLS recording. The **editor-diff-vs-upstream** bullet is deliberately
NOT here — its pixel baselines are the `editor-unchanged-*` shots in
`chat.spec.ts` / `m5-agent-edits.spec.ts`, which remain the ONLY pixel
baselines in the suite and are not touched by the M9 wave.

### 11a. What runs

| Spec | Tests | What it proves |
|---|---|---|
| `m9-visual.spec.ts` | 22 | 8 marketing + 2 auth + 4 authed pages each swept at 320/390/768/1024/1280/1440/1920 (document answers < 400, surface testid renders, §13 primary action visible, full-page screenshot smoke at every width; hard no-horizontal-scroll gate at 320 + 390); a reduced-motion arm (3 pages × 390/1280: matchMedia took, theme.css §6.2 override collapses the frame-line animation, layout invariants hold); a 200% zoom spot-check (deviceScaleFactor 2 at 390 + 768); a landing LCP/CLS smoke (§11e) |
| `m9-axe.spec.ts` | 10 (skipped until §11c) | axe sweeps over the 10 public routes — zero WCAG 2.x A/AA violations, full JSON report attached per test |

Run just the M9 wave: `pnpm --filter @studio/web exec playwright test m9-`.

### 11b. The runner recipe — same boot, zero new env

Everything in §4/§5 applies unchanged: the same ports (3100 edge / 3000 web /
8787 gateway — `E2E_EDGE_PORT` / `E2E_WEB_PORT` / `E2E_GATEWAY_PORT`
overrides) and the same env set (`APP_URL`, `NEXT_PUBLIC_APP_URL`,
`APP_ENV=local`, `MOCK_MODEL=true`, `DATABASE_URL`, `AUTH_SECRET`,
`GATEWAY_INTERNAL_URL`). What each half needs on top:

| Half | Needs |
|---|---|
| marketing + auth sweeps, 200% zoom, reduced-motion, LCP/CLS, axe | nothing extra — no sign-in, no seed, no fixtures (`/status` probes the gateway health endpoint through the edge, which the standard boot provides) |
| authed sweep (`/w`, `/w/projects`, `/w/billing`, `/w/settings/members`) | §2's seed (sign in as `demo@studio.test` through the real `/sign-in` form — the m7 recipe's `signIn` helper). The §3 `.ecproj` staging and §10 share fixture are NOT needed: no editor, no share page |

**Wave-pending routes (honest note).** The authed sweep is written against
the route contract: `/w` (W2-03 §8.4 dashboard), `/w/projects` (W2-04 §8.5),
`/w/settings/members` (W2-06 §8.9) land with the W2/W3 wave; `/w/billing`
is live today (`billing-view`, plus W2-01's URL-preserving `(shell)` move
and W2-08's additive usage section). Running the suite BEFORE those siblings
land reds exactly those three tests with 404s — the documented mid-wave
state, not a harness bug.

**First-run expectation — the 320px gate.** The no-horizontal-scroll gate at
320/390 encodes §12/§13, not a guess about the current chrome: on-box px
math suggests the marketing header's CTA pair (`Sign in` + `Start trial`)
may overflow 320px. If CI confirms, the fix belongs in the app chrome
(`site-header.tsx` — wrap the CTAs or use §13's sticky bottom bar), NEVER in
the gate. The same ruling applies to the authed shell pages at 320
(§12: "no horizontal scroll at 320px for the shell").

### 11c. The axe install contract (CI-owned — packages/ui/README.md §5)

```sh
pnpm --filter @studio/web add -D @axe-core/playwright
```

- The spec loads the package through a **runtime import guard**: absent →
  every axe test SKIPS with the install command as its printed reason (a
  logged, visible skip — never a silent green, never a red). On the build
  box that is the permanent state (the no-install law); CI installs once and
  the sweep goes live with zero other changes.
- The gate is **zero violations** on `wcag2a/wcag2aa/wcag21a/wcag21aa`. The
  full JSON report is attached per test (`axe-report-<page>`) so a red names
  the exact rules and nodes.
- First-run policy: an environmental rule (dev-only chrome — the Next dev
  overlay `<nextjs-portal>` is the one sanctioned exclusion) gets an entry
  in `AXE_DISABLED_RULES` with a comment; the tag set is never weakened.
- Scope per the W2-10 manifest: the REAL marketing + auth routes. The
  `@studio/ui` example galleries are not routes (packages/ui README §5) —
  the primitives are exercised in situ through the pages that compose them;
  the component-level floor stays the unit suite's a11y assertions.

### 11d. Screenshot smokes, not baselines (the runner-GPU caveat)

`m9-visual` writes one full-page PNG per page × viewport into the run's
output dir (`e2e/.results/…`, via `testInfo.outputPath` — run artifacts,
never committed) and asserts existence + a non-blank byte floor (≥ 10 KiB).
They are NOT pixel baselines: the same runner-GPU caveat that governs the
editor WebGL baselines (§First run) applies to every rendered pixel —
antialiasing and font rasterization differ per runner image — so only the
editor-unchanged masks (chat/m5) are pinned against committed images, and
this harness deliberately does not add to them.

### 11e. LCP/CLS smoke — the CI-owned honest note

The last `m9-visual` test reads the landing's
`performance.getEntriesByType("largest-contentful-paint" |
"layout-shift")` through an inline, guarded helper in the spec:

- **CLS is a hard gate** (`< 0.1`, the §M9 exit criterion): layout shift is
  geometry — stable in `next dev`, so it gates honestly here.
- **LCP is recorded, not production-gated**: the number is annotated onto
  the test and held only under a 15 s pathological ceiling. §16.2's
  "LCP < 2.5s on a throttled profile" is a production-build measurement; a
  warm dev-server number is not that measurement, and pretending otherwise
  would be a fake green. The production budget run is CI's perf job
  (BUILD_PLAN §M10 task 3).
- **Guarded**: a runner that buffers no LCP entry SKIPS that half with the
  reason printed — absence is a skip, never a red.
