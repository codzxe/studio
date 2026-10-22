# deploy/litellm

LiteLLM proxy deployment surface for the `studio-fast` / `studio-smart` /
`studio-vision` model aliases (PRODUCT_ARCHITECTURE.md §8.2). Provider
identities live ONLY in `config.yaml`; the gateway only knows aliases.

- **Runbook (start here):** [docs/deploy/LITELLM.md](../../docs/deploy/LITELLM.md) — deploy, keys/budgets, usage, redaction, health.
- **Stack:** [docker-compose.litellm.yml](../../docker-compose.litellm.yml) · **Boot:** `bash scripts/dev-litellm.sh start` (Docker-less boxes exit 0 with a pointer).
