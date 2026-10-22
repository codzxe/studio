# LiteLLM — deployment & ops runbook

Status: **M4 surface** (chat = read-only agent) · Owner: platform · Cite: `PRODUCT_ARCHITECTURE.md` §8.1–8.2, `BUILD_PLAN.md` §M4 task 3, `docs/phases/M4-SEAMS.md` Seam 3/Seam 8.

Files in this deployment surface:

| File | What it is |
|---|---|
| `deploy/litellm/config.yaml` | The proxy config — aliases, tier fallbacks, keys *by env reference only* |
| `docker-compose.litellm.yml` (repo root) | Standalone stack: `litellm` + its dedicated `postgres:17` |
| `scripts/dev-litellm.sh` | One-command boot on Docker boxes; friendly no-op elsewhere |
| this file | The runbook you are reading |

## 1. Why LiteLLM (§8.1 boundary)

The stack-role table in §8.1 draws a hard line: **the AI SDK is not a gateway,
LiteLLM is not a chat UI.** The Studio gateway's runner (`services/gateway`,
OpenAI-compatible client built in M4-A) speaks plain `POST /v1/chat/completions`
to LiteLLM and knows **only the three aliases** — never a provider name, never
a provider key. LiteLLM provides what a gateway must not: model aliasing,
provider credentials in one place, virtual keys + budgets, within-tier
fallbacks and spend logs (the M6 reconciliation source).

Consequence for ops: provider identities (which real model sits behind
`studio-fast`, which key talks to which provider) live **only in
`deploy/litellm/config.yaml`**. Changing providers is a config edit + env var —
no application deploy, no schema change, no client update.

## 2. Deploy via compose (turnkey)

Target: a real deployment box (§14.2 — one Linux box is enough for beta;
LiteLLM can live on it or on its own host). **This repo's dev box has no
Docker** — that's fine, see §9.

```bash
# on the deployment host
git clone https://github.com/codzxe/studio && cd studio

# deployment-layer secrets (gitignored; NOT the app's 34-var contract):
#   LITELLM_MASTER_KEY="sk-master-$(openssl rand -hex 24)"
#   OPENAI_API_KEY=sk-…          # per the primary models in config.yaml
#   ANTHROPIC_API_KEY=sk-ant-…   # per the fallback models in config.yaml
$EDITOR .env                     # add the lines above (and EDIT-ME the LITELLM_DB_* defaults for prod)

bash scripts/dev-litellm.sh start
#   = docker compose --env-file .env -f docker-compose.litellm.yml up -d
#   + waits for GET /health/liveliness (first boot migrates the LiteLLM DB — up to ~1 min)
```

What comes up:

- `litellm` — `ghcr.io/berriai/litellm:main-stable`, `--config /app/config.yaml`,
  published on **127.0.0.1:4000 only** (never internet-facing; if the gateway
  runs in the same compose network, point it at `http://litellm:4000` instead).
- `litellm-db` — dedicated PostgreSQL 17 for LiteLLM's virtual keys, budgets
  and spend tables. **Separate from the app control-plane DB** by design: a
  proxy incident cannot touch auth/projects/credits, and spend rows stay a
  clean reconciliation source (§7).

Verify:

```bash
curl -s http://127.0.0.1:4000/health/liveliness   # → "I'm alive!"
bash scripts/dev-litellm.sh status                # same probe, packaged
bash scripts/dev-litellm.sh logs                  # follow proxy logs
bash scripts/dev-litellm.sh stop                  # down (DB volume kept)
```

Relationship to `infra/compose/docker-compose.yml`: the full-stack compose also
embeds a `litellm` service (same aliases; its DB is a database inside the
shared Postgres instance). Pick **one** path per `LITELLM_BASE_URL` — this
standalone stack when LiteLLM runs split-out, the full-stack compose when
everything shares one box.

## 3. Keys — master, platform, per-workspace

Three key classes, three different homes:

| Key | Generated | Lives in | Used by |
|---|---|---|---|
| `LITELLM_MASTER_KEY` | `sk-master-$(openssl rand -hex 24)` | deployment env (`.env`, gitignored) | **ops only** — mints keys, reads spend. Never in the app env, never in code. |
| platform key → app env `LITELLM_API_KEY` | `POST /key/generate` (below) | app `.env` (app contract var, `packages/config/src/env.ts`) | the gateway's bearer key in v1 (platform keys only) |
| per-workspace virtual key → app env `LITELLM_VIRTUAL_KEY` | `POST /key/generate` with budget | app `.env` / per-tenant secret storage | optional in v1; maps a workspace to a LiteLLM **budget + spend log** (§8.2) |

### 3.1 Mint the platform key (becomes `LITELLM_API_KEY`)

```bash
curl -X POST http://127.0.0.1:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "studio-platform-v1",
    "models": ["studio-fast", "studio-smart", "studio-vision"],
    "max_budget": null
  }'
# → {"key": "sk-…", …}  →  put that key in the app env as LITELLM_API_KEY
```

`max_budget: null` = no LiteLLM-side cap for the platform key: the app's
credit ledger is the billing truth (§8.8 — LiteLLM budgets are a second
guardrail, not the ledger). Do **not** grant the `*-fallback` model names to
keys — they are internal fallback targets, not part of the app's
`MODEL_IDS`, and the gateway never requests them.

### 3.2 Mint a per-workspace virtual key (budgets + spend)

When you split tenants onto virtual keys (v1 ships platform-key-only;
§8.2 "Workspace/user virtual keys map to budgets and spend logs"):

```bash
curl -X POST http://127.0.0.1:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "workspace-<uuid>",
    "models": ["studio-fast", "studio-smart"],
    "max_budget": 50,
    "budget_duration": "30d"
  }'
# → {"key": "sk-…", …}  →  store per workspace; the gateway sends it as
#   LITELLM_VIRTUAL_KEY and spend lands on the alias/budget rows automatically.
```

`max_budget` is USD; `budget_duration` resets the window (`"1d"`, `"30d"`, …).
Exhausted/invalid keys surface in the gateway as `RUN_MODEL_UNAVAILABLE`
(retryable) — the credit UX stays owned by the app, never by the proxy.

### 3.3 Key housekeeping

```bash
# inspect one key (usage so far, budget, spend):
curl -X POST http://127.0.0.1:4000/key/info \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" -d '{"key": "sk-…"}'

# list keys:
curl http://127.0.0.1:4000/key/list -H "Authorization: Bearer $LITELLM_MASTER_KEY"

# revoke (e.g. workspace churned):
curl -X POST http://127.0.0.1:4000/key/delete \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" -d '{"keys": ["sk-…"]}'
```

Admin routes are master-key protected and intentionally left enabled
(`general_settings.disable_proxy_admin_routes: false` in the config) — that's
how every key in this section is minted. Rotate the master key by updating the
deployment env and re-running `bash scripts/dev-litellm.sh start` (rolling the
proxy does not affect already-minted virtual keys).

## 4. How the gateway authenticates (pinned seam)

The gateway sends **one** bearer header on every model call
(`docs/phases/M4-SEAMS.md` Seam 3):

```text
Authorization: Bearer {LITELLM_VIRTUAL_KEY ?? LITELLM_API_KEY}
```

- v1 default: `LITELLM_VIRTUAL_KEY` unset → the platform key authenticates.
- Per-tenant mode: set `LITELLM_VIRTUAL_KEY` per deployment/tenant → LiteLLM
  budgets + spend logs engage for that key (§8.2).
- The master key is **never** an app env var — it could mint keys and bypass
  budgets.

App env vars involved (all declared in `packages/config/src/env.ts`):
`LITELLM_BASE_URL` (default `http://127.0.0.1:4000`), `LITELLM_API_KEY`,
optional `LITELLM_VIRTUAL_KEY`. Dev-only note: `MOCK_MODEL` (production
rejects `true`) and `CHAT_MAX_STEPS` (per-run model/tool step cap) round out
the runner's env surface.

## 5. Aliases & tier fallbacks (§8.2)

| Alias | Tier | Use (§8.2) | Example primary | Same-tier fallback | Plans (MODEL_CATALOG) |
|---|---|---|---|---|---|
| `studio-fast` | fast | Cheap planning, classification, quick edits | `openai/gpt-4o-mini` | `anthropic/claude-3-5-haiku-latest` | trial, starter, pro, studio |
| `studio-smart` | smart | Main agent, multi-step edits, tool use | `openai/gpt-4o` | `anthropic/claude-3-5-sonnet-latest` | pro, studio |
| `studio-vision` | vision | Frame/screenshot understanding | `openai/gpt-4o` (multimodal) | `anthropic/claude-3-5-sonnet-latest` (image-capable) | studio |

- Provider ids above are the shipped **examples** — swap freely in
  `deploy/litellm/config.yaml` (Azure/Bedrock/Vertex/Ollama all work; keep the
  `api_key: os.environ/<VAR>` pattern). The gateway never notices.
- **Fallbacks never cross tiers** (§8.2: "provider failure → secondary model
  within the same tier; never silently downgrade a paid user to a weaker model
  without telling them"). The router block in the config wires exactly three
  same-tier hops: `fast → *-fast-fallback`, `smart → *-smart-fallback`,
  `vision → *-vision-fallback`. Tiers differ in credit rates and entitlements —
  a cross-tier hop would mis-bill or leak a paid capability.
- `studio-vision` is plan-gated and metered separately (§8.2; gap/milestones
  A8: the alias ships in the config at M4, UI exposure is behind the Studio
  plan entitlement). Only mint it into keys that should have it.

## 6. Usage capture — what the runner reads

Every model call the gateway makes is streamed with
`stream_options: { include_usage: true }` (Seam 3): the **final SSE chunk**
caries `usage` (`prompt_tokens`, `completion_tokens`). The runner commits
credits as `ceil(prompt_tokens/1000 × creditsPer1kInput +
completion_tokens/1000 × creditsPer1kOutput)`, minimum 1, using the alias's
`MODEL_CATALOG` rates; if a provider omits usage, it estimates
`≈ chars/4` over the assembled messages. Reserve-vs-commit against the credit
ledger is unchanged gateway behavior (§8.8).

In parallel, LiteLLM's Postgres records its own **spend rows** per request
(tokens, computed USD spend, the virtual/platform key, model alias, request
metadata — *not* prompt bodies, §7). That's the second ledger.

## 7. Spend reconciliation hook (M6 — forward pointer, no code here)

M6 (billing) runs a reconciliation job joining LiteLLM's spend tables to the
app's append-only `credit_ledger` (control-plane `DATABASE_URL`):

- LiteLLM side: the `litellm-db` Postgres from §2 (`docker compose exec
  litellm-db psql -U litellm -d litellm`) — spend rows keyed by api key,
  alias, tokens and USD.
- App side: committed credits per run in the credit ledger.
- Correlation: if the runner forwards a request `metadata` field
  (`metadata: {"run_id": …}` — a LiteLLM-native passthrough stored on spend
  rows), the join is exact per run. That's a one-line runner change owned by
  M4-A/M6, decided by the orchestrator — noted here so ops knows the seam
  exists. Without it, reconciliation is per-key/time-window/token-count
  heuristics (weaker; document whichever M6 ships).

## 8. Redaction & privacy posture

- The gateway **never logs prompt bodies** — runner logs carry message lengths
  and sha256 prefixes only (Seam 3; BUILD_PLAN §M4 task 3 "redact prompts in
  logs").
- LiteLLM request/response logging stays **off** in production: the config
  configures no `success_callback`/`failure_callback`/`callbacks` (Langfuse,
  OpenMeter, S3 logging …) — those ship prompt contents somewhere by design.
  Do not add them to a production proxy without a privacy ruling.
  `litellm_settings.telemetry: false` keeps anonymous usage reporting off;
  `cache_response: false` keeps responses uncached (per-tenant project context
  must never cross tenants).
- Spend rows record tokens/costs/keys/aliases — never bodies.
- Debug flags (`--debug`, `--detailed_debug`) print full request bodies to
  container stdout — debug sessions only, never in production.
- Secrets in this surface: only env references (`os.environ/…`) — the config
  file itself is safe to commit and review; real keys live in the
  gitignored `.env` (chmod 600) or a secret manager.

## 9. Local dev without Docker

- Local chat development **needs no LiteLLM at all**: the mock runner is the
  default (`MOCK_MODEL=true` in the local `.env`, D-16; the schema default is
  `false` and **production rejects `true`**). No test in the repo talks to a
  real model — `MOCK_MODEL` fakes streaming/tool calls deterministically.
- Docker boxes that want a live proxy: `bash scripts/dev-litellm.sh start`
  (auto-detects `docker compose` / `docker-compose`; exits 0 with a pointer
  otherwise).
- §14.1 also allows **LiteLLM in a Python venv** (no Docker needed):

  ```bash
  python3 -m venv .local/litellm-venv
  .local/litellm-venv/bin/pip install 'litellm[proxy]'
  export LITELLM_MASTER_KEY='sk-master-…' OPENAI_API_KEY='sk-…' ANTHROPIC_API_KEY='sk-ant-…'
  # virtual keys/budgets/spend need a DB — point LITELLM_DATABASE_URL at any Postgres,
  # e.g. the dev one: postgres://studio:studio@127.0.0.1:5432/litellm (createdb litellm first)
  .local/litellm-venv/bin/litellm --config deploy/litellm/config.yaml --port 4000
  ```

  Then set `LITELLM_BASE_URL=http://127.0.0.1:4000`,
  `LITELLM_API_KEY=<minted platform key>`, optional `LITELLM_VIRTUAL_KEY`,
  `MOCK_MODEL=false` in `.env`.

## 10. Health & metrics

| Endpoint | Meaning |
|---|---|
| `GET /health/liveliness` | Process alive — the probe `scripts/dev-litellm.sh` waits on; LB health check. |
| `GET /health/readiness` | Ready to serve (config parsed, DB reachable). |
| `GET /metrics` | Prometheus metrics (request latency, spend, per-model counters). |
| `GET /v1/models` | Alias list as the calling key sees it — sanity-check entitlements per key. |
| `POST /key/generate` · `/key/info` · `GET /key/list` · `POST /key/delete` | Key management (§3), master-key protected. |

Ops quick reference (repo root):

```bash
bash scripts/dev-litellm.sh start|stop|status|logs
docker compose --env-file .env -f docker-compose.litellm.yml exec litellm-db psql -U litellm -d litellm  # spend tables (M6)
curl -s http://127.0.0.1:4000/metrics | head                      # Prometheus
docker compose --env-file .env -f docker-compose.litellm.yml pull  # upgrade → up -d
```
