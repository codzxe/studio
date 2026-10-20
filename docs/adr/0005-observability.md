# ADR 0005 — Observability: pino + OTel + Langfuse + GlitchTip + Uptime Kuma

Date: 2026-10-20 · Status: accepted

## Context

§22 fixes the requirements: request→run correlation in every log line and span, a
Prometheus-format metric set covering runs/queue/engine/billing, sampled traces, error
tracking, external uptime checks, an immutable audit log, and alerts with runbooks
(`docs/runbooks/`). §17.1 fixes the budget (near-zero at 2 users) and §16.5 rules out
the default picks in each category (Sentry server = FSL; Redis-style license traps;
Grafana AGPL — internal unmodified dashboard only).

## Decision

All MIT/Apache-2.0/BSD (§16.3 core picks); self-hosted on the same box where cheap,
free cloud tiers where honest (§17.1).

1. **pino (MIT)** — structured JSON logs on every service (gateway W1-H, worker W1-I
   already log this way). Every line carries the correlation chain
   `request_id → workspace_id → run_id → step_seq` (§22); `request_id` is adopted-or-
   generated per HTTP request (X-Request-Id) and propagated through the queue payload
   so the worker logs continue the same chain.

2. **OpenTelemetry (opentelemetry-js, Apache-2.0)** — spans for
   HTTP → queue → worker → tool → engine call (§22), exported to Grafana Cloud's
   free tier first, self-hosted collector when volume justifies. **Sampling: 100 % of
   errors, 10 % of successes** (configurable via env, ADR-0002 `.env.example`).

3. **Langfuse (MIT core; `ee/` excluded from our deployment)** — LLM traces per run and
   step: model, tokens in/out/cache, cost, cache hit, plus critic/validator verdicts
   (§22). Start on its free cloud tier pointed at **masked prompts** (§17.2 note);
   self-host (Postgres + Clickhouse + Redis-class store + S3) at ~100 users or on a
   privacy requirement — Langfuse's `ee/` directory is never enabled, keeping us on
   the MIT core.

4. **GlitchTip (MIT), not Sentry self-host** — Sentry's *server* is FSL-1.1 (§16.5
   trap); GlitchTip implements the Sentry-compatible ingestion API, so the standard
   Sentry SDKs (already MIT/Apache) point at it unchanged. Self-hosted on the box
   (§17.2 compose) or their SaaS free tier.

5. **Uptime Kuma (MIT)** — the only watcher that runs *outside* the box: pings
   gateway `/v1/health`, engine availability and provider endpoints (§22/§17.4),
   drives the alert notifications for the runbooks (queue age, disk, TLS expiry,
   webhook failures).

6. **Log redaction (§15.3/§22):** user prompts are redacted from logs and Langfuse
   payloads **unless the workspace opts in** (per-workspace flag). Pino redact paths
   are declared centrally (gateway W1-H `redactPaths` export); the worker scrubs
   prompt/attachment fields before any export. Correlation ids are kept — only
   content is redacted.

7. **Metrics (Prometheus format, §22):** runs by status/tier, duration p50/p95, steps
   per run, tool error rate, validator blocker rate, critic revise rate, credits
   reserved/committed, AI cost per run/workspace/day, tokens in/out/cache, queue
   depth and age, engine pool utilisation, sessions active/idle, uploads, exports,
   DB pool saturation. Dashboards per §22: business / product / reliability / cost.

8. **Audit:** `audit_log` is append-only, org-scoped export (W1-F schema), immutable,
   covering auth events, role changes, API keys, exports, deletes, credit adjustments
   (§15.4/§22).

## Consequences

- Alert thresholds map 1:1 to runbooks: run failure > 5 %/15 min → RB-01; queue age
  > 2 min → RB-02; engine restarts > 3/h → RB-03; provider error rate > 10 % → RB-04;
  disk > 80 % → RB-05; backup > 26 h → RB-06; Stripe webhook failures → RB-07;
  cost/day over budget → RB-08 (§22).
- Every service must parse observability endpoints from env via `packages/config`
  (optional vars, ADR-0002) and refuse to guess defaults for DSNs.
- No customer prompt text ever reaches GlitchTip (error payloads are the typed
  envelope only, §13.3) or logs (redaction above); Langfuse sees masked prompts
  until the workspace opts in.
- Grafana may be used as an internal, unmodified dashboard (AGPL exception in §16.5)
  but is never embedded or shipped.
