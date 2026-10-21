# Secrets policy — how credentials live, rotate, and die

Owner: platform / env owner (`W10-N`) · Sources: spec §4, §15.2, §17.4, §17.5,
ADR-0002, `infra/environments.md` ("Secret provisioning"), `.env.example`.

The rule in one line: **secrets live only in a `0600` env file on the box,
one file per environment — never in the repo, never in git, never in CI
logs.** Everything below is that sentence, operationalized.

## 1. Where secrets live

| Place | What it holds | Notes |
|---|---|---|
| Local dev `.env` (repo root) | local/test keys, `changeme` placeholders | git-ignored (`.env`, `.env.*`, `!.env.example`), `chmod 0600` |
| Box `.env` (clone root, production) | live keys | `0600`, created by ops from `.env.example` + box values (ADR-0002) |
| Staging env file (e.g. `/srv/studio-staging.env`) | Stripe TEST keys, own DB password | same box, separate Compose project (`COMPOSE_PROJECT_NAME`, §17.5) |
| GitHub Actions | **exactly two** secrets: SSH key to the box + GHCR token | CI never sees app secrets; the box never sees CI credentials |
| Deploy bookkeeping (`STATE_DIR`) | image tags + timestamps only | never secrets |
| `.env.example` (in-repo) | names + placeholders only | the contract, not the values |

Enforcement already in the tree: `.gitignore` keeps `.env*` out while
preserving `!.env.example`; `scripts/git-sync.sh` stages the whole tree, so
a secret placed outside an env file reaches git immediately — do not do it;
compose fails fast on missing secrets via `:?` interpolation
(`POSTGRES_PASSWORD`, `GLITCHTIP_SECRET_KEY`, `METRICS_TOKEN`).

## 2. Secret vs config

A value is a **secret** if it grants access, signs something, pays money, or
decrypts — i.e. if its appearance in a public log would be an incident:

- `AUTH_SECRET` (signs session cookies) — **note:** rotating it logs everyone out
- `POSTGRES_PASSWORD`, and `DATABASE_URL` (contains the password)
- `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY`, `STORAGE_SIGNING_SECRET`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (`STRIPE_PUBLISHABLE_KEY` is
  publishable by design — environment-scoped config, not a secret)
- `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`,
  `FLUX_API_KEY` (paid-tier keys, §1.5 constraint 6)
- `LANGFUSE_SECRET_KEY` (the public key is not secret), `GLITCHTIP_SECRET_KEY`
- `METRICS_TOKEN` (internal /metrics Basic-auth password — unset fails closed)
- `MOCK_ENGINE_TOKEN` (dev/test only — still a token; never reuse patterns)

Everything else — ports, hostnames, URLs, caps, timeouts, flags — is config
and may appear in logs, error messages and this repo. `NEXT_PUBLIC_*` vars
are bundled into the browser: **never** place a secret behind that prefix.

## 3. The fail-fast rule (§4)

> "All env vars parsed and typed once in `packages/config`; missing var =
> process refuses to start (fail fast, never default a secret)."

- A REQUIRED secret that is missing, invalid, or still `changeme` aborts
  startup. `EnvFatalError` names the **variable**, never the **value**.
- No secret is ever silently defaulted, anywhere, by anything.
- Error envelopes, startup logs and CI output never echo env values
  (`apps/worker/src/env.ts` and the config schemas set this precedent).
- Health/metrics endpoints fail **closed** when their token is unset.

## 4. Rotation

Rotate **quarterly**, **on any staff change** (departure, role change,
contractor offboarding), and **on suspicion** — §15.2 "rotate on schedule and
on suspicion". Separate keys per environment (§17.5); rotating staging never
touches production and vice versa.

Procedure (per `infra/environments.md`):

1. Provider-side first for API keys: create the new key, swap it into the box
   env file, redeploy, verify — then revoke the old key (zero-downtime order).
2. `docker compose --env-file .env up -d <svc>` → verify with
   `infra/scripts/smoke.sh`.
3. `POSTGRES_PASSWORD`/`DATABASE_URL`: alter the role's password in SQL first,
   then update BOTH rows in the env file together (they must match, compose
   interpolates the db service from `POSTGRES_PASSWORD`).
4. `AUTH_SECRET` rotation invalidates all sessions — schedule it, announce it.

## 5. Token-exposure incident protocol (§17.4: revoke + rotate + audit)

Trigger: a secret value lands anywhere it should not be — git history, CI
log, issue, chat message, error report, screenshot, core dump, support
ticket.

1. **Revoke** (contain, within the hour): deactivate the exposed credential at
   its provider — Stripe dashboard key roll, provider key deactivation,
   `METRICS_TOKEN` replacement. For `AUTH_SECRET`/`POSTGRES_PASSWORD` you
   cannot "revoke" — go straight to rotate.
2. **Rotate**: treat the exposure as broad — rotate every secret that lived
   next to the leaked one (same file ⇒ assume sibling exposure), using §4.
3. **Audit**: establish the blast radius — `audit_log` (append-only, §22),
   provider dashboards, request logs: which workspaces, runs, payments or
   data the credential could have touched, and for how long.
4. **Preserve**: export and keep the audit log BEFORE cleanup; evidence is
   never deleted to "tidy up".
5. **Notify**: per ToS timelines — 72 h for GDPR-reportable incidents; user
   communication via the incident owner, not ad-hoc.
6. **Postmortem**: find the leak's *class* (repo? CI log? ticket?) and close
   it — then file the runbook delta. Cross-links: `docs/runbooks/` (RB-04
   provider outage, RB-07 Stripe webhook), drill log in `docs/runbooks/`.

## 6. Non-negotiables (worth repeating)

- No secrets in code, docs, issues, commit messages or CI logs (AGENTS.md).
- No font files committed (§1.5 constraint 9) and no secrets — same rule
  class: the repo is public-safe by construction, verified by review.
- Never mix test and live Stripe keys in one env file (§17.5).
- No free LLM tiers for customer data (§1.5 constraint 6): a free-tier key is
  both a cost choice and a **privacy** violation — treat its presence in a
  production env file as a §15.2 incident.
