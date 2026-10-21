# License audit — §16 compliance statement

Task W10-I · Date 2026-10-21 · Status: **PASS** (verified by `pnpm check:licenses`, default
and `--strict`)

This document is the §16 compliance statement for the closed core ("studio" SaaS). It is
owned by the license policy task (W10-series) and maintained together with
[`licenses.overrides.json`](../../licenses.overrides.json) (the machine-readable manifest),
[`ATTRIBUTION.md`](../../ATTRIBUTION.md) (human-readable attribution) and
[`scripts/check-licenses.mjs`](../../scripts/check-licenses.mjs) (the offline gate, wired as
`pnpm check:licenses` and enforced by `infra/ci-staged/license-check.yml`).

Authoritative sources: spec §16.0 (license policy), §16.5 (avoid list), §16.3/§16.4 (picks),
§1.5 rules 8–9, AGENTS.md "Forbidden".

## 1. Policy (spec §16.0 / §16.5)

**Allowed in the product** (permissive only):

| License | Condition |
|---|---|
| MIT | unrestricted |
| Apache-2.0 | unrestricted (NOTICE preserved) |
| BSD-2-Clause / BSD-3-Clause | unrestricted |
| ISC | unrestricted |
| 0BSD | unrestricted |
| PostgreSQL License | unrestricted (the database server) |
| MPL-2.0 | **only** unmodified files, kept identifiable, notices retained |

**Denied** (§16.0 "not allowed in the product or its deployment without a written legal
review"): AGPL-3.0, SSPL, BUSL-1.1, RSALv2, Elastic License, Sustainable Use License, FSL —
i.e. **all "source-available" licenses** — plus GPL/LGPL as *product* dependencies
(copyleft), UNLICENSED/PROPRIETARY code, and restrictive Creative Commons (CC-BY-NC/ND/SA).

**The one carve-out** (§16.0): *"Copyleft tools are fine as internal, unmodified,
separately-run utilities (never linked into or shipped with our code)."*

Every dependency must appear in `licenses.overrides.json`; anything that ships additionally
gets an `ATTRIBUTION.md` row and its license text under `LICENSES/`, and must pass the CI
license check.

## 2. What is used

### 2.1 npm dependencies (root + apps/* + packages/*)

45 external dependencies across 15 `package.json` manifests (27 workspace-internal
`@studio/*` edges are skipped by policy). Every one is declared and allowed — checker output
2026-10-21:

```
PASS — 45 declared dependencies allowed, 0 font binaries, 0 .env files.
```

License mix: MIT (the overwhelming majority), Apache-2.0 (ai, drizzle-orm/-kit,
typescript), ISC (lucide-react), one dual MIT/Apache-2.0 (@biomejs/biome, either branch
satisfies §16.0). No AGPL/SSPL/BUSL/RSALv2/Elastic/FSL component anywhere in the dependency
graph.

W10-I inventory actions:

- **Added**: `@vitejs/plugin-react` (MIT, vitejs org — apps/web devDependency for the
  vitest/jsdom pipeline). It was the single undeclared dep the checker caught.
- **Anticipated wave additions did not materialize**: no `react-email` (not adopted; email
  templates are not built out), no new `@radix-ui/react-*` beyond the five declared ones
  (dialog, label, slot, tabs, tooltip), and no separate Better Auth plugin packages — the
  `organization` / `apiKey` / `admin` plugins (§16.3) ship *inside* the MIT-licensed
  `better-auth` package itself.
- **Resolved all 11 `TODO-verify` rows** to `declared` from upstream license knowledge
  (@hono/node-server, the four @testing-library packages, the three @types/* packages,
  aws4fetch, jsdom, tailwind-merge — all MIT). None were genuinely unsure, so none remain
  `TODO-verify`. CI should still re-confirm declarations against package metadata
  (`LICENSE_CHECK_STRICT=1` remains the strict gate for future unsure rows).

### 2.2 Infrastructure images (Docker)

Unmodified upstream images, run as separate containers on the single Lightsail box (§17.1/§17.2).
All declared as `kind: "infra"` rows in the manifest; full table with license texts in
`ATTRIBUTION.md`:

| Image | License |
|---|---|
| `postgres:16-alpine` | PostgreSQL License |
| `valkey/valkey:8-alpine` | BSD-3-Clause |
| `caddy:2-alpine` | Apache-2.0 |
| `louislam/uptime-kuma:latest` | MIT |
| `glitchtip/glitchtip:latest` | MIT |
| `prom/prometheus:latest` | Apache-2.0 |
| `persesdev/perses:latest` | Apache-2.0 |
| `prom/alertmanager:latest` | Apache-2.0 |
| `node:22-alpine` (base of the 5 app Dockerfiles) | MIT |

Build-stage toolchain (never shipped at runtime): `pnpm` (MIT, corepack pin from the root
`packageManager` field) and `dumb-init` (MIT, apk PID 1). The Rust engine binary is **not**
baked into any image — it is compiled on the host from the pinned MIT OR Apache-2.0 vendor
clone and bind-mounted read-only (ADR-0001; §3.2).

## 3. AGPL trap analysis — Grafana avoided, Perses adopted (§16.0 / §16.5)

§16.5 lists `grafana/grafana` (AGPL-3.0) with the note: *"fine as an internal unmodified
dashboard, avoid shipping/embedding"*. §16.0's carve-out would therefore have allowed a
strictly internal, unmodified, separately-run Grafana container as an ops utility — the
observability wave (W9-F/W9-M) deliberately **did not take that option**: `persesdev/perses`
(Apache-2.0) fills the same dashboard role with **zero copyleft exposure** and no legal
review dependency. The dashboard JSONs (`infra/obs/grafana/*.json`) are plain
Grafana-format artifacts imported into Perses; their panel PromQL carries over unchanged.

The same pattern was applied across the stack (each replaces a §16.5 trap with a
§16.0-clean component):

| Trap (§16.5) | License | Replaced by |
|---|---|---|
| `redis/redis` ≥ 7.4 | RSALv2 / SSPL | **Valkey** (BSD-3-Clause) |
| `getsentry/sentry` server | FSL-1.1 | **GlitchTip** (MIT) — Sentry *SDKs* only point at it |
| `grafana/grafana` | AGPL-3.0 | **Perses** (Apache-2.0) |
| `minio/minio`, `deuxfleurs/garage` | AGPL-3.0 | AWS S3 / Cloudflare R2 (§17.1); SeaweedFS (Apache-2.0) if self-hosting |
| `hashicorp/terraform` | BUSL-1.1 | **OpenTofu** (MPL-2.0) if/when IaC lands (not yet used) |
| `elastic/elasticsearch` | SSPL / Elastic | Postgres full-text search |

## 4. Copyleft containers as internal utilities (§16.0)

The product's own containers are built `FROM node:22-alpine`. Node.js is MIT, but the Alpine
userspace carries GPL-2.0 components (busybox; the Linux kernel is GPL-2.0 throughout).
Position under §16.0:

- Base images and OS userspace are used **unmodified**, **separately-run** (process/container
  isolation), and are **never linked into, distributed with, or derived from** our code —
  precisely the §16.0 "internal, unmodified, separately-run utility" allowance. Shipping our
  app *inside* a stock GPL-userspace container does not create a combined work with it
  (standard container practice; upstream notices are preserved in the images).
- The same allowance would cover an internal unmodified AGPL dashboard *if one were ever
  needed* — the Perses decision (§3 above) means we currently need none.
- Rule of engagement going forward: a copyleft-licensed container may be added only as an
  unmodified stock image run as an internal utility; any modification, embedding, or
  customer-facing exposure requires written legal review first (§16.0).
- Transitive npm copyleft is a different matter and stays **flatly denied** for product
  code — the checker rejects GPL/LGPL npm entries (§1 above).

## 5. Source-available / legal-review flag

**Status: none in core.** No BUSL, RSALv2, FSL, Elastic License or Sustainable Use component
is present in the product, its dependency graph, its images, or the deployment. No source-
available license is waiting on a written legal review. The standing rule (§16.0): any
proposal touching a source-available license (or a copyleft component beyond the §16.0
internal-utility pattern) must be flagged for legal review **before** adoption — open a task,
mark the manifest entry `"status": "TODO-verify"` with a note, and do not ship until cleared.

## 6. Mechanical enforcement

`scripts/check-licenses.mjs` (zero-dependency, offline) fails the build on: any undeclared
dependency, any denied license anywhere in the manifest (used or not), any license not in
the §16.0 allowlist, any committed font binary, and any committed `.env` secret file.
`LICENSE_CHECK_STRICT=1` additionally makes `TODO-verify` rows fatal. Run: `pnpm
check:licenses`. Result at audit time (2026-10-21): **PASS**, default and strict.

## 7. Attestations (W10-I)

1. **Fonts**: 0 font binaries committed; fonts come from the pinned `vendor/craft-fonts`
   clone via `CRAFT_FONTS_DIR` (checker-enforced; see ATTRIBUTION.md "Fonts").
2. **Secrets**: 0 `.env` files committed (`.env.example` templates only).
3. **Vendor pins**: all seven clones re-verified against ADR-0001 via `git rev-parse HEAD` —
   unchanged (table in ATTRIBUTION.md "Vendor pins").
4. **Editor/engine**: MIT OR Apache-2.0, used under the terms of the permissive branch;
   engine additions live in `engine-patches/` in this repo, never as in-place vendor edits
   (ADR-0001; `docs/brand/` assets excluded and never shipped).
