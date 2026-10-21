# infra/obs — Observability (dashboards, alert rules)

Owner: infra/obs (W9-F). Spec §22. This directory holds the Grafana dashboards and the
Prometheus alert rules. Nothing here runs by itself — compose wiring (Prometheus,
Grafana, exporters) is owned by W9-M; see [Compose mount contract](#compose-mount-contract-w9-m-wires).

```
infra/obs/
  grafana/business.json        # MRR, customers, credits burned, COGS ratio
  grafana/product.json         # runs by status/tier, templates, edit acceptance, undo rate
  grafana/reliability.json     # error rate, queue age, engine restarts, run duration p50/p95
  grafana/cost.json            # per-workspace spend top-N, tokens by model, COGS ratio
  alerts/prometheus-rules.yml  # §22 alerts, each labelled with its runbook
```

## Metric registry (canonical contract)

Every dashboard panel and alert expression references these series names. The app series
are emitted by **`packages/agent/src/obs/metrics.ts` (W9-D)** at `/metrics` (Prometheus
format, `prom-client`); the ops/billing series are published by the jobs noted below.
If W9-D's implementation diverges, reconcile there or here **before** W9-M wires scrapes —
dashboards/alerts silently show no data otherwise.

| Series | Type | Labels | Producer | Used by |
|---|---|---|---|---|
| `studio_runs_total` | counter | `status` (succeeded\|failed\|cancelled), `tier` | agent (W9-D) | product, reliability, RB-01 |
| `studio_run_duration_seconds` | histogram | `tier` (+ `_bucket/_sum/_count`) | agent (W9-D) | reliability p50/p95 |
| `studio_run_steps` | histogram | — | agent (W9-D) | registry (§22) |
| `studio_tool_calls_total` | counter | `tool`, `result` (ok\|error) | agent (W9-D) | reliability error rate |
| `studio_provider_requests_total` | counter | `provider`, `result` (ok\|error) | agent (W9-D) | reliability, RB-04 |
| `studio_validator_checks_total` | counter | `verdict` (pass\|block) | agent (W9-D) | product edit acceptance |
| `studio_critic_renders_total` | counter | `verdict` (accept\|revise) | agent (W9-D) | registry (§22 revise rate) |
| `studio_undo_actions_total` | counter | `action` (undo\|redo) | agent (W9-D) | product undo rate |
| `studio_templates_used_total` | counter | `template_id` | agent (W9-D) | product templates table |
| `studio_credits_reserved_total` | counter | — | agent (W9-D) | business credits burned |
| `studio_credits_committed_total` | counter | — | agent (W9-D) | business credits burned |
| `studio_ai_cost_usd_total` | counter | — (USD) | agent (W9-D) | cost, COGS ratio, RB-08 |
| `studio_workspace_cost_usd_total` | counter | `workspace_id` ⚠️ cardinality-guard: only top-N tracked workspaces | agent (W9-D) | cost top-spenders table |
| `studio_tokens_total` | counter | `model`, `direction` (input\|output\|cache_read) | agent (W9-D) | cost tokens by model |
| `studio_queue_depth` | gauge | — | agent (W9-D) | reliability queue panel |
| `studio_queue_age_seconds` | gauge | — (oldest job age) | agent (W9-D) | reliability, RB-02 |
| `studio_engine_restarts_total` | counter | — | agent (W9-D) | reliability, RB-03 |
| `studio_engine_pool_utilization_ratio` | gauge | — | agent (W9-D) | registry (§22) |
| `studio_engine_sessions` | gauge | `state` (active\|idle) | agent (W9-D) | registry (§22) |
| `studio_uploads_total` / `studio_exports_total` | counter | — | agent (W9-D) | registry (§22) |
| `studio_db_pool_saturation_ratio` | gauge | — | agent (W9-D) | registry (§22) |
| `studio_stripe_webhook_events_total` | counter | `event_type`, `result` (ok\|failed) | gateway (W9-D/webhooks) | RB-07 |
| `studio_billing_mrr_usd` | gauge | — | **manual placeholder** (below) | business MRR, COGS ratio |
| `studio_customers_total` | gauge | — | billing sync placeholder | business customers |
| `studio_daily_cost_budget_usd` | gauge | — | config (`DAILY_BUDGET_USD`) | cost, RB-08 |
| `studio_backup_last_success_timestamp_seconds` | gauge | — | `infra/scripts/backup.sh` (pushgateway/textfile) | RB-06 |

Cardinality guard: `studio_workspace_cost_usd_total` and `studio_templates_used_total`
carry per-entity labels; W9-D must cap tracked entities (top-N + global fallback) so the
time series don't explode.

## Dashboards

Four JSONs under `grafana/` (schemaVersion 39, `DS_PROMETHEUS` datasource template
variable). Panel inventory maps 1:1 to the §22 dashboard list:

| Dashboard | Panels |
|---|---|
| `business` | MRR (stat, **placeholder**), customers (stat), COGS ratio (gauge, ≤25% §1.5-7), credits burned (timeseries: committed + reserved) |
| `product` | runs by status, runs by tier (timeseries), templates used top-10 7d (table), edit acceptance = validator pass rate 24h (stat), undo rate = undos/successful run (timeseries) |
| `reliability` | error rate (tool + provider, timeseries), queue age w/ 120s threshold (timeseries), engine restarts/1h (timeseries), run duration p50/p95 (timeseries) |
| `cost` | per-workspace spend top-10 24h (table), tokens by model (timeseries), COGS ratio gauge **annotated with the §1.5-7 ≤25% threshold**, daily AI cost vs budget (timeseries) |

COGS ratio formula (business + cost): `sum(increase(studio_ai_cost_usd_total[30d])) /
studio_billing_mrr_usd` — trailing-30d AI spend ÷ MRR, red ≥ 0.25 (§1.5-7 "AI COGS ≤ 25%
of revenue", §18.2).

## Manual MRR input (placeholder doc)

`studio_billing_mrr_usd` and `studio_customers_total` are **not auto-synced yet** (Stripe
reconciliation job belongs to `packages/billing`, §18.2). Until it lands, update them
manually on the 1st of each month via the pushgateway `billing-manual` job (W9-M wires
the pushgateway):

```bash
curl -X POST http://pushgateway:9091/metrics/job/billing-manual \
  -d 'studio_billing_mrr_usd 4200'
```

The business MRR panel description links back here. Do not invent a number — if the
placeholder is unset, the MRR/COGS panels intentionally show "No data".

## Alerts → runbooks (1:1)

`alerts/prometheus-rules.yml` implements the §22 alert list. Every alert carries
`labels.runbook` (`RB-0X`) plus `annotations.runbook_file` pointing at
`docs/runbooks/RB-0X-*.md` — one runbook per alert, matched by number:

| Alert | Condition (§22) | `for:` | Severity | Runbook |
|---|---|---|---|---|
| `StudioRunFailureRateHigh` | failure rate > 5% (15m window) | 5m | critical | RB-01 run-failure-spike |
| `StudioQueueAgeHigh` | queue age > 2 min | 5m | warning | RB-02 queue-backlog |
| `StudioEngineRestartLoop` | restarts > 3/h | 5m | critical | RB-03 engine-crash-loop |
| `StudioProviderErrorRateHigh` | provider errors > 10% | 10m | critical | RB-04 provider-outage |
| `StudioHostDiskNearCapacity` | disk > 80% | 15m | warning | RB-05 disk-usage |
| `StudioHostMemoryNearCapacity` | memory > 90% | 10m | warning | RB-05 disk-usage *(shared)* |
| `StudioBackupStale` | backup > 26 h old | 30m | warning | RB-06 restore-drill |
| `StudioTLSCertificateExpiringSoon` | cert < 14 d to expiry | 1h | warning | RB-06 restore-drill *(provisional)* |
| `StudioStripeWebhookFailures` | >3 failed webhooks / 15m | 10m | critical | RB-07 stripe-webhook-failures |
| `StudioDailyCostOverBudget` | 24h AI cost > budget | 15m | critical | RB-08 cost-guardrail-breach |

`for:` rationale: the §22 windows (15m rate window for run failures) live inside the
expression; `for:` clauses de-flap (scrape gaps, single blips) rather than delay §22
thresholds materially.

**Known gaps (flagged to the runbooks owner — do not create here, infra/obs owns only
this tree):** memory and TLS alerts currently borrow RB-05/RB-06 because no dedicated
runbook exists. Recommended: `RB-09` TLS-certificate-renewal and `RB-10`
host-memory-pressure.

## On-call rotation (placeholder)

> **PLACEHOLDER — ops lead fills this in.** No rotation is defined yet.

| Week | Primary | Secondary |
|---|---|---|
| _TBD_ | _TBD_ | _TBD_ |

Routing contract for W9-M's Alertmanager: `severity=critical` → page the primary;
`severity=warning` → ops channel, fix within business hours. Every alert's runbook is
its first-response protocol.

## Compose mount contract (W9-M wires)

`infra/compose/docker-compose.yml` currently has **no** Prometheus/Grafana services. When
W9-M adds them, the contract is:

```yaml
  prometheus:
    image: prom/prometheus:<pin>        # W9-M pins the version (Apache-2.0)
    volumes:
      # rules: this file, evaluated via Prometheus `rule_files: /etc/prometheus/rules/*.yml`
      - ../obs/alerts/prometheus-rules.yml:/etc/prometheus/rules/studio-alerts.yml:ro
    # scrape_configs: agent /metrics (studio_*), node_exporter, blackbox http_2xx probe,
    # pushgateway (backup timestamp + billing-manual MRR placeholder)

  grafana:
    image: <pin chosen by W9-M>
    # LICENSE NOTE: Grafana server is AGPL-3.0. §16.5 avoid-lists AGPL infrastructure
    # (minio/garage precedent). These dashboard JSONs are plain data and fine either way;
    # if §16.5 is read strictly, Perses (Apache-2.0, CNCF) serves the same role and W9-M
    # should pick it — panel exprs are plain PromQL and carry over.
    volumes:
      # dashboards: this directory via a dashboards provider (provisioning/yml is W9-M's)
      - ../obs/grafana:/var/lib/grafana/dashboards:ro
```

## Exporter layouts (PromQL placeholders)

- **Disk/memory:** standard `node_exporter` series — disk uses
  `node_filesystem_avail_bytes{mountpoint="/"}` / `node_filesystem_size_bytes`,
  memory uses `node_memory_MemAvailable_bytes` / `node_memory_MemTotal_bytes`.
  Disk alert filters `mountpoint="/"` — retarget to the compose data volume when W9-M wires it.
- **TLS:** `blackbox_exporter` `probe_ssl_earliest_cert_expiry` from an `http_2xx` (TLS)
  probe of the public endpoint; 14-day threshold.
- **Backup age:** `infra/scripts/backup.sh` pushes
  `studio_backup_last_success_timestamp_seconds` (pushgateway `backup` job or node
  textfile collector — whichever W9-M wires; the alert expression is identical).
- **Budget:** `studio_daily_cost_budget_usd` set from `DAILY_BUDGET_USD` (config).
